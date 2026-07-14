// End-to-end CLI runs against the compiled dist/cli.js in fresh temp
// dirs: exit codes, formats and policies are the scripting contract.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const V1 = join(ROOT, "examples", "schema-v1.graphql");
const V2 = join(ROOT, "examples", "schema-v2.graphql");
const OPS = join(ROOT, "examples", "operations");

function run(...args) {
  const result = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "gqlsift-test-"));
}

test("--version matches package.json; --help documents every subcommand", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const version = run("--version");
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), pkg.version);
  const help = run("--help");
  assert.equal(help.code, 0);
  for (const needle of ["diff", "lint", "score", "coverage", "--ops", "--fail-on", "--max-cost", "--min", "--format"]) {
    assert.ok(help.stdout.includes(needle), `help missing ${needle}`);
  }
});

test("unknown commands and unknown flags exit 2 with a message on stderr", () => {
  const cmd = run("frobnicate");
  assert.equal(cmd.code, 2);
  assert.match(cmd.stderr, /unknown command/);
  const flag = run("diff", V1, V2, "--frobnicate");
  assert.equal(flag.code, 2);
});

test("diff over the bundled schemas finds the seeded changes; no --ops, no verdicts", () => {
  const { code, stdout } = run("diff", V1, V2, "--ops", OPS);
  assert.equal(code, 1);
  assert.match(stdout, /6 recorded operations consulted/);
  assert.match(stdout, /BREAKING \(6\)/);
  assert.match(stdout, /DANGEROUS \(3\)/);
  assert.match(stdout, /SAFE \(4\)/);
  assert.match(stdout, /B103 User.email/);
  assert.match(stdout, /BREAKS GetUser \(.*get-user.graphql\)/);
  assert.match(stdout, /unreferenced by the recorded operations/);
  assert.match(stdout, /MAY BREAK CreatePost/);
  assert.match(stdout, /6 breaking \(5 confirmed against recorded operations, 1 unreferenced\) · 3 dangerous · 4 safe/);
  // Without --ops the same diff carries no impact lines at all.
  const bare = run("diff", V1, V2);
  assert.equal(bare.code, 1);
  assert.ok(!bare.stdout.includes("impact:"));
  assert.ok(!bare.stdout.includes("consulted"));
});

test("diff --format json emits valid JSON with a stable shape", () => {
  const { code, stdout } = run("diff", V1, V2, "--ops", OPS, "--format", "json");
  assert.equal(code, 1);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.summary.breaking, 6);
  assert.equal(parsed.summary.confirmedBreaking, 5);
  const email = parsed.changes.find((c) => c.path === "User.email");
  assert.equal(email.impact.status, "breaks");
  assert.equal(email.impact.operations[0].name, "GetUser");
  const safe = parsed.changes.find((c) => c.code === "S301");
  assert.equal(safe.impact, null);
});

test("--fail-on policies drive the exit code; identical schemas are clean", () => {
  assert.equal(run("diff", V1, V2, "--fail-on", "never").code, 0);
  assert.equal(run("diff", V1, V2, "--fail-on", "dangerous").code, 1);
  // impacted requires --ops.
  assert.equal(run("diff", V1, V2, "--fail-on", "impacted").code, 2);
  assert.equal(run("diff", V1, V2, "--fail-on", "impacted", "--ops", OPS).code, 1);
  const clean = run("diff", V1, V1);
  assert.equal(clean.code, 0);
  assert.match(clean.stdout, /no changes/);
  assert.match(clean.stdout, /0 breaking · 0 dangerous · 0 safe/);
});

test("--fail-on impacted passes when the only breaking change is unreferenced", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "old.graphql"), "type Query { a: Int b: Int }");
  writeFileSync(join(dir, "new.graphql"), "type Query { a: Int }");
  writeFileSync(join(dir, "op.graphql"), "query Q { a }");
  const gated = run("diff", join(dir, "old.graphql"), join(dir, "new.graphql"), "--fail-on", "impacted", "--ops", join(dir, "op.graphql"));
  assert.equal(gated.code, 0, gated.stdout);
  // The default policy still fails: the change is breaking, just unreferenced.
  const strict = run("diff", join(dir, "old.graphql"), join(dir, "new.graphql"), "--ops", join(dir, "op.graphql"));
  assert.equal(strict.code, 1);
});

test("lint: clean against the recorded schema, drift surfaces against the proposal", () => {
  const clean = run("lint", "--schema", V1, OPS);
  assert.equal(clean.code, 0, clean.stdout);
  assert.match(clean.stdout, /6 files linted · 0 errors · 0 warnings/);
  const drifted = run("lint", "--schema", V2, OPS);
  assert.equal(drifted.code, 1);
  assert.match(drifted.stdout, /error L401 {2}unknown field "email" on type "User"/);
  assert.match(drifted.stdout, /error L413 {2}argument "role": "GUEST" is not a value of enum "Role"/);
  assert.match(drifted.stdout, /error L403 {2}missing required argument "scope"/);
  assert.match(drifted.stdout, /3 errors · 1 warning$/m);
});

test("summary lines pluralize correctly at count 1", () => {
  // "1 files linted" or "1 errors" in CI output reads as sloppiness; the
  // singular forms are part of the text contract.
  const dir = tempDir();
  writeFileSync(join(dir, "s.graphql"), "type Query { a: Int }");
  writeFileSync(join(dir, "op.graphql"), "query Q($x: Int) { b }");
  const lint = run("lint", "--schema", join(dir, "s.graphql"), join(dir, "op.graphql"));
  assert.match(lint.stdout, /1 file linted · 1 error · 1 warning$/m);
  const score = run("score", "--schema", join(dir, "s.graphql"), join(dir, "op.graphql"));
  assert.match(score.stdout, /1 operation scored/);
  const cov = run("coverage", "--schema", join(dir, "s.graphql"), join(dir, "op.graphql"));
  assert.match(cov.stdout, /0\/1 field used by 1 recorded operation — 0%/);
  writeFileSync(join(dir, "old.graphql"), "type Query { a: Int b: Int }");
  const diff = run("diff", join(dir, "old.graphql"), join(dir, "s.graphql"), "--ops", join(dir, "op.graphql"));
  assert.match(diff.stdout, /1 recorded operation consulted/);
});

test("lint --strict turns a warnings-only run into a failure", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "s.graphql"), 'type Query { old: Int @deprecated(reason: "x") }');
  writeFileSync(join(dir, "op.graphql"), "query Q { old }");
  assert.equal(run("lint", "--schema", join(dir, "s.graphql"), join(dir, "op.graphql")).code, 0);
  assert.equal(run("lint", "--schema", join(dir, "s.graphql"), join(dir, "op.graphql"), "--strict").code, 1);
});

test("score prints the table; --max-cost gates; --list-factor reweights", () => {
  const ok = run("score", "--schema", V1, OPS);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /operation\s+depth\s+fields\s+cost/);
  assert.match(ok.stdout, /all within limits/);
  const gated = run("score", "--schema", V1, OPS, "--max-cost", "1000");
  assert.equal(gated.code, 1);
  assert.match(gated.stdout, /Feed .*EXCEEDS cost 6661 > 1000/);
  assert.match(gated.stdout, /1 over limit/);
  const reweighted = run("score", "--schema", V1, OPS, "--list-factor", "1", "--format", "json");
  const feed = JSON.parse(reweighted.stdout).operations.find((o) => o.name === "Feed");
  // users(first: 20) stays bounded by its literal; inner lists collapse to 1x.
  assert.equal(feed.cost, 181);
});

test("coverage reports unused and deprecated-but-used fields; --min gates", () => {
  const report = run("coverage", "--schema", V2, OPS);
  assert.equal(report.code, 0);
  assert.match(report.stdout, /unused fields \(10\):/);
  assert.match(report.stdout, /Mutation.deletePost/);
  assert.match(report.stdout, /deprecated but still used \(1\):/);
  assert.match(report.stdout, /Post.body \("Use excerpt fields once they land"\) — used by CreatePost/);
  const gated = run("coverage", "--schema", V2, OPS, "--min", "80");
  assert.equal(gated.code, 1);
});

test("operation paths accept files and nested directories; errors exit 2 with locations", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "a.graphql"), 'query A { user(id: "1") { id } }');
  writeFileSync(join(dir, "nested", "b.gql"), 'query B { user(id: "2") { name } }');
  writeFileSync(join(dir, "ignored.txt"), "not graphql");
  const { code, stdout } = run("lint", "--schema", V1, dir);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /2 files linted/);
  // A syntax error points at file:line:col and exits 2.
  writeFileSync(join(dir, "nested", "bad.graphql"), "query Q {\n  book( {\n}");
  const bad = run("lint", "--schema", V1, join(dir, "nested", "bad.graphql"));
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /bad.graphql:2:9/);
  // Missing files and directories with no GraphQL files also exit 2.
  assert.equal(run("diff", V1, "/nonexistent/nope.graphql").code, 2);
  const empty = mkdtempSync(join(tmpdir(), "gqlsift-empty-"));
  const noneFound = run("lint", "--schema", V1, empty);
  assert.equal(noneFound.code, 2);
  assert.match(noneFound.stderr, /no .graphql or .gql files found/);
});

test("determinism: repeated runs are byte-identical", () => {
  const one = run("diff", V1, V2, "--ops", OPS, "--format", "json");
  const two = run("diff", V1, V2, "--ops", OPS, "--format", "json");
  assert.equal(one.stdout, two.stdout);
  const scoreOne = run("score", "--schema", V1, OPS);
  const scoreTwo = run("score", "--schema", V1, OPS);
  assert.equal(scoreOne.stdout, scoreTwo.stdout);
});
