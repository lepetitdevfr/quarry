# Grid Sort and Resize — Design Spec

**Date:** 2026-08-15
**Status:** Approved, ready for implementation planning

Click a column header to sort the result. Drag a column border to resize
it, double-click to fit it to its content.

---

## 1. Motivation

The result grid renders and nothing more. Every column is as wide as the
browser decides, and rows arrive in whatever order the query produced.
Reordering by a column means editing the SQL and running it again;
reading a wide `text` column means reading it in a tooltip.

Both are constant, low-grade friction in the loop this app exists for —
run a query, look at the answer.

## 2. Scope

### In scope

- Sorting by one column, cycling ascending → descending → off.
- Column resize by dragging a border; double-click a border to fit.
- An honest marker when a sort covers only part of a truncated result.

### Out of scope

- **Multi-column sorting.** A different feature with its own
  interaction design; guessing at it now would be wrong.
- **Persisting sort or widths to disk.** Both are cosmetic state, held
  in memory. No migration, no storage layer, no IPC.
- Copy, export, and inline editing. Each is its own later stage, in that
  order, with the production write-guard before editing.

## 3. Where sorting happens

The result grid does not decide how to sort. It reports intent through
`onSortChange(columnIndex, direction)`, and `App` routes it by tab kind.

### Table tab in Data mode → re-run with `ORDER BY`

The SQL is ours. `previewSql` generates it, so it can be regenerated
with ordering:

```sql
select * from "public"."users" order by "created_at" asc limit 500
```

Nothing is parsed and nothing is wrapped. `quoteIdent` already handles
identifiers that need quoting.

This is the case that motivated the whole decision: a Data tab caps at
`LIMIT 500`, and sorting those 500 rows in memory answers a question
nobody asked. Re-running gives the true first 500 by that column.

### Query tab → sort in memory

For a user-written query, re-running is the wrong instinct in both
directions:

- The statement has **no `LIMIT`**, so the result is already complete
  and an in-memory sort is exact. A round-trip buys nothing.
- The statement has **its own `LIMIT`**, and sorting "the whole table"
  would mean stripping it — running something the user did not write.
  Wrapping it as `select * from (their sql) t order by …` sorts exactly
  the rows already on screen, at the cost of re-executing their query.

So a query tab sorts locally, and says so when the result looks
truncated.

### The two paths must agree

Nulls sort last ascending and first descending — Postgres's own default.
This is load-bearing rather than a nicety: the same data sorted through
either path must land in the same order, or the grid contradicts itself
depending on which tab you are in.

## 4. Modules

Decisions live in pure modules that vitest covers directly;
`ResultGrid` renders. This is the split that worked for the table detail
view, and it holds for the same reason: the project has no
component-test harness, so logic in a component is logic without tests.

### `src/lib/gridSort.ts`

- `compareCells(a, b)` — type-aware. Numbers numerically, strings by
  `localeCompare`, booleans false before true, JSON by its formatted
  text. A mixed-type column falls back to comparing formatted text, so
  the comparator cannot throw on real Postgres output.
- `sortedIndices(rows, columnIndex, direction)` — returns a permutation
  of row indices, not a copied array. The virtualizer keeps rendering
  from `result.rows`, so a sort costs no row copying.
- `isTruncated(result, sql)` — true when the row count equals a `LIMIT`
  in the statement. Deliberately conservative: SQL it cannot read counts
  as complete, so ordinary queries never carry a spurious warning.

### `src/lib/gridWidths.ts`

- `initialWidths(columns, rows)` — measured from the header text and a
  sample of rows, clamped to a minimum and a maximum so one long `text`
  column cannot push everything else off screen.
- `fitWidth(column, rows)` — the double-click target.
- `resized(widths, index, delta)` — resize arithmetic, clamped to the
  minimum so a column cannot vanish.

Widths are in character units, converted once at render. Nothing in
either module touches the DOM.

## 5. State

`ResultGrid` holds `sort` and `widths`, both reset when `result` changes
identity. A re-run may return different columns, so carrying either
across would be wrong.

Nothing is persisted. This follows the precedent `App.tsx` already sets
for sidebar width: "deliberately not persisted: one integer of UI state,
restored by a single drag."

Sorting a Data tab is a query execution, so it uses the existing `busy`
and error handling. **A failed sort leaves the previous result on
screen** rather than blanking the grid — losing your data because a
sort failed would be worse than the failure.

## 6. Interaction

Clicking a header cycles ascending → descending → off, so query order is
always reachable. The active column shows its direction; a truncated
client-side sort also shows a marker whose tooltip reads *sorted within
the first 500 rows fetched, not the whole table*.

The table moves to `table-layout: fixed` with a `<colgroup>`. Explicit
widths do not hold under the browser's automatic layout, which sizes
columns from content.

## 7. Testing

Both modules are pure, so vitest covers them directly.

**`gridSort`** — the cycle through ascending, descending and off;
numeric ordering (9 before 10, not after); `localeCompare` on strings;
booleans; nulls last ascending and first descending; a mixed-type column
falling back to text; a column of all nulls; stability of equal values;
`isTruncated` on a statement with a matching `LIMIT`, one with a
different `LIMIT`, one with none, and one it cannot parse.

**`gridWidths`** — initial widths clamped at both ends; a long text
column not starving its neighbours; fit-to-content; resize clamped at
the minimum.

**`previewSql`** — with and without ordering, including a column name
that needs quoting.

`ResultGrid` itself is not directly tested, for the same reason
`TableView` is not: there is no component-test harness in this project,
and adding one is not this stage's job. Keeping every decision in the
two modules is what makes that acceptable.

## 8. Stage order after this

1. **This stage** — sort and resize.
2. **Copy and export** — clipboard as TSV, then CSV/JSON/SQL to a file.
   Needs a Tauri dialog/filesystem plugin, a capability change, and
   Rust-side writing; `run_query` collects every row in memory today, so
   a streamed re-run is real backend work.
3. **The production write-guard** — Section 4 of the original design
   spec, still unbuilt.
4. **Inline row editing** — which the original spec requires be
   "disabled entirely on `ReadOnly` connections", so it follows the
   guard rather than preceding it.
