// Flag parser: the CLI's argument contract — typed values, repeatables,
// and hard errors on typos instead of silent behavior changes.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseArgs } from "../dist/cliargs.js";

const SPECS = [
  { name: "format", kind: "string", choices: ["text", "json"] },
  { name: "ops", kind: "string", repeatable: true },
  { name: "max-cost", kind: "number" },
  { name: "strict", kind: "boolean" },
];

test("positionals and flags interleave freely; --flag=value equals the two-token form", () => {
  const args = parseArgs(["a.graphql", "--strict", "b.graphql", "--format", "json"], SPECS);
  assert.equal(args.error, null);
  assert.deepEqual(args.positionals, ["a.graphql", "b.graphql"]);
  assert.ok(args.booleans.has("strict"));
  assert.equal(args.strings.get("format"), "json");
  const inline = parseArgs(["--format=json", "--max-cost=100"], SPECS);
  assert.equal(inline.strings.get("format"), "json");
  assert.equal(inline.numbers.get("max-cost"), 100);
});

test("repeatable flags accumulate in order", () => {
  const args = parseArgs(["--ops", "a", "--ops=b", "--ops", "c"], SPECS);
  assert.deepEqual(args.lists.get("ops"), ["a", "b", "c"]);
});

test("unknown flags are errors, not positionals", () => {
  const args = parseArgs(["--frobnicate"], SPECS);
  assert.match(args.error, /unknown flag "--frobnicate"/);
});

test("number flags reject non-integers, negatives and garbage; choices are enforced", () => {
  for (const bad of ["abc", "-1", "1.5", ""]) {
    const args = parseArgs(["--max-cost", bad], SPECS);
    assert.match(args.error, /non-negative integer/, `expected error for ${JSON.stringify(bad)}`);
  }
  assert.match(parseArgs(["--format", "xml"], SPECS).error, /must be one of: text, json/);
});

test("missing values, repeated non-repeatables and valued booleans are errors", () => {
  assert.match(parseArgs(["--format"], SPECS).error, /requires a value/);
  assert.match(parseArgs(["--format", "text", "--format", "json"], SPECS).error, /more than once/);
  assert.match(parseArgs(["--strict=yes"], SPECS).error, /takes no value/);
});
