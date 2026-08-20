# Never lose work — implementation plan

> **For agentic workers:** this repository works inline in the main thread; see
> `CLAUDE.md`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Closing a tab stops destroying what you typed, and every statement you
run is recorded, searchable and restorable.

**Architecture:** One new SQLite table, `recent`, holding two kinds of row —
`run` (an executed statement, repeats collapsed) and `closed` (a closed tab's
unsaved text). Writes happen at two chokepoints already in the code:
`commands::execute` and `Store::close_tab`. The read side returns every row and
a pure frontend module decides ordering and filtering. The sidebar's bottom
section becomes tabbed, `Queries | History`.

**Tech stack:** Rust (rusqlite, tauri commands), React 19 + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-never-lose-work-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `src-tauri/src/library/db.rs` | Schema v5: create `recent` and its indexes (modify) |
| `src-tauri/src/library/model.rs` | `RecentItem`, `RecentKind` (modify) |
| `src-tauri/src/library/store/recent.rs` | All `recent` reads and writes (create) |
| `src-tauri/src/library/store/mod.rs` | `mod recent;` (modify, one line) |
| `src-tauri/src/library/store/tabs.rs` | `close_tab` records before deleting (modify) |
| `src-tauri/src/commands.rs` | `execute` records runs; `list_recent`, `delete_recent` (modify) |
| `src-tauri/src/lib.rs` | Register the two new commands (modify) |
| `src-tauri/tests/recent_test.rs` | Store-level behaviour (create) |
| `src/types.ts` | `RecentItem` mirror (modify) |
| `src/lib/ipc.ts` | `execute(sql, generated)`, `listRecent`, `deleteRecent` (modify) |
| `src/lib/recent.ts` | Grouping, ordering, filtering — the pure decision (create) |
| `src/lib/recent.test.ts` | Its tests (create) |
| `src/components/RecentList.tsx` | The list, its filter box and context menu (create) |
| `src/components/Sidebar.tsx` | Bottom section becomes tabbed (modify) |
| `src/App.tsx` | Load recent, open a tab from a row, delete a row (modify) |
| `src/App.css` | Section tabs, row styling (modify) |

---

## Task 1: The `recent` table

**Files:**
- Modify: `src-tauri/src/library/db.rs`
- Test: `src-tauri/src/library/db.rs` (its own `mod tests`)

- [ ] **Step 1: Write the failing test**

Add to the `mod tests` block in `db.rs`, following the shape of
`upgrading_a_v1_database_keeps_existing_rows`:

```rust
#[test]
fn upgrading_a_v4_database_adds_recent_and_keeps_existing_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.db");

    // A v4 database: everything except `recent`.
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "create table tabs (
                id          text primary key,
                query_id    text,
                scratch_sql text,
                position    integer not null,
                is_active   integer not null default 0,
                cursor_pos  integer not null default 0
             );
             insert into tabs (id, query_id, scratch_sql, position, is_active, cursor_pos)
             values ('t1', null, 'select 1', 100, 1, 0);",
        )
        .unwrap();
    }

    let conn = open(&path).unwrap();

    let sql: String = conn
        .query_row("select scratch_sql from tabs where id = 't1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sql, "select 1", "an existing tab must survive the migration");

    // The new table exists and takes a row.
    conn.execute(
        "insert into recent (id, kind, sql, first_at, last_at, run_count)
         values ('r1', 'run', 'select 2', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', 1)",
        [],
    )
    .unwrap();

    let version: i64 = conn
        .query_row("select value from meta where key = 'schema_version'", [], |r| {
            r.get::<_, String>(0).map(|v| v.parse().unwrap())
        })
        .unwrap();
    assert_eq!(version, 5);
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd src-tauri && cargo test --lib upgrading_a_v4_database
```

Expected: FAIL — `no such table: recent`.

- [ ] **Step 3: Add the table and bump the version**

In `db.rs`, change `pub const SCHEMA_VERSION: i64 = 4;` to `5`, and add to the
`execute_batch` in `migrate`, after the `connections` table:

```sql
        create table if not exists recent (
            id            text primary key,
            kind          text not null,
            sql           text not null,
            connection_id text references connections(id) on delete set null,
            title         text,
            first_at      text not null,
            last_at       text not null,
            run_count     integer not null default 0,
            duration_ms   integer,
            row_count     integer,
            error         text
        );
```

and to the index block:

```sql
        create unique index if not exists idx_recent_run
            on recent(sql, connection_id) where kind = 'run';
        create index if not exists idx_recent_last_at on recent(last_at);
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd src-tauri && cargo test --lib db::
```

Expected: every `db` test passes, the new one included.

- [ ] **Step 5: Mutation check**

Delete the `create unique index … idx_recent_run` line, run
`cargo test --lib db::`, and confirm the tests still pass — they do, because
nothing yet depends on the collapse. Restore it. Record that this index is
proven in Task 2, not here.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/library/db.rs
git commit -m "feat(library): add the recent table at schema version 5"
```

---

## Task 2: Store reads and writes

**Files:**
- Create: `src-tauri/src/library/store/recent.rs`
- Modify: `src-tauri/src/library/store/mod.rs` (add `mod recent;` beside `mod tabs;`)
- Modify: `src-tauri/src/library/model.rs`
- Test: `src-tauri/tests/recent_test.rs`

- [ ] **Step 1: Define the row the UI receives**

Add to `model.rs`, beside the other serde structs:

```rust
/// One row of the History list: a statement that was run, or the text
/// of a tab that was closed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentItem {
    pub id: String,
    /// `run` or `closed`.
    pub kind: String,
    pub sql: String,
    /// The connection it ran against, or was open beside. `None` once
    /// that connection has been deleted — the work outlives its origin.
    pub connection_id: Option<String>,
    /// The closed tab's name, when it had one.
    pub title: Option<String>,
    pub first_at: String,
    pub last_at: String,
    pub run_count: i64,
    pub duration_ms: Option<i64>,
    pub row_count: Option<i64>,
    /// The last run's error message; `None` when it succeeded.
    pub error: Option<String>,
}
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/tests/recent_test.rs`. This needs no Docker — it is the
workspace SQLite only:

```rust
use quarry_lib::library::store::Store;
use tempfile::tempdir;

fn store() -> (Store, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let store = Store::open_at(&dir.path().join("library.db")).unwrap();
    (store, dir)
}

#[test]
fn a_run_is_recorded_with_its_result() {
    let (store, _dir) = store();

    store
        .record_run("select 1", Some("conn-a"), Some(12), Some(1), None)
        .unwrap();

    let all = store.recent().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].sql, "select 1");
    assert_eq!(all[0].kind, "run");
    assert_eq!(all[0].run_count, 1);
    assert_eq!(all[0].duration_ms, Some(12));
    assert_eq!(all[0].error, None);
}

#[test]
fn a_failed_run_is_recorded_with_its_error() {
    // The query you spent ten minutes failing to get right is work.
    let (store, _dir) = store();

    store
        .record_run("slect 1", Some("conn-a"), None, None, Some("syntax error"))
        .unwrap();

    let all = store.recent().unwrap();
    assert_eq!(all[0].error.as_deref(), Some("syntax error"));
}

#[test]
fn re_running_the_same_statement_collapses_and_counts() {
    let (store, _dir) = store();

    store.record_run("select 1", Some("conn-a"), Some(10), Some(1), None).unwrap();
    store.record_run("select 1", Some("conn-a"), Some(20), Some(1), None).unwrap();
    store.record_run("select 1", Some("conn-a"), Some(30), Some(1), None).unwrap();

    let all = store.recent().unwrap();
    assert_eq!(all.len(), 1, "a debugging loop must not fill the list");
    assert_eq!(all[0].run_count, 3);
    assert_eq!(all[0].duration_ms, Some(30), "the last run's timing wins");
}

#[test]
fn the_same_statement_against_another_connection_is_another_row() {
    // Same text, different database, different work.
    let (store, _dir) = store();

    store.record_run("select 1", Some("conn-a"), Some(10), Some(1), None).unwrap();
    store.record_run("select 1", Some("conn-b"), Some(10), Some(1), None).unwrap();

    assert_eq!(store.recent().unwrap().len(), 2);
}

#[test]
fn two_closed_drafts_with_the_same_text_stay_two_rows() {
    // Collapsing them would lose one piece of work.
    let (store, _dir) = store();

    store.record_closed("select 1", Some("conn-a"), None).unwrap();
    store.record_closed("select 1", Some("conn-a"), None).unwrap();

    let all = store.recent().unwrap();
    assert_eq!(all.len(), 2);
    assert!(all.iter().all(|r| r.kind == "closed"));
}

#[test]
fn a_closed_tab_keeps_its_title() {
    let (store, _dir) = store();

    store
        .record_closed("select 1", Some("conn-a"), Some("scratch"))
        .unwrap();

    assert_eq!(store.recent().unwrap()[0].title.as_deref(), Some("scratch"));
}

#[test]
fn deleting_a_row_removes_only_that_row() {
    let (store, _dir) = store();
    store.record_run("select 1", Some("conn-a"), Some(1), Some(1), None).unwrap();
    store.record_run("select 2", Some("conn-a"), Some(1), Some(1), None).unwrap();

    let target = store.recent().unwrap()[0].id.clone();
    store.delete_recent(&target).unwrap();

    let left = store.recent().unwrap();
    assert_eq!(left.len(), 1);
    assert_ne!(left[0].id, target);
}

#[test]
fn rows_come_back_newest_first() {
    let (store, _dir) = store();
    store.record_run("select 1", Some("conn-a"), Some(1), Some(1), None).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    store.record_run("select 2", Some("conn-a"), Some(1), Some(1), None).unwrap();

    let all = store.recent().unwrap();
    assert_eq!(all[0].sql, "select 2");
}
```

- [ ] **Step 3: Run them and watch them fail**

```bash
cd src-tauri && cargo test --test recent_test
```

Expected: FAIL to compile — `no method named record_run`.

- [ ] **Step 4: Implement the store**

Create `src-tauri/src/library/store/recent.rs`:

```rust
use crate::error::AppError;
use crate::library::model::RecentItem;
use crate::library::store::{new_id, now, sql_err, Store};
use rusqlite::{params, Row};

impl Store {
    /// Record a statement the user ran.
    ///
    /// Identical SQL against the same connection collapses onto the
    /// existing row: `last_at` moves, `run_count` increments, and the
    /// latest result replaces the previous one. A loop that runs one
    /// statement forty times leaves one row, so the list shows forty
    /// different queries rather than one repeated.
    pub fn record_run(
        &self,
        sql: &str,
        connection_id: Option<&str>,
        duration_ms: Option<i64>,
        row_count: Option<i64>,
        error: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self.lock();
        let stamp = now();
        conn.execute(
            "insert into recent
                (id, kind, sql, connection_id, title, first_at, last_at,
                 run_count, duration_ms, row_count, error)
             values (?1, 'run', ?2, ?3, null, ?4, ?4, 1, ?5, ?6, ?7)
             on conflict(sql, connection_id) where kind = 'run'
             do update set
                last_at     = excluded.last_at,
                run_count   = recent.run_count + 1,
                duration_ms = excluded.duration_ms,
                row_count   = excluded.row_count,
                error       = excluded.error",
            params![new_id(), sql, connection_id, stamp, duration_ms, row_count, error],
        )
        .map_err(sql_err)?;
        Ok(())
    }

    /// Record the unsaved text of a tab being closed.
    ///
    /// Never collapses: two drafts that happen to read the same are two
    /// pieces of work, and merging them would lose one.
    pub fn record_closed(
        &self,
        sql: &str,
        connection_id: Option<&str>,
        title: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self.lock();
        let stamp = now();
        conn.execute(
            "insert into recent
                (id, kind, sql, connection_id, title, first_at, last_at, run_count)
             values (?1, 'closed', ?2, ?3, ?4, ?5, ?5, 0)",
            params![new_id(), sql, connection_id, title, stamp],
        )
        .map_err(sql_err)?;
        Ok(())
    }

    /// Every row, newest first. Ordering beyond that — the active
    /// connection's work first — is decided in `src/lib/recent.ts`,
    /// where it can be tested without a database.
    pub fn recent(&self) -> Result<Vec<RecentItem>, AppError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "select id, kind, sql, connection_id, title, first_at, last_at,
                        run_count, duration_ms, row_count, error
                 from recent
                 order by last_at desc, rowid desc",
            )
            .map_err(sql_err)?;

        let rows = stmt
            .query_map([], read_recent)
            .map_err(sql_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_err)?;
        Ok(rows)
    }

    /// Forget one row. The only deletion there is: SQL sometimes
    /// carries a literal secret, and nothing else should ever remove
    /// work.
    pub fn delete_recent(&self, id: &str) -> Result<(), AppError> {
        let conn = self.lock();
        conn.execute("delete from recent where id = ?1", params![id])
            .map_err(sql_err)?;
        Ok(())
    }
}

fn read_recent(row: &Row) -> rusqlite::Result<RecentItem> {
    Ok(RecentItem {
        id: row.get(0)?,
        kind: row.get(1)?,
        sql: row.get(2)?,
        connection_id: row.get(3)?,
        title: row.get(4)?,
        first_at: row.get(5)?,
        last_at: row.get(6)?,
        run_count: row.get(7)?,
        duration_ms: row.get(8)?,
        row_count: row.get(9)?,
        error: row.get(10)?,
    })
}
```

Add `mod recent;` under `mod tabs;` in `src-tauri/src/library/store/mod.rs`.

- [ ] **Step 5: Run them and watch them pass**

```bash
cd src-tauri && cargo test --test recent_test
```

Expected: 8 passed.

- [ ] **Step 6: Mutation check — the collapse**

Change `run_count = recent.run_count + 1` to `run_count = 1`, run the suite,
and confirm `re_running_the_same_statement_collapses_and_counts` fails on the
count. Restore. Then drop `where kind = 'run'` from the conflict target, run
again, and confirm `two_closed_drafts_with_the_same_text_stay_two_rows` fails.
Restore. Show both failures and the restored pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/library/store/recent.rs src-tauri/src/library/store/mod.rs \
        src-tauri/src/library/model.rs src-tauri/tests/recent_test.rs
git commit -m "feat(library): record and read recent work"
```

---

## Task 3: `execute` records what the user ran

**Files:**
- Modify: `src-tauri/src/commands.rs` (the `execute` command)
- Modify: `src/lib/ipc.ts`
- Modify: `src/App.tsx` (one call site)

- [ ] **Step 1: Add the parameter and the recording**

Replace the body of `execute` in `commands.rs`:

```rust
#[tauri::command]
pub async fn execute(
    state: tauri::State<'_, AppState>,
    sql: String,
    generated: bool,
) -> Result<QueryResult, AppError> {
    let (pool, policy, unlocked_until) = state.pool_and_guard()?;

    // The one chokepoint. Every statement the user runs passes here.
    let read_write = match decide(policy, unlocked_until, Instant::now(), &sql) {
        Decision::Allow { read_write } => read_write,
        Decision::Deny => return Err(AppError::WriteBlocked(sql.trim().to_string())),
    };

    let outcome = run_query(&pool, &sql, read_write).await;

    // `generated` marks the app's own preview SQL. Recording it would
    // write an entry every time somebody clicks a table in the tree,
    // and the list would be nothing but `select * from x limit 500`.
    if !generated {
        let connection_id = state.active().as_ref().map(|a| a.id.clone());
        let recorded = match &outcome {
            Ok(result) => state.library.record_run(
                &sql,
                connection_id.as_deref(),
                Some(result.duration_ms as i64),
                Some(result.row_count as i64),
                None,
            ),
            Err(e) => state.library.record_run(
                &sql,
                connection_id.as_deref(),
                None,
                None,
                Some(&e.to_string()),
            ),
        };
        // A history write that failed must not turn a successful SELECT
        // into an error on screen: the workspace database is ours, not
        // the user's, and their query really did run.
        if let Err(e) = recorded {
            eprintln!("could not record this statement in history: {e}");
        }
    }

    outcome
}
```

If `QueryResult::duration_ms` or `row_count` is not `i64`-castable as written,
match the real field types rather than changing them.

- [ ] **Step 2: Thread the flag through the frontend**

In `src/lib/ipc.ts`:

```ts
export async function execute(
  sql: string,
  generated: boolean,
): Promise<QueryResult> {
  return invoke<QueryResult>("execute", { sql, generated });
}
```

In `src/App.tsx`, inside `runSql`, the existing call becomes:

```ts
        const next = await execute(sql, generated);
```

- [ ] **Step 3: Verify**

```bash
cd src-tauri && cargo build && cargo clippy --all-targets -- -D warnings
cd .. && npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src/lib/ipc.ts src/App.tsx
git commit -m "feat(history): record every statement the user runs"
```

---

## Task 4: `close_tab` keeps what you typed

**Files:**
- Modify: `src-tauri/src/library/store/tabs.rs`
- Test: `src-tauri/tests/recent_test.rs`

- [ ] **Step 1: Write the failing tests**

Append to `recent_test.rs`:

```rust
#[test]
fn closing_a_scratch_tab_keeps_its_text() {
    // The defect: closing a tab used to destroy what you had typed,
    // with no recovery of any kind.
    let (store, _dir) = store();
    let tabs = store.open_tab(None).unwrap();
    let id = tabs[0].id.clone();
    store.save_scratch(&id, "select 42").unwrap();

    store.close_tab(&id, Some("conn-a")).unwrap();

    let all = store.recent().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].sql, "select 42");
    assert_eq!(all[0].connection_id.as_deref(), Some("conn-a"));
    assert_eq!(all[0].kind, "closed");
}

#[test]
fn closing_an_empty_tab_records_nothing() {
    // There is nothing to recover, and a list of blank rows is noise.
    let (store, _dir) = store();
    let tabs = store.open_tab(None).unwrap();
    let id = tabs[0].id.clone();

    store.close_tab(&id).unwrap();

    assert!(store.recent().unwrap().is_empty());
}
```

Check the real signatures of `open_tab` and `save_scratch` in
`src-tauri/src/library/store/tabs.rs` before running, and match them.

- [ ] **Step 2: Run and watch them fail**

```bash
cd src-tauri && cargo test --test recent_test closing_a
```

Expected: FAIL — `assertion failed: all.len() == 1`, the list is empty.

- [ ] **Step 3: Give `close_tab` the connection it is closing beside**

The store knows nothing about which connection is live — that lives in
`AppState`. So the command passes it in. In `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub fn close_tab(state: tauri::State<'_, AppState>, id: String) -> Result<Vec<Tab>, AppError> {
    let connection_id = state.active().as_ref().map(|a| a.id.clone());
    state.library.close_tab(&id, connection_id.as_deref())?;
    state.library.tabs()
}
```

and the store signature becomes:

```rust
    pub fn close_tab(&self, id: &str, connection_id: Option<&str>) -> Result<(), AppError> {
```

It is context, not provenance: a tab is not bound to a connection, but the
database you were looking at when you closed it is the best answer to "where
did this belong", and it is what puts the row in the right group.

Update the two existing `close_tab` call sites in `src-tauri/tests/` (find them
with `grep -rn "close_tab" src-tauri/tests/`) to pass `None`.

- [ ] **Step 4: Record inside the delete transaction**

In `close_tab`, immediately before `tx.execute("delete from tabs …")`:

```rust
        // What the tab was holding, if losing it would lose anything. A
        // saved query's text lives in `queries`, so closing its tab
        // costs nothing and a `recent` row would duplicate work that
        // was never at risk.
        let keepable: Option<(String, Option<String>)> = tx
            .query_row(
                "select scratch_sql, title from tabs
                 where id = ?1 and query_id is null
                   and scratch_sql is not null and trim(scratch_sql) <> ''",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();

        if let Some((sql, title)) = keepable {
            tx.execute(
                "insert into recent
                    (id, kind, sql, connection_id, title, first_at, last_at, run_count)
                 values (?1, 'closed', ?2, ?3, ?4, ?5, ?5, 0)",
                params![new_id(), sql, connection_id, title, now()],
            )
            .map_err(sql_err)?;
        }
```

Written inline rather than through `record_closed` because it has to run inside
this transaction: the row and the deletion must land together or neither, or a
crash between them is the loss this exists to prevent. Import `new_id` and
`now` at the top of `tabs.rs` if they are not already there.

- [ ] **Step 5: Run and watch them pass**

```bash
cd src-tauri && cargo test --test recent_test
```

Expected: 10 passed.

- [ ] **Step 6: Mutation check**

Change the guard `and query_id is null` to `and 1 = 1`, run
`cargo test --test recent_test`, and confirm nothing fails — then write the
missing test rather than leaving the hole:

```rust
#[test]
fn closing_a_saved_querys_tab_records_nothing() {
    // Its text is in `queries`; a recent row would duplicate work that
    // was never at risk.
    let (store, _dir) = store();
    let tree = store.create_query("saved", None).unwrap();
    let query_id = tree.queries[0].id.clone();
    let tabs = store.open_tab(Some(&query_id)).unwrap();
    let id = tabs[0].id.clone();
    store.save_scratch(&id, "select 42").unwrap();

    store.close_tab(&id, None).unwrap();

    assert!(store.recent().unwrap().is_empty());
}
```

Re-run the mutation with this test present, show it failing, restore the guard,
show it passing.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/library/store/tabs.rs src-tauri/src/commands.rs \
        src-tauri/tests/recent_test.rs
git commit -m "feat(history): closing a tab keeps its unsaved text"
```

---

## Task 5: Commands and bindings

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- Modify: `src/lib/ipc.ts`, `src/types.ts`

- [ ] **Step 1: Add the two commands**

In `commands.rs`, beside the other library commands:

```rust
#[tauri::command]
pub fn list_recent(state: tauri::State<'_, AppState>) -> Result<Vec<RecentItem>, AppError> {
    state.library.recent()
}

#[tauri::command]
pub fn forget_recent(state: tauri::State<'_, AppState>, id: String) -> Result<Vec<RecentItem>, AppError> {
    state.library.delete_recent(&id)?;
    state.library.recent()
}
```

Returning the refreshed list matches every other mutating command here, so the
frontend replaces state rather than patching it. Import `RecentItem` from
`crate::library::model` alongside the existing imports, and register both in
`src-tauri/src/lib.rs`:

```rust
            commands::list_recent,
            commands::forget_recent,
```

- [ ] **Step 2: Mirror the type**

In `src/types.ts`:

```ts
/** Mirrors Rust `RecentItem`. */
export interface RecentItem {
  id: string;
  /** `run` or `closed`. */
  kind: string;
  sql: string;
  connection_id: string | null;
  title: string | null;
  first_at: string;
  last_at: string;
  run_count: number;
  duration_ms: number | null;
  row_count: number | null;
  error: string | null;
}
```

In `src/lib/ipc.ts`:

```ts
export async function listRecent(): Promise<RecentItem[]> {
  return invoke<RecentItem[]>("list_recent");
}

export async function forgetRecent(id: string): Promise<RecentItem[]> {
  return invoke<RecentItem[]>("forget_recent", { id });
}
```

Add `RecentItem` to the type import list at the top of `ipc.ts`.

- [ ] **Step 3: Verify**

```bash
cd src-tauri && cargo build && cargo clippy --all-targets -- -D warnings
cd .. && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/lib/ipc.ts src/types.ts
git commit -m "feat(history): expose recent work over IPC"
```

---

## Task 6: The ordering decision, as a pure module

**Files:**
- Create: `src/lib/recent.ts`, `src/lib/recent.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/recent.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { groupRecent, summarise } from "./recent";
import type { RecentItem } from "../types";

function item(over: Partial<RecentItem>): RecentItem {
  return {
    id: "id",
    kind: "run",
    sql: "select 1",
    connection_id: "conn-a",
    title: null,
    first_at: "2026-08-20T10:00:00Z",
    last_at: "2026-08-20T10:00:00Z",
    run_count: 1,
    duration_ms: 5,
    row_count: 1,
    error: null,
    ...over,
  };
}

describe("groupRecent", () => {
  it("puts the active connection's work first, keeping the rest below", () => {
    // Nothing is hidden by connection: a query written against staging
    // stays findable while connected to production.
    const rows = groupRecent(
      [
        item({ id: "1", connection_id: "other", sql: "select other" }),
        item({ id: "2", connection_id: "conn-a", sql: "select mine" }),
      ],
      "conn-a",
      "",
    );

    expect(rows.map((r) => r.item.id)).toEqual(["2", "1"]);
    expect(rows[0].here).toBe(true);
    expect(rows[1].here).toBe(false);
  });

  it("keeps each group newest first", () => {
    const rows = groupRecent(
      [
        item({ id: "old", last_at: "2026-08-19T10:00:00Z" }),
        item({ id: "new", last_at: "2026-08-20T10:00:00Z" }),
      ],
      "conn-a",
      "",
    );

    expect(rows.map((r) => r.item.id)).toEqual(["new", "old"]);
  });

  it("filters on the SQL, case-insensitively", () => {
    const rows = groupRecent(
      [item({ id: "1", sql: "SELECT * FROM orders" }), item({ id: "2", sql: "select 1" })],
      "conn-a",
      "orders",
    );

    expect(rows.map((r) => r.item.id)).toEqual(["1"]);
  });

  it("filters on a closed tab's title too", () => {
    const rows = groupRecent(
      [item({ id: "1", kind: "closed", title: "revenue draft", sql: "select 1" })],
      "conn-a",
      "revenue",
    );

    expect(rows).toHaveLength(1);
  });

  it("treats an item whose connection was deleted as elsewhere, not as here", () => {
    // The work outlives its origin; it must not masquerade as belonging
    // to whatever you happen to be connected to now.
    const rows = groupRecent([item({ connection_id: null })], "conn-a", "");

    expect(rows[0].here).toBe(false);
  });
});

describe("summarise", () => {
  it("gives a run its count when it has been run more than once", () => {
    expect(summarise(item({ run_count: 4 }))).toContain("4×");
  });

  it("says nothing about the count of a single run", () => {
    expect(summarise(item({ run_count: 1 }))).not.toContain("×");
  });

  it("marks a run whose last attempt failed", () => {
    expect(summarise(item({ error: "syntax error" }))).toContain("failed");
  });

  it("describes a closed tab as unsaved rather than as a run", () => {
    const text = summarise(item({ kind: "closed", run_count: 0, duration_ms: null }));
    expect(text).toContain("unsaved");
    expect(text).not.toContain("×");
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run src/lib/recent.test.ts
```

Expected: FAIL — cannot resolve `./recent`.

- [ ] **Step 3: Implement**

Create `src/lib/recent.ts`:

```ts
import type { RecentItem } from "../types";

/** One row of the History list, with what the view needs decided. */
export interface RecentRow {
  item: RecentItem;
  /** Whether it belongs to the connection that is live right now. */
  here: boolean;
}

/** Case-insensitive match on the SQL and, when there is one, the title. */
function matches(item: RecentItem, filter: string): boolean {
  if (filter === "") return true;
  const needle = filter.toLowerCase();
  return (
    item.sql.toLowerCase().includes(needle) ||
    (item.title ?? "").toLowerCase().includes(needle)
  );
}

/**
 * Order the list: this connection's work first, everything else below,
 * each group newest first.
 *
 * Nothing is hidden. A query written against staging has to stay
 * findable while connected to production — you often reconnect
 * precisely in order to find it.
 */
export function groupRecent(
  items: RecentItem[],
  activeConnectionId: string | null,
  filter: string,
): RecentRow[] {
  const newestFirst = (a: RecentItem, b: RecentItem) =>
    a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0;

  const kept = items.filter((i) => matches(i, filter));
  const here = (i: RecentItem) =>
    activeConnectionId !== null && i.connection_id === activeConnectionId;

  return [
    ...kept.filter(here).sort(newestFirst).map((item) => ({ item, here: true })),
    ...kept.filter((i) => !here(i)).sort(newestFirst).map((item) => ({ item, here: false })),
  ];
}

/**
 * The one quiet line under a row's SQL.
 *
 * A single run says only when; a repeated one says how often, because
 * that is the fact the collapse traded the individual timings for.
 */
export function summarise(item: RecentItem): string {
  if (item.kind === "closed") {
    return item.title ? `unsaved · ${item.title}` : "unsaved";
  }
  const parts: string[] = [];
  if (item.run_count > 1) parts.push(`${item.run_count}×`);
  if (item.error !== null) parts.push("failed");
  else if (item.row_count !== null) {
    parts.push(`${item.row_count} ${item.row_count === 1 ? "row" : "rows"}`);
  }
  return parts.join(" · ");
}
```

- [ ] **Step 4: Run and watch them pass**

```bash
npx vitest run src/lib/recent.test.ts
```

Expected: 9 passed.

- [ ] **Step 5: Mutation check**

Make `here` always return `false`, run the suite, and confirm the first and
last `groupRecent` tests fail. Restore, show the pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/recent.ts src/lib/recent.test.ts
git commit -m "feat(history): decide the list's order and summary"
```

---

## Task 7: The History list in the sidebar

**Files:**
- Create: `src/components/RecentList.tsx`
- Modify: `src/components/Sidebar.tsx`, `src/App.tsx`, `src/App.css`

- [ ] **Step 1: Build the list**

Create `src/components/RecentList.tsx`. It follows `SchemaTree`'s idioms — a
filter box above, rows that select on click and open on Enter or double-click,
a context menu via `useContextMenu`:

```tsx
import { useMemo, useState } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { groupRecent, summarise } from "../lib/recent";
import type { Connection, RecentItem } from "../types";

interface Props {
  items: RecentItem[];
  connections: Connection[];
  activeConnectionId: string | null;
  /** Open a new tab holding this SQL. Never runs it. */
  onOpen: (sql: string) => void;
  onForget: (id: string) => void;
}

/** The first non-empty line, which is what a row can show. */
function firstLine(sql: string): string {
  return sql.split("\n").find((l) => l.trim() !== "")?.trim() ?? sql.trim();
}

export function RecentList({
  items,
  connections,
  activeConnectionId,
  onOpen,
  onForget,
}: Props) {
  const [filter, setFilter] = useState("");
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const rows = useMemo(
    () => groupRecent(items, activeConnectionId, filter),
    [items, activeConnectionId, filter],
  );

  return (
    <>
      <div className="schema-toolbar">
        <input
          className="schema-filter"
          placeholder="Filter history…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
      </div>

      {rows.length === 0 && (
        <p className="tree-empty">
          {items.length === 0
            ? "Nothing yet. Statements you run and tabs you close land here."
            : "Nothing matches."}
        </p>
      )}

      <div className="recent-rows">
        {rows.map(({ item, here }) => {
          const origin = connections.find((c) => c.id === item.connection_id);
          return (
            <div
              key={item.id}
              className={`tree-row recent-row${here ? " here" : ""}`}
              role="button"
              tabIndex={0}
              title={item.sql}
              onDoubleClick={() => onOpen(item.sql)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onOpen(item.sql);
                }
              }}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: "Open in a new tab", shortcut: "↵", onSelect: () => onOpen(item.sql) },
                  {
                    label: "Copy SQL",
                    onSelect: () => void navigator.clipboard.writeText(item.sql),
                  },
                  { separator: true as const },
                  { label: "Forget this", onSelect: () => onForget(item.id) },
                ])
              }
            >
              <span className="recent-sql">{firstLine(item.sql)}</span>
              <span className="recent-meta">
                {origin && (
                  <span
                    className="picker-tag overline"
                    style={{ color: origin.colour, borderColor: origin.colour }}
                  >
                    {origin.tag}
                  </span>
                )}
                <span className="recent-summary">{summarise(item)}</span>
              </span>
            </div>
          );
        })}
      </div>

      <ContextMenu menu={menu} onClose={closeMenu} />
    </>
  );
}
```

Check `ContextMenu`'s real export names and menu-item shape in
`src/components/ContextMenu.tsx` before running, and match them.

- [ ] **Step 2: Make the bottom sidebar section tabbed**

In `Sidebar.tsx`, add to `Props`:

```tsx
  recent: RecentItem[];
  connections: Connection[];
  activeConnectionId: string | null;
  onOpenRecent: (sql: string) => void;
  onForgetRecent: (id: string) => void;
```

Add the local state, above the return:

```tsx
  // Queries and History share the bottom section rather than stacking.
  // A third stacked section would need a second resizer and three-way
  // height maths in a sidebar that is already tight — and the two are
  // alternatives, not competitors: you are either browsing work you
  // saved or recovering work you did not.
  const [bottom, setBottom] = useState<"queries" | "history">("queries");
```

Replace the `<header className="sidebar-header">` of the queries section with:

```tsx
        <header className="sidebar-header">
          <div className="section-tabs">
            <button
              className={bottom === "queries" ? "overline active" : "overline"}
              onClick={() => setBottom("queries")}
            >
              Queries
            </button>
            <button
              className={bottom === "history" ? "overline active" : "overline"}
              onClick={() => setBottom("history")}
            >
              History
            </button>
          </div>
          {bottom === "queries" && (
            <div className="sidebar-header-actions">
              <button
                className="row-action text"
                title="New query"
                onClick={props.onNewQuery}
              >
                + Query
              </button>
              <button
                className="row-action text"
                title="New folder"
                onClick={props.onNewCollection}
              >
                + Folder
              </button>
            </div>
          )}
        </header>
```

and wrap the existing `<QueryTree …/>` so the section renders one or the other:

```tsx
        {bottom === "queries" ? (
          <QueryTree /* every existing prop, unchanged */ />
        ) : (
          <RecentList
            items={props.recent}
            connections={props.connections}
            activeConnectionId={props.activeConnectionId}
            onOpen={props.onOpenRecent}
            onForget={props.onForgetRecent}
          />
        )}
```

- [ ] **Step 3: Wire it in App**

In `App.tsx`, beside the other state:

```tsx
  // Everything run or closed, newest first. Reloaded after every run so
  // a statement you just executed is in the list you look at next.
  const [recent, setRecent] = useState<RecentItem[]>([]);

  const refreshRecent = useCallback(() => {
    void listRecent().then(setRecent);
  }, []);

  useEffect(() => refreshRecent(), [refreshRecent]);
```

Call `refreshRecent()` at the end of `runSql`'s `finally` block, and after
`actions.closeTab(...)` in `onCloseTab.current` and in `closeOtherTabs`.

Opening a row, near the other tab actions:

```tsx
  // Opens, never runs — the same rule the schema tree follows. Your
  // current buffer is untouched: recovering work must not cost work.
  const openRecent = useCallback(
    async (sql: string) => {
      await actions.newTab();
      setText(sql);
    },
    [actions],
  );
```

`actions.newTab()` has to return the id of the tab it created for the autosave
to land on the right one — mirror the change made to `openTableTab` in
`useLibrary.ts`, which returns `next.find((t) => t.is_active)?.id ?? null`, and
then call `autosave` for that tab so the recovered text is persisted rather
than living only in the editor:

```tsx
  const openRecent = useCallback(
    async (sql: string) => {
      const target = await actions.newTab();
      setText(sql);
      // The same call `useLibrary`'s autosave makes for a tab with no
      // query_id, so recovered text is persisted immediately rather
      // than waiting for a keystroke that may never come.
      if (target) void saveScratch(target, sql);
    },
    [actions],
  );
```

`saveScratch` is already exported from `src/lib/ipc.ts:184`; add it to the
import list at the top of `App.tsx`.

Forgetting a row:

```tsx
  const forgetRecent = useCallback(async (id: string) => {
    setRecent(await ipc.forgetRecent(id));
  }, []);
```

Pass `recent`, `connections`, `connection?.id ?? null`, `openRecent` and
`forgetRecent` down to `<Sidebar …>`.

- [ ] **Step 4: Style it**

In `App.css`, beside the sidebar rules:

```css
/* Two names, one section. The inactive one stays legible: it is a
   place to go, not a disabled control. */
.section-tabs {
  display: flex;
  gap: var(--s-3);
}

.section-tabs button {
  background: none;
  border: none;
  padding: 0;
  color: var(--faint);
  cursor: pointer;
}

.section-tabs button.active {
  color: var(--text);
}

.recent-rows {
  flex: 1;
  overflow-y: auto;
}

/* Two lines: the statement, then the quiet facts about it. */
.recent-row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  height: auto;
  padding: 6px 8px;
  cursor: default;
}

.recent-sql {
  font-family: var(--mono);
  font-size: var(--t-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent-meta {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  color: var(--faint);
  font-size: var(--t-xs);
}

/* Work from the connection you are on. A left edge rather than a
   heading: it groups without spending a row on saying so. */
.recent-row.here {
  border-left: 2px solid var(--border);
}
```

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit -p tsconfig.json && npm test && npm run build
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/components/RecentList.tsx src/components/Sidebar.tsx src/App.tsx src/App.css
git commit -m "feat(history): browse and recover recent work from the sidebar"
```

---

## Smoke test, for the owner

Against `smoke-test` or `lifegame`, never `railway`:

1. Run three different statements → History lists three rows, newest first.
2. Re-run one of them five times → still three rows; that one reads `6×`.
3. Run a statement with a typo → it appears, marked `failed`.
4. Click a table in the schema tree → **no** new history row.
5. Type into a scratch tab, close it without saving → it appears as `unsaved`;
   Enter on it opens a new tab holding the text, and nothing runs.
6. Open a saved query's tab, edit it, close it → **no** new history row (its
   text is in the library).
7. Switch connection → the other database's rows drop below yours, still
   visible, still tagged.
8. Right-click a row → Forget this → it goes, and nothing else does.
9. Quit and relaunch → the list is intact.
