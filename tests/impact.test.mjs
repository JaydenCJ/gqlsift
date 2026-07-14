// Impact analysis: joining diff changes against recorded operations —
// the breakage verdicts that make a diff CI-gateable.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildUsageIndex } from "../dist/index.js";
import { LIB_SDL, assess, hitsFor, ops, schema } from "./helpers.mjs";

// The "after" schema used by several cases: Book.title removed.
const LIB_NO_TITLE = LIB_SDL.replace("title: String!\n", "");

test("a removed field breaks exactly the operations that select it", () => {
  const assessed = assess(LIB_SDL, LIB_NO_TITLE, [
    `query WithTitle { books { id title } }`,
    `query WithoutTitle { books { id } }`,
  ]);
  assert.deepEqual(hitsFor(assessed, "B103", "Book.title"), ["breaks WithTitle"]);
});

test("untouched breaking changes get zero hits; safe changes are never assessed", () => {
  const withNew = LIB_NO_TITLE.replace("type Author implements Node {", "type Author implements Node {\n  bio: String");
  const assessed = assess(LIB_SDL, withNew, [`query Q { books { id } }`]);
  assert.deepEqual(hitsFor(assessed, "B103", "Book.title"), []);
  const safe = assessed.find((a) => a.change.code === "S302");
  assert.deepEqual(safe.hits, []);
});

test("uses reached through named fragments are attributed to the operation", () => {
  const assessed = assess(LIB_SDL, LIB_NO_TITLE, [
    `query ViaFrag { books { ...B } }\nfragment B on Book { title }`,
  ]);
  assert.deepEqual(hitsFor(assessed, "B103", "Book.title"), ["breaks ViaFrag"]);
});

test("selecting a field on an interface counts as using every implementor's field", () => {
  // Book.id is selected only through Node, but removing Book.id would
  // still break this operation at runtime.
  const withoutBookId = LIB_SDL.replace("type Book implements Node {\n  id: ID!", "type Book implements Node {");
  const assessed = assess(LIB_SDL, withoutBookId, [
    `query ViaNode($id: ID!) { book(id: $id) { ... on Node { id } } }`,
  ]);
  assert.deepEqual(hitsFor(assessed, "B103", "Book.id"), ["breaks ViaNode"]);
});

test("a newly required argument breaks every recorded use of the field", () => {
  const withArg = LIB_SDL.replace(
    "books(genre: Genre = FICTION, first: Int)",
    "books(genre: Genre = FICTION, first: Int, tenant: ID!)"
  );
  const assessed = assess(LIB_SDL, withArg, [
    `query Lists { books { id } }`,
    `query Unrelated($id: ID!) { book(id: $id) { id } }`,
  ]);
  assert.deepEqual(hitsFor(assessed, "B105"), ["breaks Lists"]);
});

test("enum value removal: literal use breaks, variable feed may-break, breaks outranks", () => {
  const noPoetry = LIB_SDL.replace(" POETRY", "");
  const assessed = assess(LIB_SDL, noPoetry, [
    `query Poets { books(genre: POETRY) { id } }`,
    `query ByGenre($g: Genre!) { books(genre: $g) { id } }`,
    `query Fiction { books(genre: FICTION) { id } }`,
  ]);
  assert.deepEqual(hitsFor(assessed, "B108", "Genre.POETRY"), ["breaks Poets", "may-break ByGenre"]);
  // One operation hit both ways collapses to a single "breaks".
  const both = assess(LIB_SDL, noPoetry, [
    `query Both($g: Genre!) { a: books(genre: POETRY) { id } b: books(genre: $g) { id } }`,
  ]);
  assert.deepEqual(hitsFor(both, "B108", "Genre.POETRY"), ["breaks Both"]);
});

test("input field removal: literal key use breaks, variable feed may-break", () => {
  const noTitleLike = LIB_SDL.replace("titleLike: String ", "");
  const assessed = assess(LIB_SDL, noTitleLike, [
    `query Literal { find(where: {titleLike: "dune"}) { id } }`,
    `query Variable($w: BookFilter!) { find(where: $w) { id } }`,
    `query OtherKey { find(where: {genre: FICTION}) { id } }`,
  ]);
  assert.deepEqual(hitsFor(assessed, "B111", "BookFilter.titleLike"), [
    "breaks Literal",
    "may-break Variable",
  ]);
});

test("a newly required input field breaks recorded literals, may-break variables", () => {
  const withRequired = LIB_SDL.replace(
    "input BookInput { title: String!,",
    "input BookInput { title: String!, isbn: ID!,"
  );
  const assessed = assess(LIB_SDL, withRequired, [
    `mutation Lit { addBook(input: {title: "t"}) { id } }`,
    `mutation Var($i: BookInput!) { addBook(input: $i) { id } }`,
  ]);
  assert.deepEqual(hitsFor(assessed, "B112", "BookInput.isbn"), ["breaks Lit", "may-break Var"]);
});

test("union member removal hits only operations spreading on that member", () => {
  const withHits = LIB_SDL.replace(
    "find(where: BookFilter!): [Book!]!",
    "find(where: BookFilter!): [Book!]!\n  hits(term: String!): [Hit!]!"
  );
  const noAuthorInUnion = withHits.replace("union Hit = Book | Author", "union Hit = Book");
  const assessed = assess(withHits, noAuthorInUnion, [
    `query OnAuthor($t: String!) { hits(term: $t) { ... on Author { name } } }`,
    `query OnBook($t: String!) { hits(term: $t) { ... on Book { title } } }`,
  ]);
  assert.deepEqual(hitsFor(assessed, "B109", "Hit.Author"), ["breaks OnAuthor"]);
});

test("dangerous changes flag only at-risk operations (D201 enum readers, D203 default reliers)", () => {
  const withValue = LIB_SDL.replace("enum Genre { FICTION", "enum Genre { HORROR FICTION");
  const enumAdded = assess(LIB_SDL, withValue, [
    `query Reads($id: ID!) { book(id: $id) { genre } }`,
    `query Blind($id: ID!) { book(id: $id) { id } }`,
  ]);
  assert.deepEqual(hitsFor(enumAdded, "D201", "Genre.HORROR"), ["may-break Reads"]);
  const newDefault = LIB_SDL.replace("reviews(first: Int = 5)", "reviews(first: Int = 50)");
  const defaultChanged = assess(LIB_SDL, newDefault, [
    `query Relies($id: ID!) { book(id: $id) { reviews { stars } } }`,
    `query Pins($id: ID!) { book(id: $id) { reviews(first: 3) { stars } } }`,
  ]);
  assert.deepEqual(hitsFor(defaultChanged, "D203"), ["may-break Relies"]);
});

test("the usage index survives fragment cycles; anonymous ops get stable identities", () => {
  const doc = ops(`query Q { books { ...A } }\nfragment A on Book { id ...B }\nfragment B on Book { title ...A }`);
  const index = buildUsageIndex(schema(LIB_SDL), [doc]);
  assert.equal(index.fieldUses.get("Book.id").size, 1);
  assert.equal(index.fieldUses.get("Book.title").size, 1);
  const anon = buildUsageIndex(schema(LIB_SDL), [ops(`{ books { id } }`, "a.graphql")]);
  const [opId, ref] = [...anon.ops][0];
  assert.equal(opId, "a.graphql::anon@1");
  assert.equal(ref.name, null);
});
