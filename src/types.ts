/**
 * Shared model types for gqlsift: the schema model produced by the SDL
 * parser, the executable-document model produced by the operation parser,
 * diff changes, diagnostics, and the small type-reference algebra that
 * every analysis pass leans on.
 */

import type { DirectiveUse } from "./parser.js";

// ---------------------------------------------------------------------------
// Type references
// ---------------------------------------------------------------------------

/** A GraphQL type reference: `User`, `[User!]`, `ID!`, ... */
export type TypeRef =
  | { kind: "named"; name: string }
  | { kind: "list"; of: TypeRef }
  | { kind: "nonnull"; of: TypeRef };

/** The five scalars every GraphQL schema has without declaring them. */
export const BUILTIN_SCALARS: ReadonlySet<string> = new Set([
  "Int",
  "Float",
  "String",
  "Boolean",
  "ID",
]);

/** Render a type reference back to SDL syntax (`[User!]!`). */
export function typeToString(t: TypeRef): string {
  switch (t.kind) {
    case "named":
      return t.name;
    case "list":
      return `[${typeToString(t.of)}]`;
    case "nonnull":
      return `${typeToString(t.of)}!`;
  }
}

/** The named type at the core of a reference (`[User!]!` -> `User`). */
export function baseTypeName(t: TypeRef): string {
  return t.kind === "named" ? t.name : baseTypeName(t.of);
}

/** Structural equality of two type references. */
export function typeRefEquals(a: TypeRef, b: TypeRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "named" && b.kind === "named") return a.name === b.name;
  if (a.kind !== "named" && b.kind !== "named") return typeRefEquals(a.of, b.of);
  return false;
}

/**
 * Whether changing an OUTPUT position (field return type) from `oldT` to
 * `newT` keeps every existing client working. The only safe moves are
 * keeping the shape identical or tightening nullability (`String` ->
 * `String!`): clients prepared for null cope with never seeing one.
 */
export function isChangeSafeForOutput(oldT: TypeRef, newT: TypeRef): boolean {
  if (oldT.kind === "nonnull") {
    return newT.kind === "nonnull" && isChangeSafeForOutput(oldT.of, newT.of);
  }
  if (newT.kind === "nonnull") {
    // Tightening a nullable output to non-null is safe.
    return isChangeSafeForOutput(oldT, newT.of);
  }
  if (oldT.kind === "list") {
    return newT.kind === "list" && isChangeSafeForOutput(oldT.of, newT.of);
  }
  return newT.kind === "named" && oldT.name === newT.name;
}

/**
 * Whether changing an INPUT position (argument or input-object field) from
 * `oldT` to `newT` keeps every existing client working. The mirror image
 * of the output rule: loosening nullability (`String!` -> `String`) is
 * safe, requiring more is not.
 */
export function isChangeSafeForInput(oldT: TypeRef, newT: TypeRef): boolean {
  if (newT.kind === "nonnull") {
    return oldT.kind === "nonnull" && isChangeSafeForInput(oldT.of, newT.of);
  }
  if (oldT.kind === "nonnull") {
    // Loosening a required input to optional is safe.
    return isChangeSafeForInput(oldT.of, newT);
  }
  if (oldT.kind === "list") {
    return newT.kind === "list" && isChangeSafeForInput(oldT.of, newT.of);
  }
  return newT.kind === "named" && oldT.name === newT.name;
}

// ---------------------------------------------------------------------------
// Values (literals in SDL defaults and operation arguments)
// ---------------------------------------------------------------------------

export type Value =
  | { kind: "int"; value: number; line: number }
  | { kind: "float"; value: number; line: number }
  | { kind: "string"; value: string; line: number }
  | { kind: "boolean"; value: boolean; line: number }
  | { kind: "null"; line: number }
  | { kind: "enum"; value: string; line: number }
  | { kind: "variable"; name: string; line: number }
  | { kind: "list"; items: Value[]; line: number }
  | { kind: "object"; fields: { name: string; value: Value }[]; line: number };

/** Render a value back to GraphQL literal syntax (used in diff messages). */
export function valueToString(v: Value): string {
  switch (v.kind) {
    case "int":
    case "float":
      return String(v.value);
    case "string":
      return JSON.stringify(v.value);
    case "boolean":
      return v.value ? "true" : "false";
    case "null":
      return "null";
    case "enum":
      return v.value;
    case "variable":
      return `$${v.name}`;
    case "list":
      return `[${v.items.map(valueToString).join(", ")}]`;
    case "object":
      return `{${v.fields.map((f) => `${f.name}: ${valueToString(f.value)}`).join(", ")}}`;
  }
}

// ---------------------------------------------------------------------------
// Schema model
// ---------------------------------------------------------------------------

export interface ArgDef {
  name: string;
  type: TypeRef;
  defaultValue: Value | null;
  deprecationReason: string | null;
}

export interface FieldDef {
  name: string;
  type: TypeRef;
  args: Map<string, ArgDef>;
  deprecationReason: string | null;
}

export interface InputFieldDef {
  name: string;
  type: TypeRef;
  defaultValue: Value | null;
  deprecationReason: string | null;
}

export interface EnumValueDef {
  name: string;
  deprecationReason: string | null;
}

export type TypeDef =
  | { kind: "scalar"; name: string }
  | { kind: "object"; name: string; interfaces: string[]; fields: Map<string, FieldDef> }
  | { kind: "interface"; name: string; interfaces: string[]; fields: Map<string, FieldDef> }
  | { kind: "union"; name: string; members: string[] }
  | { kind: "enum"; name: string; values: Map<string, EnumValueDef> }
  | { kind: "input"; name: string; fields: Map<string, InputFieldDef> };

export interface Schema {
  types: Map<string, TypeDef>;
  queryType: string | null;
  mutationType: string | null;
  subscriptionType: string | null;
}

/** Look up a type, falling back to the implicit built-in scalars. */
export function lookupType(schema: Schema, name: string): TypeDef | null {
  const def = schema.types.get(name);
  if (def) return def;
  if (BUILTIN_SCALARS.has(name)) return { kind: "scalar", name };
  return null;
}

/** True for types that carry a selection set (object/interface/union). */
export function isCompositeType(def: TypeDef): boolean {
  return def.kind === "object" || def.kind === "interface" || def.kind === "union";
}

/** True for types legal in input positions (scalar/enum/input). */
export function isInputType(def: TypeDef): boolean {
  return def.kind === "scalar" || def.kind === "enum" || def.kind === "input";
}

// ---------------------------------------------------------------------------
// Executable-document model
// ---------------------------------------------------------------------------

export interface Argument {
  name: string;
  value: Value;
  line: number;
}

export type Selection =
  | {
      kind: "field";
      alias: string | null;
      name: string;
      args: Argument[];
      directives: DirectiveUse[];
      selections: Selection[] | null;
      line: number;
    }
  | { kind: "spread"; name: string; directives: DirectiveUse[]; line: number }
  | {
      kind: "inline";
      typeCondition: string | null;
      directives: DirectiveUse[];
      selections: Selection[];
      line: number;
    };

export interface VariableDef {
  name: string;
  type: TypeRef;
  defaultValue: Value | null;
  line: number;
}

export type OperationKind = "query" | "mutation" | "subscription";

export interface OperationDef {
  operation: OperationKind;
  name: string | null;
  variables: VariableDef[];
  directives: DirectiveUse[];
  selections: Selection[];
  line: number;
}

export interface FragmentDef {
  name: string;
  typeCondition: string;
  directives: DirectiveUse[];
  selections: Selection[];
  line: number;
}

export interface Document {
  file: string;
  operations: OperationDef[];
  fragments: Map<string, FragmentDef>;
}

// ---------------------------------------------------------------------------
// Diff changes
// ---------------------------------------------------------------------------

export type Severity = "breaking" | "dangerous" | "safe";

/** Structured pointer at what a change touches, used for impact matching. */
export type ChangeRef =
  | { kind: "type"; name: string }
  | { kind: "field"; type: string; field: string }
  | { kind: "arg"; type: string; field: string; arg: string }
  | { kind: "enumValue"; enum: string; value: string }
  | { kind: "unionMember"; union: string; member: string }
  | { kind: "interfaceImpl"; iface: string; object: string }
  | { kind: "inputField"; input: string; field: string };

export interface Change {
  /** Stable code, e.g. `B103`. Codes are API: never renumbered. */
  code: string;
  /** Machine-readable kind, e.g. `FIELD_REMOVED`. */
  kind: string;
  severity: Severity;
  /** Dotted path, e.g. `User.email` or `Role.GUEST`. */
  path: string;
  message: string;
  ref: ChangeRef;
}

// ---------------------------------------------------------------------------
// Impact assessment
// ---------------------------------------------------------------------------

export interface OpRef {
  file: string;
  name: string | null;
  operation: OperationKind;
}

/**
 * `breaks`: the recorded operation provably stops working.
 * `may-break`: the operation's runtime values decide (e.g. it feeds an
 * input object through a variable, so we cannot see the concrete fields).
 */
export type ImpactLevel = "breaks" | "may-break";

export interface ImpactHit {
  op: OpRef;
  level: ImpactLevel;
}

export interface AssessedChange {
  change: Change;
  /** Empty when no recorded operation touches what the change touches. */
  hits: ImpactHit[];
}

// ---------------------------------------------------------------------------
// Lint diagnostics
// ---------------------------------------------------------------------------

export interface Diagnostic {
  file: string;
  line: number;
  code: string;
  severity: "error" | "warning";
  message: string;
}
