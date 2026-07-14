# Change catalog and lint rules

Every diagnostic gqlsift emits carries a stable code. Codes are API:
they are never renumbered or repurposed; new rules get new codes. This
document is the authoritative list, with the reasoning behind each
classification.

## Severity model

| Severity | Meaning |
|---|---|
| **breaking** (B1xx) | Some conforming client that worked against the old schema stops working. |
| **dangerous** (D2xx) | No query becomes invalid, but observable behavior or response values change under existing clients. |
| **safe** (S3xx) | Purely additive or informational; every existing client keeps working unchanged. |

With `--ops`, each breaking/dangerous change additionally gets an impact
verdict against the recorded operations:

- **breaks** — the operation provably stops working (it selects the
  removed field, passes the removed enum literal, uses the field that
  gained a required argument, ...).
- **may-break** — the deciding value flows through a variable, so it is
  only visible at runtime (an enum fed by `$var`, an input object built
  client-side, an operation relying on a changed default).
- **unreferenced** — no recorded operation touches what changed. Under
  `--fail-on impacted`, these do not fail the gate.

## Breaking changes (B1xx)

| Code | Kind | Fires when |
|---|---|---|
| B101 | TYPE_REMOVED | a named type disappears (fields of removed types are not re-reported — the type is the root cause) |
| B102 | TYPE_KIND_CHANGED | a name is reused as a different kind (e.g. union → object) |
| B103 | FIELD_REMOVED | an object/interface field disappears |
| B104 | FIELD_TYPE_CHANGED | an output type changes incompatibly (incl. `T!` → `T`; list shape changes) |
| B105 | REQUIRED_ARG_ADDED | a field gains a non-null argument without a default — every recorded use of the field breaks |
| B106 | ARG_REMOVED | an argument disappears |
| B107 | ARG_TYPE_CHANGED | an argument type changes incompatibly (incl. `T` → `T!`) |
| B108 | ENUM_VALUE_REMOVED | an enum value disappears |
| B109 | UNION_MEMBER_REMOVED | a union loses a member (fragments on it stop matching) |
| B110 | INTERFACE_IMPL_REMOVED | a type stops implementing an interface |
| B111 | INPUT_FIELD_REMOVED | an input-object field disappears |
| B112 | REQUIRED_INPUT_FIELD_ADDED | an input object gains a non-null field without a default |
| B113 | INPUT_FIELD_TYPE_CHANGED | an input field type changes incompatibly (incl. `T` → `T!`) |

Nullability direction matters and is position-dependent: tightening an
**output** (`String` → `String!`) is safe, loosening it breaks; for
**inputs** (arguments, input fields) it is the mirror image. The
compatible direction is reported as S305 instead.

## Dangerous changes (D2xx)

| Code | Kind | Fires when |
|---|---|---|
| D201 | ENUM_VALUE_ADDED | clients matching exhaustively on the enum may break; verdicts flag operations that read the enum |
| D202 | UNION_MEMBER_ADDED | same reasoning, for `__typename` matching |
| D203 | ARG_DEFAULT_CHANGED | changed, gained or lost; verdicts flag only operations that rely on the default (use the field, omit the argument) |
| D204 | INPUT_FIELD_DEFAULT_CHANGED | as D203, for input-object fields |

## Safe changes (S3xx)

| Code | Kind |
|---|---|
| S301 | TYPE_ADDED |
| S302 | FIELD_ADDED |
| S303 | OPTIONAL_ARG_ADDED (nullable, or non-null with a default) |
| S304 | DEPRECATION_CHANGED (added, removed or reworded, on any position) |
| S305 | TYPE_CHANGED_SAFE (the compatible nullability direction) |
| S306 | INTERFACE_IMPL_ADDED |
| S307 | OPTIONAL_INPUT_FIELD_ADDED |

Description changes are deliberately ignored: they cannot break a client
and would drown real findings in noise.

## Lint rules (L4xx)

Errors unless marked as warnings.

| Code | Checks |
|---|---|
| L401 | field exists on its parent type (unions: points at inline fragments); nearest-name suggestion |
| L402 | argument / input-object field exists; nearest-name suggestion |
| L403 | required arguments and required input fields are provided |
| L404 | referenced types exist and have the right kind (fragment conditions composite, variable types input, operation root present) |
| L405 | every used variable is declared (fragment usage is traced to the operation) |
| L406 | *warning* — declared variables are used |
| L407 | *warning* — deprecated field / argument / enum value is used |
| L408 | fragment spreads resolve; nearest-name suggestion |
| L409 | *warning* — fragments are reachable from some operation |
| L410 | composite fields carry a selection set |
| L411 | leaf fields carry none |
| L412 | operation names are unique across the run; anonymous operations stand alone |
| L413 | enum literals are valid values and are not quoted strings |

## Scope notes (0.1.0)

- Type extensions (`extend type ...`) are rejected with an error rather
  than half-merged; flatten them before diffing.
- Variable-vs-argument type compatibility and fragment-condition
  applicability are not yet checked by `lint` (see the roadmap).
- Introspection fields (`__typename`, `__schema`, ...) are accepted and
  excluded from impact, complexity and coverage accounting.
