# Inline Row Editing — Design Spec

**Date:** 2026-08-16
**Status:** Approved, ready for implementation planning

Edit cells in the result grid. Changes stage as highlighted pending
diffs; a bottom bar shows the count with Cancel and Confirm. Applying
runs generated `UPDATE`s in one transaction. Disabled entirely on a
locked connection.

This implements the "Inline row editing" part of Section 6 of
`2026-08-13-quarry-design.md`, which calls it "the riskiest surface"
and schedules it last, and Section 9 of
`2026-08-15-write-guard-design.md`, which the guard was built to gate.

---

## 1. Motivation

Changing one value today means writing an `UPDATE` by hand, which means
writing a `WHERE` by hand, which is where the accident lives. A grid
edit that generates its own `WHERE` from the primary key cannot address
the wrong row.

The reason this ships last is the same reason it is worth shipping: a
highlighted cell and a Confirm button is the shortest path from
intention to a production write that exists in the product. Every
decision below is chosen so that the short path is also the safe one.

## 2. Where row identity comes from

**Postgres tells us. We do not parse.**

`tokio_postgres::Column` exposes `table_oid()` and `column_id()`,
populated from the server's RowDescription on every `prepare`. Postgres
sets both to `0` — which the driver maps to `None` — for anything that
is not a plain reference to a table column: expressions, aggregates,
literals, function calls.

So the question "can this result set be edited, and which table row does
each cell belong to" is answered by metadata the server already sent,
not by re-parsing the SQL the user wrote. This is the load-bearing
decision of the design. Parsing would have to independently rediscover
what `select coalesce(a.name, b.name) from a join b` means; the server
already knows, and reports `None`.

When every column agrees on one `table_oid`, one catalog query resolves
that oid:

```sql
select c.relkind, n.nspname, c.relname, a.attnum, a.attname,
       exists (
         select 1 from pg_constraint pc
         where pc.conrelid = c.oid
           and pc.contype = 'p'
           and a.attnum = any (pc.conkey)
       ) as is_pk
from   pg_class c
join   pg_namespace n on n.oid = c.relnamespace
join   pg_attribute a on a.attrelid = c.oid
where  c.oid = $1
  and  a.attnum > 0
  and  not a.attisdropped
```

The `is_pk` subquery is the same one `introspect.rs` already uses for
the schema tree, so the two agree on what a primary key is by
construction.

It lives in `schema/introspect.rs` as `lookup_table(pool, oid)`. It runs
only when the oids agree, so a single-table `SELECT` pays one small
round-trip and a join pays nothing.

**Why not the schema cache.** The sidebar's cached `Schema` is keyed by
name, holds no oids, and can be stale or unloaded. Editability must not
depend on whether the user has expanded a tree node.

## 3. Editability rules

Evaluated in order. Each failing rule carries the exact sentence shown
to the user — "read-only" without a reason is the failure mode this
list exists to prevent.

| # | Condition | Reason shown |
|---|---|---|
| 1 | No result columns | (no grid to edit) |
| 2 | Every `table_oid` is `None` | "these are computed values, not table columns" |
| 3 | Two or more distinct `table_oid`s | "this result joins 2 tables — an UPDATE cannot tell which row to change" |
| 4 | `relkind` not `r` or `p` | "this result comes from a view" |
| 5 | Table has no primary key | "table `public.events` has no primary key" |
| 6 | Some PK column absent from result | "add `id` to the query to edit these rows" |

Otherwise the result is editable, and each column is then judged:

| Condition | Cell state |
|---|---|
| `table_oid` is `None` | read-only, "computed value" |
| Its attnum appears in two result columns | both read-only, "this column appears twice in the result" |
| It is a primary-key column | read-only, "primary key" |
| Otherwise | editable |

**Views are excluded deliberately** (rule 4) even though they carry a
`table_oid`. Postgres auto-updatable views are real, but the rules
governing which views qualify are subtle, and a view that silently is
not updatable fails at apply time rather than at edit time. Better to
say so before the user types.

**Primary keys are read-only in v1.** Mechanically an edit would work —
the `WHERE` uses the original value, so `set "id" = $1 where "id" = $2`
addresses correctly. It is excluded because it is rare and it is the one
edit that can orphan a foreign key without warning. Backlog item, not a
permanent decision.

**Aliases stay editable.** `select name as n from users` produces header
`n` and attnum pointing at `name`. The generated statement must use the
attnum's real column name, never the header — `set "n" = $1` would be
wrong SQL against the right intent.

## 4. Generated SQL

One statement per edited row:

```sql
update "public"."users"
   set "email" = $1::text::"text",
       "plan"  = $2::text::"text"
 where "id" = $3::text::"int4"
returning "email", "plan"
```

### The double cast

Every value binds as `Option<String>` and Postgres's own input function
converts it. `$1::text` alone is not enough: assigning text to an
integer column raises `column "n" is of type integer but expression is
of type text`. The second cast names the column's type, taken from the
`prepare` metadata rather than from the catalog, so it is the type the
server just said the column has.

Spelling that type reuses `friendly_type_name`, so an array comes out
`text[]` and not the internal `_text`, and a custom type stays
schema-qualified.

The consequence, accepted: a value the type cannot parse fails as an
ordinary Postgres error with the real code and message
(`invalid input syntax for type integer: "abc"`). That is better than
pre-validating in the client, which would mean reimplementing every
Postgres input function badly and disagreeing with the server about
edge cases like `'  12  '::int`.

### NULL

Binding `None` produces a real `NULL`, not the string `"NULL"`. It needs
its own gesture, because for a text column typing nothing means the
empty string and the two must stay distinguishable — the grid has
rendered `NULL` distinctly since stage 1 and that promise holds here.
`⌘⌫` on a cell stages `NULL`.

### Identifier quoting

Every identifier is double-quoted with embedded quotes doubled. A table
named `my"table` is legal Postgres and must not become an injection
point on the one path that writes SQL the user did not.

### WHERE: primary key only

`where "id" = $n`, and the transaction rolls back unless the statement
reports **exactly one** affected row.

Rejected: optimistic locking on original values
(`where "id" = $1 and "email" is not distinct from $2`). It would detect
a concurrent change, but the `json` type — unlike `jsonb` — has no
equality operator, so the generated statement errors outright on any
`json` column. Carving that type out means some columns silently get
weaker checking than others, which is a worse guarantee than one
honest, uniform guarantee.

Accepted risk, stated plainly: **last write wins.** If someone changed
that same cell between fetch and apply, the edit overwrites them without
a warning. This is also what DBeaver does. The rowcount assert still
catches the case that matters more — the row being gone.

## 5. Apply

One transaction, opened with `BEGIN READ WRITE` when the connection is
`ReadOnly`-and-unlocked, exactly as `run_query` does today.

Each statement must report exactly 1 affected row. Any `0`, any `>1`,
any error → `ROLLBACK`, and the failure names the cell that caused it.
**A partial apply never happens**: if the fifth of six edits hits a
deleted row, the four that succeeded are rolled back with it. Half-
applied edits with a highlighted grid that no longer matches the
database is the state this transaction exists to make impossible.

On success, `COMMIT`, and the `RETURNING` values patch the grid in
place. This costs nothing extra — same round-trip — and keeps scroll
position and sort. It also shows the truth rather than the input: a
`BEFORE UPDATE` trigger that rewrites the value, a `numeric(10,2)` that
rounds it, a domain that coerces it, all land in the grid as what the
database actually stored.

### Guard interaction

Three layers, unchanged in spirit from the write-guard spec:

1. **UI** — on a locked connection, cells do not enter edit mode and the
   bottom bar never appears.
2. **The apply command calls `guard::decide`** on the generated
   statements before running anything, and refuses with the guard's own
   denial error kind. It does not trust the frontend to have disabled
   itself.
3. **`default_transaction_read_only=on`** refuses underneath both, from
   Postgres itself.

Layer 2 is the point the write-guard spec made in advance: "Inline
editing, two stages away, will issue `UPDATE`s through a path that does
not exist yet." This is that path, and it crosses the same chokepoint as
every other statement.

## 6. Frontend

### Modules

`src/lib/pendingEdits.ts` — pure, unit-tested. Holds the staging map
keyed by row and column, the count, the payload built for IPC, and
**revert detection**: editing a cell back to its original value removes
the pending change rather than staging a no-op `UPDATE`.

No new component-test harness. The grid component stays thin; every
decision it makes lives in the pure module.

### Grid

Double-click or Enter opens an inline input on an editable cell. Esc
cancels. Enter or Tab commits to pending. Pending cells are highlighted.
Read-only cells carry their reason as a tooltip; a grid-level reason
(rules 1–6) shows in the status bar, so "why can't I edit this" is
always answerable without guessing.

### Bottom bar

```
3 pending changes          [View SQL]   [Cancel]   [Confirm]
```

Confirm applies immediately. **`View SQL` is optional, not a gate.**

The original design spec made the SQL review mandatory before applying.
Dropping that to an affordance follows the write-guard spec's own
reasoning against a "confirm each write" policy: a modal on a routine
path gets dismissed reflexively, and a dismissed modal is worse than no
modal because it looks like a safeguard. The lock is the safeguard. The
review stays available for when it is actually wanted.

`View SQL` calls a `preview_edits` command that runs the same generator
`apply` runs. Not a second implementation — a preview that can drift
from what executes is worse than no preview.

## 7. Rust module layout

New `src-tauri/src/edit/`:

| File | Purity | Responsibility |
|---|---|---|
| `decide.rs` | pure | column metadata + table facts → editable, or a reason |
| `sql.rs` | pure | pending cells → statements and bound params |
| `apply.rs` | impure | transaction, rowcount assert, `RETURNING` |

`decide.rs` and `sql.rs` take plain data — no pool, no state, no
`async`. Same shape as `guard`, and for the same reason: it makes the
case table exhaustive rather than representative.

`QueryResult` gains an `edit` field carrying the decision, so the
frontend never computes editability itself.

## 8. Testing

**Pure Rust units.** One test per branch of the rule table in §3,
including: join, aggregate-only, view, missing PK, PK not selected,
aliased column, duplicate attnum, computed column beside real ones.
Cast-target spelling for arrays and custom types. Identifier quoting
with an embedded `"`. `NULL` versus empty string. Several cells in one
row; several rows in one batch.

**Against a real Postgres** (testcontainers, Docker must be running):

- an edit lands, and the grid receives the stored value
- a `BEFORE UPDATE` trigger's rewrite comes back through `RETURNING`
- a row deleted mid-flight makes rowcount 0 and rolls back **the whole
  batch**, including edits that would have succeeded
- a locked connection refuses apply at the command, with the
  classifier's own denial
- an unlocked connection succeeds
- setting a text column to `NULL` differs from setting it to `''`

**TypeScript.** `pendingEdits` under Vitest, including revert detection.

**Mutation evidence required** for the rowcount-assert test and the
guard-refusal test specifically. Both have the shape that passes
trivially when the code under them is deleted, which is the shape of the
four already found in this project. Delete the assert, watch the test
fail, restore it.

## 9. Out of scope

- **`INSERT` and `DELETE` from the grid.** Insert needs an empty pending
  row, `NOT NULL`/default awareness, and returning a generated key;
  delete needs its own affordance and pending rendering. Both are
  cheaper once this machinery exists. Backlog.
- **Editing primary keys** (see §3).
- **Optimistic concurrency** (see §4).
- **Multi-statement execution**, still, from the write-guard spec.
- **Editing a joined result via its base tables.** Rule 3 refuses it.
