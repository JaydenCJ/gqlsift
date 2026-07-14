/**
 * Field coverage: which schema fields do the recorded operations actually
 * touch? Built on the same usage index as impact analysis, so a field
 * selected through an interface counts as used on every implementor.
 *
 * Two outputs matter for schema gardening:
 * - unused fields — candidates for deprecation and eventual removal;
 * - deprecated-but-still-used fields — deprecations that cannot be
 *   completed yet, with the operations still holding them hostage.
 */

import type { UsageIndex } from "./impact.js";
import type { OpRef, Schema } from "./types.js";

export interface UnusedField {
  type: string;
  field: string;
}

export interface DeprecatedUse {
  type: string;
  field: string;
  reason: string;
  ops: OpRef[];
}

export interface CoverageReport {
  totalFields: number;
  usedFields: number;
  /** Percentage 0-100, one decimal place. */
  percent: number;
  unused: UnusedField[];
  deprecatedStillUsed: DeprecatedUse[];
}

/** Compute field coverage of a schema by a set of recorded operations. */
export function computeCoverage(schema: Schema, index: UsageIndex): CoverageReport {
  let totalFields = 0;
  let usedFields = 0;
  const unused: UnusedField[] = [];
  const deprecatedStillUsed: DeprecatedUse[] = [];

  const typeNames = [...schema.types.keys()].sort();
  for (const typeName of typeNames) {
    const def = schema.types.get(typeName);
    if (!def || (def.kind !== "object" && def.kind !== "interface")) continue;
    const fieldNames = [...def.fields.keys()].sort();
    for (const fieldName of fieldNames) {
      totalFields += 1;
      const users = index.fieldUses.get(`${typeName}.${fieldName}`);
      if (!users || users.size === 0) {
        unused.push({ type: typeName, field: fieldName });
        continue;
      }
      usedFields += 1;
      const fieldDef = def.fields.get(fieldName);
      if (fieldDef && fieldDef.deprecationReason !== null) {
        const ops: OpRef[] = [];
        for (const opId of [...users].sort()) {
          const op = index.ops.get(opId);
          if (op) ops.push(op);
        }
        deprecatedStillUsed.push({
          type: typeName,
          field: fieldName,
          reason: fieldDef.deprecationReason,
          ops,
        });
      }
    }
  }

  const percent = totalFields === 0 ? 100 : Math.round((usedFields / totalFields) * 1000) / 10;
  return { totalFields, usedFields, percent, unused, deprecatedStillUsed };
}
