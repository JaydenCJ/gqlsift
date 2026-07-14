/**
 * Impact analysis: maps schema-diff changes onto recorded operations.
 *
 * `buildUsageIndex` walks every recorded operation with the OLD schema
 * (the one the operations were recorded against) and records what each
 * operation touches: fields, arguments, enum literals, input-object keys,
 * fragment type conditions and variable types. `assessChanges` then joins
 * each change against the index and produces per-operation verdicts:
 *
 * - `breaks`     — the operation provably stops working;
 * - `may-break`  — runtime values decide (e.g. the operation feeds an
 *                  input object or enum through a variable, so the
 *                  concrete fields/values are not visible statically).
 *
 * Field selections on an interface are also credited to every implementor
 * (`Node.id` counts as a use of `User.id`), because at runtime the data
 * comes from concrete types.
 */

import {
  baseTypeName,
  lookupType,
  type AssessedChange,
  type Change,
  type Document,
  type ImpactHit,
  type ImpactLevel,
  type OpRef,
  type Schema,
  type Selection,
  type TypeDef,
  type TypeRef,
  type Value,
} from "./types.js";

export interface UsageIndex {
  /** opId -> operation reference. opId = `${file}::${name ?? anon@line}` */
  ops: Map<string, OpRef>;
  /** `Type.field` -> opIds selecting that field. */
  fieldUses: Map<string, Set<string>>;
  /** `Type.field.arg` -> opIds passing that argument. */
  argUses: Map<string, Set<string>>;
  /** `Enum.VALUE` -> opIds using the literal (args, defaults, input keys). */
  enumValueUses: Map<string, Set<string>>;
  /** type name -> opIds referencing it in any position. */
  typeUses: Map<string, Set<string>>;
  /** `AbstractType.ConcreteType` -> opIds spreading that condition. */
  conditionUses: Map<string, Set<string>>;
  /** `Input.field` -> opIds passing that key in a literal object. */
  inputFieldUses: Map<string, Set<string>>;
  /** input type name -> opIds passing a literal object of that type. */
  inputLiteralUses: Map<string, Set<string>>;
  /** named base type -> opIds declaring a variable of that type. */
  varTypeUses: Map<string, Set<string>>;
  /** named base return type -> opIds selecting a field returning it. */
  returnTypeUses: Map<string, Set<string>>;
}

function record(map: Map<string, Set<string>>, key: string, opId: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(opId);
}

/** Build the usage index for a set of documents against a schema. */
export function buildUsageIndex(schema: Schema, docs: Document[]): UsageIndex {
  const index: UsageIndex = {
    ops: new Map(),
    fieldUses: new Map(),
    argUses: new Map(),
    enumValueUses: new Map(),
    typeUses: new Map(),
    conditionUses: new Map(),
    inputFieldUses: new Map(),
    inputLiteralUses: new Map(),
    varTypeUses: new Map(),
    returnTypeUses: new Map(),
  };

  // Objects implementing each interface, for interface-field expansion.
  const implementors = new Map<string, string[]>();
  for (const def of schema.types.values()) {
    if (def.kind !== "object" && def.kind !== "interface") continue;
    for (const iface of def.interfaces) {
      const list = implementors.get(iface) ?? [];
      list.push(def.name);
      implementors.set(iface, list);
    }
  }

  for (const doc of docs) {
    for (const op of doc.operations) {
      const opId = `${doc.file}::${op.name ?? `anon@${op.line}`}`;
      index.ops.set(opId, { file: doc.file, name: op.name, operation: op.operation });

      for (const v of op.variables) {
        const base = baseTypeName(v.type);
        record(index.varTypeUses, base, opId);
        record(index.typeUses, base, opId);
        if (v.defaultValue) walkValue(schema, index, opId, v.type, v.defaultValue);
      }

      const rootName =
        op.operation === "query"
          ? schema.queryType
          : op.operation === "mutation"
            ? schema.mutationType
            : schema.subscriptionType;
      if (rootName === null) continue; // No such root in the old schema.
      walkSelections(schema, index, implementors, opId, doc, rootName, op.selections, new Set());
    }
  }
  return index;
}

function walkSelections(
  schema: Schema,
  index: UsageIndex,
  implementors: Map<string, string[]>,
  opId: string,
  doc: Document,
  parentName: string,
  selections: Selection[],
  activeFragments: Set<string>
): void {
  const parent = lookupType(schema, parentName);
  record(index.typeUses, parentName, opId);

  for (const sel of selections) {
    if (sel.kind === "field") {
      if (sel.name.startsWith("__")) continue; // Introspection is not schema surface.
      const fieldDef =
        parent && (parent.kind === "object" || parent.kind === "interface")
          ? parent.fields.get(sel.name)
          : undefined;
      // Credit the parent and — for interfaces — every implementor.
      const owners = [parentName, ...(parent?.kind === "interface" ? implementors.get(parentName) ?? [] : [])];
      for (const owner of owners) record(index.fieldUses, `${owner}.${sel.name}`, opId);
      if (fieldDef) {
        const returnBase = baseTypeName(fieldDef.type);
        record(index.returnTypeUses, returnBase, opId);
        record(index.typeUses, returnBase, opId);
        for (const arg of sel.args) {
          for (const owner of owners) record(index.argUses, `${owner}.${sel.name}.${arg.name}`, opId);
          const argDef = fieldDef.args.get(arg.name);
          if (argDef) walkValue(schema, index, opId, argDef.type, arg.value);
        }
        if (sel.selections) {
          walkSelections(schema, index, implementors, opId, doc, returnBase, sel.selections, activeFragments);
        }
      } else if (sel.selections) {
        // Unknown field (or union parent): keep child fields out of the
        // index rather than misattributing them.
        continue;
      }
      continue;
    }

    if (sel.kind === "inline") {
      const condition = sel.typeCondition;
      if (condition === null) {
        walkSelections(schema, index, implementors, opId, doc, parentName, sel.selections, activeFragments);
        continue;
      }
      recordCondition(index, opId, parent, parentName, condition);
      walkSelections(schema, index, implementors, opId, doc, condition, sel.selections, activeFragments);
      continue;
    }

    // Named fragment spread.
    const frag = doc.fragments.get(sel.name);
    if (!frag || activeFragments.has(sel.name)) continue; // Unknown or cyclic: lint's job.
    recordCondition(index, opId, parent, parentName, frag.typeCondition);
    activeFragments.add(sel.name);
    walkSelections(schema, index, implementors, opId, doc, frag.typeCondition, frag.selections, activeFragments);
    activeFragments.delete(sel.name);
  }
}

function recordCondition(
  index: UsageIndex,
  opId: string,
  parent: TypeDef | null,
  parentName: string,
  condition: string
): void {
  record(index.typeUses, condition, opId);
  if (parent && (parent.kind === "union" || parent.kind === "interface") && condition !== parentName) {
    record(index.conditionUses, `${parentName}.${condition}`, opId);
  }
}

/** Walk a literal value against its expected type, recording enum literals
 * and input-object keys. Variables carry no static information here. */
function walkValue(
  schema: Schema,
  index: UsageIndex,
  opId: string,
  type: TypeRef,
  value: Value
): void {
  if (value.kind === "variable" || value.kind === "null") return;
  if (type.kind === "nonnull") {
    walkValue(schema, index, opId, type.of, value);
    return;
  }
  if (type.kind === "list") {
    if (value.kind === "list") {
      for (const item of value.items) walkValue(schema, index, opId, type.of, item);
    } else {
      walkValue(schema, index, opId, type.of, value); // Single-item coercion.
    }
    return;
  }
  const def = lookupType(schema, type.name);
  if (!def) return;
  if (def.kind === "enum" && value.kind === "enum") {
    record(index.typeUses, def.name, opId);
    record(index.enumValueUses, `${def.name}.${value.value}`, opId);
    return;
  }
  if (def.kind === "input" && value.kind === "object") {
    record(index.typeUses, def.name, opId);
    record(index.inputLiteralUses, def.name, opId);
    for (const f of value.fields) {
      record(index.inputFieldUses, `${def.name}.${f.name}`, opId);
      const fieldDef = def.fields.get(f.name);
      if (fieldDef) walkValue(schema, index, opId, fieldDef.type, f.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Assessment: join changes against the index
// ---------------------------------------------------------------------------

/** Assess each change against the usage index. Safe changes get no hits. */
export function assessChanges(changes: Change[], index: UsageIndex): AssessedChange[] {
  return changes.map((change) => ({
    change,
    hits: change.severity === "safe" ? [] : hitsFor(change, index),
  }));
}

function hitsFor(change: Change, index: UsageIndex): ImpactHit[] {
  const hits = new Map<string, ImpactLevel>();
  const add = (opIds: Iterable<string> | undefined, level: ImpactLevel): void => {
    if (!opIds) return;
    for (const id of opIds) {
      // A provable break always outranks a maybe.
      if (level === "breaks" || !hits.has(id)) hits.set(id, level);
    }
  };
  const ref = change.ref;

  switch (change.code) {
    case "B101":
    case "B102":
      if (ref.kind === "type") add(index.typeUses.get(ref.name), "breaks");
      break;
    case "B103":
    case "B104":
    case "B105": // required arg added: every recorded use of the field breaks
      if (ref.kind === "field") add(index.fieldUses.get(`${ref.type}.${ref.field}`), "breaks");
      break;
    case "B106":
    case "B107":
      if (ref.kind === "arg") add(index.argUses.get(`${ref.type}.${ref.field}.${ref.arg}`), "breaks");
      break;
    case "B108":
      if (ref.kind === "enumValue") {
        add(index.enumValueUses.get(`${ref.enum}.${ref.value}`), "breaks");
        // Ops feeding this enum through a variable might send the removed
        // value at runtime.
        add(index.varTypeUses.get(ref.enum), "may-break");
      }
      break;
    case "B109":
      if (ref.kind === "unionMember") add(index.conditionUses.get(`${ref.union}.${ref.member}`), "breaks");
      break;
    case "B110":
      if (ref.kind === "interfaceImpl") add(index.conditionUses.get(`${ref.iface}.${ref.object}`), "breaks");
      break;
    case "B111":
    case "B113":
      if (ref.kind === "inputField") {
        add(index.inputFieldUses.get(`${ref.input}.${ref.field}`), "breaks");
        add(index.varTypeUses.get(ref.input), "may-break");
      }
      break;
    case "B112":
      if (ref.kind === "inputField") {
        // Recorded literals predate the field, so they cannot include it.
        add(index.inputLiteralUses.get(ref.input), "breaks");
        add(index.varTypeUses.get(ref.input), "may-break");
      }
      break;
    case "D201":
      if (ref.kind === "enumValue") add(index.returnTypeUses.get(ref.enum), "may-break");
      break;
    case "D202":
      if (ref.kind === "unionMember") add(index.returnTypeUses.get(ref.union), "may-break");
      break;
    case "D203":
      if (ref.kind === "arg") {
        // Only operations relying on the default (using the field without
        // passing the argument) observe a behavior change.
        const users = index.fieldUses.get(`${ref.type}.${ref.field}`) ?? new Set<string>();
        const passers = index.argUses.get(`${ref.type}.${ref.field}.${ref.arg}`) ?? new Set<string>();
        add([...users].filter((id) => !passers.has(id)), "may-break");
      }
      break;
    case "D204":
      if (ref.kind === "inputField") {
        const literals = index.inputLiteralUses.get(ref.input) ?? new Set<string>();
        const passers = index.inputFieldUses.get(`${ref.input}.${ref.field}`) ?? new Set<string>();
        add([...literals].filter((id) => !passers.has(id)), "may-break");
        add(index.varTypeUses.get(ref.input), "may-break");
      }
      break;
    default:
      break;
  }

  const out: ImpactHit[] = [];
  for (const [opId, level] of hits) {
    const op = index.ops.get(opId);
    if (op) out.push({ op, level });
  }
  out.sort((a, b) => {
    const fa = `${a.op.file}::${a.op.name ?? ""}`;
    const fb = `${b.op.file}::${b.op.name ?? ""}`;
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
  return out;
}
