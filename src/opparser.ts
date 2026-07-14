/**
 * Executable-document parser: turns recorded `.graphql` operation files
 * (queries, mutations, subscriptions and fragments) into the `Document`
 * model. Directives on operations, fields and fragments are kept on the
 * nodes so variable uses inside them (`@include(if: $x)`) count as uses;
 * beyond that gqlsift analyzes the type surface, not execution semantics.
 */

import { Cursor, parseArguments, parseDirectives, parseTypeRef, parseValue } from "./parser.js";
import type {
  Document,
  FragmentDef,
  OperationDef,
  OperationKind,
  Selection,
  VariableDef,
} from "./types.js";

/** Parse one operations file. Throws GraphQLSyntaxError on bad syntax. */
export function parseOperations(src: string, file: string): Document {
  const cur = new Cursor(src);
  const operations: OperationDef[] = [];
  const fragments = new Map<string, FragmentDef>();

  while (!cur.atEnd()) {
    const start = cur.peek();

    // Anonymous shorthand: a bare selection set is a query.
    if (cur.isPunct("{")) {
      operations.push({
        operation: "query",
        name: null,
        variables: [],
        directives: [],
        selections: parseSelectionSet(cur),
        line: start.line,
      });
      continue;
    }

    const kw = cur.expectName("query, mutation, subscription or fragment").value;

    if (kw === "fragment") {
      const nameTok = cur.expectName("a fragment name");
      if (nameTok.value === "on") cur.fail(`a fragment cannot be named "on"`);
      if (!cur.eatName("on")) cur.fail(`expected "on" after the fragment name`);
      const typeCondition = cur.expectName("a type condition").value;
      const directives = parseDirectives(cur, false);
      const selections = parseSelectionSet(cur);
      if (fragments.has(nameTok.value)) {
        cur.fail(`duplicate fragment definition "${nameTok.value}"`);
      }
      fragments.set(nameTok.value, {
        name: nameTok.value,
        typeCondition,
        directives,
        selections,
        line: nameTok.line,
      });
      continue;
    }

    if (kw !== "query" && kw !== "mutation" && kw !== "subscription") {
      cur.fail(`unknown definition keyword "${kw}"`);
    }
    const operation = kw as OperationKind;
    const name = cur.isName() ? cur.next().value : null;
    const variables = parseVariableDefs(cur);
    const directives = parseDirectives(cur, false);
    operations.push({
      operation,
      name,
      variables,
      directives,
      selections: parseSelectionSet(cur),
      line: start.line,
    });
  }

  return { file, operations, fragments };
}

/** Parse an optional `($id: ID!, $n: Int = 10)` variable definition list. */
function parseVariableDefs(cur: Cursor): VariableDef[] {
  const out: VariableDef[] = [];
  if (!cur.eatPunct("(")) return out;
  while (!cur.eatPunct(")")) {
    if (cur.atEnd()) cur.fail("unterminated variable definition list");
    const dollar = cur.expectPunct("$");
    const name = cur.expectName("a variable name").value;
    cur.expectPunct(":");
    const type = parseTypeRef(cur);
    const defaultValue = cur.eatPunct("=") ? parseValue(cur, true) : null;
    parseDirectives(cur, true);
    out.push({ name, type, defaultValue, line: dollar.line });
  }
  return out;
}

/** Parse a `{ ... }` selection set. */
function parseSelectionSet(cur: Cursor): Selection[] {
  cur.expectPunct("{");
  const selections: Selection[] = [];
  while (!cur.eatPunct("}")) {
    if (cur.atEnd()) cur.fail("unterminated selection set");
    selections.push(parseSelection(cur));
  }
  if (selections.length === 0) cur.fail("selection sets cannot be empty");
  return selections;
}

function parseSelection(cur: Cursor): Selection {
  const start = cur.peek();

  if (cur.eatPunct("...")) {
    // Inline fragment (with or without a type condition) or named spread.
    if (cur.isName("on")) {
      cur.next();
      const typeCondition = cur.expectName("a type condition").value;
      const directives = parseDirectives(cur, false);
      return { kind: "inline", typeCondition, directives, selections: parseSelectionSet(cur), line: start.line };
    }
    if (cur.isName()) {
      const name = cur.next().value;
      const directives = parseDirectives(cur, false);
      return { kind: "spread", name, directives, line: start.line };
    }
    // `... @include(if: $x) { ... }` — condition-less inline fragment.
    const directives = parseDirectives(cur, false);
    return { kind: "inline", typeCondition: null, directives, selections: parseSelectionSet(cur), line: start.line };
  }

  const first = cur.expectName("a field name");
  let alias: string | null = null;
  let name = first.value;
  if (cur.eatPunct(":")) {
    alias = first.value;
    name = cur.expectName("a field name after the alias").value;
  }
  const args = parseArguments(cur, false);
  const directives = parseDirectives(cur, false);
  const selections = cur.isPunct("{") ? parseSelectionSet(cur) : null;
  return { kind: "field", alias, name, args, directives, selections, line: first.line };
}
