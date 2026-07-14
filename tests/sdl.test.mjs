// SDL parser: the schema model round-trip and the loud rejections that
// keep gqlsift from analyzing a schema it misread.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GraphQLSyntaxError, parseSchema, typeToString } from "../dist/index.js";
import { LIB_SDL, schema } from "./helpers.mjs";

test("every type kind parses into the model; union pipes allow a leading |", () => {
  const s = schema(LIB_SDL + "\nscalar DateTime\nunion U = | Book | Author");
  assert.equal(s.types.get("Book").kind, "object");
  assert.equal(s.types.get("Node").kind, "interface");
  assert.equal(s.types.get("Hit").kind, "union");
  assert.equal(s.types.get("Genre").kind, "enum");
  assert.equal(s.types.get("BookFilter").kind, "input");
  assert.equal(s.types.get("DateTime").kind, "scalar");
  assert.deepEqual(s.types.get("U").members, ["Book", "Author"]);
});

test("field types, argument defaults and input fields keep their full shape", () => {
  const s = schema(LIB_SDL + '\ninput F { limit: Int! = 10 old: String @deprecated(reason: "gone") }');
  const reviews = s.types.get("Book").fields.get("reviews");
  assert.equal(typeToString(reviews.type), "[Review!]!");
  const first = reviews.args.get("first");
  assert.deepEqual({ kind: first.defaultValue.kind, value: first.defaultValue.value }, { kind: "int", value: 5 });
  const f = s.types.get("F");
  assert.equal(typeToString(f.fields.get("limit").type), "Int!");
  assert.equal(f.fields.get("limit").defaultValue.value, 10);
  assert.equal(f.fields.get("old").deprecationReason, "gone");
});

test("@deprecated captures the reason, defaulting per the spec", () => {
  const s = schema(`
    type Query {
      a: String @deprecated(reason: "use b")
      b: String @deprecated
      c: String
    }
  `);
  const q = s.types.get("Query");
  assert.equal(q.fields.get("a").deprecationReason, "use b");
  assert.equal(q.fields.get("b").deprecationReason, "No longer supported");
  assert.equal(q.fields.get("c").deprecationReason, null);
});

test("implements lists parse with & separators and a leading &", () => {
  const s = schema(`
    interface A { id: ID! }
    interface B { id: ID! }
    type T implements & A & B { id: ID! }
    type Query { t: T }
  `);
  assert.deepEqual(s.types.get("T").interfaces, ["A", "B"]);
});

test("root types: an explicit schema definition overrides the conventions", () => {
  const explicit = schema(`
    schema { query: Root }
    type Root { ok: Boolean! }
    type Query { decoy: Boolean! }
  `);
  assert.equal(explicit.queryType, "Root");
  assert.equal(explicit.mutationType, null);
  const conventional = schema(LIB_SDL);
  assert.equal(conventional.queryType, "Query");
  assert.equal(conventional.mutationType, "Mutation");
  assert.equal(conventional.subscriptionType, null);
});

test("descriptions (inline and block) are accepted on every position", () => {
  const s = schema(`
    "A root."
    type Query {
      """Finds a thing.

      Multi-line.
      """
      thing("Which one." id: ID!): String
    }
    "An enum."
    enum E { "A value." V }
  `);
  assert.ok(s.types.get("Query").fields.get("thing").args.get("id"));
  assert.ok(s.types.get("E").values.get("V"));
});

test("directive definitions are consumed without polluting the model", () => {
  const s = schema(`
    directive @auth(role: String = "user") repeatable on FIELD_DEFINITION | OBJECT
    type Query { ok: Boolean! @auth(role: "admin") }
  `);
  assert.deepEqual([...s.types.keys()], ["Query"]);
});

test("type extensions are rejected loudly, not half-applied", () => {
  assert.throws(
    () => parseSchema("type Query { a: Int }\nextend type Query { b: Int }"),
    (e) => e instanceof GraphQLSyntaxError && /extensions are not supported/.test(e.message)
  );
});

test("duplicate names and illegal enum values are rejected", () => {
  assert.throws(() => parseSchema("type T { a: Int }\ntype T { b: Int }"), /duplicate type/);
  assert.throws(() => parseSchema("type T { a: Int a: Int }"), /duplicate field/);
  assert.throws(() => parseSchema("enum E { V V }"), /duplicate enum value/);
  assert.throws(() => parseSchema("enum E { true }"), /not a legal enum value/);
});
