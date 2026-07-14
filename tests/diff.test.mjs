// Schema diff: every rule in the change catalog, the safe/breaking
// nullability directions, and the no-cascade / determinism guarantees.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { codePaths, diffOf, findChange } from "./helpers.mjs";

const Q = "type Query { ok: Boolean! }\n";

test("identical schemas produce zero changes", () => {
  const sdl = Q + "type User { id: ID! name: String }";
  assert.deepEqual(diffOf(sdl, sdl), []);
});

test("B101/S301: type removed and added; removal does not cascade into fields", () => {
  const changes = diffOf(Q + "type A { x: Int y: Int }", Q + "type B { id: ID! }");
  // One change for the removed type — no B103 noise for x and y.
  assert.deepEqual(codePaths(changes), ["B101 A", "S301 B"]);
});

test("B102: kind change is reported once, without member-level noise", () => {
  const changes = diffOf(
    Q + "type A { id: ID! }\ntype B { id: ID! }\nunion U = A | B",
    Q + "type A { id: ID! }\ntype B { id: ID! }\ntype U { id: ID! }"
  );
  assert.deepEqual(codePaths(changes), ["B102 U"]);
  assert.equal(findChange(changes, "B102").message, 'type "U" changed kind from union to object');
});

test("B103/S302: field removed and field added", () => {
  const changes = diffOf(Q + "type T { a: Int b: Int }", Q + "type T { b: Int c: Int }");
  assert.deepEqual(codePaths(changes), ["B103 T.a", "S302 T.c"]);
});

test("B104 vs S305: output nullability direction decides; list shape always breaks", () => {
  // Loosening an output (String! -> String) breaks clients...
  const loosened = diffOf(Q + "type T { a: String! }", Q + "type T { a: String }");
  assert.equal(findChange(loosened, "B104", "T.a").severity, "breaking");
  // ...tightening it (String -> String!) is compatible.
  const tightened = diffOf(Q + "type T { a: String }", Q + "type T { a: String! }");
  assert.equal(findChange(tightened, "S305", "T.a").severity, "safe");
  // Wrapping in a list changes the response shape: always breaking.
  const listed = diffOf(Q + "type T { a: String }", Q + "type T { a: [String] }");
  findChange(listed, "B104", "T.a");
});

test("B105 vs S303: a new argument breaks only when it is required", () => {
  const changes = diffOf(
    Q + "type T { f: Int g: Int h: Int }",
    Q + "type T { f(must: ID!): Int g(may: ID): Int h(dflt: ID! = \"x\"): Int }"
  );
  assert.deepEqual(codePaths(changes), ["B105 T.f(must:)", "S303 T.g(may:)", "S303 T.h(dflt:)"]);
});

test("B106/B107: argument removed; argument type change directions", () => {
  const removed = diffOf(Q + "type T { f(a: Int): Int }", Q + "type T { f: Int }");
  findChange(removed, "B106", "T.f(a:)");
  // Requiring more (Int -> Int!) breaks; requiring less (Int! -> Int) is safe.
  const required = diffOf(Q + "type T { f(a: Int): Int }", Q + "type T { f(a: Int!): Int }");
  findChange(required, "B107", "T.f(a:)");
  const relaxed = diffOf(Q + "type T { f(a: Int!): Int }", Q + "type T { f(a: Int): Int }");
  findChange(relaxed, "S305", "T.f(a:)");
});

test("B108/D201: enum value removed breaks, added is dangerous", () => {
  const changes = diffOf(Q + "enum E { A B }", Q + "enum E { B C }");
  assert.deepEqual(codePaths(changes), ["B108 E.A", "D201 E.C"]);
});

test("B109/D202 and B110/S306: union membership and implements lists", () => {
  const types = "type A { id: ID! }\ntype B { id: ID! }\ntype C { id: ID! }\n";
  const unionChanges = diffOf(Q + types + "union U = A | B", Q + types + "union U = B | C");
  assert.deepEqual(codePaths(unionChanges), ["B109 U.A", "D202 U.C"]);
  const ifaces = "interface I { id: ID! }\ninterface J { id: ID! }\n";
  const implChanges = diffOf(
    Q + ifaces + "type T implements I { id: ID! }",
    Q + ifaces + "type T implements J { id: ID! }"
  );
  assert.deepEqual(codePaths(implChanges), ["B110 T.I", "S306 T.J"]);
});

test("B111/B112/S307/B113: input field removal, addition and type rules", () => {
  const changes = diffOf(
    Q + "input In { gone: Int stays: Int }",
    Q + "input In { stays: Int need: ID! want: ID wantDflt: ID! = \"x\" }"
  );
  assert.deepEqual(codePaths(changes), [
    "B111 In.gone",
    "B112 In.need",
    "S307 In.want",
    "S307 In.wantDflt",
  ]);
  // Nullability mirrors the argument rule: requiring more breaks.
  const required = diffOf(Q + "input In { a: Int }", Q + "input In { a: Int! }");
  findChange(required, "B113", "In.a");
  const relaxed = diffOf(Q + "input In { a: Int! }", Q + "input In { a: Int }");
  findChange(relaxed, "S305", "In.a");
});

test("D203/D204: defaults changed, gained and lost are all dangerous", () => {
  const changed = diffOf(Q + "type T { f(n: Int = 10): Int }", Q + "type T { f(n: Int = 20): Int }");
  assert.match(findChange(changed, "D203").message, /changed from 10 to 20/);
  const gained = diffOf(Q + "type T { f(n: Int): Int }", Q + "type T { f(n: Int = 1): Int }");
  assert.match(findChange(gained, "D203").message, /gained a default value/);
  const lost = diffOf(Q + "type T { f(n: Int = 1): Int }", Q + "type T { f(n: Int): Int }");
  assert.match(findChange(lost, "D203").message, /lost its default value/);
  const input = diffOf(Q + "input In { n: Int = 1 }", Q + "input In { n: Int = 2 }");
  findChange(input, "D204", "In.n");
});

test("S304: deprecation added, removed and reworded are safe changes", () => {
  const added = diffOf(Q + "type T { a: Int }", Q + 'type T { a: Int @deprecated(reason: "r") }');
  assert.match(findChange(added, "S304").message, /was deprecated \("r"\)/);
  const removed = diffOf(Q + 'type T { a: Int @deprecated(reason: "r") }', Q + "type T { a: Int }");
  assert.match(findChange(removed, "S304").message, /no longer deprecated/);
  const reworded = diffOf(
    Q + 'enum E { A @deprecated(reason: "old") }',
    Q + 'enum E { A @deprecated(reason: "new") }'
  );
  assert.match(findChange(reworded, "S304").message, /changed to "new"/);
});

test("changes come out sorted: breaking, dangerous, then safe; paths alphabetical", () => {
  const changes = diffOf(
    Q + "type Z { gone: Int }\ntype A { gone: Int }\nenum E { A }",
    Q + "type Z { added: Int }\ntype A { added: Int }\nenum E { A B }"
  );
  assert.deepEqual(codePaths(changes), [
    "B103 A.gone",
    "B103 Z.gone",
    "D201 E.B",
    "S302 A.added",
    "S302 Z.added",
  ]);
});
