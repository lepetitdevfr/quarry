# Quarry — Design Spec

**Date:** 2026-08-13
**Status:** Approved, ready for implementation planning

A desktop PostgreSQL client. Fast, keyboard-first, with an Insomnia-style query
library and a safety guard that makes accidental writes to production
structurally difficult.

---

## 1. Motivation

DBeaver is the incumbent and it fails on four counts:

1. **Heavy** — Java/Eclipse startup and memory cost.
2. **Clunky UX** — panel sprawl, buried features.
3. **Weak query workflow** — saved SQL is easy to lose track of.
4. **No environment safety** — nothing structural stops a query intended for
   dev from running against prod.

Quarry targets exactly these. It is not a general-purpose multi-database IDE.

## 2. Scope

**v1 supports PostgreSQL only.** Other engines are out of scope. The connection
layer stays behind a trait so a second engine is possible later, but no work is
done toward it now.

### In scope

- Connect to Postgres; credentials in the macOS Keychain; connection-URL paste.
- Saved query library: collections, named queries, persistent tabs.
- Environments with `{{variable}}` substitution.
- Safety guard: production connections are read-only until explicitly unlocked.
- Schema browser with schema-aware autocomplete.
- Result grid with inline row editing (last feature to ship).
- Export to CSV / JSON / SQL INSERT.
- Query history, searchable.
- Command palette.

### Out of scope for v1

- SSH tunnels. (Explicitly deferred. If a target DB is only reachable via a
  bastion, use an external tunnel and connect to the forwarded local port.)
- TLS certificate configuration UI. `sslmode` is honored when present in a
  pasted connection URL (via `rustls`), but there is no UI for CA/client cert
  paths.
- ERD diagrams, data import, migration tooling, multi-database joins.
- Non-Postgres engines, including MySQL, SQLite, and MongoDB.
- Windows and Linux builds. macOS only for v1.

## 3. Architecture

Tauri: a Rust core with a React/TypeScript UI.

```
┌─ React + TypeScript (Vite) ─────────────┐
│  sidebar: schema tree, then query tree  │
│  tabs · CodeMirror 6 editor             │
│  virtualized result grid                │
└─────────── Tauri IPC (typed) ───────────┘
┌─ Rust core ─────────────────────────────┐
│  conn     — connection manager, pooling │
│  guard    — statement safety chokepoint │
│  exec     — execution, streaming, cancel│
│  schema   — introspection + cache       │
│  library  — collections, envs, history  │
│  secrets  — macOS Keychain access       │
└─────────────────────────────────────────┘
```

**Why Rust-heavy.** The safety guard must not be bypassable by a UI bug. Placing
it below the IPC boundary means every path to a socket crosses it. Rust also
serializes large result sets far more cheaply than a JS layer would.

**Rejected alternatives.**

- *TypeScript-heavy* (Rust as a dumb socket proxy): faster to build, but the
  guard would live in the most bug-prone layer, and large result sets would
  cross IPC as JSON. Rejected — safety is a core requirement.
- *Hybrid* (Rust executes, TS owns the library via the fs plugin): splits
  storage logic across two languages for no benefit.

### Module boundaries

Each Rust module is independently testable with a narrow public interface.

| Module    | Responsibility                                | Depends on      |
|-----------|-----------------------------------------------|-----------------|
| `conn`    | Connection config, pool, lifecycle, policy tag | `secrets`      |
| `guard`   | Classify SQL, allow/deny by policy             | nothing (pure)  |
| `exec`    | Run, stream rows, timeout, cancel              | `conn`, `guard` |
| `schema`  | Introspect catalogs, cache per connection      | `conn`          |
| `library` | Collections, queries, envs, history (SQLite)   | `secrets`       |
| `secrets` | Keychain read/write                            | nothing         |

`guard` depends on nothing and is a pure function. That is deliberate: it makes
exhaustive testing trivial.

### Storage

- **SQLite** at `~/Library/Application Support/com.quarry.app/workspace.db` —
  collections, queries, environments, tab state, history.
- **Mirrored `.sql` files** under a workspace directory, kept in sync from the
  SQLite source of truth, so queries are greppable and git-friendly. The UI
  never displays a file path and never asks the user to manage files.
- **Keychain** — connection passwords and any environment value whose key
  matches `/secret|password|token|key/i`. Never written to SQLite.

## 4. Safety guard

The central feature. Every statement passes one chokepoint in Rust.

### Policy

Each connection carries one policy:

| Policy     | Behavior                                            |
|------------|-----------------------------------------------------|
| `Free`     | Everything runs. Default for local and staging.      |
| `ReadOnly` | Writes rejected until unlocked. Default for prod.    |

There is deliberately no middle "confirm each write" policy: a confirmation
modal on a routine path gets dismissed reflexively, which is the failure mode
this feature exists to prevent. The lock is the whole mechanism.

### Algorithm

1. Parse the buffer with the `sqlparser` crate into individual statements.
2. **Parse failure on a `ReadOnly` connection is a denial.** Unclassifiable SQL
   is not executed.
3. Classify each statement:
   - **Read:** `SELECT` (without `FOR UPDATE`/`FOR SHARE`), `EXPLAIN` without
     `ANALYZE`, `SHOW`, `WITH` whose body and all CTEs are reads.
   - **Write:** everything else — `INSERT`/`UPDATE`/`DELETE`/`MERGE`, all DDL,
     `TRUNCATE`, `COPY ... FROM`, `SELECT INTO`, `CALL`, `DO`, `GRANT`,
     `SELECT ... FOR UPDATE`, and any `WITH` containing a data-modifying CTE.
   - **Unknown:** treated as a write.
4. On `ReadOnly`, any write or unknown → deny, quoting the offending statement.

### Defense in depth

Classification alone is not trusted. `ReadOnly` connections additionally:

- set `default_transaction_read_only = on` on session start, and
- wrap execution in `BEGIN READ ONLY`.

A classifier miss is then still rejected by Postgres itself.

### Unlock

- Per connection, per session. Never persisted — restarting relocks.
- Requires typing the connection name to confirm.
- Auto-relocks after 30 minutes; the banner shows a live countdown.
- While unlocked, the window chrome turns red.

### Environment signaling

Environments carry a color (local green, staging amber, prod red) that tints the
header bar and sidebar, so the current target is visible before running anything.

## 5. Query library

Modeled on Insomnia. The user manages named objects, never files.

### Structure

`Workspace → Collection (nestable folders) → Query`

Queries have names, not filenames. Drag to reorder or move between collections.

### Tabs

- Clicking a query opens it in a tab.
- Tabs persist across restarts, including scroll position and cursor.
- Edits autosave continuously to a draft. There are no save prompts and no
  unsaved-changes dialogs.

### Environments and variables

Environments are workspace-level named key/value sets. Each binds to one
connection and carries the environment color and policy. One environment
is active at a time, selected from a header dropdown.

Queries use `{{var}}` placeholders, resolved two ways:

- **Environment variables** — taken from the active environment.
- **Prompt variables** — any unresolved name appears as an input field above the
  editor, filled at run time.

**Substitution is parameterized, not textual.** `{{user_id}}` compiles to `$1`
with a bound parameter, so a variable value cannot inject SQL or break quoting.

**Identifier exception:** a variable in an identifier position (table or column
name) cannot be parameterized by Postgres. These fall back to textual
interpolation, are validated against `^[A-Za-z_][A-Za-z0-9_$]*$`, rejected if
they fail, and marked with a warning badge in the editor.

Environment values whose key matches `/secret|password|token|key/i` are masked in
the UI and stored in the Keychain.

### History

Separate from the library. Every executed statement is logged with connection,
environment, duration, row count, and timestamp. Searchable; any entry can be
promoted to a saved query in one action. This is the recovery path for ad-hoc
queries that were never named.

## 6. Interface

```
┌──────────────────────────────────────────────────────────┐
│ [local ▾]  connection: kolecto-dev            ⌘K search   │
├────────────┬─────────────────────────────────────────────┤
│ SCHEMA   ▾ │ ▸ users by plan  ×  ▸ untitled  ×            │
│ ▾ public   ├─────────────────────────────────────────────┤
│   users    │  select * from users where plan = {{plan}}   │
│   invoices │                                             │
├────────────┼─── plan: [pro         ]  ⌘↵ Run ────────────┤
│ QUERIES  ▾ │  id   email          plan   created_at       │
│ ▾ billing  │  1    a@b.co         pro    2026-01-04       │
│   mrr      │  2    c@d.co         pro    2026-02-11       │
│ ▾ users    ├─────────────────────────────────────────────┤
│   by plan  │ 2 rows · 14ms · local          [Export ▾]    │
└────────────┴─────────────────────────────────────────────┘
```

### Sidebar

Schema on top, Queries below, separated by a draggable splitter whose position
persists. Each section collapses independently. Schema has focus on launch.
`⌘1` and `⌘2` jump between sections.

Schema tree is lazy-loaded and cached per connection, with a filter box.
Double-clicking a table opens a tab running `select * from <table> limit 500`.
A table detail view shows columns, types, indexes, foreign keys, and DDL.

### Editor

CodeMirror 6 with the Postgres dialect. Autocomplete draws real table and column
names from the introspector and resolves aliases. `⌘↵` runs the statement under
the cursor; `⇧⌘↵` runs the whole buffer.

### Result grid

Windowed rendering for smooth scrolling on large results. `NULL` renders
distinctly from an empty string. JSON and JSONB cells expand into a side panel.
Column sort and filter operate client-side on the fetched page.

### Inline row editing

Editable only when both conditions hold:

1. The result set maps to exactly one table, and
2. that table has a primary key.

Otherwise the grid is read-only and displays the reason. Edits stage as pending
diffs (highlighted cells) until applied; applying first shows the generated
`UPDATE` statements for review, then executes them in a single transaction.
Disabled entirely on `ReadOnly` connections. This is the riskiest surface and
ships last.

### Export

CSV, JSON, or SQL `INSERT` statements. Either the fetched page or a full
re-run streamed directly to a file.

### Command palette

`⌘K` searches saved queries, schema objects, and history.

## 7. Execution and errors

**Flow:** run → guard check → acquire pooled connection → execute with a
statement timeout (default 30s, per-connection override) → stream rows into Rust
→ deliver the first 500 to the UI → fetch more on scroll.

Long-running queries display elapsed time and a Cancel button that issues a real
Postgres cancel request, not merely a UI abandon.

**Errors** surface with the Postgres error code, message, and character
position; the editor underlines the offending token. Connection loss is detected
and the affected tab offers Reconnect. Guard denials render as a distinct banner
naming the rule that fired, never as a generic error.

## 8. Testing

- **Guard** — pure-function unit tests, exhaustive by design. Every write form
  gets a test asserting denial under `ReadOnly`: data-modifying CTEs, `DO`
  blocks, `SELECT INTO`, all DDL, `CALL`, `COPY ... FROM`,
  `SELECT ... FOR UPDATE`, and unparseable input.
- **Rust integration** — `testcontainers` runs a real Postgres per test run,
  covering introspection, execution, cancellation, and row editing against
  actual server behavior.
- **TypeScript** — Vitest for pure logic (variable substitution, tree
  operations); Playwright for critical flows (connect, run, save, unlock).
- **CI** — the full suite runs on every commit.

## 9. Build order

Each stage is independently usable.

1. Connect, run, result grid — a minimal working tool.
2. Query library, tabs, persistence.
3. Environments, variables, safety guard.
4. Schema tree, schema-aware autocomplete.
5. History, command palette, export.
6. Inline row editing.

## 10. Stack

| Layer      | Choice                                             |
|------------|----------------------------------------------------|
| Shell      | Tauri 2                                            |
| Core       | Rust — `tokio-postgres`, `deadpool-postgres`, `sqlparser`, `rusqlite`, `security-framework`, `rustls` |
| UI         | React 19, TypeScript, Vite                         |
| Editor     | CodeMirror 6                                       |
| Grid       | TanStack Virtual                                   |
| Test       | `cargo test`, `testcontainers`, Vitest, Playwright |
| Platform   | macOS (Apple Silicon)                              |

## 11. Notes and assumptions

- The name "quarry" is a working title and is cheap to change before release.
- The developer is new to Rust. Implementation favors plain, explicit code over
  clever abstractions; non-obvious ownership and async details get comments.
- The connection layer sits behind a trait to leave room for a second engine,
  but no v1 work targets one.
