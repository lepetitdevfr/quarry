# Schema Tree and Autocomplete — Design Spec

**Date:** 2026-08-14
**Status:** Approved, ready for implementation planning

Browse a database's structure in the sidebar, and complete table and column
names in the editor from that same structure.

---

## 1. Motivation

The Schema section of the sidebar is a placeholder reading "Schema browsing
arrives in Stage 4". Writing a query today means remembering every table and
column name, or leaving the app to look them up.

This stage fills that section and feeds the same data to the editor, so
autocomplete offers real names instead of nothing.

It also settles a debt from the Stage 1 review: arrays and enums currently
render as `<unsupported type: _int4>` in the result grid. Both are common in
real schemas, and this is the natural moment to fix them.

## 2. Scope

### In scope

- Schemas → tables → columns, with types, nullability, defaults, and PK/FK markers
- Indexes and constraints under each table, with their real definitions
- A filter box matching schemas, tables, and columns
- Manual refresh
- Context-aware autocomplete: tables after `FROM`/`JOIN`, columns after
  `SELECT`/`WHERE`/`ON`, alias resolution for `u.`
- Array and enum rendering in the result grid

### Out of scope

- **Views and materialised views.** Deliberately excluded. Note this means a
  view can be queried but never seen in the tree — the filter is one `relkind`
  character away if that turns out to be annoying.
- Functions, procedures, sequences, enum type definitions as browsable objects
- Double-clicking a table to open a preview query (`select * … limit 500`).
  The original design spec promised this; it is deferred to `docs/BACKLOG.md`.
- Inserting a name into the editor by clicking the tree
- Copying `CREATE TABLE` DDL
- Editing schema objects — Quarry browses, it does not migrate
- Persisting the schema to disk between sessions
- Completion for keywords, functions, or SQL syntax beyond identifiers

## 3. Decisions

**Introspect on connect, cache in memory, refresh manually.** One round of
catalog queries when a connection is established, held in `AppState` beside the
active connection, dropped on disconnect. A refresh button re-reads it after a
migration.

**Not persisted to SQLite.** The schema is derived data, cheap to rebuild, and a
stale schema on disk is worse than no schema: it would autocomplete columns that
no longer exist.

**Three focused queries, not one aggregate.** Columns, indexes, and constraints
are read separately and assembled in Rust. A single `json_agg` query would save
two round-trips at the cost of being unreadable and hard to test. The cost is
paid once per connect — milliseconds locally, well under a second remotely.

**`pg_catalog`, not `information_schema`.** Faster, and it exposes
`pg_get_indexdef` and `pg_get_constraintdef`, which return the real definitions
rather than something reassembled from parts.

**CodeMirror's built-in SQL schema support drives autocomplete.**
`@codemirror/lang-sql` already detects clause context and resolves aliases.
Hand-writing a SQL context parser would take days and land somewhere worse.

## 4. Data model

```rust
pub struct Schema {
    pub schemas: Vec<SchemaNode>,
}

pub struct SchemaNode {
    pub name: String,
    pub tables: Vec<Table>,
}

pub struct Table {
    pub schema: String,
    pub name: String,
    pub columns: Vec<Column>,
    pub indexes: Vec<Index>,
    pub constraints: Vec<Constraint>,
}

pub struct Column {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub is_primary_key: bool,
    /// Present when this column has a single-column foreign key.
    pub references: Option<ForeignKey>,
}

pub struct ForeignKey {
    pub schema: String,
    pub table: String,
    pub column: String,
}

pub struct Index {
    pub name: String,
    /// From `pg_get_indexdef` — the real definition, not a reconstruction.
    pub definition: String,
    pub is_unique: bool,
    pub is_primary: bool,
}

pub struct Constraint {
    pub name: String,
    /// `p`, `f`, `u`, `c`, or `x`, as `pg_constraint.contype`.
    pub kind: String,
    /// From `pg_get_constraintdef`.
    pub definition: String,
}
```

Ordinary and partitioned tables only (`relkind in ('r', 'p')`). The schemas
`pg_catalog`, `information_schema`, and anything matching `pg_toast%` or
`pg_temp%` are excluded.

## 5. Architecture

### Modules

| File | Responsibility |
|---|---|
| `src-tauri/src/schema/mod.rs` | Module re-exports |
| `src-tauri/src/schema/model.rs` | The types above — plain data |
| `src-tauri/src/schema/introspect.rs` | The three catalog queries and assembly |
| `src-tauri/src/exec/value.rs` | *(modify)* array and enum rendering |
| `src-tauri/src/commands.rs` | *(modify)* `schema` and `refresh_schema` commands |
| `src/lib/schema.ts` | Flatten and filter the tree; build the CodeMirror schema object |
| `src/lib/schema.test.ts` | Vitest for both |
| `src/components/SchemaTree.tsx` | The virtualized tree |
| `src/components/Sidebar.tsx` | *(modify)* replace the placeholder |
| `src/components/SqlEditor.tsx` | *(modify)* accept and apply the schema |
| `src/hooks/useSchema.ts` | Fetch on connect, refresh, loading state |

`schema/` sits beside `conn/` and `exec/` rather than inside either: it depends
on a pool but has one job, reading the catalog.

### Commands

| Command | JS arguments | Returns |
|---|---|---|
| `schema` | — | `Schema \| null` |
| `refresh_schema` | — | `Schema` |

`schema` returns the cache, or `null` when nothing is connected.
`refresh_schema` re-runs introspection and replaces it.

### Caching

`AppState` gains `schema: Mutex<Option<Schema>>`, cleared by `set_active` on
every connection change so a stale schema can never outlive its database. The
frontend fetches after a successful connect.

Introspection failure is **not** a connect failure: a user without catalog
permissions should still be able to run queries. The tree shows the error with a
retry, and autocomplete stays empty.

## 6. Interface

```
│ SCHEMA              ⟳ │
│ ⌕ filter…             │
│ ▾ public              │
│   ▸ invoices          │
│   ▾ users             │
│      id      int4  PK │
│      email   text     │
│      plan_id int4  ↗  │
│      created timestamp│
│     ▸ indexes (2)     │
│     ▸ constraints (3) │
│ ▸ analytics           │
```

Single click expands a node in place. Columns show name, type, and markers: `PK`
for primary keys, `↗` for a foreign key whose tooltip names the referenced
table and column. Nullable columns render dimmer than `NOT NULL` ones. Indexes
and constraints are collapsed groups showing their definitions when opened.

The filter matches schemas, tables, and columns, auto-expanding matches — typing
`email` reveals every table containing such a column.

The tree renders as one flat virtualized list. A 400-table schema with columns
expanded runs to thousands of rows; the result grid already establishes this
pattern.

Refresh shows a spinner in place of the `⟳` and leaves the previous tree visible
while it runs, rather than blanking the sidebar.

## 7. Autocomplete

On connect the introspected schema is converted into the object
`@codemirror/lang-sql` expects: qualified table names mapped to their column
lists, with `public` as the default schema so `users` completes unqualified.

Behaviour that follows from that:

- tables after `FROM`, `JOIN`, `UPDATE`, `INSERT INTO`
- columns after `SELECT`, `WHERE`, `ON`, `GROUP BY`, `ORDER BY`
- `u.` after `from users u` offers that table's columns only
- each completion carries its type as detail text, e.g. `email  text`

The schema object is rebuilt on connect, switch, and refresh, and emptied on
disconnect — never offering names from a database you are no longer attached to.

## 8. Array and enum rendering

Closing a Stage 1 review finding. Both currently render as
`<unsupported type: …>`.

**Arrays:** decode element-wise for `int2/4/8`, `float4/8`, `numeric`, `text`,
`varchar`, `bool`, `uuid`, `date`, `timestamp`, and `timestamptz`; render as a
JSON array so `{1,2,3}` becomes `[1,2,3]`. Arrays of unhandled element types keep
the placeholder.

**Enums:** a last-resort `FromSql` implementation that accepts any type and
reads the bytes as UTF-8. Enum labels transmit as their text, so they decode
correctly. This runs only after every known-type branch has been tried, and
anything that is not valid UTF-8 still yields the visible placeholder — never a
silent null.

## 9. Errors

| Case | Behavior |
|---|---|
| Introspection fails on connect | Connection succeeds; tree shows the error and a retry; autocomplete empty |
| No permission on a schema | That schema is absent; the rest of the tree loads |
| Refresh fails | Previous tree stays; error shown; nothing is cleared |
| Disconnected | Tree shows "Not connected"; autocomplete empty |

## 10. Testing

- **Introspection** against a real Postgres via testcontainers, using a fixture
  schema built to exercise the shape: composite primary key, foreign key across
  schemas, unique index, partial index, check constraint, nullable and defaulted
  columns, an array column, and an enum type. Assertions cover the returned
  structure and that system schemas are filtered out.
- **Value rendering**: extend the existing type-conversion test with array and
  enum columns, including an empty array, an array containing NULL, and a
  multi-dimensional array (which must degrade visibly rather than lie).
- **TypeScript**: tree flattening and filtering, and construction of the
  CodeMirror schema object — both pure functions, vitest, no Tauri runtime.
- **Regression**: the existing 102 Rust and 29 TS tests stay green.

## 11. Build order

1. Introspection module and its tests — the foundation
2. Array and enum rendering — independent, immediately visible
3. Commands and caching in `AppState`
4. TypeScript schema helpers with tests
5. The tree component
6. Wiring autocomplete into the editor

## 12. Deferred

To `docs/BACKLOG.md`: views in the tree, double-click to preview a table,
insert-name-at-cursor, and copy-DDL. Also still open: moving queries between
collections, the visual design pass, and the production write-guard — which
remains the largest outstanding risk now that switching to a production database
takes two clicks.
