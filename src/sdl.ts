/**
 * SDL (schema definition language) parser: turns a `.graphql` schema
 * document into the `Schema` model. Supports object/interface/union/enum/
 * input/scalar definitions, descriptions, `implements`, argument defaults,
 * `@deprecated`, and explicit `schema { query: ... }` root declarations.
 * Directive definitions are parsed and discarded; `extend` is rejected
 * loudly rather than half-supported.
 */

import {
  Cursor,
  parseArguments,
  parseDirectives,
  parseTypeRef,
  parseValue,
  deprecationReason,
} from "./parser.js";
import type {
  ArgDef,
  EnumValueDef,
  FieldDef,
  InputFieldDef,
  Schema,
  TypeDef,
} from "./types.js";

/** Parse an SDL document into a schema model. Throws GraphQLSyntaxError. */
export function parseSchema(src: string): Schema {
  const cur = new Cursor(src);
  const types = new Map<string, TypeDef>();
  let queryType: string | null = null;
  let mutationType: string | null = null;
  let subscriptionType: string | null = null;
  let sawSchemaDef = false;

  const define = (def: TypeDef): void => {
    if (types.has(def.name)) cur.fail(`duplicate type definition "${def.name}"`);
    types.set(def.name, def);
  };

  while (!cur.atEnd()) {
    cur.eatDescription();
    const kw = cur.expectName("a type-system keyword").value;
    switch (kw) {
      case "schema": {
        if (sawSchemaDef) cur.fail("duplicate schema definition");
        sawSchemaDef = true;
        parseDirectives(cur, true);
        cur.expectPunct("{");
        while (!cur.eatPunct("}")) {
          if (cur.atEnd()) cur.fail("unterminated schema definition");
          const op = cur.expectName("query, mutation or subscription").value;
          cur.expectPunct(":");
          const name = cur.expectName("a type name").value;
          if (op === "query") queryType = name;
          else if (op === "mutation") mutationType = name;
          else if (op === "subscription") subscriptionType = name;
          else cur.fail(`unknown root operation "${op}"`);
        }
        break;
      }
      case "scalar": {
        const name = cur.expectName("a scalar name").value;
        parseDirectives(cur, true);
        define({ kind: "scalar", name });
        break;
      }
      case "type":
      case "interface": {
        const name = cur.expectName("a type name").value;
        const interfaces: string[] = [];
        if (cur.eatName("implements")) {
          cur.eatPunct("&");
          interfaces.push(cur.expectName("an interface name").value);
          while (cur.eatPunct("&")) {
            interfaces.push(cur.expectName("an interface name").value);
          }
        }
        parseDirectives(cur, true);
        const fields = cur.isPunct("{") ? parseFieldDefs(cur) : new Map<string, FieldDef>();
        define({ kind: kw === "type" ? "object" : "interface", name, interfaces, fields });
        break;
      }
      case "union": {
        const name = cur.expectName("a union name").value;
        parseDirectives(cur, true);
        const members: string[] = [];
        if (cur.eatPunct("=")) {
          cur.eatPunct("|");
          members.push(cur.expectName("a union member").value);
          while (cur.eatPunct("|")) {
            members.push(cur.expectName("a union member").value);
          }
        }
        define({ kind: "union", name, members });
        break;
      }
      case "enum": {
        const name = cur.expectName("an enum name").value;
        parseDirectives(cur, true);
        const values = new Map<string, EnumValueDef>();
        cur.expectPunct("{");
        while (!cur.eatPunct("}")) {
          if (cur.atEnd()) cur.fail("unterminated enum definition");
          cur.eatDescription();
          const v = cur.expectName("an enum value").value;
          if (v === "true" || v === "false" || v === "null") {
            cur.fail(`"${v}" is not a legal enum value name`);
          }
          const dirs = parseDirectives(cur, true);
          if (values.has(v)) cur.fail(`duplicate enum value "${name}.${v}"`);
          values.set(v, { name: v, deprecationReason: deprecationReason(dirs) });
        }
        define({ kind: "enum", name, values });
        break;
      }
      case "input": {
        const name = cur.expectName("an input type name").value;
        parseDirectives(cur, true);
        const fields = new Map<string, InputFieldDef>();
        cur.expectPunct("{");
        while (!cur.eatPunct("}")) {
          if (cur.atEnd()) cur.fail("unterminated input definition");
          cur.eatDescription();
          const fname = cur.expectName("an input field name").value;
          cur.expectPunct(":");
          const type = parseTypeRef(cur);
          const defaultValue = cur.eatPunct("=") ? parseValue(cur, true) : null;
          const dirs = parseDirectives(cur, true);
          if (fields.has(fname)) cur.fail(`duplicate input field "${name}.${fname}"`);
          fields.set(fname, {
            name: fname,
            type,
            defaultValue,
            deprecationReason: deprecationReason(dirs),
          });
        }
        define({ kind: "input", name, fields });
        break;
      }
      case "directive": {
        // Parsed for round-trip tolerance, not modeled: gqlsift diffs the
        // type surface clients query, not directive definitions.
        cur.expectPunct("@");
        cur.expectName("a directive name");
        parseArgDefs(cur);
        cur.eatName("repeatable");
        if (!cur.eatName("on")) cur.fail(`expected "on" in directive definition`);
        cur.eatPunct("|");
        cur.expectName("a directive location");
        while (cur.eatPunct("|")) cur.expectName("a directive location");
        break;
      }
      case "extend":
        cur.fail("type extensions are not supported in gqlsift 0.1.0 — merge them into the base definition first");
        break;
      default:
        cur.fail(`unknown type-system keyword "${kw}"`);
    }
  }

  // Root types: explicit schema definition wins; otherwise the
  // conventionally named types, when they exist.
  if (!sawSchemaDef) {
    if (types.has("Query")) queryType = "Query";
    if (types.has("Mutation")) mutationType = "Mutation";
    if (types.has("Subscription")) subscriptionType = "Subscription";
  }

  return { types, queryType, mutationType, subscriptionType };
}

/** Parse a `{ field(args): Type @dirs ... }` block. */
function parseFieldDefs(cur: Cursor): Map<string, FieldDef> {
  const fields = new Map<string, FieldDef>();
  cur.expectPunct("{");
  while (!cur.eatPunct("}")) {
    if (cur.atEnd()) cur.fail("unterminated fields block");
    cur.eatDescription();
    const name = cur.expectName("a field name").value;
    const args = parseArgDefs(cur);
    cur.expectPunct(":");
    const type = parseTypeRef(cur);
    const dirs = parseDirectives(cur, true);
    if (fields.has(name)) cur.fail(`duplicate field "${name}"`);
    fields.set(name, { name, type, args, deprecationReason: deprecationReason(dirs) });
  }
  return fields;
}

/** Parse an optional `(name: Type = default @dirs, ...)` block. */
function parseArgDefs(cur: Cursor): Map<string, ArgDef> {
  const args = new Map<string, ArgDef>();
  if (!cur.eatPunct("(")) return args;
  while (!cur.eatPunct(")")) {
    if (cur.atEnd()) cur.fail("unterminated argument definition list");
    cur.eatDescription();
    const name = cur.expectName("an argument name").value;
    cur.expectPunct(":");
    const type = parseTypeRef(cur);
    const defaultValue = cur.eatPunct("=") ? parseValue(cur, true) : null;
    const dirs = parseDirectives(cur, true);
    if (args.has(name)) cur.fail(`duplicate argument "${name}"`);
    args.set(name, { name, type, defaultValue, deprecationReason: deprecationReason(dirs) });
  }
  return args;
}
