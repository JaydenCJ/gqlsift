// Complexity scoring: depth, field counts and the weighted cost model
// (unbounded lists multiply, literal page sizes bound the multiplier).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { scoreDocuments } from "../dist/index.js";
import { LIB_SDL, ops, schema } from "./helpers.mjs";

const LIB = schema(LIB_SDL);

function scoreOne(src, opts) {
  const scores = scoreDocuments(LIB, [ops(src)], opts);
  assert.equal(scores.length, 1);
  return scores[0];
}

test("a flat query over a non-list field: cost equals field count", () => {
  const s = scoreOne(`query Q($id: ID!) { book(id: $id) { id title } }`);
  assert.deepEqual({ depth: s.depth, fields: s.fields, cost: s.cost }, { depth: 2, fields: 3, cost: 3 });
});

test("an unbounded list multiplies its children by the list factor", () => {
  // books = 1 + 10 * (1 + 1) = 21 with the default factor of 10.
  assert.equal(scoreOne(`query Q { books { id title } }`).cost, 21);
  // A custom factor is honored.
  assert.equal(scoreOne(`query Q { books { id } }`, { listFactor: 100 }).cost, 101);
});

test("literal first:/last:/limit: arguments bound the multiplier", () => {
  assert.equal(scoreOne(`query Q { books(first: 3) { id title } }`).cost, 1 + 3 * 2);
  const s = schema(`type Query { things(limit: Int): [Thing!]! }\ntype Thing { id: ID! }`);
  const scored = scoreDocuments(s, [ops(`query Q { things(limit: 2) { id } }`)]);
  assert.equal(scored[0].cost, 1 + 2 * 1);
});

test("nested unbounded lists compound multiplicatively", () => {
  const s = scoreOne(`query Q { books { reviews { stars } } }`);
  // reviews = 1 + 10 * 1 = 11; books = 1 + 10 * 11 = 111
  assert.deepEqual({ depth: s.depth, cost: s.cost }, { depth: 3, cost: 111 });
});

test("fragments are transparent for depth but their fields are paid at each spread site", () => {
  const s = scoreOne(`query Q { books { ...B } }\nfragment B on Book { id title }`);
  assert.deepEqual({ depth: s.depth, fields: s.fields, cost: s.cost }, { depth: 2, fields: 3, cost: 21 });
  const twice = scoreOne(
    `query Q($id: ID!) { a: book(id: $id) { ...B } b: book(id: $id) { ...B } }\nfragment B on Book { id }`
  );
  assert.equal(twice.fields, 4);
});

test("fragment cycles are cut, not looped", () => {
  const s = scoreOne(`query Q { books { ...A } }\nfragment A on Book { id ...B }\nfragment B on Book { ...A title }`);
  assert.ok(Number.isFinite(s.cost));
  assert.equal(s.fields, 3); // books, id, title — nothing from the cycle re-entry
});

test("every operation in every document is scored, in input order", () => {
  const docs = [
    ops(`query A { books { id } }\nquery B { books { id } }`, "one.graphql"),
    ops(`{ books { id } }`, "two.graphql"),
  ];
  const scores = scoreDocuments(LIB, docs);
  assert.deepEqual(
    scores.map((s) => `${s.op.file}:${s.op.name}`),
    ["one.graphql:A", "one.graphql:B", "two.graphql:null"]
  );
});
