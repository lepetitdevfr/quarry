# Table Detail Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a table in the schema tree opens a tab showing that table's columns, indexes, and constraints, with a toggle to its data.

**Architecture:** A tab may now target a table instead of a query. Three nullable columns on `tabs` (`target_schema`, `target_table`, `mode`) carry the target; a v3→v4 SQLite migration adds them. No new introspection — the structure view renders from the `Schema` the frontend already holds for autocomplete. View logic lives in a pure module (`src/lib/tableDetail.ts`) that vitest can test directly, matching how `schema.ts`, `tree.ts`, and `layout.ts` are already tested; `TableView.tsx` stays a dumb renderer.

**Tech Stack:** Rust (rusqlite, Tauri 2 commands), React 19 + TypeScript 7, vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-table-detail-tabs-design.md`

---

## Before you start

The migration touches the developer's real workspace database the first time the app runs. Back it up first — **`cp` is not acceptable**, it misses the WAL and can capture a file with no tables in it:

```bash
sqlite3 "$HOME/Library/Application Support/com.quarry.app/workspace.db" ".backup $HOME/Library/Application Support/com.quarry.app/workspace-backup-$(date +%Y%m%d-%H%M%S).db"
```

Commands you will use throughout:

```bash
cd src-tauri && cargo test
```

```bash
npm test
```

Tests that need Postgres use testcontainers and are already in the suite; nothing in this plan adds one.

## File Structure

**Rust — create nothing, modify four files:**

- `src-tauri/src/library/model.rs` — add `TableMode` enum; add three fields to `Tab`
- `src-tauri/src/library/db.rs` — `SCHEMA_VERSION` 3→4, three `add_column_if_missing` calls, migration test
- `src-tauri/src/library/store.rs` — read/write the new columns; `open_table_tab`; `set_tab_mode`; clear target fields on the query-preview reuse path
- `src-tauri/src/commands.rs` + `src-tauri/src/lib.rs` — two new commands, registered

**Rust tests:**

- `src-tauri/tests/library_test.rs` — store behaviour
- migration tests stay inline in `db.rs`, model tests inline in `model.rs`, matching what is there now

**TypeScript — create three files, modify five:**

- Create `src/lib/tableDetail.ts` — pure view model, the only place structure logic lives
- Create `src/lib/tableDetail.test.ts` — vitest
- Create `src/components/TableView.tsx` — renders the view model, no logic
- Modify `src/types.ts` — `Tab` fields, `TableMode`
- Modify `src/lib/ipc.ts` — two calls
- Modify `src/hooks/useLibrary.ts` — two actions
- Modify `src/App.tsx` — render `TableView` when the active tab has a target
- Modify `src/components/SchemaTree.tsx` — single-click and double-click handlers
- Modify `src/App.css` — styles

---

### Task 1: `TableMode` enum

**Files:**
- Modify: `src-tauri/src/library/model.rs` (add at the end, after `Tag`)

- [ ] **Step 1: Write the failing test**

`model.rs` has no `tests` module yet. Add one at the very end of the file:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_mode_round_trips_through_storage() {
        assert_eq!(TableMode::from_stored("structure"), TableMode::Structure);
        assert_eq!(TableMode::from_stored("data"), TableMode::Data);
        assert_eq!(TableMode::Structure.as_str(), "structure");
        assert_eq!(TableMode::Data.as_str(), "data");
    }

    #[test]
    fn an_unknown_mode_is_structure() {
        // Structure runs no SQL. A corrupted row must not be able to
        // make the app execute a query on open.
        assert_eq!(TableMode::from_stored("nonsense"), TableMode::Structure);
        assert_eq!(TableMode::from_stored(""), TableMode::Structure);
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd src-tauri && cargo test --lib table_mode
```

Expected: compile error, `cannot find type TableMode in this scope`.

- [ ] **Step 3: Add the enum**

In `model.rs`, immediately after the `impl Tag { ... }` block:

```rust
/// Which face of a table a table tab is showing.
///
/// `Structure` renders from the cached schema and runs no SQL; `Data`
/// runs the preview `SELECT`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableMode {
    Structure,
    Data,
}

impl TableMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            TableMode::Structure => "structure",
            TableMode::Data => "data",
        }
    }

    /// Unrecognised values become `Structure`, following `Tag::from_stored`:
    /// a corrupted row resolves to the mode that touches no database.
    pub fn from_stored(s: &str) -> Self {
        match s {
            "data" => TableMode::Data,
            _ => TableMode::Structure,
        }
    }
}
```

`#[serde(rename_all = "lowercase")]` is what makes this cross the IPC boundary as the string `"structure"`, not `"Structure"` — the frontend union type depends on it. It is the same attribute `Tag` uses.

- [ ] **Step 4: Run the tests**

```bash
cd src-tauri && cargo test --lib table_mode && cargo test --lib an_unknown_mode
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/library/model.rs
git commit -m "feat(tabs): add a TableMode enum"
```

---

### Task 2: v3→v4 migration

**Files:**
- Modify: `src-tauri/src/library/db.rs:6` (`SCHEMA_VERSION`), `:92-93` (column adds), `:346` (an existing assertion)

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `db.rs`:

```rust
#[test]
fn adds_table_target_columns_to_an_existing_tabs_table() {
    // A real database on disk, with a real tab in it. This is exactly
    // where a migration can cost someone their work: prove both that
    // the columns arrive and that the old row is untouched.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("w.db");

    {
        // The v3 tabs table exactly as it shipped, built with raw SQL.
        // Going through open() would create the new columns for us and
        // the migration under test would never run — the test would
        // pass with the add_column_if_missing calls deleted.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "create table tabs (
                id          text primary key,
                query_id    text,
                scratch_sql text,
                position    integer not null,
                is_active   integer not null default 0,
                cursor_pos  integer not null default 0,
                is_preview  integer not null default 0,
                title       text
             );
             insert into tabs (id, query_id, scratch_sql, position, is_active, cursor_pos)
             values ('t1', null, 'select 1', 100, 1, 0);",
        )
        .unwrap();
    }

    // The real upgrade.
    let conn = open(&path).unwrap();

    let sql: String = conn
        .query_row("select scratch_sql from tabs where id = 't1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sql, "select 1", "an existing tab must survive the migration");

    let target_schema: Option<String> = conn
        .query_row("select target_schema from tabs where id = 't1'", [], |r| r.get(0))
        .unwrap();
    let target_table: Option<String> = conn
        .query_row("select target_table from tabs where id = 't1'", [], |r| r.get(0))
        .unwrap();
    let mode: Option<String> = conn
        .query_row("select mode from tabs where id = 't1'", [], |r| r.get(0))
        .unwrap();

    assert_eq!(target_schema, None, "an existing tab targets no table");
    assert_eq!(target_table, None);
    assert_eq!(mode, None);
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd src-tauri && cargo test --lib adds_table_target_columns
```

Expected: FAIL — `no such column: target_schema`.

**Then prove the test bites the right thing.** After Step 3, delete the three `add_column_if_missing` lines you added, re-run this test, and confirm it fails; restore them and confirm it passes. A migration test that passes without the migration is worse than no test, and this one is easy to write that way by accident.

- [ ] **Step 3: Migrate**

Three edits in `db.rs`.

Bump the version at line 6:

```rust
pub const SCHEMA_VERSION: i64 = 4;
```

Add the columns beside the existing `add_column_if_missing` calls (after the `title` line, around line 93):

```rust
    // v4: a tab may target a table instead of a query. Two columns
    // rather than one qualified string, because a Postgres identifier
    // may contain a dot and could not be split back apart reliably.
    add_column_if_missing(conn, "tabs", "target_schema", "text")?;
    add_column_if_missing(conn, "tabs", "target_table", "text")?;
    add_column_if_missing(conn, "tabs", "mode", "text")?;
```

Also add the three columns to the `create table if not exists tabs` block (around line 63), so a **fresh** database gets them without going through `add_column_if_missing`:

```sql
        create table if not exists tabs (
            id            text primary key,
            query_id      text references queries(id) on delete cascade,
            scratch_sql   text,
            position      integer not null,
            is_active     integer not null default 0,
            cursor_pos    integer not null default 0,
            is_preview    integer not null default 0,
            title         text,
            target_schema text,
            target_table  text,
            mode          text
        );
```

- [ ] **Step 4: Fix the existing version assertion**

`upgrading_a_v1_database_keeps_existing_rows` (near line 346) hard-codes the old version and will now fail. Change:

```rust
        assert_eq!(version, "3");
```

to:

```rust
        assert_eq!(version, "4");
```

- [ ] **Step 5: Run the whole db module**

```bash
cd src-tauri && cargo test --lib library::db
```

Expected: every test in the module passes, including `migrating_twice_is_harmless` and `purges_preview_tabs_when_the_database_is_opened`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/library/db.rs
git commit -m "feat(db): migrate tabs to v4 with a table target"
```

---

### Task 3: Carry the target on `Tab`

**Files:**
- Modify: `src-tauri/src/library/model.rs` (the `Tab` struct)
- Modify: `src-tauri/src/library/store.rs` (`tabs`, `read_tab`)
- Test: `src-tauri/tests/library_test.rs`

- [ ] **Step 1: Write the failing test**

Append to `library_test.rs`:

```rust
#[test]
fn an_ordinary_tab_targets_no_table() {
    let (s, _dir) = store();

    let tab = s.open_tab(None).unwrap();

    assert_eq!(tab.target_schema, None);
    assert_eq!(tab.target_table, None);
    assert_eq!(tab.mode, None);
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd src-tauri && cargo test --test library_test an_ordinary_tab_targets
```

Expected: compile error, `no field target_schema on type Tab`.

- [ ] **Step 3: Add the fields**

In `model.rs`, inside `struct Tab`, after `title`:

```rust
    /// Schema and table this tab targets. Both are `None` on an
    /// ordinary query tab; both are `Some` on a table tab. They move
    /// together — one set without the other is a bug, not a state.
    pub target_schema: Option<String>,
    pub target_table: Option<String>,
    /// Which face of the target is showing. `None` when there is no
    /// target.
    pub mode: Option<TableMode>,
```

- [ ] **Step 4: Read them back in `store.rs`**

Both `Store::tabs` (around line 351) and the free function `read_tab` (near the bottom of the file) run the same `select`. Update the column list in **both** to:

```sql
select id, query_id, scratch_sql, position, is_active, cursor_pos,
       is_preview, title, target_schema, target_table, mode
```

and add three lines to **both** row constructors, after `title: row.get(7)?`:

```rust
                    target_schema: row.get(8)?,
                    target_table: row.get(9)?,
                    mode: row
                        .get::<_, Option<String>>(10)?
                        .as_deref()
                        .map(TableMode::from_stored),
```

`row.get::<_, Option<String>>(10)?` reads a nullable text column into an `Option<String>`; `.as_deref()` turns `Option<String>` into `Option<&str>` so `from_stored` can be handed a borrowed string, and `.map` leaves `None` as `None`. This is the idiom to reach for whenever a nullable column becomes a typed enum.

Add `TableMode` to the existing model import at the top of `store.rs`:

```rust
use crate::library::model::{Collection, LibraryTree, Query, Tab, TableMode, POSITION_GAP};
```

- [ ] **Step 5: Run the tests**

```bash
cd src-tauri && cargo test --test library_test
```

Expected: all pass, including the new one.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/library/model.rs src-tauri/src/library/store.rs src-tauri/tests/library_test.rs
git commit -m "feat(tabs): carry a table target on Tab"
```

---

### Task 4: `open_table_tab`

**Files:**
- Modify: `src-tauri/src/library/store.rs` (after `open_preview_tab`)
- Test: `src-tauri/tests/library_test.rs`

- [ ] **Step 1: Write the failing tests**

Append to `library_test.rs`:

```rust
#[test]
fn opens_a_table_tab_in_the_preview_slot() {
    let (s, _dir) = store();

    let tabs = s
        .open_table_tab("public", "users", TableMode::Structure, false)
        .unwrap();

    assert_eq!(tabs.len(), 1);
    let tab = &tabs[0];
    assert_eq!(tab.target_schema.as_deref(), Some("public"));
    assert_eq!(tab.target_table.as_deref(), Some("users"));
    assert_eq!(tab.mode, Some(TableMode::Structure));
    assert_eq!(tab.title.as_deref(), Some("users"), "the tab is labelled by its table");
    assert_eq!(tab.query_id, None);
    assert_eq!(tab.scratch_sql, None, "a table tab stores no SQL");
    assert!(tab.is_preview, "an unpinned table tab is a preview");
    assert!(tab.is_active);
}

#[test]
fn a_second_table_tab_reuses_the_preview_slot() {
    // Clicking down a long tree must not leave a tab per row.
    let (s, _dir) = store();

    s.open_table_tab("public", "users", TableMode::Structure, false).unwrap();
    let tabs = s
        .open_table_tab("public", "events", TableMode::Structure, false)
        .unwrap();

    assert_eq!(tabs.len(), 1, "the preview slot is reused, not added to");
    assert_eq!(tabs[0].target_table.as_deref(), Some("events"));
}

#[test]
fn a_pinned_table_tab_is_not_reused() {
    let (s, _dir) = store();

    s.open_table_tab("public", "users", TableMode::Data, true).unwrap();
    let tabs = s
        .open_table_tab("public", "events", TableMode::Structure, false)
        .unwrap();

    assert_eq!(tabs.len(), 2, "the pinned tab survives");
    let pinned = tabs.iter().find(|t| t.target_table.as_deref() == Some("users")).unwrap();
    assert!(!pinned.is_preview);
    assert_eq!(pinned.mode, Some(TableMode::Data));
}

#[test]
fn a_query_preview_clears_a_table_target() {
    // One preview slot serves both kinds. Reusing it must not leave the
    // previous kind's fields behind, or a query preview would still
    // look like a table tab to the UI.
    let (s, _dir) = store();

    s.open_table_tab("public", "users", TableMode::Structure, false).unwrap();
    let tabs = s.open_preview_tab("events", "select * from events").unwrap();

    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].target_schema, None);
    assert_eq!(tabs[0].target_table, None);
    assert_eq!(tabs[0].mode, None);
    assert_eq!(tabs[0].scratch_sql.as_deref(), Some("select * from events"));
}
```

Add the import at the top of `library_test.rs`:

```rust
use quarry_lib::library::model::TableMode;
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd src-tauri && cargo test --test library_test table_tab
```

Expected: compile error, `no method named open_table_tab`.

- [ ] **Step 3: Implement**

In `store.rs`, directly after `open_preview_tab`:

```rust
    /// Open a tab targeting a table, reusing the preview slot unless
    /// `pin` is set.
    ///
    /// `pin` is what a double-click passes: an explicit "keep this one",
    /// so the next single-click in the tree opens elsewhere instead of
    /// overwriting it. The preview slot is shared with query previews,
    /// so this clears `scratch_sql` on the reuse path — otherwise a
    /// table tab would still be carrying the previous preview's SQL.
    pub fn open_table_tab(
        &self,
        schema: &str,
        table: &str,
        mode: TableMode,
        pin: bool,
    ) -> Result<Vec<Tab>, AppError> {
        let conn = self.lock();

        let existing: Option<String> = conn
            .query_row("select id from tabs where is_preview = 1 limit 1", [], |r| {
                r.get(0)
            })
            .ok();

        let is_preview = if pin { 0 } else { 1 };

        let id = match existing {
            Some(id) => {
                conn.execute(
                    "update tabs
                        set title = ?2, target_schema = ?3, target_table = ?4,
                            mode = ?5, scratch_sql = null, query_id = null,
                            cursor_pos = 0, is_preview = ?6
                      where id = ?1",
                    params![id, table, schema, table, mode.as_str(), is_preview],
                )
                .map_err(sql_err)?;
                id
            }
            None => {
                let id = new_id();
                let position: i64 = conn
                    .query_row("select coalesce(max(position), 0) + 100 from tabs", [], |r| {
                        r.get(0)
                    })
                    .map_err(sql_err)?;

                conn.execute(
                    "insert into tabs
                       (id, query_id, scratch_sql, position, is_active, cursor_pos,
                        is_preview, title, target_schema, target_table, mode)
                     values (?1, null, null, ?2, 0, 0, ?3, ?4, ?5, ?6, ?7)",
                    params![id, position, is_preview, table, schema, table, mode.as_str()],
                )
                .map_err(sql_err)?;
                id
            }
        };

        activate(&conn, &id)?;
        drop(conn);
        self.tabs()
    }
```

Then make the query-preview path clear the table fields. In `open_preview_tab`, replace the `update` in the `Some(id)` arm with:

```rust
                conn.execute(
                    "update tabs
                        set title = ?2, scratch_sql = ?3, cursor_pos = 0,
                            target_schema = null, target_table = null, mode = null
                      where id = ?1",
                    params![id, title, sql],
                )
                .map_err(sql_err)?;
```

`drop(conn)` before `self.tabs()` is not optional: `self.tabs()` takes the same lock, and holding it while calling would deadlock. The existing `open_preview_tab` does the same thing for the same reason.

- [ ] **Step 4: Run the tests**

```bash
cd src-tauri && cargo test --test library_test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/library/store.rs src-tauri/tests/library_test.rs
git commit -m "feat(tabs): open a tab targeting a table"
```

---

### Task 5: `set_tab_mode`

**Files:**
- Modify: `src-tauri/src/library/store.rs` (after `promote_tab`)
- Test: `src-tauri/tests/library_test.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn switching_mode_pins_the_tab() {
    // Toggling to Data is a deliberate act on a specific table, so the
    // tab stops being disposable — same rule as editing a query preview.
    let (s, _dir) = store();

    let tabs = s
        .open_table_tab("public", "users", TableMode::Structure, false)
        .unwrap();
    let id = tabs[0].id.clone();

    let tabs = s.set_tab_mode(&id, TableMode::Data).unwrap();

    assert_eq!(tabs[0].mode, Some(TableMode::Data));
    assert!(!tabs[0].is_preview, "switching mode pins the tab");
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd src-tauri && cargo test --test library_test switching_mode
```

Expected: compile error, `no method named set_tab_mode`.

- [ ] **Step 3: Implement**

In `store.rs`, after `promote_tab`:

```rust
    /// Switch a table tab between structure and data, pinning it.
    pub fn set_tab_mode(&self, id: &str, mode: TableMode) -> Result<Vec<Tab>, AppError> {
        self.lock()
            .execute(
                "update tabs set mode = ?2, is_preview = 0 where id = ?1",
                params![id, mode.as_str()],
            )
            .map_err(sql_err)?;
        self.tabs()
    }
```

The `self.lock()` guard is a temporary here: it is dropped at the end of the statement it appears in, before `self.tabs()` runs, so there is no deadlock. `promote_tab` above uses the same shape.

- [ ] **Step 4: Run the tests**

```bash
cd src-tauri && cargo test --test library_test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/library/store.rs src-tauri/tests/library_test.rs
git commit -m "feat(tabs): switch a table tab between structure and data"
```

---

### Task 6: Tauri commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (after `promote_tab`, around line 261)
- Modify: `src-tauri/src/lib.rs:45` (handler registration)

There is no unit test for this layer — the commands are two-line pass-throughs over `store`, which Tasks 4 and 5 already cover, and that is the existing convention (`commands.rs` says as much in its own comment). `cargo build` is the check.

- [ ] **Step 1: Add the commands**

In `commands.rs`, after `promote_tab`:

```rust
#[tauri::command]
pub fn open_table_tab(
    state: tauri::State<'_, AppState>,
    schema: String,
    table: String,
    mode: TableMode,
    pin: bool,
) -> Result<Vec<Tab>, AppError> {
    state.library.open_table_tab(&schema, &table, mode, pin)
}

#[tauri::command]
pub fn set_tab_mode(
    state: tauri::State<'_, AppState>,
    id: String,
    mode: TableMode,
) -> Result<Vec<Tab>, AppError> {
    state.library.set_tab_mode(&id, mode)
}
```

Extend the model import at the top of `commands.rs`:

```rust
use crate::library::model::{LibraryTree, Query, Tab, TableMode};
```

`TableMode` arrives from the frontend as the JSON string `"structure"` or `"data"` and deserializes through the `#[serde(rename_all = "lowercase")]` from Task 1. An unknown string is a deserialize error at the IPC boundary, which surfaces as a normal command failure — the frontend only ever sends the two.

- [ ] **Step 2: Register them**

In `lib.rs`, after `commands::promote_tab,` (line 45):

```rust
            commands::open_table_tab,
            commands::set_tab_mode,
```

- [ ] **Step 3: Build**

```bash
cd src-tauri && cargo build
```

Expected: compiles with no errors.

- [ ] **Step 4: Run the full Rust suite**

```bash
cd src-tauri && cargo test
```

Expected: everything passes (128 tests plus the ones added here).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): expose the table tab commands"
```

---

### Task 7: Frontend types and IPC

**Files:**
- Modify: `src/types.ts:56-65` (`Tab`)
- Modify: `src/lib/ipc.ts` (after `promoteTab`)
- Modify: `src/hooks/useLibrary.ts` (the `actions` object)

- [ ] **Step 1: Extend the types**

In `src/types.ts`, above `Tab`:

```ts
/** Mirrors Rust `TableMode`. */
export type TableMode = "structure" | "data";
```

and inside `interface Tab`, after `title`:

```ts
  /** Both set on a table tab, both null on a query tab. */
  target_schema: string | null;
  target_table: string | null;
  mode: TableMode | null;
```

- [ ] **Step 2: Add the IPC calls**

In `src/lib/ipc.ts`, after `promoteTab`:

```ts
export async function openTableTab(
  schema: string,
  table: string,
  mode: TableMode,
  pin: boolean,
): Promise<Tab[]> {
  return invoke<Tab[]>("open_table_tab", { schema, table, mode, pin });
}

export async function setTabMode(id: string, mode: TableMode): Promise<Tab[]> {
  return invoke<Tab[]>("set_tab_mode", { id, mode });
}
```

Add `TableMode` to the type import at the top of the file:

```ts
import type {
  Connection,
  ConnectionInfo,
  ConnectionInput,
  LibraryTree,
  Query,
  QueryResult,
  Schema,
  Tab,
  TableMode,
} from "../types";
```

- [ ] **Step 3: Add the actions**

In `src/hooks/useLibrary.ts`, in the `actions` object after `promoteTab`:

```ts
    openTableTab: async (
      schema: string,
      table: string,
      mode: TableMode,
      pin: boolean,
    ) => setTabs(await ipc.openTableTab(schema, table, mode, pin)),
    setTabMode: async (id: string, mode: TableMode) =>
      setTabs(await ipc.setTabMode(id, mode)),
```

Add `TableMode` to that file's type import alongside `Tab`.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/lib/ipc.ts src/hooks/useLibrary.ts
git commit -m "feat(ui): wire up the table tab IPC calls"
```

---

### Task 8: The view model

**Files:**
- Create: `src/lib/tableDetail.ts`
- Test: `src/lib/tableDetail.test.ts`

All the logic lives here so vitest can test it without a DOM. `TableView.tsx` in Task 9 only renders what this returns.

- [ ] **Step 1: Write the failing test**

Create `src/lib/tableDetail.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { tableDetail } from "./tableDetail";
import type { Schema } from "../types";

const schema: Schema = {
  schemas: [
    {
      name: "public",
      tables: [
        {
          schema: "public",
          name: "orders",
          columns: [
            {
              name: "id",
              type_name: "int4",
              nullable: false,
              default: "nextval('orders_id_seq')",
              is_primary_key: true,
              references: null,
            },
            {
              name: "customer_id",
              type_name: "int4",
              nullable: true,
              default: null,
              is_primary_key: false,
              references: { schema: "public", table: "customers", column: "id" },
            },
          ],
          indexes: [
            {
              name: "orders_pkey",
              definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
              is_unique: true,
              is_primary: true,
            },
          ],
          constraints: [
            { name: "orders_pkey", kind: "p", definition: "PRIMARY KEY (id)" },
            {
              name: "orders_customer_fkey",
              kind: "f",
              definition: "FOREIGN KEY (customer_id) REFERENCES customers(id)",
            },
          ],
        },
        {
          schema: "public",
          name: "bare",
          columns: [],
          indexes: [],
          constraints: [],
        },
      ],
    },
  ],
};

describe("tableDetail", () => {
  it("returns the columns of the named table", () => {
    const detail = tableDetail(schema, "public", "orders");

    expect(detail).not.toBeNull();
    expect(detail!.columns.map((c) => c.name)).toEqual(["id", "customer_id"]);
    expect(detail!.columns[0].isPrimaryKey).toBe(true);
    expect(detail!.columns[0].default).toBe("nextval('orders_id_seq')");
    expect(detail!.columns[1].referencesLabel).toBe("public.customers.id");
    expect(detail!.columns[0].referencesLabel).toBeUndefined();
  });

  it("badges indexes", () => {
    const detail = tableDetail(schema, "public", "orders");

    expect(detail!.indexes[0].badges).toEqual(["PK", "UNIQUE"]);
    expect(detail!.indexes[0].definition).toContain("btree (id)");
  });

  it("groups constraints by kind, in a stable order", () => {
    const detail = tableDetail(schema, "public", "orders");

    expect(detail!.constraints.map((g) => g.label)).toEqual(["Primary key", "Foreign key"]);
    expect(detail!.constraints[0].items[0].name).toBe("orders_pkey");
  });

  it("reports empty sections rather than omitting them", () => {
    const detail = tableDetail(schema, "public", "bare");

    expect(detail!.columns).toEqual([]);
    expect(detail!.indexes).toEqual([]);
    expect(detail!.constraints).toEqual([]);
  });

  it("returns null when the table is not in the schema", () => {
    // A dropped table, or a schema that has not loaded yet. The caller
    // shows an empty state; it must not be able to crash on undefined.
    expect(tableDetail(schema, "public", "gone")).toBeNull();
    expect(tableDetail(schema, "other", "orders")).toBeNull();
    expect(tableDetail(null, "public", "orders")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- tableDetail
```

Expected: FAIL — cannot resolve `./tableDetail`.

- [ ] **Step 3: Implement**

Create `src/lib/tableDetail.ts`:

```ts
import type { Schema } from "../types";

/**
 * The structure view's whole data model. Everything the view needs is
 * computed here so the component stays a renderer and the logic stays
 * testable without a DOM.
 */
export interface TableDetail {
  schema: string;
  name: string;
  columns: DetailColumn[];
  indexes: DetailIndex[];
  constraints: ConstraintGroup[];
}

export interface DetailColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
  /** `schema.table.column`, on single-column foreign keys only. */
  referencesLabel?: string;
}

export interface DetailIndex {
  name: string;
  definition: string;
  /** PK before UNIQUE, so the badges read the same on every row. */
  badges: string[];
}

export interface ConstraintGroup {
  kind: string;
  label: string;
  items: { name: string; definition: string }[];
}

/**
 * `pg_constraint.contype` spelled out, in the order the sections are
 * shown. A kind outside this list still renders, under its raw letter —
 * a future Postgres release adding one must not make constraints vanish.
 */
const CONSTRAINT_KINDS: [string, string][] = [
  ["p", "Primary key"],
  ["f", "Foreign key"],
  ["u", "Unique"],
  ["c", "Check"],
  ["x", "Exclusion"],
];

/**
 * Build the structure view for one table, or null when it is not in the
 * schema — a dropped table, a schema that has not loaded, or no
 * connection at all.
 */
export function tableDetail(
  schema: Schema | null,
  schemaName: string,
  tableName: string,
): TableDetail | null {
  const node = schema?.schemas.find((s) => s.name === schemaName);
  const table = node?.tables.find((t) => t.name === tableName);
  if (!table) return null;

  return {
    schema: schemaName,
    name: tableName,
    columns: table.columns.map((c) => ({
      name: c.name,
      type: c.type_name,
      nullable: c.nullable,
      default: c.default,
      isPrimaryKey: c.is_primary_key,
      referencesLabel: c.references
        ? `${c.references.schema}.${c.references.table}.${c.references.column}`
        : undefined,
    })),
    indexes: table.indexes.map((i) => ({
      name: i.name,
      definition: i.definition,
      badges: [...(i.is_primary ? ["PK"] : []), ...(i.is_unique ? ["UNIQUE"] : [])],
    })),
    constraints: groupConstraints(table.constraints),
  };
}

function groupConstraints(
  constraints: { name: string; kind: string; definition: string }[],
): ConstraintGroup[] {
  const known = CONSTRAINT_KINDS.map(([kind, label]) => ({
    kind,
    label,
    items: constraints
      .filter((c) => c.kind === kind)
      .map((c) => ({ name: c.name, definition: c.definition })),
  })).filter((g) => g.items.length > 0);

  const seen = new Set(CONSTRAINT_KINDS.map(([kind]) => kind));
  const others = constraints
    .filter((c) => !seen.has(c.kind))
    .map((c) => ({
      kind: c.kind,
      label: c.kind,
      items: [{ name: c.name, definition: c.definition }],
    }));

  return [...known, ...others];
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- tableDetail
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tableDetail.ts src/lib/tableDetail.test.ts
git commit -m "feat(ui): build the table structure view model"
```

---

### Task 9: `TableView`

**Files:**
- Create: `src/components/TableView.tsx`

- [ ] **Step 1: Write the component**

There is no component-test harness in this project (no testing-library, no jsdom) — Task 8 is what covers this behaviour, and adding a DOM test stack is out of scope for this stage. Keep every decision in `tableDetail.ts` so this stays true.

```tsx
import type { TableDetail } from "../lib/tableDetail";
import type { TableMode } from "../types";

interface Props {
  schemaName: string;
  tableName: string;
  /** Null when the table is not in the current schema. */
  detail: TableDetail | null;
  mode: TableMode;
  onModeChange: (mode: TableMode) => void;
  onRefreshSchema: () => void;
  /** Rendered under the toggle in data mode — the result grid. */
  children?: React.ReactNode;
}

export function TableView({
  schemaName,
  tableName,
  detail,
  mode,
  onModeChange,
  onRefreshSchema,
  children,
}: Props) {
  return (
    <div className="table-view">
      <header className="table-view-head">
        <span className="table-view-name">
          {schemaName}.{tableName}
        </span>
        <div className="segmented">
          <button
            className={mode === "structure" ? "active" : ""}
            onClick={() => onModeChange("structure")}
          >
            Structure
          </button>
          <button
            className={mode === "data" ? "active" : ""}
            onClick={() => onModeChange("data")}
          >
            Data
          </button>
        </div>
      </header>

      {mode === "data" ? (
        children
      ) : detail === null ? (
        <p className="table-view-empty">
          {schemaName}.{tableName} is not in this database.{" "}
          <button className="link" onClick={onRefreshSchema}>
            Refresh
          </button>
        </p>
      ) : (
        <div className="table-view-body">
          <section>
            <h3>Columns</h3>
            {detail.columns.length === 0 ? (
              <p className="none">None</p>
            ) : (
              <table className="detail-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Nullable</th>
                    <th>Default</th>
                    <th>References</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.columns.map((c) => (
                    <tr key={c.name}>
                      <td>
                        {c.name}
                        {c.isPrimaryKey && <span className="marker pk">PK</span>}
                      </td>
                      <td className="mono">{c.type}</td>
                      <td>{c.nullable ? "yes" : "no"}</td>
                      <td className="mono">{c.default ?? ""}</td>
                      <td className="mono">{c.referencesLabel ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h3>Indexes</h3>
            {detail.indexes.length === 0 ? (
              <p className="none">None</p>
            ) : (
              <ul className="detail-list">
                {detail.indexes.map((i) => (
                  <li key={i.name}>
                    <span className="detail-name">{i.name}</span>
                    {i.badges.map((b) => (
                      <span key={b} className="marker">
                        {b}
                      </span>
                    ))}
                    <code>{i.definition}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>Constraints</h3>
            {detail.constraints.length === 0 ? (
              <p className="none">None</p>
            ) : (
              detail.constraints.map((g) => (
                <div key={g.kind} className="constraint-group">
                  <h4>{g.label}</h4>
                  <ul className="detail-list">
                    {g.items.map((c) => (
                      <li key={c.name}>
                        <span className="detail-name">{c.name}</span>
                        <code>{c.definition}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors. (`TableView` is unused until Task 10; an unused *export* is not an error.)

- [ ] **Step 3: Commit**

```bash
git add src/components/TableView.tsx
git commit -m "feat(ui): render a table's structure"
```

---

### Task 10: Wire it into `App`

**Files:**
- Modify: `src/App.tsx` — imports, one derived value, the editor/grid render block around line 490

- [ ] **Step 1: Import and derive**

Add to the imports at the top of `App.tsx`:

```tsx
import { TableView } from "./components/TableView";
import { tableDetail } from "./lib/tableDetail";
import type { TableMode } from "./types";
```

After the `completionSchema` memo (around line 89), add:

```tsx
  // A tab either targets a table or holds a query buffer, never both.
  const tableTarget =
    activeTab?.target_schema && activeTab.target_table
      ? { schema: activeTab.target_schema, table: activeTab.target_table }
      : null;

  const detail = useMemo(
    () =>
      tableTarget ? tableDetail(dbSchema, tableTarget.schema, tableTarget.table) : null,
    [dbSchema, tableTarget?.schema, tableTarget?.table],
  );
```

`activeTab` is declared by the `useLibrary` destructure on line 74, so this must sit below it.

- [ ] **Step 2: Keep the editor effect off table tabs**

The effect on line 120 loads tab text into the editor. A table tab has no text, and letting it run would blank the editor buffer behind the structure view. Change its body to bail out first:

```tsx
  useEffect(() => {
    if (!activeTab) {
      setText("");
      return;
    }
    // A table tab has no editor buffer; leave the editor's text alone.
    if (activeTab.target_table) return;
    const query = queryById(activeTab.query_id);
    setText(query ? effectiveSql(query) : (activeTab.scratch_sql ?? ""));
    // Only re-run when the tab identity changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id]);
```

- [ ] **Step 3: Add the handlers**

Below `previewTable` (around line 179):

```tsx
  // Single-click in the tree: a disposable structure tab, reused by the
  // next click so navigating the tree does not open a tab per row.
  const openTableStructure = useCallback(
    async (schemaName: string, tableName: string) => {
      await actions.openTableTab(schemaName, tableName, "structure", false);
    },
    [actions],
  );

  // Double-click: data, pinned — an explicit "keep this one".
  const openTableData = useCallback(
    async (schemaName: string, tableName: string) => {
      await actions.openTableTab(schemaName, tableName, "data", true);
      await runSql(previewSql(schemaName, tableName));
    },
    [actions, runSql],
  );

  const changeTableMode = useCallback(
    async (next: TableMode) => {
      if (!activeTab || !tableTarget) return;
      await actions.setTabMode(activeTab.id, next);
      if (next === "data") await runSql(previewSql(tableTarget.schema, tableTarget.table));
    },
    [activeTab, tableTarget, actions, runSql],
  );
```

`previewSql` is already imported on line 18. The old `previewTable` callback (line 172) is now dead — delete it, along with `openPreview` from the actions it used, only if nothing else references them. Check first:

```bash
grep -rn "previewTable\|openPreview" src
```

Leave `actions.openPreview` and `ipc.openPreviewTab` in place regardless: `open_preview_tab` is still a live Rust command with tests, and Task 4 explicitly keeps its slot-sharing behaviour correct.

- [ ] **Step 4: Render the view**

Replace the editor/grid block (lines 490-497) with:

```tsx
        {tableTarget ? (
          <TableView
            schemaName={tableTarget.schema}
            tableName={tableTarget.table}
            detail={detail}
            mode={activeTab?.mode ?? "structure"}
            onModeChange={(next) => void changeTableMode(next)}
            onRefreshSchema={() => void refreshDbSchema()}
          >
            {result && <ResultGrid result={result} />}
          </TableView>
        ) : (
          <>
            <SqlEditor
              value={text}
              onChange={onChange}
              onRun={run}
              busy={busy}
              completionSchema={completionSchema}
            />
            {result && <ResultGrid result={result} />}
          </>
        )}
```

- [ ] **Step 5: Point the tree at the new handlers**

`App.tsx:414` passes `onPreviewTable={(s, t) => void previewTable(s, t)}` to `Sidebar`. Replace that line with both handlers:

```tsx
          onOpenTableStructure={(s, t) => void openTableStructure(s, t)}
          onPreviewTable={(s, t) => void openTableData(s, t)}
```

Keep the prop name `onPreviewTable` for the double-click so `SchemaTree` and `Sidebar` need only the one new prop threaded through.

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```

Expected: one error, `onOpenTableStructure does not exist` on the SchemaTree props — Task 11 adds it. If you see any other error, fix it before moving on.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat(ui): show a table tab in the main pane"
```

---

### Task 11: Tree gestures

**Files:**
- Modify: `src/components/SchemaTree.tsx` (props, and the row's `onClick` at line 133)
- Modify: `src/components/Sidebar.tsx` (thread the prop through)

- [ ] **Step 1: Add the prop**

In `SchemaTree.tsx`, add to the props interface beside `onPreviewTable` (line 13):

```tsx
  /** Single-click on a table row. */
  onOpenTableStructure: (schema: string, table: string) => void;
```

Destructure it in the component signature alongside `onPreviewTable` (line 49).

- [ ] **Step 2: Handle the click**

Replace the row's `onClick` (line 133):

```tsx
                onClick={() => {
                  // Both, deliberately: expanding and inspecting are the
                  // same intent, and a click that only did one of them
                  // would make the other need a second gesture.
                  if (row.expandable) toggle(row.id);
                  if (row.kind === "table" && row.tableSchema && row.tableName) {
                    onOpenTableStructure(row.tableSchema, row.tableName);
                  }
                }}
```

Leave `onDoubleClick` exactly as it is — `App` now points it at data mode.

- [ ] **Step 3: Thread it through `Sidebar`**

`Sidebar.tsx` declares `onPreviewTable` at line 24 and forwards it at line 40. Add `onOpenTableStructure` in both places the same way.

- [ ] **Step 4: Typecheck and test**

```bash
npx tsc --noEmit && npm test
```

Expected: no type errors; all TS tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/SchemaTree.tsx src/components/Sidebar.tsx
git commit -m "feat(ui): open a table's structure from the tree"
```

---

### Task 12: Styles

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Add the styles**

Append to `App.css`, using the existing CSS variables rather than literal colours — check the `:root` block at the top of the file and substitute the real variable names if these differ:

```css
/* ---- table detail view ---------------------------------------- */

.table-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.table-view-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.table-view-name {
  font-family: var(--font-mono);
  font-size: 13px;
}

.segmented {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.segmented button {
  padding: 3px 10px;
  font-size: 12px;
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
}

.segmented button.active {
  background: var(--surface-raised);
  color: var(--text);
}

.table-view-body {
  overflow: auto;
  padding: 12px;
}

.table-view-body section {
  margin-bottom: 20px;
}

.table-view-body h3 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  margin-bottom: 6px;
}

.table-view-body h4 {
  font-size: 12px;
  color: var(--text-dim);
  margin: 8px 0 4px;
}

.table-view-body .none {
  color: var(--text-dim);
  font-size: 13px;
}

.detail-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.detail-table th {
  text-align: left;
  font-weight: 500;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
  padding: 4px 8px;
}

.detail-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-subtle);
}

.detail-table .mono,
.detail-list code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
}

.detail-list {
  list-style: none;
  font-size: 13px;
}

.detail-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 8px;
  border-bottom: 1px solid var(--border-subtle);
}

.detail-list .detail-name {
  font-family: var(--font-mono);
  font-size: 12px;
}

.table-view-empty {
  padding: 16px;
  color: var(--text-dim);
  font-size: 13px;
}
```

- [ ] **Step 2: Look at it**

```bash
npm run tauri dev
```

Click a table in the tree: a Structure tab opens showing columns, indexes, and constraints. Click another table: the same tab is reused. Double-click a table: a pinned Data tab with rows in the grid. Toggle back to Structure: the tab stays.

- [ ] **Step 3: Commit**

```bash
git add src/App.css
git commit -m "style(ui): style the table detail view"
```

---

### Task 13: Verify the whole thing

- [ ] **Step 1: Rust**

```bash
cd src-tauri && cargo test
```

Expected: PASS. Baseline before this stage was 128 tests; this plan adds 9 (2 model, 1 migration, 1 tab fields, 4 table tab, 1 mode).

- [ ] **Step 2: TypeScript**

```bash
npm test && npx tsc --noEmit
```

Expected: PASS. Baseline was 51 tests; this plan adds 5.

- [ ] **Step 3: Clippy**

```bash
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

**This does not pass at baseline and is not expected to.** Two `dead_code` errors on `pub pool` and `pub port` in `src-tauri/tests/common/mod.rs` fail four test targets, and they failed identically at `6af8a67`, before this stage. What you are checking is that this stage adds nothing new: the output must contain those two errors and nothing else. Anything naming a file this stage touched is yours to fix.

`cargo fmt --check` is deliberately not run. The repo has never been rustfmt-formatted (19 files differ at baseline) and reformatting would bury this stage's diff. Both of these are on the backlog as their own piece of work.

- [ ] **Step 4: Migration on the real database**

Confirm the backup from the top of this plan exists, then launch the app and check the version actually moved:

```bash
sqlite3 "$HOME/Library/Application Support/com.quarry.app/workspace.db" "select value from meta where key='schema_version'; select count(*) from queries;"
```

Expected: `4`, and a query count matching what the sidebar shows. If the count is 0 while the sidebar shows queries, stop and restore the backup.

- [ ] **Step 5: Hand over for smoke testing**

Report what was built, the two test counts, and the four things to try by hand: single-click reuse, double-click pinning, the mode toggle, and a table tab surviving a restart after being pinned.

---

## Notes for the implementer

- **`is_preview` is purged at open.** `migrate` deletes every `is_preview = 1` row, so an unpinned table tab is gone after a restart and a pinned one is not. That is the intended behaviour, matching every other preview in the app — do not "fix" it.
- **One preview slot, two kinds.** Query previews and table previews share the row. That is why both open paths null out the other kind's fields, and why Task 4 tests it explicitly.
- **Do not add introspection.** Row counts, table size, comments, triggers, and dependent views are on the backlog on purpose. If a task seems to need one, the task is wrong.
