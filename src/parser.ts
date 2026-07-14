/**
 * Shared parsing infrastructure: a token cursor over the lexer output plus
 * the grammar productions common to SDL and executable documents — type
 * references, values, argument lists and directive annotations.
 */

import { GraphQLSyntaxError, lex, type Token } from "./lexer.js";
import type { Argument, TypeRef, Value } from "./types.js";

export { GraphQLSyntaxError };

export class Cursor {
  private readonly tokens: Token[];
  private i = 0;

  constructor(src: string) {
    this.tokens = lex(src);
  }

  peek(): Token {
    return this.tokens[Math.min(this.i, this.tokens.length - 1)] as Token;
  }

  next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.i += 1;
    return t;
  }

  atEnd(): boolean {
    return this.peek().kind === "eof";
  }

  isPunct(value: string): boolean {
    const t = this.peek();
    return t.kind === "punct" && t.value === value;
  }

  eatPunct(value: string): boolean {
    if (this.isPunct(value)) {
      this.next();
      return true;
    }
    return false;
  }

  expectPunct(value: string): Token {
    if (!this.isPunct(value)) this.fail(`expected "${value}"`);
    return this.next();
  }

  isName(value?: string): boolean {
    const t = this.peek();
    return t.kind === "name" && (value === undefined || t.value === value);
  }

  eatName(value: string): boolean {
    if (this.isName(value)) {
      this.next();
      return true;
    }
    return false;
  }

  expectName(what: string): Token {
    const t = this.peek();
    if (t.kind !== "name") this.fail(`expected ${what}`);
    return this.next();
  }

  /** Consume a leading string token (a description) if present. */
  eatDescription(): void {
    if (this.peek().kind === "string") this.next();
  }

  fail(msg: string): never {
    const t = this.peek();
    const got = t.kind === "eof" ? "end of input" : JSON.stringify(t.value);
    throw new GraphQLSyntaxError(`${msg}, got ${got}`, t.line, t.col);
  }
}

/** Parse a type reference: `Name`, `[Type]`, with optional `!` suffixes. */
export function parseTypeRef(cur: Cursor): TypeRef {
  let t: TypeRef;
  if (cur.eatPunct("[")) {
    const inner = parseTypeRef(cur);
    cur.expectPunct("]");
    t = { kind: "list", of: inner };
  } else {
    t = { kind: "named", name: cur.expectName("a type name").value };
  }
  if (cur.eatPunct("!")) t = { kind: "nonnull", of: t };
  return t;
}

/**
 * Parse a value literal. With `constOnly` set (SDL defaults, variable
 * defaults) variable references are rejected, per the spec's Const grammar.
 */
export function parseValue(cur: Cursor, constOnly: boolean): Value {
  const t = cur.peek();
  if (t.kind === "punct" && t.value === "$") {
    if (constOnly) cur.fail("variables are not allowed in constant values");
    cur.next();
    const name = cur.expectName("a variable name").value;
    return { kind: "variable", name, line: t.line };
  }
  if (t.kind === "int") {
    cur.next();
    return { kind: "int", value: parseInt(t.value, 10), line: t.line };
  }
  if (t.kind === "float") {
    cur.next();
    return { kind: "float", value: parseFloat(t.value), line: t.line };
  }
  if (t.kind === "string") {
    cur.next();
    return { kind: "string", value: t.value, line: t.line };
  }
  if (t.kind === "name") {
    cur.next();
    if (t.value === "true") return { kind: "boolean", value: true, line: t.line };
    if (t.value === "false") return { kind: "boolean", value: false, line: t.line };
    if (t.value === "null") return { kind: "null", line: t.line };
    return { kind: "enum", value: t.value, line: t.line };
  }
  if (t.kind === "punct" && t.value === "[") {
    cur.next();
    const items: Value[] = [];
    while (!cur.eatPunct("]")) {
      if (cur.atEnd()) cur.fail("unterminated list value");
      items.push(parseValue(cur, constOnly));
    }
    return { kind: "list", items, line: t.line };
  }
  if (t.kind === "punct" && t.value === "{") {
    cur.next();
    const fields: { name: string; value: Value }[] = [];
    while (!cur.eatPunct("}")) {
      if (cur.atEnd()) cur.fail("unterminated object value");
      const name = cur.expectName("an object field name").value;
      cur.expectPunct(":");
      fields.push({ name, value: parseValue(cur, constOnly) });
    }
    return { kind: "object", fields, line: t.line };
  }
  cur.fail("expected a value");
}

/** Parse a parenthesized argument list `(a: 1, b: $x)`; empty when absent. */
export function parseArguments(cur: Cursor, constOnly: boolean): Argument[] {
  const args: Argument[] = [];
  if (!cur.eatPunct("(")) return args;
  while (!cur.eatPunct(")")) {
    if (cur.atEnd()) cur.fail("unterminated argument list");
    const nameTok = cur.expectName("an argument name");
    cur.expectPunct(":");
    const value = parseValue(cur, constOnly);
    args.push({ name: nameTok.value, value, line: nameTok.line });
  }
  return args;
}

export interface DirectiveUse {
  name: string;
  args: Argument[];
}

/** Parse zero or more `@directive(args)` annotations. */
export function parseDirectives(cur: Cursor, constOnly: boolean): DirectiveUse[] {
  const out: DirectiveUse[] = [];
  while (cur.eatPunct("@")) {
    const name = cur.expectName("a directive name").value;
    out.push({ name, args: parseArguments(cur, constOnly) });
  }
  return out;
}

/**
 * Extract the deprecation reason from a directive list. Returns the reason
 * string when `@deprecated` is present (spec default: "No longer
 * supported"), otherwise null.
 */
export function deprecationReason(directives: DirectiveUse[]): string | null {
  for (const d of directives) {
    if (d.name !== "deprecated") continue;
    for (const a of d.args) {
      if (a.name === "reason" && a.value.kind === "string") return a.value.value;
    }
    return "No longer supported";
  }
  return null;
}
