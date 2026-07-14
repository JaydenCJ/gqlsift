// Shared factories for the test suite. Everything is deterministic and
// in-memory; only the CLI tests touch the filesystem, in fresh temp dirs.
import { parseSchema, parseOperations, diffSchemas, buildUsageIndex, assessChanges } from "../dist/index.js";

/** Parse SDL into a schema model. */
export function schema(sdl) {
  return parseSchema(sdl);
}

/** Parse an operations document with a stable fake filename. */
export function ops(src, file = "ops.graphql") {
  return parseOperations(src, file);
}

/** Diff two SDL strings. */
export function diffOf(oldSdl, newSdl) {
  return diffSchemas(parseSchema(oldSdl), parseSchema(newSdl));
}

/** The (code, path) pairs of a change list, for terse assertions. */
export function codePaths(changes) {
  return changes.map((c) => `${c.code} ${c.path}`);
}

/** Find exactly one change by code (and optional path); throws otherwise. */
export function findChange(changes, code, path) {
  const matches = changes.filter((c) => c.code === code && (path === undefined || c.path === path));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${code}${path ? ` at ${path}` : ""}, found ${matches.length}`);
  }
  return matches[0];
}

/** Diff old vs new SDL and assess against recorded operation sources. */
export function assess(oldSdl, newSdl, opSources) {
  const oldSchema = parseSchema(oldSdl);
  const changes = diffSchemas(oldSchema, parseSchema(newSdl));
  const docs = opSources.map((src, i) => parseOperations(src, `ops-${i}.graphql`));
  const index = buildUsageIndex(oldSchema, docs);
  return assessChanges(changes, index);
}

/** Hits for the single change with the given code, as "level name" strings. */
export function hitsFor(assessed, code, path) {
  const matches = assessed.filter((a) => a.change.code === code && (path === undefined || a.change.path === path));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${code}${path ? ` at ${path}` : ""}, found ${matches.length}`);
  }
  return matches[0].hits.map((h) => `${h.level} ${h.op.name ?? "(anonymous)"}`);
}

/** A compact SDL used by many impact/lint tests. */
export const LIB_SDL = `
type Query {
  book(id: ID!): Book
  books(genre: Genre = FICTION, first: Int): [Book!]!
  find(where: BookFilter!): [Book!]!
}
type Mutation {
  addBook(input: BookInput!): Book!
}
interface Node { id: ID! }
type Book implements Node {
  id: ID!
  title: String!
  genre: Genre!
  author: Author
  reviews(first: Int = 5): [Review!]!
}
type Author implements Node {
  id: ID!
  name: String!
}
type Review {
  id: ID!
  stars: Int!
  blurb: String @deprecated(reason: "Use body")
}
union Hit = Book | Author
enum Genre { FICTION NONFICTION POETRY }
input BookFilter { genre: Genre, titleLike: String }
input BookInput { title: String!, genre: Genre }
`;
