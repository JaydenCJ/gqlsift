#!/usr/bin/env node
/**
 * gqlsift CLI: subcommand dispatch, file loading and exit-code policy.
 * All analysis lives in pure modules; this file is the only place that
 * touches the filesystem or the process.
 *
 * Exit codes: 0 clean · 1 findings (per policy) · 2 usage or parse error.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { parseArgs, type FlagSpec } from "./cliargs.js";
import { DEFAULT_LIST_FACTOR, scoreDocuments } from "./complexity.js";
import { computeCoverage } from "./coverage.js";
import { diffSchemas } from "./diff.js";
import { assessChanges, buildUsageIndex } from "./impact.js";
import { GraphQLSyntaxError } from "./lexer.js";
import { lintDocuments } from "./lint.js";
import { parseOperations } from "./opparser.js";
import {
  exceededLimits,
  renderCoverageJson,
  renderCoverageText,
  renderDiffJson,
  renderDiffText,
  renderLintJson,
  renderLintText,
  renderScoreJson,
  renderScoreText,
} from "./report.js";
import { parseSchema } from "./sdl.js";
import type { Document, Schema } from "./types.js";
import { VERSION } from "./version.js";

const USAGE = `gqlsift — GraphQL schema diff and operation linter

Usage:
  gqlsift diff <old-schema> <new-schema> [--ops <file|dir>]... [options]
  gqlsift lint --schema <file> <operations>... [options]
  gqlsift score --schema <file> <operations>... [options]
  gqlsift coverage --schema <file> <operations>... [options]

Commands:
  diff      classify schema changes as breaking / dangerous / safe, with
            breakage verdicts against recorded operations when --ops is given
  lint      validate recorded operations against a schema
  score     complexity scores (depth, fields, weighted cost) per operation
  coverage  report which schema fields the recorded operations actually use

Options:
  diff:      --ops <file|dir>          recorded operations (repeatable)
             --fail-on <policy>        breaking | dangerous | impacted | never
                                       (default: breaking; "impacted" needs --ops)
  lint:      --strict                  warnings also fail the run
  score:     --max-depth <n>           fail when an operation nests deeper
             --max-cost <n>            fail when an operation costs more
             --list-factor <n>         multiplier for unbounded list fields
                                       (default: ${DEFAULT_LIST_FACTOR})
  coverage:  --min <pct>               fail when coverage is below <pct>
  common:    --schema <file>           schema SDL (lint / score / coverage)
             --format <text|json>      report format (default: text)
             --help                    show this help
             --version                 print the version

Exit codes: 0 clean · 1 findings per policy · 2 usage or parse error

Operation paths may be files or directories; directories are scanned
recursively for *.graphql and *.gql files, in sorted order.
`;

class CliError extends Error {}

function usageError(msg: string): never {
  throw new CliError(msg);
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

/** Expand a path into .graphql/.gql files, recursing into directories. */
function collectGraphQLFiles(path: string): string[] {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) usageError(`no such file or directory: "${path}"`);
  if (stat.isFile()) return [path];
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && (extname(entry.name) === ".graphql" || extname(entry.name) === ".gql")) {
        out.push(full);
      }
    }
  };
  walk(path);
  if (out.length === 0) usageError(`no .graphql or .gql files found under "${path}"`);
  return out;
}

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    usageError(`cannot read "${path}"`);
  }
}

function loadSchema(path: string): Schema {
  try {
    return parseSchema(readFile(path));
  } catch (e) {
    rethrowParse(e, path);
  }
}

function loadOperations(paths: string[]): Document[] {
  const files = paths.flatMap(collectGraphQLFiles);
  return files.map((file) => {
    try {
      return parseOperations(readFile(file), file);
    } catch (e) {
      rethrowParse(e, file);
    }
  });
}

function rethrowParse(e: unknown, file: string): never {
  if (e instanceof GraphQLSyntaxError) {
    usageError(`${file}:${e.line}:${e.col}: ${e.message}`);
  }
  throw e;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const COMMON_FLAGS: FlagSpec[] = [
  { name: "format", kind: "string", choices: ["text", "json"] },
  { name: "schema", kind: "string" },
];

function cmdDiff(argv: string[], write: (s: string) => void): number {
  const args = parseArgs(argv, [
    ...COMMON_FLAGS,
    { name: "ops", kind: "string", repeatable: true },
    { name: "fail-on", kind: "string", choices: ["breaking", "dangerous", "impacted", "never"] },
  ]);
  if (args.error) usageError(args.error);
  if (args.positionals.length !== 2) {
    usageError("diff takes exactly two positional arguments: <old-schema> <new-schema>");
  }
  const [oldFile, newFile] = args.positionals as [string, string];
  const failOn = args.strings.get("fail-on") ?? "breaking";
  const opsPaths = args.lists.get("ops") ?? [];
  if (failOn === "impacted" && opsPaths.length === 0) {
    usageError(`--fail-on impacted requires at least one --ops path`);
  }

  const oldSchema = loadSchema(oldFile);
  const newSchema = loadSchema(newFile);
  const changes = diffSchemas(oldSchema, newSchema);

  let assessed;
  let operationsConsulted: number | null = null;
  if (opsPaths.length > 0) {
    const docs = loadOperations(opsPaths);
    const index = buildUsageIndex(oldSchema, docs);
    assessed = assessChanges(changes, index);
    operationsConsulted = index.ops.size;
  } else {
    assessed = changes.map((change) => ({ change, hits: [] }));
  }

  const ctx = { oldFile, newFile, operationsConsulted };
  write(args.strings.get("format") === "json" ? renderDiffJson(assessed, ctx) : renderDiffText(assessed, ctx));

  const hasBreaking = changes.some((c) => c.severity === "breaking");
  const hasDangerous = changes.some((c) => c.severity === "dangerous");
  const hasImpacted = assessed.some((a) => a.change.severity === "breaking" && a.hits.length > 0);
  switch (failOn) {
    case "never":
      return 0;
    case "impacted":
      return hasImpacted ? 1 : 0;
    case "dangerous":
      return hasBreaking || hasDangerous ? 1 : 0;
    default:
      return hasBreaking ? 1 : 0;
  }
}

function requireSchemaAndOps(args: ReturnType<typeof parseArgs>, command: string): { schema: Schema; docs: Document[] } {
  const schemaPath = args.strings.get("schema");
  if (!schemaPath) usageError(`${command} requires --schema <file>`);
  if (args.positionals.length === 0) usageError(`${command} requires at least one operations path`);
  return { schema: loadSchema(schemaPath), docs: loadOperations(args.positionals) };
}

function cmdLint(argv: string[], write: (s: string) => void): number {
  const args = parseArgs(argv, [...COMMON_FLAGS, { name: "strict", kind: "boolean" }]);
  if (args.error) usageError(args.error);
  const { schema, docs } = requireSchemaAndOps(args, "lint");
  const diags = lintDocuments(schema, docs);
  write(
    args.strings.get("format") === "json"
      ? renderLintJson(diags, docs.length)
      : renderLintText(diags, docs.length)
  );
  const errors = diags.filter((d) => d.severity === "error").length;
  const warnings = diags.filter((d) => d.severity === "warning").length;
  return errors > 0 || (args.booleans.has("strict") && warnings > 0) ? 1 : 0;
}

function cmdScore(argv: string[], write: (s: string) => void): number {
  const args = parseArgs(argv, [
    ...COMMON_FLAGS,
    { name: "max-depth", kind: "number" },
    { name: "max-cost", kind: "number" },
    { name: "list-factor", kind: "number" },
  ]);
  if (args.error) usageError(args.error);
  const { schema, docs } = requireSchemaAndOps(args, "score");
  const listFactor = args.numbers.get("list-factor") ?? DEFAULT_LIST_FACTOR;
  if (listFactor < 1) usageError("--list-factor must be at least 1");
  const scores = scoreDocuments(schema, docs, { listFactor });
  const thresholds = {
    maxDepth: args.numbers.get("max-depth") ?? null,
    maxCost: args.numbers.get("max-cost") ?? null,
  };
  write(
    args.strings.get("format") === "json"
      ? renderScoreJson(scores, thresholds)
      : renderScoreText(scores, thresholds)
  );
  return scores.some((s) => exceededLimits(s, thresholds).length > 0) ? 1 : 0;
}

function cmdCoverage(argv: string[], write: (s: string) => void): number {
  const args = parseArgs(argv, [...COMMON_FLAGS, { name: "min", kind: "number" }]);
  if (args.error) usageError(args.error);
  const { schema, docs } = requireSchemaAndOps(args, "coverage");
  const index = buildUsageIndex(schema, docs);
  const report = computeCoverage(schema, index);
  write(
    args.strings.get("format") === "json"
      ? renderCoverageJson(report, index.ops.size)
      : renderCoverageText(report, index.ops.size)
  );
  const min = args.numbers.get("min");
  return min !== undefined && report.percent < min ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function main(argv: string[]): number {
  const write = (s: string): void => {
    process.stdout.write(s);
  };
  if (argv.length === 0 || argv.includes("--help")) {
    write(USAGE);
    return 0;
  }
  if (argv.includes("--version")) {
    write(`${VERSION}\n`);
    return 0;
  }
  const [command, ...rest] = argv as [string, ...string[]];
  try {
    switch (command) {
      case "diff":
        return cmdDiff(rest, write);
      case "lint":
        return cmdLint(rest, write);
      case "score":
        return cmdScore(rest, write);
      case "coverage":
        return cmdCoverage(rest, write);
      default:
        usageError(`unknown command "${command}" (expected diff, lint, score or coverage)`);
    }
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`gqlsift: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

process.exit(main(process.argv.slice(2)));
