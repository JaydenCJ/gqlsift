/**
 * Renderers: turn analysis results into terminal text or stable JSON.
 * Every renderer is a pure function from data to string, so output is
 * byte-identical across runs — a hard requirement for CI diffing.
 */

import type { CoverageReport } from "./coverage.js";
import type { OperationScore } from "./complexity.js";
import type { AssessedChange, Diagnostic, ImpactLevel, OpRef, Severity } from "./types.js";

function opLabel(op: OpRef): string {
  return `${op.name ?? "(anonymous)"} (${op.file})`;
}

/** `1 error`, `3 errors` — every summary count goes through this. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

export interface DiffRenderContext {
  oldFile: string;
  newFile: string;
  /** Number of recorded operations consulted; null when --ops was not given. */
  operationsConsulted: number | null;
}

type ImpactStatus = "breaks" | "may-break" | "unreferenced";

function impactStatus(a: AssessedChange): ImpactStatus {
  if (a.hits.some((h) => h.level === "breaks")) return "breaks";
  if (a.hits.length > 0) return "may-break";
  return "unreferenced";
}

export function renderDiffText(assessed: AssessedChange[], ctx: DiffRenderContext): string {
  const lines: string[] = [];
  lines.push(`gqlsift diff: ${ctx.oldFile} -> ${ctx.newFile}`);
  if (ctx.operationsConsulted !== null) {
    lines.push(`${count(ctx.operationsConsulted, "recorded operation")} consulted`);
  }
  lines.push("");

  const groups: { severity: Severity; title: string }[] = [
    { severity: "breaking", title: "BREAKING" },
    { severity: "dangerous", title: "DANGEROUS" },
    { severity: "safe", title: "SAFE" },
  ];

  for (const group of groups) {
    const items = assessed.filter((a) => a.change.severity === group.severity);
    if (items.length === 0) continue;
    lines.push(`${group.title} (${items.length})`);
    for (const a of items) {
      lines.push(`  ${a.change.code} ${a.change.path} — ${a.change.message}`);
      if (ctx.operationsConsulted !== null && a.change.severity !== "safe") {
        lines.push(`       impact: ${impactLine(a)}`);
      }
    }
    lines.push("");
  }

  if (assessed.length === 0) {
    lines.push("no changes");
    lines.push("");
  }

  lines.push(summaryLine(assessed, ctx));
  return lines.join("\n") + "\n";
}

function impactLine(a: AssessedChange): string {
  const breaks = a.hits.filter((h) => h.level === "breaks");
  const maybes = a.hits.filter((h) => h.level === "may-break");
  if (breaks.length === 0 && maybes.length === 0) {
    return "unreferenced by the recorded operations";
  }
  const parts: string[] = [];
  if (breaks.length > 0) parts.push(`BREAKS ${breaks.map((h) => opLabel(h.op)).join(", ")}`);
  if (maybes.length > 0) parts.push(`MAY BREAK ${maybes.map((h) => opLabel(h.op)).join(", ")}`);
  return parts.join(" · ");
}

function summaryLine(assessed: AssessedChange[], ctx: DiffRenderContext): string {
  const bySeverity = (s: Severity): AssessedChange[] => assessed.filter((a) => a.change.severity === s);
  const breaking = bySeverity("breaking");
  const dangerous = bySeverity("dangerous");
  const safe = bySeverity("safe");
  let breakingPart = `${breaking.length} breaking`;
  if (ctx.operationsConsulted !== null && breaking.length > 0) {
    const confirmed = breaking.filter((a) => impactStatus(a) !== "unreferenced").length;
    breakingPart += ` (${confirmed} confirmed against recorded operations, ${breaking.length - confirmed} unreferenced)`;
  }
  return `${breakingPart} · ${dangerous.length} dangerous · ${safe.length} safe`;
}

export function renderDiffJson(assessed: AssessedChange[], ctx: DiffRenderContext): string {
  const breaking = assessed.filter((a) => a.change.severity === "breaking");
  const out = {
    old: ctx.oldFile,
    new: ctx.newFile,
    operationsConsulted: ctx.operationsConsulted,
    summary: {
      breaking: breaking.length,
      dangerous: assessed.filter((a) => a.change.severity === "dangerous").length,
      safe: assessed.filter((a) => a.change.severity === "safe").length,
      confirmedBreaking:
        ctx.operationsConsulted === null
          ? null
          : breaking.filter((a) => impactStatus(a) !== "unreferenced").length,
    },
    changes: assessed.map((a) => ({
      code: a.change.code,
      kind: a.change.kind,
      severity: a.change.severity,
      path: a.change.path,
      message: a.change.message,
      impact:
        ctx.operationsConsulted === null || a.change.severity === "safe"
          ? null
          : {
              status: impactStatus(a),
              operations: a.hits.map((h) => ({
                name: h.op.name,
                file: h.op.file,
                level: h.level as ImpactLevel,
              })),
            },
    })),
  };
  return JSON.stringify(out, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

export function renderLintText(diags: Diagnostic[], filesLinted: number): string {
  const lines: string[] = [];
  let currentFile: string | null = null;
  for (const d of diags) {
    if (d.file !== currentFile) {
      if (currentFile !== null) lines.push("");
      lines.push(d.file);
      currentFile = d.file;
    }
    lines.push(`  line ${d.line}  ${d.severity} ${d.code}  ${d.message}`);
  }
  if (diags.length > 0) lines.push("");
  const errors = diags.filter((d) => d.severity === "error").length;
  const warnings = diags.filter((d) => d.severity === "warning").length;
  lines.push(`${count(filesLinted, "file")} linted · ${count(errors, "error")} · ${count(warnings, "warning")}`);
  return lines.join("\n") + "\n";
}

export function renderLintJson(diags: Diagnostic[], filesLinted: number): string {
  const out = {
    summary: {
      files: filesLinted,
      errors: diags.filter((d) => d.severity === "error").length,
      warnings: diags.filter((d) => d.severity === "warning").length,
    },
    diagnostics: diags,
  };
  return JSON.stringify(out, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// score
// ---------------------------------------------------------------------------

export interface ScoreThresholds {
  maxDepth: number | null;
  maxCost: number | null;
}

export function exceededLimits(score: OperationScore, t: ScoreThresholds): string[] {
  const out: string[] = [];
  if (t.maxDepth !== null && score.depth > t.maxDepth) out.push(`depth ${score.depth} > ${t.maxDepth}`);
  if (t.maxCost !== null && score.cost > t.maxCost) out.push(`cost ${score.cost} > ${t.maxCost}`);
  return out;
}

export function renderScoreText(scores: OperationScore[], t: ScoreThresholds): string {
  const rows = scores.map((s) => ({
    label: opLabel(s.op),
    depth: String(s.depth),
    fields: String(s.fields),
    cost: String(s.cost),
    exceeded: exceededLimits(s, t),
  }));
  const labelWidth = Math.max("operation".length, ...rows.map((r) => r.label.length));
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
  const num = (s: string, w: number): string => " ".repeat(Math.max(0, w - s.length)) + s;

  const lines: string[] = [];
  lines.push(`${pad("operation", labelWidth)}  depth  fields    cost`);
  for (const r of rows) {
    let line = `${pad(r.label, labelWidth)}  ${num(r.depth, 5)}  ${num(r.fields, 6)}  ${num(r.cost, 6)}`;
    if (r.exceeded.length > 0) line += `  EXCEEDS ${r.exceeded.join(", ")}`;
    lines.push(line);
  }
  const flagged = rows.filter((r) => r.exceeded.length > 0).length;
  lines.push("");
  lines.push(
    flagged === 0
      ? `${count(rows.length, "operation")} scored · all within limits`
      : `${count(rows.length, "operation")} scored · ${flagged} over limit`
  );
  return lines.join("\n") + "\n";
}

export function renderScoreJson(scores: OperationScore[], t: ScoreThresholds): string {
  const out = {
    summary: {
      operations: scores.length,
      overLimit: scores.filter((s) => exceededLimits(s, t).length > 0).length,
    },
    operations: scores.map((s) => ({
      name: s.op.name,
      file: s.op.file,
      operation: s.op.operation,
      depth: s.depth,
      fields: s.fields,
      cost: s.cost,
      exceeded: exceededLimits(s, t),
    })),
  };
  return JSON.stringify(out, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

export function renderCoverageText(report: CoverageReport, opsCount: number): string {
  const lines: string[] = [];
  lines.push(
    `schema coverage: ${report.usedFields}/${report.totalFields} field${report.totalFields === 1 ? "" : "s"} used by ${count(opsCount, "recorded operation")} — ${report.percent}%`
  );
  if (report.unused.length > 0) {
    lines.push("");
    lines.push(`unused fields (${report.unused.length}):`);
    for (const u of report.unused) lines.push(`  ${u.type}.${u.field}`);
  }
  if (report.deprecatedStillUsed.length > 0) {
    lines.push("");
    lines.push(`deprecated but still used (${report.deprecatedStillUsed.length}):`);
    for (const d of report.deprecatedStillUsed) {
      lines.push(`  ${d.type}.${d.field} ("${d.reason}") — used by ${d.ops.map(opLabel).join(", ")}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function renderCoverageJson(report: CoverageReport, opsCount: number): string {
  const out = {
    summary: {
      totalFields: report.totalFields,
      usedFields: report.usedFields,
      percent: report.percent,
      operations: opsCount,
    },
    unused: report.unused,
    deprecatedStillUsed: report.deprecatedStillUsed.map((d) => ({
      type: d.type,
      field: d.field,
      reason: d.reason,
      operations: d.ops.map((op) => ({ name: op.name, file: op.file })),
    })),
  };
  return JSON.stringify(out, null, 2) + "\n";
}
