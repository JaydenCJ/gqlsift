/**
 * Schema diff engine: compares two parsed schemas and classifies every
 * difference as breaking (B1xx), dangerous (D2xx) or safe (S3xx) with a
 * stable rule code. The catalog is documented in docs/change-catalog.md;
 * codes are API and are never renumbered or reused.
 *
 * Deliberate scope choices:
 * - Fields of a removed type are not re-reported individually — B101 on
 *   the type is the root cause, everything below it is cascade noise.
 * - Description changes are ignored entirely; they cannot break a client.
 */

import {
  isChangeSafeForInput,
  isChangeSafeForOutput,
  typeRefEquals,
  typeToString,
  valueToString,
  type ArgDef,
  type Change,
  type FieldDef,
  type InputFieldDef,
  type Schema,
  type Severity,
  type TypeDef,
  type Value,
} from "./types.js";

const SEVERITY_RANK: Record<Severity, number> = { breaking: 0, dangerous: 1, safe: 2 };

/** Compare two schemas, returning changes sorted by severity, then path. */
export function diffSchemas(oldSchema: Schema, newSchema: Schema): Change[] {
  const changes: Change[] = [];
  const push = (c: Change): void => {
    changes.push(c);
  };

  const names = new Set<string>([...oldSchema.types.keys(), ...newSchema.types.keys()]);
  for (const name of names) {
    const oldT = oldSchema.types.get(name);
    const newT = newSchema.types.get(name);
    if (oldT && !newT) {
      push({
        code: "B101",
        kind: "TYPE_REMOVED",
        severity: "breaking",
        path: name,
        message: `${oldT.kind} type "${name}" was removed`,
        ref: { kind: "type", name },
      });
      continue;
    }
    if (!oldT && newT) {
      push({
        code: "S301",
        kind: "TYPE_ADDED",
        severity: "safe",
        path: name,
        message: `${newT.kind} type "${name}" was added`,
        ref: { kind: "type", name },
      });
      continue;
    }
    if (!oldT || !newT) continue;
    if (oldT.kind !== newT.kind) {
      push({
        code: "B102",
        kind: "TYPE_KIND_CHANGED",
        severity: "breaking",
        path: name,
        message: `type "${name}" changed kind from ${oldT.kind} to ${newT.kind}`,
        ref: { kind: "type", name },
      });
      continue; // The kinds differ; member-level diffing would be nonsense.
    }
    diffSameKind(oldT, newT, push);
  }

  changes.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
  return changes;
}

function diffSameKind(oldT: TypeDef, newT: TypeDef, push: (c: Change) => void): void {
  switch (oldT.kind) {
    case "object":
    case "interface":
      if (newT.kind === oldT.kind) {
        diffInterfaces(oldT.name, oldT.interfaces, newT.interfaces, push);
        diffFields(oldT.name, oldT.fields, newT.fields, push);
      }
      break;
    case "union":
      if (newT.kind === "union") diffUnion(oldT.name, oldT.members, newT.members, push);
      break;
    case "enum":
      if (newT.kind === "enum") diffEnum(oldT, newT, push);
      break;
    case "input":
      if (newT.kind === "input") diffInputFields(oldT.name, oldT.fields, newT.fields, push);
      break;
    case "scalar":
      break; // Same-name scalars have nothing diffable.
  }
}

function diffInterfaces(
  type: string,
  oldIfaces: string[],
  newIfaces: string[],
  push: (c: Change) => void
): void {
  for (const iface of oldIfaces) {
    if (!newIfaces.includes(iface)) {
      push({
        code: "B110",
        kind: "INTERFACE_IMPL_REMOVED",
        severity: "breaking",
        path: `${type}.${iface}`,
        message: `type "${type}" no longer implements interface "${iface}"`,
        ref: { kind: "interfaceImpl", iface, object: type },
      });
    }
  }
  for (const iface of newIfaces) {
    if (!oldIfaces.includes(iface)) {
      push({
        code: "S306",
        kind: "INTERFACE_IMPL_ADDED",
        severity: "safe",
        path: `${type}.${iface}`,
        message: `type "${type}" now implements interface "${iface}"`,
        ref: { kind: "interfaceImpl", iface, object: type },
      });
    }
  }
}

function diffFields(
  type: string,
  oldFields: Map<string, FieldDef>,
  newFields: Map<string, FieldDef>,
  push: (c: Change) => void
): void {
  for (const [name, oldF] of oldFields) {
    const newF = newFields.get(name);
    const path = `${type}.${name}`;
    if (!newF) {
      push({
        code: "B103",
        kind: "FIELD_REMOVED",
        severity: "breaking",
        path,
        message: `field "${name}" was removed from type "${type}"`,
        ref: { kind: "field", type, field: name },
      });
      continue;
    }
    if (!typeRefEquals(oldF.type, newF.type)) {
      const safe = isChangeSafeForOutput(oldF.type, newF.type);
      push({
        code: safe ? "S305" : "B104",
        kind: safe ? "FIELD_TYPE_CHANGED_SAFE" : "FIELD_TYPE_CHANGED",
        severity: safe ? "safe" : "breaking",
        path,
        message: `field "${path}" changed type from "${typeToString(oldF.type)}" to "${typeToString(newF.type)}"${safe ? " (compatible for all existing clients)" : ""}`,
        ref: { kind: "field", type, field: name },
      });
    }
    diffDeprecation(path, "field", oldF.deprecationReason, newF.deprecationReason, {
      kind: "field",
      type,
      field: name,
    }, push);
    diffArgs(type, name, oldF.args, newF.args, push);
  }
  for (const name of newFields.keys()) {
    if (!oldFields.has(name)) {
      push({
        code: "S302",
        kind: "FIELD_ADDED",
        severity: "safe",
        path: `${type}.${name}`,
        message: `field "${name}" was added to type "${type}"`,
        ref: { kind: "field", type, field: name },
      });
    }
  }
}

function diffArgs(
  type: string,
  field: string,
  oldArgs: Map<string, ArgDef>,
  newArgs: Map<string, ArgDef>,
  push: (c: Change) => void
): void {
  for (const [name, oldA] of oldArgs) {
    const newA = newArgs.get(name);
    const path = `${type}.${field}(${name}:)`;
    const ref = { kind: "arg", type, field, arg: name } as const;
    if (!newA) {
      push({
        code: "B106",
        kind: "ARG_REMOVED",
        severity: "breaking",
        path,
        message: `argument "${name}" was removed from field "${type}.${field}"`,
        ref,
      });
      continue;
    }
    if (!typeRefEquals(oldA.type, newA.type)) {
      const safe = isChangeSafeForInput(oldA.type, newA.type);
      push({
        code: safe ? "S305" : "B107",
        kind: safe ? "ARG_TYPE_CHANGED_SAFE" : "ARG_TYPE_CHANGED",
        severity: safe ? "safe" : "breaking",
        path,
        message: `argument "${path}" changed type from "${typeToString(oldA.type)}" to "${typeToString(newA.type)}"${safe ? " (compatible for all existing clients)" : ""}`,
        ref,
      });
    }
    diffDefault(path, "argument", oldA.defaultValue, newA.defaultValue, "D203", ref, push);
    diffDeprecation(path, "argument", oldA.deprecationReason, newA.deprecationReason, ref, push);
  }
  for (const [name, newA] of newArgs) {
    if (oldArgs.has(name)) continue;
    const required = newA.type.kind === "nonnull" && newA.defaultValue === null;
    push({
      code: required ? "B105" : "S303",
      kind: required ? "REQUIRED_ARG_ADDED" : "OPTIONAL_ARG_ADDED",
      severity: required ? "breaking" : "safe",
      path: `${type}.${field}(${name}:)`,
      message: `${required ? "required" : "optional"} argument "${name}: ${typeToString(newA.type)}" was added to field "${type}.${field}"`,
      ref: required
        ? { kind: "field", type, field } // every recorded use of the field breaks
        : { kind: "arg", type, field, arg: name },
    });
  }
}

function diffUnion(
  union: string,
  oldMembers: string[],
  newMembers: string[],
  push: (c: Change) => void
): void {
  for (const m of oldMembers) {
    if (!newMembers.includes(m)) {
      push({
        code: "B109",
        kind: "UNION_MEMBER_REMOVED",
        severity: "breaking",
        path: `${union}.${m}`,
        message: `member "${m}" was removed from union "${union}"`,
        ref: { kind: "unionMember", union, member: m },
      });
    }
  }
  for (const m of newMembers) {
    if (!oldMembers.includes(m)) {
      push({
        code: "D202",
        kind: "UNION_MEMBER_ADDED",
        severity: "dangerous",
        path: `${union}.${m}`,
        message: `member "${m}" was added to union "${union}" — clients matching exhaustively on __typename may break`,
        ref: { kind: "unionMember", union, member: m },
      });
    }
  }
}

function diffEnum(
  oldT: Extract<TypeDef, { kind: "enum" }>,
  newT: Extract<TypeDef, { kind: "enum" }>,
  push: (c: Change) => void
): void {
  for (const [v, oldV] of oldT.values) {
    const newV = newT.values.get(v);
    const path = `${oldT.name}.${v}`;
    const ref = { kind: "enumValue", enum: oldT.name, value: v } as const;
    if (!newV) {
      push({
        code: "B108",
        kind: "ENUM_VALUE_REMOVED",
        severity: "breaking",
        path,
        message: `enum value "${v}" was removed from enum "${oldT.name}"`,
        ref,
      });
      continue;
    }
    diffDeprecation(path, "enum value", oldV.deprecationReason, newV.deprecationReason, ref, push);
  }
  for (const v of newT.values.keys()) {
    if (!oldT.values.has(v)) {
      push({
        code: "D201",
        kind: "ENUM_VALUE_ADDED",
        severity: "dangerous",
        path: `${oldT.name}.${v}`,
        message: `enum value "${v}" was added to enum "${oldT.name}" — clients matching exhaustively may break`,
        ref: { kind: "enumValue", enum: oldT.name, value: v },
      });
    }
  }
}

function diffInputFields(
  input: string,
  oldFields: Map<string, InputFieldDef>,
  newFields: Map<string, InputFieldDef>,
  push: (c: Change) => void
): void {
  for (const [name, oldF] of oldFields) {
    const newF = newFields.get(name);
    const path = `${input}.${name}`;
    const ref = { kind: "inputField", input, field: name } as const;
    if (!newF) {
      push({
        code: "B111",
        kind: "INPUT_FIELD_REMOVED",
        severity: "breaking",
        path,
        message: `input field "${name}" was removed from input type "${input}"`,
        ref,
      });
      continue;
    }
    if (!typeRefEquals(oldF.type, newF.type)) {
      const safe = isChangeSafeForInput(oldF.type, newF.type);
      push({
        code: safe ? "S305" : "B113",
        kind: safe ? "INPUT_FIELD_TYPE_CHANGED_SAFE" : "INPUT_FIELD_TYPE_CHANGED",
        severity: safe ? "safe" : "breaking",
        path,
        message: `input field "${path}" changed type from "${typeToString(oldF.type)}" to "${typeToString(newF.type)}"${safe ? " (compatible for all existing clients)" : ""}`,
        ref,
      });
    }
    diffDefault(path, "input field", oldF.defaultValue, newF.defaultValue, "D204", ref, push);
    diffDeprecation(path, "input field", oldF.deprecationReason, newF.deprecationReason, ref, push);
  }
  for (const [name, newF] of newFields) {
    if (oldFields.has(name)) continue;
    const required = newF.type.kind === "nonnull" && newF.defaultValue === null;
    push({
      code: required ? "B112" : "S307",
      kind: required ? "REQUIRED_INPUT_FIELD_ADDED" : "OPTIONAL_INPUT_FIELD_ADDED",
      severity: required ? "breaking" : "safe",
      path: `${input}.${name}`,
      message: `${required ? "required" : "optional"} input field "${name}: ${typeToString(newF.type)}" was added to input type "${input}"`,
      ref: { kind: "inputField", input, field: name },
    });
  }
}

/** D203/D204: default values steer server behavior for clients that omit
 * the argument, so any edit to them is dangerous, not safe. */
function diffDefault(
  path: string,
  what: string,
  oldD: Value | null,
  newD: Value | null,
  code: "D203" | "D204",
  ref: Change["ref"],
  push: (c: Change) => void
): void {
  const oldS = oldD === null ? null : valueToString(oldD);
  const newS = newD === null ? null : valueToString(newD);
  if (oldS === newS) return;
  let message: string;
  if (oldS === null) message = `${what} "${path}" gained a default value of ${newS}`;
  else if (newS === null) message = `${what} "${path}" lost its default value (was ${oldS})`;
  else message = `default value of ${what} "${path}" changed from ${oldS} to ${newS}`;
  push({
    code,
    kind: code === "D203" ? "ARG_DEFAULT_CHANGED" : "INPUT_FIELD_DEFAULT_CHANGED",
    severity: "dangerous",
    path,
    message,
    ref,
  });
}

/** S304: any deprecation transition (added, removed or reworded). */
function diffDeprecation(
  path: string,
  what: string,
  oldR: string | null,
  newR: string | null,
  ref: Change["ref"],
  push: (c: Change) => void
): void {
  if (oldR === newR) return;
  let message: string;
  if (oldR === null) message = `${what} "${path}" was deprecated ("${newR}")`;
  else if (newR === null) message = `${what} "${path}" is no longer deprecated`;
  else message = `deprecation reason of ${what} "${path}" changed to "${newR}"`;
  push({ code: "S304", kind: "DEPRECATION_CHANGED", severity: "safe", path, message, ref });
}
