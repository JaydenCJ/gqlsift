// Operation linter: every rule code, the suggestion engine, and the
// one-report-per-fragment guarantee.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lintDocuments, suggest } from "../dist/index.js";
import { LIB_SDL, ops, schema } from "./helpers.mjs";

const LIB = schema(LIB_SDL);

function lint(...sources) {
  const docs = sources.map((src, i) => ops(src, `f${i}.graphql`));
  return lintDocuments(LIB, docs);
}

function codes(diags) {
  return diags.map((d) => d.code);
}

test("a valid operation produces zero diagnostics", () => {
  const diags = lint(`query Q($id: ID!) { book(id: $id) { id title author { name } } }`);
  assert.deepEqual(diags, []);
});

test("L401: unknown field with a nearest-name suggestion; unions name the fix", () => {
  const diags = lint(`query Q($id: ID!) { book(id: $id) { titel } }`);
  assert.deepEqual(codes(diags), ["L401"]);
  assert.match(diags[0].message, /unknown field "titel" on type "Book" — did you mean "title"\?/);
  const withHits = schema(LIB_SDL.replace("find(where: BookFilter!): [Book!]!", "hits: [Hit!]!"));
  const unionDiags = lintDocuments(withHits, [ops(`query Q { hits { title } }`)]);
  assert.deepEqual(codes(unionDiags), ["L401"]);
  assert.match(unionDiags[0].message, /union "Hit" has no fields.*inline fragment/);
});

test("L402: unknown argument and unknown input-object field, with suggestions", () => {
  const diags = lint(
    `query Q { books(frist: 3) { id } }`,
    `query R { find(where: {titleLik: "x"}) { id } }`
  );
  assert.deepEqual(codes(diags), ["L402", "L402"]);
  assert.match(diags[0].message, /unknown argument "frist".*did you mean "first"\?/);
  assert.match(diags[1].message, /unknown input field "titleLik" on input type "BookFilter" — did you mean "titleLike"\?/);
});

test("L403: missing required argument and missing required input field", () => {
  const diags = lint(`query Q { book { id } }`, `mutation M { addBook(input: {genre: FICTION}) { id } }`);
  assert.deepEqual(codes(diags), ["L403", "L403"]);
  assert.match(diags[0].message, /missing required argument "id"/);
  assert.match(diags[1].message, /missing required input field "title"/);
});

test("L404: unknown or non-composite fragment conditions", () => {
  const diags = lint(
    `query Q { books { ...F } }\nfragment F on Bok { id }`,
    `query R { books { ...G } }\nfragment G on Genre { id }`
  );
  assert.deepEqual(codes(diags), ["L404", "L404"]);
  assert.match(diags[0].message, /unknown type "Bok"/);
  assert.match(diags[1].message, /enum type "Genre", which cannot be selected into/);
});

test("L404: variable types and missing operation roots are checked", () => {
  const varDiags = lint(`query Q($b: Book, $x: Nope) { books { id } }`);
  assert.deepEqual(codes(varDiags).sort(), ["L404", "L404", "L406", "L406"]);
  const messages = varDiags.map((d) => d.message).join("\n");
  assert.match(messages, /object type "Book"; variables must use input types/);
  assert.match(messages, /unknown type "Nope"/);
  const rootDiags = lint(`subscription S { books { id } }`);
  assert.deepEqual(codes(rootDiags), ["L404"]);
  assert.match(rootDiags[0].message, /no subscription root/);
});

test("L405/L406: undefined variables error (even via fragments); unused ones warn", () => {
  const diags = lint(
    `query Direct { books(first: $n) { id } }`,
    `query ViaFrag { books { ...F } }\nfragment F on Book { reviews(first: $m) { stars } }`
  );
  assert.deepEqual(codes(diags), ["L405", "L405"]);
  assert.match(diags[0].message, /"\$n" is used but never declared/);
  assert.match(diags[1].message, /"\$m" is used \(via fragment "F"\) but never declared/);
  const unused = lint(`query Q($ghost: Int) { books { id } }`);
  assert.deepEqual(codes(unused), ["L406"]);
  assert.equal(unused[0].severity, "warning");
});

test("L405/L406: variables referenced only inside @include/@skip directives count as uses", () => {
  // Regression: directive arguments used to be parsed and discarded, so
  // `$flag` here was wrongly reported unused (and never caught undeclared).
  const used = lint(`query Q($flag: Boolean!) { books { id @include(if: $flag) } }`);
  assert.deepEqual(used, []);
  const viaFragment = lint(
    `query Q($flag: Boolean!) { books { ...F } }\nfragment F on Book { id @skip(if: $flag) }`
  );
  assert.deepEqual(viaFragment, []);
  const undeclared = lint(`query Q { books { id @include(if: $flag) } }`);
  assert.deepEqual(codes(undeclared), ["L405"]);
  assert.match(undeclared[0].message, /"\$flag" is used but never declared/);
});

test("L407: deprecated field and deprecated enum value usage warn", () => {
  const withDeprecatedValue = schema(
    LIB_SDL.replace("enum Genre { FICTION", 'enum Genre { FICTION @deprecated(reason: "split up")')
  );
  const diags = lintDocuments(withDeprecatedValue, [
    ops(`query Q($id: ID!) { book(id: $id) { reviews { blurb } } books(genre: FICTION) { id } }`),
  ]);
  assert.deepEqual(codes(diags), ["L407", "L407"]);
  assert.ok(diags.every((d) => d.severity === "warning"));
  assert.match(diags[0].message, /"Review.blurb" is deprecated: Use body/);
  assert.match(diags[1].message, /"Genre.FICTION" is deprecated: split up/);
});

test("L408/L409: unknown spreads suggest, orphans warn, transitive use counts", () => {
  const diags = lint(`query Q { books { ...BookBitz } }\nfragment BookBits on Book { id }`);
  assert.deepEqual(codes(diags), ["L408", "L409"]); // typo'd spread + now-orphaned fragment
  assert.match(diags[0].message, /did you mean "BookBits"\?/);
  assert.match(diags[1].message, /"BookBits" is defined but never used/);
  // A fragment used only by another fragment is still reachable.
  const chained = lint(`query Q { books { ...A } }\nfragment A on Book { ...B }\nfragment B on Book { id }`);
  assert.deepEqual(chained, []);
});

test("L410/L411: composite fields need selections, leaves refuse them", () => {
  const diags = lint(`query Q($id: ID!) { book(id: $id) { author title { x } } }`);
  assert.deepEqual(codes(diags), ["L410", "L411"]);
  assert.match(diags[0].message, /returns object "Author" and needs a selection set/);
  assert.match(diags[1].message, /is a leaf \(String\) and takes no selection set/);
});

test("L412: duplicate names across files; anonymous mixed with named", () => {
  const dup = lint(`query Same { books { id } }`, `query Same { books { title } }`);
  assert.deepEqual(codes(dup), ["L412"]);
  assert.equal(dup[0].file, "f1.graphql");
  assert.match(dup[0].message, /also defined at f0.graphql:1/);
  const anon = lint(`{ books { id } }\nquery Named { books { id } }`);
  assert.deepEqual(codes(anon), ["L412"]);
  assert.match(anon[0].message, /must be the only operation/);
});

test("L413: unknown enum value, quoted enum string, and values inside lists", () => {
  const diags = lint(`query Q { books(genre: FICTON) { id } }`, `query R { books(genre: "fiction") { id } }`);
  assert.deepEqual(codes(diags), ["L413", "L413"]);
  assert.match(diags[0].message, /did you mean "FICTION"\?/);
  assert.match(diags[1].message, /enum "Genre" values are not quoted — write FICTION instead of "fiction"/);
  const withListArg = schema(`type Query { by(genres: [Genre!]): [Int!]! }\nenum Genre { FICTION }`);
  const listDiags = lintDocuments(withListArg, [ops(`query Q { by(genres: [FICTION, FICTON]) }`)]);
  assert.deepEqual(codes(listDiags), ["L413"]);
});

test("an error inside a shared fragment is reported once, not per spread", () => {
  const diags = lint(
    `query A { books { ...F } }\nquery B { books { ...F } }\nfragment F on Book { nope }`
  );
  assert.deepEqual(codes(diags), ["L401"]);
});

test("diagnostics are ordered by file then line; distant names get no suggestion", () => {
  const diags = lint(`query Q {\n  books {\n    zz\n  }\n  aa\n}`, `query R { books { yy } }`);
  assert.deepEqual(
    diags.map((d) => `${d.file}:${d.line}`),
    ["f0.graphql:3", "f0.graphql:5", "f1.graphql:1"]
  );
  assert.equal(suggest("zebra", ["title", "genre"]), "");
  assert.match(suggest("titel", ["title", "genre"]), /did you mean "title"/);
});
