// Field coverage: totals, interface expansion, and the deprecated-but-
// still-used list that tells you which deprecations cannot land yet.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildUsageIndex, computeCoverage } from "../dist/index.js";
import { LIB_SDL, ops, schema } from "./helpers.mjs";

const LIB = schema(LIB_SDL);

function coverageOf(...sources) {
  const docs = sources.map((src, i) => ops(src, `f${i}.graphql`));
  return computeCoverage(LIB, buildUsageIndex(LIB, docs));
}

test("counts, percent and the unused list are computed over object and interface fields", () => {
  const report = coverageOf(`query Q($id: ID!) { book(id: $id) { id title } }`);
  // LIB_SDL has 15 object/interface fields (Query 3, Mutation 1, Node 1,
  // Book 5, Author 2, Review 3).
  assert.equal(report.totalFields, 15);
  assert.equal(report.usedFields, 3); // Query.book, Book.id, Book.title
  assert.equal(report.percent, 20);
  assert.ok(report.unused.some((u) => u.type === "Mutation" && u.field === "addBook"));
  assert.ok(!report.unused.some((u) => u.type === "Book" && u.field === "title"));
  // Zero recorded operations means zero coverage, not a crash.
  const empty = computeCoverage(LIB, buildUsageIndex(LIB, []));
  assert.deepEqual({ used: empty.usedFields, percent: empty.percent, unused: empty.unused.length }, { used: 0, percent: 0, unused: 15 });
});

test("selecting through an interface marks every implementor's field used", () => {
  const report = coverageOf(`query Q($id: ID!) { book(id: $id) { ... on Node { id } } }`);
  assert.ok(!report.unused.some((u) => u.type === "Book" && u.field === "id"));
  assert.ok(!report.unused.some((u) => u.type === "Author" && u.field === "id"));
  assert.ok(!report.unused.some((u) => u.type === "Node" && u.field === "id"));
});

test("deprecated fields still in use are listed with the operations holding them", () => {
  const report = coverageOf(
    `query Old($id: ID!) { book(id: $id) { reviews { blurb } } }`,
    `query New($id: ID!) { book(id: $id) { reviews { stars } } }`
  );
  assert.equal(report.deprecatedStillUsed.length, 1);
  const d = report.deprecatedStillUsed[0];
  assert.deepEqual(
    { type: d.type, field: d.field, reason: d.reason, ops: d.ops.map((o) => o.name) },
    { type: "Review", field: "blurb", reason: "Use body", ops: ["Old"] }
  );
});

test("a deprecated field nobody uses is unused, not deprecated-still-used; list is sorted", () => {
  const report = coverageOf(`query Q { books { id } }`);
  assert.deepEqual(report.deprecatedStillUsed, []);
  assert.ok(report.unused.some((u) => u.type === "Review" && u.field === "blurb"));
  const rendered = report.unused.map((u) => `${u.type}.${u.field}`);
  assert.deepEqual(rendered, [...rendered].sort());
});

