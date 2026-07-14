#!/usr/bin/env bash
# Smoke test for gqlsift: exercises the real CLI end to end against the
# bundled example schemas and operations, plus freshly written temp files.
# No network, idempotent, runs from a clean checkout (after `npm install`).
# Prints "SMOKE OK" on success.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "SMOKE FAIL: $1" >&2
  exit 1
}

# 1. Build (idempotent).
npm run build >/dev/null 2>&1 || fail "npm run build failed"
CLI="node $ROOT/dist/cli.js"
echo "[smoke] build ok"

# 2. --version matches package.json; --help documents every subcommand.
PKG_VERSION="$(node -p "require('$ROOT/package.json').version")"
CLI_VERSION="$($CLI --version)"
[ "$CLI_VERSION" = "$PKG_VERSION" ] || fail "--version mismatch: $CLI_VERSION != $PKG_VERSION"
HELP="$($CLI --help)"
for word in diff lint score coverage --ops --fail-on --max-cost --min; do
  echo "$HELP" | grep -q -- "$word" || fail "--help missing $word"
done
echo "[smoke] --help/--version ok ($CLI_VERSION)"

# 3. Error handling: usage and parse errors exit 2 (distinct from findings' 1).
set +e
$CLI frobnicate >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown command should exit 2"; }
$CLI diff examples/schema-v1.graphql /nonexistent.graphql >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "missing file should exit 2"; }
printf 'query Q {\n  book( {\n}' > "$WORKDIR/bad.graphql"
$CLI lint --schema examples/schema-v1.graphql "$WORKDIR/bad.graphql" 2>"$WORKDIR/err.txt"; CODE=$?
set -e
[ "$CODE" -eq 2 ] || fail "parse error should exit 2, got $CODE"
grep -q 'bad.graphql:2:9' "$WORKDIR/err.txt" || fail "parse error should point at file:line:col"
echo "[smoke] error handling ok (exit 2)"

# 4. diff with recorded operations: seeded verdicts, exit 1.
set +e
DIFF_OUT="$($CLI diff examples/schema-v1.graphql examples/schema-v2.graphql --ops examples/operations)"; DIFF_CODE=$?
set -e
[ "$DIFF_CODE" -eq 1 ] || fail "breaking diff should exit 1, got $DIFF_CODE"
for needle in "BREAKING (6)" "DANGEROUS (3)" "SAFE (4)" "B103 User.email" "BREAKS GetUser" \
  "unreferenced by the recorded operations" "MAY BREAK CreatePost" \
  "6 breaking (5 confirmed against recorded operations, 1 unreferenced)"; do
  echo "$DIFF_OUT" | grep -qF "$needle" || fail "diff output missing: $needle"
done
echo "[smoke] diff verdicts ok (6 breaking, 5 confirmed)"

# 5. diff --format json is valid JSON with the expected summary.
set +e
DIFF_JSON="$($CLI diff examples/schema-v1.graphql examples/schema-v2.graphql --ops examples/operations --format json)"
set -e
echo "$DIFF_JSON" | node -e "
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const p = JSON.parse(s);
  if (p.summary.breaking !== 6 || p.summary.confirmedBreaking !== 5) process.exit(1);
});" || fail "diff --format json summary wrong or invalid JSON"
echo "[smoke] diff JSON ok"

# 6. --fail-on policies: never passes, impacted distinguishes real breakage.
$CLI diff examples/schema-v1.graphql examples/schema-v2.graphql --fail-on never >/dev/null || fail "--fail-on never should exit 0"
printf 'type Query { a: Int b: Int }' > "$WORKDIR/old.graphql"
printf 'type Query { a: Int }' > "$WORKDIR/new.graphql"
printf 'query Q { a }' > "$WORKDIR/op.graphql"
$CLI diff "$WORKDIR/old.graphql" "$WORKDIR/new.graphql" --fail-on impacted --ops "$WORKDIR/op.graphql" >/dev/null \
  || fail "unreferenced breaking change should pass --fail-on impacted"
set +e
$CLI diff "$WORKDIR/old.graphql" "$WORKDIR/new.graphql" --ops "$WORKDIR/op.graphql" >/dev/null; [ $? -eq 1 ] || { set -e; fail "default policy should still exit 1"; }
set -e
echo "[smoke] --fail-on policies ok"

# 7. lint: clean against the recorded schema, drift caught against the proposal.
LINT_OK="$($CLI lint --schema examples/schema-v1.graphql examples/operations)" || fail "recorded ops should lint clean against v1"
echo "$LINT_OK" | grep -q '6 files linted · 0 errors · 0 warnings' || fail "clean lint summary wrong"
set +e
LINT_BAD="$($CLI lint --schema examples/schema-v2.graphql examples/operations)"; LINT_CODE=$?
set -e
[ "$LINT_CODE" -eq 1 ] || fail "drifted lint should exit 1, got $LINT_CODE"
for needle in 'unknown field "email"' '"GUEST" is not a value of enum "Role"' 'missing required argument "scope"'; do
  echo "$LINT_BAD" | grep -qF "$needle" || fail "lint output missing: $needle"
done
echo "[smoke] lint ok (clean on v1, 3 errors on v2)"

# 8. score: complexity table and the --max-cost gate.
$CLI score --schema examples/schema-v1.graphql examples/operations >/dev/null || fail "score without limits should exit 0"
set +e
SCORE_OUT="$($CLI score --schema examples/schema-v1.graphql examples/operations --max-cost 1000)"; SCORE_CODE=$?
set -e
[ "$SCORE_CODE" -eq 1 ] || fail "score over limit should exit 1, got $SCORE_CODE"
echo "$SCORE_OUT" | grep -q 'Feed .*EXCEEDS cost 6661 > 1000' || fail "score should flag Feed at cost 6661"
echo "[smoke] score ok (Feed flagged at 6661)"

# 9. coverage: unused fields, deprecated-but-used, and the --min gate.
COV_OUT="$($CLI coverage --schema examples/schema-v2.graphql examples/operations)" || fail "coverage should exit 0 without --min"
echo "$COV_OUT" | grep -q 'unused fields (10):' || fail "coverage should list 10 unused fields"
echo "$COV_OUT" | grep -qF 'Post.body ("Use excerpt fields once they land") — used by CreatePost' || fail "coverage missing deprecated-but-used"
set +e
$CLI coverage --schema examples/schema-v2.graphql examples/operations --min 80 >/dev/null; [ $? -eq 1 ] || { set -e; fail "--min 80 should exit 1"; }
set -e
echo "[smoke] coverage ok"

# 10. Determinism: two runs over the same inputs are byte-identical.
$CLI diff examples/schema-v1.graphql examples/schema-v2.graphql --ops examples/operations --format json > "$WORKDIR/run1.json" || true
$CLI diff examples/schema-v1.graphql examples/schema-v2.graphql --ops examples/operations --format json > "$WORKDIR/run2.json" || true
cmp -s "$WORKDIR/run1.json" "$WORKDIR/run2.json" || fail "repeat runs differ"
echo "[smoke] determinism ok"

echo "SMOKE OK"
