/**
 * Complexity scoring for recorded operations. Three signals per operation:
 *
 * - `depth`  — the deepest chain of nested selection sets (fragments are
 *              transparent: spreading a fragment does not add a level).
 * - `fields` — total field selections, counting each fragment spread's
 *              fields at every spread site (that is what the server pays).
 * - `cost`   — a weighted score: every field costs 1, and a field whose
 *              return type is a list multiplies the cost of its children
 *              by the literal `first`/`last`/`limit` argument when one is
 *              present, or by `listFactor` (default 10) when unbounded.
 *
 * The model is deliberately simple and fully deterministic: the point is a
 * stable CI threshold, not a perfect execution estimate.
 */

import {
  baseTypeName,
  lookupType,
  type Document,
  type OpRef,
  type Schema,
  type Selection,
  type TypeRef,
} from "./types.js";

export interface ComplexityOptions {
  /** Multiplier for unbounded list fields. */
  listFactor: number;
}

export const DEFAULT_LIST_FACTOR = 10;

export interface OperationScore {
  op: OpRef;
  depth: number;
  fields: number;
  cost: number;
}

/** Score every operation in the given documents. Deterministic order. */
export function scoreDocuments(
  schema: Schema,
  docs: Document[],
  opts: ComplexityOptions = { listFactor: DEFAULT_LIST_FACTOR }
): OperationScore[] {
  const scores: OperationScore[] = [];
  for (const doc of docs) {
    for (const op of doc.operations) {
      const rootName =
        op.operation === "query"
          ? schema.queryType
          : op.operation === "mutation"
            ? schema.mutationType
            : schema.subscriptionType;
      const result = scoreSelections(schema, doc, opts, rootName, op.selections, new Set());
      scores.push({
        op: { file: doc.file, name: op.name, operation: op.operation },
        depth: result.depth,
        fields: result.fields,
        cost: result.cost,
      });
    }
  }
  return scores;
}

interface Tally {
  cost: number;
  fields: number;
  depth: number;
}

function scoreSelections(
  schema: Schema,
  doc: Document,
  opts: ComplexityOptions,
  parentName: string | null,
  selections: Selection[],
  activeFragments: Set<string>
): Tally {
  const parent = parentName === null ? null : lookupType(schema, parentName);
  let cost = 0;
  let fields = 0;
  let depth = 0;

  for (const sel of selections) {
    if (sel.kind === "field") {
      fields += 1;
      const fieldDef =
        parent && (parent.kind === "object" || parent.kind === "interface")
          ? parent.fields.get(sel.name)
          : undefined;
      if (!sel.selections) {
        cost += 1;
        depth = Math.max(depth, 1);
        continue;
      }
      const childParent = fieldDef ? baseTypeName(fieldDef.type) : null;
      const child = scoreSelections(schema, doc, opts, childParent, sel.selections, activeFragments);
      // One multiplier per list field, regardless of list nesting depth;
      // a literal first/last/limit bounds it.
      const multiplier = fieldDef && containsList(fieldDef.type) ? listMultiplier(sel, opts) : 1;
      cost += 1 + multiplier * child.cost;
      fields += child.fields;
      depth = Math.max(depth, 1 + child.depth);
      continue;
    }

    if (sel.kind === "inline") {
      const child = scoreSelections(
        schema,
        doc,
        opts,
        sel.typeCondition ?? parentName,
        sel.selections,
        activeFragments
      );
      cost += child.cost;
      fields += child.fields;
      depth = Math.max(depth, child.depth);
      continue;
    }

    const frag = doc.fragments.get(sel.name);
    if (!frag || activeFragments.has(sel.name)) continue; // Cycle/unknown: lint's job.
    activeFragments.add(sel.name);
    const child = scoreSelections(schema, doc, opts, frag.typeCondition, frag.selections, activeFragments);
    activeFragments.delete(sel.name);
    cost += child.cost;
    fields += child.fields;
    depth = Math.max(depth, child.depth);
  }

  return { cost, fields, depth };
}

function containsList(t: TypeRef): boolean {
  if (t.kind === "list") return true;
  if (t.kind === "nonnull") return containsList(t.of);
  return false;
}

/** The literal page-size argument when present, else the list factor. */
function listMultiplier(sel: Extract<Selection, { kind: "field" }>, opts: ComplexityOptions): number {
  for (const argName of ["first", "last", "limit"]) {
    const arg = sel.args.find((a) => a.name === argName);
    if (arg && arg.value.kind === "int") return Math.max(1, arg.value.value);
  }
  return opts.listFactor;
}
