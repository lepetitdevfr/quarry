# Table Detail Tabs — Design Spec

**Date:** 2026-08-15
**Status:** Approved, ready for implementation planning

Clicking a table in the schema tree opens a tab showing that table's
structure — columns, indexes, constraints — with a toggle to its data.
Today the tree is the only place structure is visible, and it shows one
level at a time.

---

## 1. Motivation

The schema tree answers "does this column exist?" It does not answer
"what does this table look like?" Indexes and constraints are already
introspected and cached, but nothing renders them: the tree shows
columns only. A user who wants to know whether a lookup is indexed has
to leave Quarry or write a `pg_indexes` query by hand.

Double-clicking a table already opens a data preview tab. This stage
adds the other half — the structure — and makes the two modes of looking
at a table one thing rather than two.

## 2. Scope

### In scope

- A new tab kind that targets a table rather than a query.
- A structure view: columns, indexes, constraints, rendered from the
  schema cache the frontend already holds.
- A `Structure | Data` toggle inside that tab; Data reuses the existing
  preview `SELECT` path unchanged.
- Persistence of table tabs across restart, via a v3→v4 migration.

### Out of scope

- **New introspection.** Row-count estimates (`pg_class.reltuples`),
  on-disk size (`pg_total_relation_size`), table and column comments,
  triggers, and dependent views are all deliberately excluded. Each
  needs a new catalog query and a round-trip per table open; the three
  sections that ship here need neither. These go to the backlog.
- Editing structure. Nothing here issues DDL.
- Views and materialised views, which are still excluded from the tree
  by the `relkind` filter — that backlog item is unchanged by this
  stage.

## 3. Storage

`tabs` gains three nullable columns, added with the existing
`add_column_if_missing` helper in `library/db.rs`:

| Column          | Type   | Meaning                                     |
|-----------------|--------|---------------------------------------------|
| `target_schema` | text   | Schema of the targeted table                |
| `target_table`  | text   | Table name                                  |
| `mode`          | text   | `structure` or `data`                       |

A tab is a **table tab** when `target_table` is non-NULL. Ordinary query
tabs leave all three NULL and are untouched.

`SCHEMA_VERSION` goes 3 → 4. Unlike v2→v3, this migration deletes
nothing — it only adds columns.

**Two target columns, not one qualified string.** A Postgres identifier
may contain dots and quotes, so a single `public.users` string cannot be
split back into its parts unambiguously. The second column costs nothing
now and cannot be retrofitted cheaply later.

**Before running the migration against the real workspace database, back
it up with `sqlite3 <db> ".backup <out>.db"`.** Never `cp` — a plain
copy of a WAL database can capture a file with no tables in it.

### Model

`Tab` in `library/model.rs` gains:

```rust
pub target_schema: Option<String>,
pub target_table: Option<String>,
pub mode: Option<TableMode>,
```

and a new enum beside `Tag`:

```rust
pub enum TableMode { Structure, Data }
```

`TableMode::from_stored` follows `Tag::from_stored`'s precedent and
resolves anything unrecognised to `Structure` — the mode that runs no
SQL. A corrupted row must not silently execute a query.

`title` already exists to label preview tabs and carries the table name
here. `query_id` and `scratch_sql` stay NULL: a table tab has no editor
buffer.

## 4. Commands

No new introspection — `refresh_schema` already gathers everything the
structure view renders, and the whole `Schema` is already sent to the
frontend for autocomplete.

Two commands, mirroring `open_preview_tab`:

- `open_table_tab(schema, table, mode) -> Vec<Tab>`
- `set_tab_mode(id, mode) -> Vec<Tab>`

Both return the full tab list, as every other tab command does.

### Preview reuse

Single-click opens a **preview** table tab (`is_preview = 1`), reused by
the next single-click. Without this, arrowing through a large tree
would open a tab per row.

A table tab is promoted to an ordinary tab by either of:

- opening it with a double-click (Data mode), or
- toggling its mode.

Both are deliberate acts on a specific table, unlike a single click
while navigating. This mirrors the promote-on-edit rule that preview
query tabs already use; a table tab has no editor, so the trigger
differs but the intent is the same.

## 5. Frontend

### `TableView.tsx`

Renders from the cached `Schema` already held in frontend state. Three
sections:

- **Columns** — name, type, nullable, default, primary-key badge, and
  for a single-column foreign key, `schema.table.column` of its target.
  Composite foreign keys appear under Constraints instead, which is
  what the existing `Column::references` doc comment already promises.
- **Indexes** — name, unique and primary badges, and the
  `pg_get_indexdef` definition text.
- **Constraints** — grouped by `pg_constraint.contype` (primary,
  foreign, unique, check, exclusion), with the `pg_get_constraintdef`
  text.

An empty section reads "None" rather than rendering blank, so the view
distinguishes "no indexes" from "not loaded".

### Wiring

`App.tsx` renders `TableView` in place of `SqlEditor` + `ResultGrid`
when the active tab has a target. Data mode reuses the existing
`previewSql` + `execute` + `ResultGrid` path with no change.

`SchemaTree` single-click on a table row opens a structure tab in
addition to its existing expand toggle. Double-click replaces its
current `openPreview` call with `open_table_tab(..., Data)`.

### Missing target

The schema cache is cleared on every connection change, and a table can
be dropped between refreshes. When the active tab's target is not in the
current schema, the view shows `public.users is not in this database`
and a Refresh action.

Table tabs are never silently closed or dropped on a failed lookup: a
tab disappearing on its own is worse than a tab explaining itself.

## 6. Testing

**Rust**

- The v3→v4 migration adds all three columns and preserves existing tab
  rows, which keep NULL targets.
- Migrating twice is a no-op (extends the existing test).
- `open_table_tab` reuses the preview slot rather than accumulating tabs.
- Double-click promotion and toggle promotion each clear `is_preview`.
- `mode` round-trips through storage.
- `TableMode::from_stored` resolves unknown input to `Structure`.

**TypeScript**

- `TableView` renders all three sections from a fixture schema.
- Empty index and constraint lists render "None".
- A target absent from the schema renders the empty state.
- The mode toggle calls `setTabMode`.

## 7. Deferred to the backlog

- Live table stats: estimated row count, on-disk size, table and column
  comments.
- Triggers and dependent views (`pg_depend`).
- Copy `CREATE TABLE` DDL — already on the backlog, and this view is
  where it would naturally live once the assembly work is done.
