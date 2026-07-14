# gqlsift examples

A miniature but realistic scenario: `schema-v1.graphql` is what
production serves today, `operations/` holds six queries and mutations
recorded from real clients against it, and `schema-v2.graphql` is a
proposed release carrying six months of accumulated edits — additive
ones, dangerous ones, and several that break recorded clients.

## Try it

```bash
# Which changes break, and which recorded operations do they hit?
gqlsift diff examples/schema-v1.graphql examples/schema-v2.graphql --ops examples/operations

# Gate CI only on breakage that hits a real recorded operation:
gqlsift diff examples/schema-v1.graphql examples/schema-v2.graphql \
  --ops examples/operations --fail-on impacted

# The same drift, seen from the operations' side:
gqlsift lint --schema examples/schema-v2.graphql examples/operations

# Complexity scores — Feed is the deep one:
gqlsift score --schema examples/schema-v1.graphql examples/operations --max-cost 1000

# What does nobody query anymore?
gqlsift coverage --schema examples/schema-v2.graphql examples/operations
```

## What is seeded where

| Edit in v2 | Code | Verdict against the recorded operations |
|---|---|---|
| `User.email` removed | B103 | breaks `GetUser` |
| `User.nickname` removed | B103 | unreferenced — nobody queries it |
| `Comment.text` made nullable | B104 | breaks `Search` and `Feed` |
| `Query.search` gains required `scope:` | B105 | breaks `Search` |
| `Role.GUEST` removed | B108 | breaks `ListGuests` (literal), may-break `UsersByRole` (variable) |
| `CreatePostInput.authorId` (required) added | B112 | may-break `CreatePost` (input arrives via `$input`) |
| `Role.OWNER` added | D201 | may-break `GetUser` (reads `role`) |
| `SearchResult` gains `Comment` | D202 | may-break `Search` |
| `User.posts(first:)` default 10 → 20 | D203 | may-break `Feed` (relies on the default) |
| `Post.body` deprecated; `Team`, `SearchScope`, `User.team` added | S304/S301/S302 | safe |
