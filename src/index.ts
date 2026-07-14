/**
 * Public programmatic API. Everything the CLI does is available as pure
 * functions over parsed values, so gqlsift can run inside build scripts,
 * gateways or test suites without shelling out.
 */

export { lex, GraphQLSyntaxError, type Token } from "./lexer.js";
export { parseSchema } from "./sdl.js";
export { parseOperations } from "./opparser.js";
export { diffSchemas } from "./diff.js";
export { buildUsageIndex, assessChanges, type UsageIndex } from "./impact.js";
export {
  scoreDocuments,
  DEFAULT_LIST_FACTOR,
  type ComplexityOptions,
  type OperationScore,
} from "./complexity.js";
export { lintDocuments, suggest } from "./lint.js";
export {
  computeCoverage,
  type CoverageReport,
  type DeprecatedUse,
  type UnusedField,
} from "./coverage.js";
export {
  renderDiffText,
  renderDiffJson,
  renderLintText,
  renderLintJson,
  renderScoreText,
  renderScoreJson,
  renderCoverageText,
  renderCoverageJson,
  exceededLimits,
  type DiffRenderContext,
  type ScoreThresholds,
} from "./report.js";
export { VERSION } from "./version.js";
export * from "./types.js";
