// Lexer: token kinds, positions, ignored tokens, and the loud failure
// modes that keep bad input from becoming silent misparses.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lex, GraphQLSyntaxError } from "../dist/index.js";

function kinds(src) {
  return lex(src).map((t) => `${t.kind}:${t.value}`);
}

/** Run fn, assert it throws a GraphQLSyntaxError, and return the error. */
function capture(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GraphQLSyntaxError, `expected GraphQLSyntaxError, got ${e}`);
    return e;
  }
  assert.fail("expected an error");
}

test("names, punctuators and the spread token are recognized", () => {
  assert.deepEqual(kinds("query Q { ...frag }"), [
    "name:query",
    "name:Q",
    "punct:{",
    "punct:...",
    "name:frag",
    "punct:}",
    "eof:",
  ]);
});

test("commas and comments are ignored; tokens carry 1-based line/col", () => {
  assert.deepEqual(kinds("a, b # trailing comment\n c"), ["name:a", "name:b", "name:c", "eof:"]);
  const tokens = lex("a\n  bb");
  assert.deepEqual(
    tokens.slice(0, 2).map((t) => [t.line, t.col]),
    [[1, 1], [2, 3]]
  );
});

test("number literals: int vs float, exponents, and malformed forms rejected", () => {
  assert.deepEqual(kinds("42 -7 3.14 1e10 2.5E-3"), [
    "int:42",
    "int:-7",
    "float:3.14",
    "float:1e10",
    "float:2.5E-3",
    "eof:",
  ]);
  assert.throws(() => lex("007"), GraphQLSyntaxError); // leading zeros
  assert.throws(() => lex("1."), GraphQLSyntaxError); // digitless fraction
  assert.throws(() => lex("1.e3"), GraphQLSyntaxError);
  // `123abc` must not silently become int 123 + name abc.
  assert.throws(() => lex("123abc"), GraphQLSyntaxError);
});

test("string escapes are decoded; unterminated strings fail with a position", () => {
  const tokens = lex('"a\\"b\\\\c\\nd\\u0041"');
  assert.equal(tokens[0].kind, "string");
  assert.equal(tokens[0].value, 'a"b\\c\ndA');
  const err = capture(() => lex('x "oops'));
  assert.equal(err.line, 1);
  assert.throws(() => lex('"bad \\q escape"'), GraphQLSyntaxError);
});

test("block strings: common-indent stripping, blank edge lines, and the \\\"\"\" escape", () => {
  const dedented = lex('"""\n    Hello,\n      world.\n    """');
  assert.equal(dedented[0].value, "Hello,\n  world.");
  const escaped = lex('"""quote: \\""" done"""');
  assert.equal(escaped[0].value, 'quote: """ done');
});

test("line counting stays correct after a multi-line block string", () => {
  const tokens = lex('"""\na\nb\n"""\nname');
  const nameTok = tokens.find((t) => t.kind === "name");
  assert.equal(nameTok.line, 5);
});

test("unexpected characters report line and column", () => {
  const err = capture(() => lex("a\n  %"));
  assert.equal(err.line, 2);
  assert.equal(err.col, 3);
});
