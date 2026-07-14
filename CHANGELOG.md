# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-13

### Added

- `gqlsift diff`: compares two SDL schemas and classifies every change
  with a stable code — 13 breaking rules (B101–B113), 4 dangerous rules
  (D201–D204) and 7 safe rules (S301–S307), covering fields, arguments,
  enums, unions, interfaces, input types, defaults and deprecations, with
  correct nullability direction for output vs input positions.
- Impact analysis (`--ops`): recorded `.graphql` operations are walked
  against the old schema and every breaking/dangerous change gets a
  per-operation verdict — `breaks` (provable), `may-break` (the value
  arrives through a variable at runtime) or `unreferenced`. Interface
  selections are credited to every implementor; fragments are resolved
  with cycle guards.
- `--fail-on breaking|dangerous|impacted|never`: CI exit-code policies,
  including the "only fail when a recorded operation is actually hit"
  gate that makes schema cleanup deploys safe to automate.
- `gqlsift lint`: validates operations against a schema with 13 rules
  (L401–L413) — unknown fields/arguments/types, missing required
  arguments and input fields, variable declaration/usage, fragment
  reachability, leaf/composite selection shape, duplicate operation
  names, enum literal validity — with nearest-name fix suggestions.
- `gqlsift score`: deterministic complexity scores per operation (depth,
  field count, weighted cost where unbounded lists multiply by
  `--list-factor` and literal `first`/`last`/`limit` arguments bound the
  multiplier), gated by `--max-depth` / `--max-cost`.
- `gqlsift coverage`: schema-field coverage from recorded operations —
  unused fields sorted for stable diffs, deprecated-but-still-used fields
  with the operations holding them, and a `--min` percentage gate.
- Dependency-free GraphQL front end: spec-conformant lexer (block strings
  with dedent, escapes, position tracking), SDL parser (descriptions,
  directives, explicit schema definitions; `extend` rejected loudly) and
  executable-document parser.
- `--format json` on every subcommand with stable shapes for CI, plus
  exit codes that distinguish findings (1) from usage/parse errors (2).
- Public programmatic API (`parseSchema`, `parseOperations`,
  `diffSchemas`, `buildUsageIndex`, `assessChanges`, `lintDocuments`,
  `scoreDocuments`, `computeCoverage`, renderers) with type declarations.
- Test suite: 92 node:test tests (unit + CLI integration in fresh temp
  dirs) and an end-to-end `scripts/smoke.sh` against the bundled example
  schemas and recorded operations.

[0.1.0]: https://github.com/JaydenCJ/gqlsift/releases/tag/v0.1.0
