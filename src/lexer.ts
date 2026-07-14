/**
 * GraphQL lexer shared by the SDL and executable-document parsers.
 * Covers the token grammar of the October 2021 GraphQL spec: names,
 * int/float literals, string and block-string literals with escapes, the
 * punctuator set, and the ignored tokens (whitespace, commas, comments,
 * BOM). Every token carries a 1-based line/column for diagnostics.
 */

export interface Token {
  kind: "name" | "int" | "float" | "string" | "punct" | "eof";
  value: string;
  line: number;
  col: number;
}

export class GraphQLSyntaxError extends Error {
  readonly line: number;
  readonly col: number;
  constructor(message: string, line: number, col: number) {
    super(message);
    this.name = "GraphQLSyntaxError";
    this.line = line;
    this.col = col;
  }
}

const PUNCT = new Set(["!", "$", "&", "(", ")", ":", "=", "@", "[", "]", "{", "}", "|"]);

function isNameStart(ch: string): boolean {
  return ch === "_" || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isNameContinue(ch: string): boolean {
  return isNameStart(ch) || (ch >= "0" && ch <= "9");
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/** Tokenize a GraphQL source string. Always ends with a single `eof` token. */
export function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  if (src.charAt(0) === "﻿") i = 1; // BOM

  const col = (at: number): number => at - lineStart + 1;
  const err = (msg: string, at: number): never => {
    throw new GraphQLSyntaxError(msg, line, col(at));
  };

  while (i < src.length) {
    const ch = src.charAt(i);

    // Ignored tokens: whitespace, commas, comments.
    if (ch === " " || ch === "\t" || ch === "\r" || ch === ",") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      i += 1;
      line += 1;
      lineStart = i;
      continue;
    }
    if (ch === "#") {
      while (i < src.length && src.charAt(i) !== "\n") i += 1;
      continue;
    }

    const startCol = col(i);

    // Spread punctuator.
    if (ch === "." ) {
      if (src.startsWith("...", i)) {
        tokens.push({ kind: "punct", value: "...", line, col: startCol });
        i += 3;
        continue;
      }
      err(`unexpected character "."`, i);
    }

    if (PUNCT.has(ch)) {
      tokens.push({ kind: "punct", value: ch, line, col: startCol });
      i += 1;
      continue;
    }

    if (isNameStart(ch)) {
      const start = i;
      while (i < src.length && isNameContinue(src.charAt(i))) i += 1;
      tokens.push({ kind: "name", value: src.slice(start, i), line, col: startCol });
      continue;
    }

    if (ch === "-" || isDigit(ch)) {
      const start = i;
      if (ch === "-") i += 1;
      if (!isDigit(src.charAt(i))) err(`invalid number: expected a digit after "-"`, i);
      if (src.charAt(i) === "0" && isDigit(src.charAt(i + 1))) {
        err("invalid number: leading zeros are not allowed", i);
      }
      while (isDigit(src.charAt(i))) i += 1;
      let isFloat = false;
      if (src.charAt(i) === ".") {
        isFloat = true;
        i += 1;
        if (!isDigit(src.charAt(i))) err(`invalid number: expected a digit after "."`, i);
        while (isDigit(src.charAt(i))) i += 1;
      }
      if (src.charAt(i) === "e" || src.charAt(i) === "E") {
        isFloat = true;
        i += 1;
        if (src.charAt(i) === "+" || src.charAt(i) === "-") i += 1;
        if (!isDigit(src.charAt(i))) err("invalid number: malformed exponent", i);
        while (isDigit(src.charAt(i))) i += 1;
      }
      // A number must not run straight into a name (`123abc`).
      if (isNameStart(src.charAt(i))) err("invalid number: unexpected trailing characters", i);
      tokens.push({
        kind: isFloat ? "float" : "int",
        value: src.slice(start, i),
        line,
        col: startCol,
      });
      continue;
    }

    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const startLine = line;
        const { value, end, linesCrossed, lastLineStart } = readBlockString(src, i, err);
        tokens.push({ kind: "string", value, line: startLine, col: startCol });
        line += linesCrossed;
        if (linesCrossed > 0) lineStart = lastLineStart;
        i = end;
        continue;
      }
      const start = i;
      i += 1;
      let out = "";
      for (;;) {
        if (i >= src.length) err("unterminated string", start);
        const c = src.charAt(i);
        if (c === "\n") err("unterminated string (newline in single-quoted string)", i);
        if (c === '"') {
          i += 1;
          break;
        }
        if (c === "\\") {
          const esc = src.charAt(i + 1);
          switch (esc) {
            case '"': out += '"'; break;
            case "\\": out += "\\"; break;
            case "/": out += "/"; break;
            case "b": out += "\b"; break;
            case "f": out += "\f"; break;
            case "n": out += "\n"; break;
            case "r": out += "\r"; break;
            case "t": out += "\t"; break;
            case "u": {
              const hex = src.slice(i + 2, i + 6);
              if (!/^[0-9A-Fa-f]{4}$/.test(hex)) err(`invalid unicode escape "\\u${hex}"`, i);
              out += String.fromCharCode(parseInt(hex, 16));
              i += 4;
              break;
            }
            default:
              err(`invalid escape sequence "\\${esc}"`, i);
          }
          i += 2;
          continue;
        }
        out += c;
        i += 1;
      }
      tokens.push({ kind: "string", value: out, line, col: startCol });
      continue;
    }

    err(`unexpected character ${JSON.stringify(ch)}`, i);
  }

  tokens.push({ kind: "eof", value: "", line, col: col(i) });
  return tokens;
}

/**
 * Read a `"""block string"""` starting at `start`, applying the spec's
 * common-indent stripping so descriptions read the way they were written.
 */
function readBlockString(
  src: string,
  start: number,
  err: (msg: string, at: number) => never
): { value: string; end: number; linesCrossed: number; lastLineStart: number } {
  let i = start + 3;
  let raw = "";
  let linesCrossed = 0;
  let lastLineStart = start;
  for (;;) {
    if (i >= src.length) err("unterminated block string", start);
    if (src.startsWith('\\"""', i)) {
      raw += '"""';
      i += 4;
      continue;
    }
    if (src.startsWith('"""', i)) {
      i += 3;
      break;
    }
    const c = src.charAt(i);
    if (c === "\n") {
      linesCrossed += 1;
      lastLineStart = i + 1;
    }
    raw += c;
    i += 1;
  }

  // Common-indent stripping (GraphQL spec "BlockStringValue()").
  const lines = raw.split("\n");
  let commonIndent: number | null = null;
  for (let n = 1; n < lines.length; n += 1) {
    const l = lines[n] ?? "";
    const indent = l.length - l.trimStart().length;
    if (indent < l.length && (commonIndent === null || indent < commonIndent)) {
      commonIndent = indent;
    }
  }
  const out = lines.map((l, n) => (n === 0 ? l : l.slice(commonIndent ?? 0)));
  while (out.length > 0 && (out[0] ?? "").trim() === "") out.shift();
  while (out.length > 0 && (out[out.length - 1] ?? "").trim() === "") out.pop();
  return { value: out.join("\n"), end: i, linesCrossed, lastLineStart };
}
