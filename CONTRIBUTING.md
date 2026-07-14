# Contributing to gqlsift

Issues, discussions and pull requests are all welcome — this project aims
to stay small, zero-dependency at runtime, and honest about its verdicts.

## Getting started

Requirements: Node.js >= 22.13 (for the stable `node:test` runner used by the suite).

```bash
git clone https://github.com/JaydenCJ/gqlsift.git
cd gqlsift
npm install            # installs typescript, the only devDependency
npm run build          # compile TypeScript to dist/
npm test               # build + 92 node:test tests
bash scripts/smoke.sh  # end-to-end CLI check against examples/
```

`scripts/smoke.sh` exercises the real CLI (diff verdicts, --fail-on
policies, lint, score, coverage, exit codes, JSON output, determinism)
against the bundled example schemas and must print `SMOKE OK`.

## Before you open a pull request

1. `npx tsc -p tsconfig.json --noEmit` — the tree must type-check clean (strict mode is enforced).
2. `npm test` — all tests must pass.
3. `bash scripts/smoke.sh` — must print `SMOKE OK`.
4. Add tests for behavior changes; keep logic in pure, unit-testable
   modules (parsing, diffing, impact, scoring and linting all take values,
   not file handles — only the CLI touches the filesystem).
5. New diagnostics need a row in `docs/change-catalog.md`, a stable code
   that is never reused, and at least one test.

## Ground rules

- **No runtime dependencies.** The zero-dependency install is a core
  feature; adding one needs justification in the PR and will usually be
  declined.
- No network calls, ever — the tool reads local files and prints. That is
  the whole I/O surface.
- Rule codes (`B1xx`/`D2xx`/`S3xx`/`L4xx`) are stable API: never renumber
  or repurpose an existing code; add new ones instead.
- Verdicts must be honest: `breaks` only when an operation provably stops
  working; anything runtime-dependent is `may-break`, never silently
  dropped.
- Output must stay deterministic — sorted collections, no timestamps, no
  map-iteration-order dependence.
- Code comments and doc comments are written in English.

## Reporting bugs

Please include: `gqlsift --version` output, the exact command line, and
the smallest schema pair (or schema + operation) that reproduces the
problem — one type with one field is usually enough. If a verdict is
wrong, say which operation you expected to be flagged (or not) and why.

## Security

Do not open public issues for security problems; use GitHub private
vulnerability reporting on this repository instead.
