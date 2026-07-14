/**
 * Operation linter: validates recorded operations against a schema.
 *
 * Rules (stable codes, documented in docs/change-catalog.md):
 *   L401  unknown field on a type (with a nearest-name suggestion)
 *   L402  unknown argument / unknown input-object field
 *   L403  missing required argument / input field
 *   L404  unknown or ill-kinded type (fragment condition, variable type,
 *         missing operation root)
 *   L405  variable used but never declared
 *   L406  variable declared but never used            (warning)
 *   L407  deprecated field / argument / enum value used (warning)
 *   L408  spread of an unknown fragment
 *   L409  fragment defined but never used             (warning)
 *   L410  composite field selected without a selection set
 *   L411  selection set on a leaf field
 *   L412  duplicate operation name / misplaced anonymous operation
 *   L413  invalid enum literal (unknown value, or a quoted string where
 *         an enum value belongs)
 *
 * Fragment bodies are validated exactly once, standalone against their
 * type condition, so an error inside a fragment is reported once no
 * matter how many operations spread it.
 */

import {
  baseTypeName,
  isCompositeType,
  isInputType,
  lookupType,
  type Argument,
  type Diagnostic,
  type Document,
  type FieldDef,
  type Schema,
  type Selection,
  type TypeRef,
  type Value,
} from "./types.js";

/** Lint a set of documents against a schema. Cross-file rule: duplicate
 * operation names collide in persisted-query pipelines, so L412 spans
 * every file in the run. */
export function lintDocuments(schema: Schema, docs: Document[]): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const seenOpNames = new Map<string, string>(); // name -> "file:line"

  for (const doc of docs) {
    lintDocument(schema, doc, diags);
    for (const op of doc.operations) {
      if (op.name === null) continue;
      const prev = seenOpNames.get(op.name);
      if (prev) {
        diags.push({
          file: doc.file,
          line: op.line,
          code: "L412",
          severity: "error",
          message: `duplicate operation name "${op.name}" (also defined at ${prev})`,
        });
      } else {
        seenOpNames.set(op.name, `${doc.file}:${op.line}`);
      }
    }
  }

  diags.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
  return diags;
}

interface FragmentFacts {
  /** variable name -> line of first use inside the fragment. */
  varUses: Map<string, number>;
  /** fragments this fragment spreads. */
  spreads: Set<string>;
}

function lintDocument(schema: Schema, doc: Document, diags: Diagnostic[]): void {
  const push = (line: number, code: string, severity: "error" | "warning", message: string): void => {
    diags.push({ file: doc.file, line, code, severity, message });
  };

  // Anonymous shorthand must be the lone operation in its document.
  if (doc.operations.length > 1 && doc.operations.some((op) => op.name === null)) {
    for (const op of doc.operations) {
      if (op.name === null) {
        push(op.line, "L412", "error", "an anonymous operation must be the only operation in a document");
      }
    }
  }

  // Phase A: validate each fragment body once, standalone.
  const fragFacts = new Map<string, FragmentFacts>();
  for (const frag of doc.fragments.values()) {
    const facts: FragmentFacts = { varUses: new Map(), spreads: new Set() };
    fragFacts.set(frag.name, facts);
    // Directives on the definition itself may reference variables too.
    for (const d of frag.directives) collectVariables(d.args, facts);
    const condition = lookupType(schema, frag.typeCondition);
    if (!condition) {
      push(frag.line, "L404", "error", `fragment "${frag.name}" is on unknown type "${frag.typeCondition}"`);
      continue;
    }
    if (!isCompositeType(condition)) {
      push(
        frag.line,
        "L404",
        "error",
        `fragment "${frag.name}" is on ${condition.kind} type "${frag.typeCondition}", which cannot be selected into`
      );
      continue;
    }
    walkSelections(schema, doc, frag.typeCondition, frag.selections, push, facts);
  }

  // Phase B: validate operations and stitch variable facts together.
  const reachableFragments = new Set<string>();
  for (const op of doc.operations) {
    const opLabel = op.name ?? "(anonymous)";
    const rootName =
      op.operation === "query"
        ? schema.queryType
        : op.operation === "mutation"
          ? schema.mutationType
          : schema.subscriptionType;
    const facts: FragmentFacts = { varUses: new Map(), spreads: new Set() };
    for (const d of op.directives) collectVariables(d.args, facts);

    for (const v of op.variables) {
      const base = lookupType(schema, baseTypeName(v.type));
      if (!base) {
        push(v.line, "L404", "error", `variable "$${v.name}" has unknown type "${baseTypeName(v.type)}"`);
      } else if (!isInputType(base)) {
        push(
          v.line,
          "L404",
          "error",
          `variable "$${v.name}" has ${base.kind} type "${base.name}"; variables must use input types`
        );
      } else if (v.defaultValue) {
        checkValue(schema, v.type, v.defaultValue, `default of "$${v.name}"`, push, facts);
      }
    }

    if (rootName === null) {
      push(op.line, "L404", "error", `schema defines no ${op.operation} root, but operation "${opLabel}" is a ${op.operation}`);
    } else {
      walkSelections(schema, doc, rootName, op.selections, push, facts);
    }

    // Variables: close over fragments this operation (transitively) spreads.
    const usedVars = new Map(facts.varUses);
    const viaFragment = new Map<string, string>();
    const queue = [...facts.spreads];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      reachableFragments.add(name);
      const ff = fragFacts.get(name);
      if (!ff) continue;
      for (const [v, line] of ff.varUses) {
        if (!usedVars.has(v)) {
          usedVars.set(v, line);
          viaFragment.set(v, name);
        }
      }
      queue.push(...ff.spreads);
    }

    const declared = new Set(op.variables.map((v) => v.name));
    for (const [v, line] of usedVars) {
      if (!declared.has(v)) {
        const via = viaFragment.get(v);
        push(
          via ? op.line : line,
          "L405",
          "error",
          `variable "$${v}" is used${via ? ` (via fragment "${via}")` : ""} but never declared by operation "${opLabel}"`
        );
      }
    }
    for (const v of op.variables) {
      if (!usedVars.has(v.name)) {
        push(v.line, "L406", "warning", `variable "$${v.name}" is declared by operation "${opLabel}" but never used`);
      }
    }
  }

  // L409: fragments not reachable from any operation.
  for (const frag of doc.fragments.values()) {
    if (!reachableFragments.has(frag.name)) {
      push(frag.line, "L409", "warning", `fragment "${frag.name}" is defined but never used`);
    }
  }
}

function walkSelections(
  schema: Schema,
  doc: Document,
  parentName: string,
  selections: Selection[],
  push: (line: number, code: string, severity: "error" | "warning", message: string) => void,
  facts: FragmentFacts
): void {
  const parent = lookupType(schema, parentName);

  for (const sel of selections) {
    // Variables riding on execution directives (`@include(if: $x)`,
    // `@skip(if: $x)`) count as uses for the L405/L406 bookkeeping.
    for (const d of sel.directives) collectVariables(d.args, facts);
    if (sel.kind === "field") {
      collectVariables(sel.args, facts);
      if (sel.name === "__typename") {
        if (sel.selections) push(sel.line, "L411", "error", `"__typename" is a leaf and takes no selection set`);
        continue;
      }
      if (sel.name.startsWith("__")) continue; // Introspection fields: out of scope.
      if (!parent) continue; // The parent was already reported unknown.
      if (parent.kind === "union") {
        push(
          sel.line,
          "L401",
          "error",
          `union "${parentName}" has no fields; select "${sel.name}" via an inline fragment on a member type`
        );
        continue;
      }
      if (parent.kind !== "object" && parent.kind !== "interface") continue;
      const fieldDef = parent.fields.get(sel.name);
      if (!fieldDef) {
        const hint = suggest(sel.name, [...parent.fields.keys()]);
        push(sel.line, "L401", "error", `unknown field "${sel.name}" on type "${parentName}"${hint}`);
        continue;
      }
      if (fieldDef.deprecationReason !== null) {
        push(
          sel.line,
          "L407",
          "warning",
          `field "${parentName}.${sel.name}" is deprecated: ${fieldDef.deprecationReason}`
        );
      }
      checkArguments(schema, parentName, fieldDef, sel.args, sel.line, push, facts);

      const returnDef = lookupType(schema, baseTypeName(fieldDef.type));
      if (returnDef && isCompositeType(returnDef)) {
        if (!sel.selections) {
          push(
            sel.line,
            "L410",
            "error",
            `field "${parentName}.${sel.name}" returns ${returnDef.kind} "${returnDef.name}" and needs a selection set`
          );
        } else {
          walkSelections(schema, doc, returnDef.name, sel.selections, push, facts);
        }
      } else if (sel.selections) {
        push(
          sel.line,
          "L411",
          "error",
          `field "${parentName}.${sel.name}" is a leaf (${baseTypeName(fieldDef.type)}) and takes no selection set`
        );
      }
      continue;
    }

    if (sel.kind === "inline") {
      if (sel.typeCondition === null) {
        walkSelections(schema, doc, parentName, sel.selections, push, facts);
        continue;
      }
      const condition = lookupType(schema, sel.typeCondition);
      if (!condition) {
        push(sel.line, "L404", "error", `inline fragment is on unknown type "${sel.typeCondition}"`);
        continue;
      }
      if (!isCompositeType(condition)) {
        push(
          sel.line,
          "L404",
          "error",
          `inline fragment is on ${condition.kind} type "${sel.typeCondition}", which cannot be selected into`
        );
        continue;
      }
      walkSelections(schema, doc, sel.typeCondition, sel.selections, push, facts);
      continue;
    }

    // Named fragment spread. The body was validated in phase A; here we
    // only check the reference and record it for variable/reach analysis.
    facts.spreads.add(sel.name);
    if (!doc.fragments.has(sel.name)) {
      const hint = suggest(sel.name, [...doc.fragments.keys()]);
      push(sel.line, "L408", "error", `spread of unknown fragment "${sel.name}"${hint}`);
    }
  }
}

function checkArguments(
  schema: Schema,
  parentName: string,
  fieldDef: FieldDef,
  args: Argument[],
  fieldLine: number,
  push: (line: number, code: string, severity: "error" | "warning", message: string) => void,
  facts: FragmentFacts
): void {
  const seen = new Set<string>();
  for (const arg of args) {
    seen.add(arg.name);
    const argDef = fieldDef.args.get(arg.name);
    if (!argDef) {
      const hint = suggest(arg.name, [...fieldDef.args.keys()]);
      push(
        arg.line,
        "L402",
        "error",
        `unknown argument "${arg.name}" on field "${parentName}.${fieldDef.name}"${hint}`
      );
      continue;
    }
    if (argDef.deprecationReason !== null) {
      push(
        arg.line,
        "L407",
        "warning",
        `argument "${parentName}.${fieldDef.name}(${arg.name}:)" is deprecated: ${argDef.deprecationReason}`
      );
    }
    checkValue(schema, argDef.type, arg.value, `argument "${arg.name}"`, push, facts);
  }
  for (const argDef of fieldDef.args.values()) {
    if (argDef.type.kind === "nonnull" && argDef.defaultValue === null && !seen.has(argDef.name)) {
      push(
        fieldLine,
        "L403",
        "error",
        `missing required argument "${argDef.name}" on field "${parentName}.${fieldDef.name}"`
      );
    }
  }
}

/** Validate a literal value against its expected type: enum literals and
 * input-object keys are the checks that catch real drift. */
function checkValue(
  schema: Schema,
  type: TypeRef,
  value: Value,
  where: string,
  push: (line: number, code: string, severity: "error" | "warning", message: string) => void,
  facts: FragmentFacts
): void {
  if (value.kind === "variable") {
    if (!facts.varUses.has(value.name)) facts.varUses.set(value.name, value.line);
    return;
  }
  if (value.kind === "null") return;
  if (type.kind === "nonnull") {
    checkValue(schema, type.of, value, where, push, facts);
    return;
  }
  if (type.kind === "list") {
    const items = value.kind === "list" ? value.items : [value];
    for (const item of items) checkValue(schema, type.of, item, where, push, facts);
    return;
  }
  const def = lookupType(schema, type.name);
  if (!def) return;

  if (def.kind === "enum") {
    if (value.kind === "string") {
      push(
        value.line,
        "L413",
        "error",
        `${where}: enum "${def.name}" values are not quoted — write ${value.value.toUpperCase()} instead of "${value.value}"`
      );
      return;
    }
    if (value.kind !== "enum") return;
    const enumValue = def.values.get(value.value);
    if (!enumValue) {
      const hint = suggest(value.value, [...def.values.keys()]);
      push(value.line, "L413", "error", `${where}: "${value.value}" is not a value of enum "${def.name}"${hint}`);
      return;
    }
    if (enumValue.deprecationReason !== null) {
      push(
        value.line,
        "L407",
        "warning",
        `${where}: enum value "${def.name}.${value.value}" is deprecated: ${enumValue.deprecationReason}`
      );
    }
    return;
  }

  if (def.kind === "input" && value.kind === "object") {
    const present = new Set<string>();
    for (const f of value.fields) {
      present.add(f.name);
      const fieldDef = def.fields.get(f.name);
      if (!fieldDef) {
        const hint = suggest(f.name, [...def.fields.keys()]);
        push(value.line, "L402", "error", `${where}: unknown input field "${f.name}" on input type "${def.name}"${hint}`);
        continue;
      }
      checkValue(schema, fieldDef.type, f.value, `input field "${def.name}.${f.name}"`, push, facts);
    }
    for (const fieldDef of def.fields.values()) {
      if (fieldDef.type.kind === "nonnull" && fieldDef.defaultValue === null && !present.has(fieldDef.name)) {
        push(
          value.line,
          "L403",
          "error",
          `${where}: missing required input field "${fieldDef.name}" on input type "${def.name}"`
        );
      }
    }
  }
}

/** Record every variable reference reachable inside an argument list. */
function collectVariables(args: Argument[], facts: FragmentFacts): void {
  const visit = (v: Value): void => {
    if (v.kind === "variable") {
      if (!facts.varUses.has(v.name)) facts.varUses.set(v.name, v.line);
    } else if (v.kind === "list") {
      for (const item of v.items) visit(item);
    } else if (v.kind === "object") {
      for (const f of v.fields) visit(f.value);
    }
  };
  for (const a of args) visit(a.value);
}

// ---------------------------------------------------------------------------
// Nearest-name suggestions
// ---------------------------------------------------------------------------

/** ` — did you mean "x"?` when a candidate is within edit distance 2. */
export function suggest(name: string, candidates: string[]): string {
  let best: string | null = null;
  let bestDist = 3; // only distances 1 and 2 are trustworthy suggestions
  for (const c of candidates) {
    if (c === name) continue;
    const d = editDistance(name.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best === null ? "" : ` — did you mean "${best}"?`;
}

/** Classic Levenshtein distance with a two-row rolling buffer. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3; // early out: cannot be <= 2
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const sub = (prev[j - 1] ?? 0) + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1);
      curr[j] = Math.min(sub, (prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 3;
}
