// Executable-document parser: operations, variables, fragments, aliases,
// and the rejections that keep recorded queries from being misread.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GraphQLSyntaxError, parseOperations, typeToString } from "../dist/index.js";
import { ops } from "./helpers.mjs";

test("a named query with variables and defaults parses fully", () => {
  const doc = ops(`query GetBook($id: ID!, $n: Int = 3) { book(id: $id) { title } }`);
  assert.equal(doc.operations.length, 1);
  const op = doc.operations[0];
  assert.equal(op.operation, "query");
  assert.equal(op.name, "GetBook");
  assert.equal(op.variables.length, 2);
  assert.equal(typeToString(op.variables[0].type), "ID!");
  assert.equal(op.variables[1].defaultValue.value, 3);
});

test("operation kinds: anonymous shorthand is a query; mutation/subscription kept", () => {
  const doc = ops(`{ books { title } }`);
  assert.equal(doc.operations[0].operation, "query");
  assert.equal(doc.operations[0].name, null);
  const kinds = ops(`mutation Add { addBook(input: {title: "t"}) { id } }\nsubscription Watch { books { id } }`);
  assert.deepEqual(kinds.operations.map((o) => o.operation), ["mutation", "subscription"]);
});

test("aliases are separated from field names; selections carry line numbers", () => {
  const doc = ops(`{\n  first: book(id: "1") {\n    t: title\n  }\n}`);
  const field = doc.operations[0].selections[0];
  assert.deepEqual({ alias: field.alias, name: field.name, line: field.line }, { alias: "first", name: "book", line: 2 });
  const child = field.selections[0];
  assert.deepEqual({ alias: child.alias, name: child.name, line: child.line }, { alias: "t", name: "title", line: 3 });
});

test("fragment definitions and spreads parse", () => {
  const doc = ops(`
    query Q { books { ...BookBits } }
    fragment BookBits on Book { id title }
  `);
  assert.ok(doc.fragments.get("BookBits"));
  assert.equal(doc.fragments.get("BookBits").typeCondition, "Book");
  const spread = doc.operations[0].selections[0].selections[0];
  assert.deepEqual({ kind: spread.kind, name: spread.name }, { kind: "spread", name: "BookBits" });
});

test("inline fragments parse with and without a type condition", () => {
  const doc = ops(`{ hits { ... on Book { title } ... @include(if: $x) { id } } }`);
  const [withCond, withoutCond] = doc.operations[0].selections[0].selections;
  assert.equal(withCond.typeCondition, "Book");
  assert.equal(withoutCond.typeCondition, null);
});

test("argument values parse: lists, objects, enums, variables, null", () => {
  const doc = ops(`{ find(where: {genres: [FICTION, $g], titleLike: null, nested: {deep: 1.5}}) { id } }`);
  const where = doc.operations[0].selections[0].args[0].value;
  assert.equal(where.kind, "object");
  const genres = where.fields[0].value;
  assert.deepEqual(genres.items.map((v) => v.kind), ["enum", "variable"]);
});

test("directives on operations, fields and spreads are consumed", () => {
  const doc = ops(`query Q @live { books @skip(if: false) { title ...B @include(if: true) } }
    fragment B on Book { id }`);
  assert.equal(doc.operations.length, 1); // parsing succeeded, directives ignored
});

test("rejections: duplicate fragments, empty selection sets, variables in const position", () => {
  assert.throws(
    () => parseOperations("fragment F on Book { id }\nfragment F on Book { id }", "x.graphql"),
    /duplicate fragment/
  );
  assert.throws(() => parseOperations("{ books { } }", "x.graphql"), GraphQLSyntaxError);
  assert.throws(
    () => parseOperations("query Q($a: Int = $b) { books { id } }", "x.graphql"),
    /variables are not allowed in constant values/
  );
});
