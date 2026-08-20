# The write audit log (Stage B) — implementation plan

> **For agentic workers:** this repository works inline in the main thread; see
> `CLAUDE.md`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every write the app performs is recorded — what ran, against which
database, and how it ended — with an undo for the grid edits where the old
values are already known.

**Architecture:** A `writes` table that never collapses and never deletes rows,
written from both write paths at the moment each one ends. Undo SQL is
generated in a pure Rust module from the previous row values the grid already
holds, so nothing new about the user's data is read or stored beyond the audit
row itself. A third sidebar tab reads it.

**Tech stack:** Rust (rusqlite, tauri commands), React 19 + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-guarded-writes-design.md`
(Stage A shipped as `guarded-writes-stage-a`.)

---

## File structure

| File | Responsibility |
|---|---|
| `src-tauri/src/library/db.rs` | Schema v6: the `writes` table (modify) |
| `src-tauri/src/library/model.rs` | `WriteRecord` (modify) |
| `src-tauri/src/library/store/writes.rs` | Recording and reading writes (create) |
| `src-tauri/src/library/store/mod.rs` | `mod writes;` (modify) |
| `src-tauri/src/edit/undo.rs` | Undo SQL from the grid's previous values (create) |
| `src-tauri/src/edit/mod.rs` | `pub mod undo;` and its re-exports (modify) |
| `src-tauri/src/commands.rs` | Recording from both write paths; `list_writes` (modify) |
| `src-tauri/src/lib.rs` | Register `list_writes` (modify) |
| `src-tauri/tests/writes_test.rs` | Store behaviour (create) |
| `src-tauri/tests/undo_test.rs` | Generated undo, statement for statement (create) |
| `src/types.ts`, `src/lib/ipc.ts` | `WriteRecord`, `listWrites`, `before` on apply (modify) |
| `src/lib/writes.ts` + `.test.ts` | Ordering and row labels (create) |
| `src/components/WritesList.tsx` | The list (create) |
| `src/components/Sidebar.tsx` | A third tab (modify) |
| `src/App.tsx` | Load writes; send previous rows when applying (modify) |

---

## Task 1: The `writes` table

**Files:**
- Modify: `src-tauri/src/library/db.rs`

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `src-tauri/src/library/db.rs`:

```rust
#[test]
fn upgrading_a_v5_database_adds_writes_and_keeps_existing_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v5.db");

    // A v5 database with history in it: the audit log must arrive
    // without costing anybody their recorded work.
    {
        let conn = open(&path).unwrap();
        conn.execute(
            "insert into recent (id, kind, sql, first_at, last_at, run_count)
             values ('r1', 'run', 'select 1', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', 1)",
            [],
        )
        .unwrap();
        conn.execute("drop table writes", []).ok();
    }

    let conn = open(&path).unwrap();

    let kept: i64 = conn
        .query_row("select count(*) from recent", [], |r| r.get(0))
        .unwrap();
    assert_eq!(kept, 1, "history must survive the migration");

    conn.execute(
        "insert into writes
            (id, at, connection_name, tag, sql, kind, outcome)
         values ('w1', '2026-08-21T00:00:00Z', 'smoke', 'local', 'delete from t', 'delete', 'committed')",
        [],
    )
    .unwrap();

    let version: String = conn
        .query_row(
            "select value from meta where key = 'schema_version'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION.to_string());
    assert_eq!(SCHEMA_VERSION, 6);
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd src-tauri && cargo test --lib upgrading_a_v5
```

Expected: FAIL — `no such table: writes`.

- [ ] **Step 3: Add the table and bump the version**

In `db.rs` change `pub const SCHEMA_VERSION: i64 = 5;` to `6`, and add to the
`execute_batch` in `migrate`, after the `recent` table:

```sql
        -- v6: what this app wrote, and how it ended. Distinct from
        -- `recent` on purpose: that answers "where is the query I had"
        -- and so collapses repeats and allows deletion, both of which
        -- are wrong here, where every occurrence is a separate fact and
        -- forgetting one defeats the point.
        create table if not exists writes (
            id              text primary key,
            at              text not null,
            connection_id   text references connections(id) on delete set null,
            connection_name text not null,
            tag             text not null,
            sql             text not null,
            kind            text not null,
            row_count       integer,
            outcome         text not null,
            reason          text,
            undo_sql        text
        );
```

and to the index block:

```sql
        create index if not exists idx_writes_at on writes(at);
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd src-tauri && cargo test --lib db::
```

Expected: every db test passes, the new one included.

- [ ] **Step 5: Mutation check**

Rename the table to `writes_DISABLED` in the migration, run
`cargo test --lib upgrading_a_v5`, confirm it fails with `no such table:
writes`. Restore, show the pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/library/db.rs
git commit -m "feat(library): add the writes table at schema version 6"
```

---

## Task 2: Recording and reading writes

**Files:**
- Modify: `src-tauri/src/library/model.rs`
- Create: `src-tauri/src/library/store/writes.rs`
- Modify: `src-tauri/src/library/store/mod.rs`
- Test: `src-tauri/tests/writes_test.rs`

- [ ] **Step 1: Define the row**

Add to `src-tauri/src/library/model.rs`, beside `RecentItem`:

```rust
/// One write this app performed, and how it ended.
///
/// `connection_name` and `tag` are copied in rather than joined: the row
/// must still say which database it hit after that connection is renamed
/// or deleted, and an audit line that loses its subject is not an audit
/// line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteRecord {
    pub id: String,
    pub at: String,
    pub connection_id: Option<String>,
    pub connection_name: String,
    pub tag: String,
    pub sql: String,
    /// `update`, `delete`, `insert`, `ddl`, `other`, or `batch` for the
    /// grid's own edits.
    pub kind: String,
    pub row_count: Option<i64>,
    /// `committed`, `rolled_back`, `refused` or `failed`.
    pub outcome: String,
    /// Why it was refused or how it failed. `None` when it committed.
    pub reason: Option<String>,
    /// SQL that would put it back, where that is derivable. `None` for
    /// typed statements, which are recorded but not reversible.
    pub undo_sql: Option<String>,
}

/// What is known about a write at the moment it is recorded.
///
/// A struct rather than eleven positional arguments: `record_write(id,
/// name, tag, sql, kind, count, outcome, reason, undo)` cannot be read
/// at a call site, and a swapped pair of strings compiles silently.
#[derive(Debug, Clone)]
pub struct WriteEntry {
    pub connection_id: Option<String>,
    pub connection_name: String,
    pub tag: String,
    pub sql: String,
    pub kind: String,
    pub row_count: Option<i64>,
    pub outcome: String,
    pub reason: Option<String>,
    pub undo_sql: Option<String>,
}
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/tests/writes_test.rs`:

```rust
//! The write audit log. No Docker here — this is the workspace SQLite.

use quarry_lib::conn::config::SslMode;
use quarry_lib::library::model::{ConnectionInput, Tag, WriteEntry};
use quarry_lib::library::store::Store;
use tempfile::tempdir;

fn store() -> (Store, String, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let store = Store::open_at(&dir.path().join("library.db")).unwrap();
    let id = store
        .create_connection(ConnectionInput {
            name: "smoke".to_string(),
            host: "localhost".to_string(),
            port: 5432,
            user: "postgres".to_string(),
            dbname: "postgres".to_string(),
            sslmode: SslMode::Disable,
            tag: Tag::Local,
            colour: None,
            password: None,
        })
        .unwrap()
        .id;
    (store, id, dir)
}

fn entry(sql: &str, outcome: &str, connection_id: Option<&str>) -> WriteEntry {
    WriteEntry {
        connection_id: connection_id.map(str::to_string),
        connection_name: "smoke".to_string(),
        tag: "local".to_string(),
        sql: sql.to_string(),
        kind: "update".to_string(),
        row_count: Some(3),
        outcome: outcome.to_string(),
        reason: None,
        undo_sql: None,
    }
}

#[test]
fn a_committed_write_is_recorded() {
    let (store, conn_id, _dir) = store();

    store
        .record_write(entry("update t set a = 1", "committed", Some(&conn_id)))
        .unwrap();

    let all = store.writes().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].sql, "update t set a = 1");
    assert_eq!(all[0].outcome, "committed");
    assert_eq!(all[0].row_count, Some(3));
    assert_eq!(all[0].connection_name, "smoke");
}

#[test]
fn a_rollback_is_recorded_as_deliberately_as_a_commit() {
    // "I nearly truncated orders and stopped" is exactly the fact worth
    // having six months later.
    let (store, conn_id, _dir) = store();

    store
        .record_write(entry("truncate orders", "rolled_back", Some(&conn_id)))
        .unwrap();

    assert_eq!(store.writes().unwrap()[0].outcome, "rolled_back");
}

#[test]
fn identical_writes_never_collapse() {
    // Unlike history: every occurrence here is a separate fact.
    let (store, conn_id, _dir) = store();

    store
        .record_write(entry("update t set a = 1", "committed", Some(&conn_id)))
        .unwrap();
    store
        .record_write(entry("update t set a = 1", "committed", Some(&conn_id)))
        .unwrap();

    assert_eq!(store.writes().unwrap().len(), 2);
}

#[test]
fn deleting_a_connection_keeps_the_writes_made_against_it() {
    // The audit outlives the connection, and still names the database:
    // that is why the name and tag are copied in rather than joined.
    let (store, conn_id, _dir) = store();
    store
        .record_write(entry("delete from t", "committed", Some(&conn_id)))
        .unwrap();

    store.delete_connection(&conn_id).unwrap();

    let all = store.writes().unwrap();
    assert_eq!(all.len(), 1, "the audit row must survive");
    assert_eq!(all[0].connection_id, None);
    assert_eq!(
        all[0].connection_name, "smoke",
        "it must still say which database it hit"
    );
    assert_eq!(all[0].tag, "local");
}

#[test]
fn writes_come_back_newest_first() {
    let (store, conn_id, _dir) = store();
    store
        .record_write(entry("update t set a = 1", "committed", Some(&conn_id)))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    store
        .record_write(entry("update t set a = 2", "committed", Some(&conn_id)))
        .unwrap();

    assert_eq!(store.writes().unwrap()[0].sql, "update t set a = 2");
}

#[test]
fn a_write_carries_its_undo_when_there_is_one() {
    let (store, conn_id, _dir) = store();
    let mut e = entry("update t set a = 1", "committed", Some(&conn_id));
    e.undo_sql = Some("update t set a = 0 where id = 1;".to_string());
    e.kind = "batch".to_string();

    store.record_write(e).unwrap();

    assert_eq!(
        store.writes().unwrap()[0].undo_sql.as_deref(),
        Some("update t set a = 0 where id = 1;")
    );
}

#[test]
fn a_refusal_records_its_reason() {
    let (store, conn_id, _dir) = store();
    let mut e = entry("update t set a = 1", "refused", Some(&conn_id));
    e.reason = Some("-- expect: 1, but 5 rows matched — rolled back".to_string());
    e.row_count = Some(5);

    store.record_write(e).unwrap();

    let all = store.writes().unwrap();
    assert_eq!(all[0].outcome, "refused");
    assert!(all[0].reason.as_deref().unwrap().contains("expect"));
}
```

- [ ] **Step 3: Run and watch them fail**

```bash
cd src-tauri && cargo test --test writes_test
```

Expected: FAIL to compile — `no method named record_write`.

- [ ] **Step 4: Implement the store**

Create `src-tauri/src/library/store/writes.rs`:

```rust
use crate::error::AppError;
use crate::library::model::{WriteEntry, WriteRecord};
use crate::library::store::{new_id, now, sql_err, Store};
use rusqlite::{params, Row};

impl Store {
    /// Record one write. Never collapses, and nothing removes it.
    pub fn record_write(&self, entry: WriteEntry) -> Result<(), AppError> {
        let conn = self.lock();
        conn.execute(
            "insert into writes
                (id, at, connection_id, connection_name, tag, sql, kind,
                 row_count, outcome, reason, undo_sql)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                new_id(),
                now(),
                entry.connection_id,
                entry.connection_name,
                entry.tag,
                entry.sql,
                entry.kind,
                entry.row_count,
                entry.outcome,
                entry.reason,
                entry.undo_sql,
            ],
        )
        .map_err(sql_err)?;
        Ok(())
    }

    /// Every write, newest first.
    pub fn writes(&self) -> Result<Vec<WriteRecord>, AppError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "select id, at, connection_id, connection_name, tag, sql, kind,
                        row_count, outcome, reason, undo_sql
                 from writes
                 order by at desc, rowid desc",
            )
            .map_err(sql_err)?;

        let rows = stmt
            .query_map([], read_write)
            .map_err(sql_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_err)?;
        Ok(rows)
    }
}

fn read_write(row: &Row) -> rusqlite::Result<WriteRecord> {
    Ok(WriteRecord {
        id: row.get(0)?,
        at: row.get(1)?,
        connection_id: row.get(2)?,
        connection_name: row.get(3)?,
        tag: row.get(4)?,
        sql: row.get(5)?,
        kind: row.get(6)?,
        row_count: row.get(7)?,
        outcome: row.get(8)?,
        reason: row.get(9)?,
        undo_sql: row.get(10)?,
    })
}
```

Add `mod writes;` beside `pub(crate) mod recent;` in
`src-tauri/src/library/store/mod.rs`.

- [ ] **Step 5: Run and watch them pass**

```bash
cd src-tauri && cargo test --test writes_test
```

Expected: 7 passed.

- [ ] **Step 6: Mutation check**

Change the insert to `insert or replace into writes` keyed on `sql` — that is,
add `on conflict(sql) do nothing` and a unique index on `sql` in `db.rs` — and
confirm `identical_writes_never_collapse` fails. Restore both, show the pass.
Then set `connection_name` to `String::new()` in `record_write` and confirm
`deleting_a_connection_keeps_the_writes_made_against_it` fails on the name.
Restore, show the pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/library/model.rs src-tauri/src/library/store/writes.rs \
        src-tauri/src/library/store/mod.rs src-tauri/tests/writes_test.rs
git commit -m "feat(library): record what this app wrote and how it ended"
```

---

## Task 3: Undo, from the values the grid already holds

**Files:**
- Create: `src-tauri/src/edit/undo.rs`
- Modify: `src-tauri/src/edit/mod.rs`
- Test: `src-tauri/tests/undo_test.rs`

The old values are not in `RowEdit` — it carries only what the cell is becoming.
They are in the grid, on screen, so the frontend sends them. Nothing extra is
read from the database and nothing about a typed statement is captured.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/undo_test.rs`:

```rust
use quarry_lib::edit::{
    build_undo, CellEdit, ColumnEdit, EditInfo, PkColumn, RowBefore, RowDelete, RowEdit,
};

/// A `users` result with `id` as its key and two editable columns.
fn users() -> EditInfo {
    EditInfo {
        editable: true,
        reason: None,
        insertable: true,
        insert_reason: None,
        schema: Some("public".to_string()),
        table: Some("users".to_string()),
        pk: vec![PkColumn {
            name: "id".to_string(),
            result_index: 0,
        }],
        columns: vec![
            ColumnEdit {
                editable: false,
                column_name: Some("id".to_string()),
                cast_type: Some("\"int4\"".to_string()),
                reason: Some("primary key".to_string()),
                insertable: false,
                insert_reason: None,
                choices: None,
                has_default: true,
            },
            ColumnEdit {
                editable: true,
                column_name: Some("email".to_string()),
                cast_type: Some("\"text\"".to_string()),
                reason: None,
                insertable: true,
                insert_reason: None,
                choices: None,
                has_default: false,
            },
            ColumnEdit {
                editable: true,
                column_name: Some("plan".to_string()),
                cast_type: Some("\"text\"".to_string()),
                reason: None,
                insertable: true,
                insert_reason: None,
                choices: None,
                has_default: false,
            },
        ],
    }
}

fn before(row: usize, cells: &[(usize, Option<&str>)]) -> RowBefore {
    RowBefore {
        row,
        cells: cells
            .iter()
            .map(|(column, value)| CellEdit {
                column: *column,
                value: value.map(str::to_string),
            })
            .collect(),
    }
}

#[test]
fn an_updates_undo_puts_the_old_value_back() {
    let edit = users();
    let rows = vec![RowEdit {
        row: 0,
        pk: vec!["7".to_string()],
        cells: vec![CellEdit {
            column: 1,
            value: Some("new@example.com".to_string()),
        }],
    }];
    let befores = vec![before(0, &[(1, Some("old@example.com"))])];

    let undo = build_undo(&edit, &rows, &befores, &[]).expect("an update is reversible");

    assert!(undo.contains("update \"public\".\"users\""), "got:\n{undo}");
    assert!(
        undo.contains("set \"email\" = 'old@example.com'::\"text\""),
        "got:\n{undo}"
    );
    assert!(undo.contains("where \"id\" = '7'::\"int4\""), "got:\n{undo}");
}

#[test]
fn a_null_it_used_to_hold_comes_back_as_null_not_as_the_word() {
    let edit = users();
    let rows = vec![RowEdit {
        row: 0,
        pk: vec!["7".to_string()],
        cells: vec![CellEdit {
            column: 2,
            value: Some("pro".to_string()),
        }],
    }];
    let befores = vec![before(0, &[(2, None)])];

    let undo = build_undo(&edit, &rows, &befores, &[]).expect("reversible");

    assert!(undo.contains("set \"plan\" = null"), "got:\n{undo}");
    assert!(!undo.contains("'null'"), "got:\n{undo}");
}

#[test]
fn a_quote_in_the_old_value_is_escaped() {
    // The undo is text somebody will run. An unescaped quote makes it
    // either invalid or, worse, a different statement.
    let edit = users();
    let rows = vec![RowEdit {
        row: 0,
        pk: vec!["7".to_string()],
        cells: vec![CellEdit {
            column: 1,
            value: Some("x".to_string()),
        }],
    }];
    let befores = vec![before(0, &[(1, Some("O'Brien"))])];

    let undo = build_undo(&edit, &rows, &befores, &[]).expect("reversible");

    assert!(undo.contains("'O''Brien'"), "got:\n{undo}");
}

#[test]
fn a_deletes_undo_puts_the_whole_row_back() {
    let edit = users();
    let deletes = vec![RowDelete {
        row: 1,
        pk: vec!["9".to_string()],
    }];
    let befores = vec![before(
        1,
        &[(0, Some("9")), (1, Some("gone@example.com")), (2, None)],
    )];

    let undo = build_undo(&edit, &[], &befores, &deletes).expect("a delete is reversible");

    assert!(
        undo.contains("insert into \"public\".\"users\""),
        "got:\n{undo}"
    );
    assert!(undo.contains("\"id\", \"email\", \"plan\""), "got:\n{undo}");
    assert!(
        undo.contains("'9'::\"int4\", 'gone@example.com'::\"text\", null"),
        "got:\n{undo}"
    );
}

#[test]
fn an_insert_has_no_undo_because_its_key_is_not_known() {
    // The batch does not return the key the database assigned, and a
    // guess would be worse than an honest gap.
    let edit = users();

    assert_eq!(build_undo(&edit, &[], &[], &[]), None);
}

#[test]
fn a_row_with_no_recorded_previous_values_is_skipped_rather_than_guessed() {
    let edit = users();
    let rows = vec![RowEdit {
        row: 0,
        pk: vec!["7".to_string()],
        cells: vec![CellEdit {
            column: 1,
            value: Some("new@example.com".to_string()),
        }],
    }];

    assert_eq!(build_undo(&edit, &rows, &[], &[]), None);
}

#[test]
fn every_changed_row_gets_its_own_statement() {
    let edit = users();
    let rows = vec![
        RowEdit {
            row: 0,
            pk: vec!["7".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("a".to_string()),
            }],
        },
        RowEdit {
            row: 1,
            pk: vec!["8".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("b".to_string()),
            }],
        },
    ];
    let befores = vec![
        before(0, &[(1, Some("was-a"))]),
        before(1, &[(1, Some("was-b"))]),
    ];

    let undo = build_undo(&edit, &rows, &befores, &[]).expect("reversible");

    assert_eq!(undo.lines().count(), 2, "got:\n{undo}");
    assert!(undo.contains("'was-a'"), "got:\n{undo}");
    assert!(undo.contains("'was-b'"), "got:\n{undo}");
}
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd src-tauri && cargo test --test undo_test
```

Expected: FAIL to compile — `no build_undo in edit`.

- [ ] **Step 3: Implement**

Create `src-tauri/src/edit/undo.rs`:

```rust
//! What would put a grid edit back.
//!
//! Derived, not captured: the values come from the rows the grid already
//! had on screen, so generating this reads nothing from the database and
//! stores nothing about the user's data that the audit row does not
//! already hold. Typed SQL gets no undo for exactly that reason — it
//! would mean reading the affected rows first.
//!
//! The result is text to read and run, not something the app executes.

use crate::edit::decide::EditInfo;
use crate::edit::sql::{quote_ident, CellEdit, RowDelete, RowEdit};
use serde::Deserialize;

/// The values a row held before the batch changed it, as the grid had
/// them.
#[derive(Debug, Clone, Deserialize)]
pub struct RowBefore {
    /// The grid row index, matching `RowEdit::row` and `RowDelete::row`.
    pub row: usize,
    pub cells: Vec<CellEdit>,
}

/// A value as SQL: quoted and cast the way the edit machinery casts, or
/// a bare `null`.
///
/// The cast matters as much as the quoting. Without it Postgres sees an
/// untyped literal and an undo for an enum or a timestamp column fails
/// where the original edit succeeded.
fn literal(value: Option<&str>, cast_type: Option<&str>) -> String {
    match value {
        None => "null".to_string(),
        Some(text) => {
            let escaped = text.replace('\'', "''");
            match cast_type {
                Some(cast) => format!("'{escaped}'::{cast}"),
                None => format!("'{escaped}'"),
            }
        }
    }
}

/// The `where` clause that names one row by its key.
fn where_key(edit: &EditInfo, pk: &[String]) -> Option<String> {
    if pk.len() != edit.pk.len() {
        return None;
    }
    let mut parts = Vec::new();
    for (column, value) in edit.pk.iter().zip(pk) {
        let cast = edit
            .columns
            .get(column.result_index)
            .and_then(|c| c.cast_type.as_deref());
        parts.push(format!(
            "{} = {}",
            quote_ident(&column.name),
            literal(Some(value), cast)
        ));
    }
    Some(parts.join(" and "))
}

/// SQL that would undo this batch, or `None` when nothing in it is
/// reversible.
///
/// Updates and deletes are. Inserts are not: the batch does not return
/// the key the database assigned, and a guessed key is worse than an
/// honest gap. A row whose previous values were not sent is skipped for
/// the same reason.
pub fn build_undo(
    edit: &EditInfo,
    rows: &[RowEdit],
    before: &[RowBefore],
    deletes: &[RowDelete],
) -> Option<String> {
    let (schema, table) = (edit.schema.as_ref()?, edit.table.as_ref()?);
    let target = format!("{}.{}", quote_ident(schema), quote_ident(table));
    let previous = |row: usize| before.iter().find(|b| b.row == row);

    let mut statements: Vec<String> = Vec::new();

    for edited in rows {
        let Some(was) = previous(edited.row) else {
            continue;
        };
        let Some(key) = where_key(edit, &edited.pk) else {
            continue;
        };

        // Only the columns this batch actually changed: an undo that
        // rewrote untouched columns would revert somebody else's
        // concurrent edit along with ours.
        let mut sets = Vec::new();
        for cell in &edited.cells {
            let Some(column) = edit.columns.get(cell.column) else {
                continue;
            };
            let Some(name) = column.column_name.as_deref() else {
                continue;
            };
            let old = was
                .cells
                .iter()
                .find(|c| c.column == cell.column)
                .and_then(|c| c.value.as_deref());
            sets.push(format!(
                "{} = {}",
                quote_ident(name),
                literal(old, column.cast_type.as_deref())
            ));
        }

        if !sets.is_empty() {
            statements.push(format!(
                "update {target} set {} where {key};",
                sets.join(", ")
            ));
        }
    }

    for deleted in deletes {
        let Some(was) = previous(deleted.row) else {
            continue;
        };

        let mut names = Vec::new();
        let mut values = Vec::new();
        for cell in &was.cells {
            let Some(column) = edit.columns.get(cell.column) else {
                continue;
            };
            let Some(name) = column.column_name.as_deref() else {
                continue;
            };
            names.push(quote_ident(name));
            values.push(literal(cell.value.as_deref(), column.cast_type.as_deref()));
        }

        if !names.is_empty() {
            statements.push(format!(
                "insert into {target} ({}) values ({});",
                names.join(", "),
                values.join(", ")
            ));
        }
    }

    if statements.is_empty() {
        return None;
    }
    Some(statements.join("\n"))
}
```

In `src-tauri/src/edit/mod.rs`, add the module and its exports:

```rust
pub mod undo;

pub use undo::{build_undo, RowBefore};
```

- [ ] **Step 4: Run and watch them pass**

```bash
cd src-tauri && cargo test --test undo_test
```

Expected: 7 passed.

- [ ] **Step 5: Mutation check**

Remove the `.replace('\'', "''")` from `literal` and confirm
`a_quote_in_the_old_value_is_escaped` fails. Restore. Then make `literal`
return `"'null'"` for `None` and confirm
`a_null_it_used_to_hold_comes_back_as_null_not_as_the_word` fails. Restore, show
both failures and the restored pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/edit/undo.rs src-tauri/src/edit/mod.rs src-tauri/tests/undo_test.rs
git commit -m "feat(edit): derive what would put a grid edit back"
```

---

## Task 4: Recording from both write paths

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the recorder**

In `src-tauri/src/commands.rs`, beside `record_run`:

```rust
/// Record a write in the audit log.
///
/// Takes what is known and fills in the connection from state, so no
/// call site has to remember to. A failure here never fails the user's
/// statement, for the same reason history's does not: the workspace
/// database is ours, and their write really did happen.
fn record_write(
    state: &tauri::State<'_, AppState>,
    sql: &str,
    kind: &str,
    row_count: Option<i64>,
    outcome: &str,
    reason: Option<&str>,
    undo_sql: Option<String>,
) {
    let (connection_id, connection_name, tag) = {
        let active = state.active();
        match active.as_ref() {
            Some(a) => {
                let name = state
                    .library
                    .connection(&a.id)
                    .map(|c| c.name)
                    .unwrap_or_else(|_| a.info.dbname.clone());
                (Some(a.id.clone()), name, a.tag.as_str().to_string())
            }
            // Recorded anyway: a write with no connection should never
            // happen, and if it does the log is where that shows up.
            None => (None, "unknown".to_string(), "unknown".to_string()),
        }
    };

    if let Err(e) = state.library.record_write(crate::library::model::WriteEntry {
        connection_id,
        connection_name,
        tag,
        sql: sql.to_string(),
        kind: kind.to_string(),
        row_count,
        outcome: outcome.to_string(),
        reason: reason.map(str::to_string),
        undo_sql,
    }) {
        eprintln!("could not record this write in the audit log: {e}");
    }
}

/// The audit log's name for a kind of write.
fn kind_name(kind: crate::guard::plan::WriteKind) -> &'static str {
    use crate::guard::plan::WriteKind;
    match kind {
        WriteKind::Update => "update",
        WriteKind::Delete => "delete",
        WriteKind::Insert => "insert",
        WriteKind::Ddl => "ddl",
        WriteKind::Other => "other",
    }
}
```

- [ ] **Step 2: Record the guarded path**

In `execute`, the write branch already computes `kind`. Add a `record_write`
call to each of its three outcomes. Replace the `match` at the end of `execute`
with:

```rust
    match crate::exec::guarded::run_guarded(&pool, &sql, tag, kind, expect, object.as_deref()).await
    {
        Ok(crate::exec::guarded::Outcome::Done(result)) => {
            record_run(
                &state,
                &sql,
                generated,
                Some(result.duration_ms as i64),
                result.affected_rows.map(|n| n as i64),
                None,
            );
            record_write(
                &state,
                &sql,
                kind_name(kind),
                result.affected_rows.map(|n| n as i64),
                "committed",
                None,
                None,
            );
            Ok(ExecuteResponse::Done(result))
        }
        Ok(crate::exec::guarded::Outcome::Waiting {
            parked,
            summary,
            affected,
        }) => {
            // Recorded when it resolves, not now: what happened to it is
            // still undecided, and an audit line that says "committed"
            // about a write the user then discarded would be worse than
            // no line at all.
            let token = crate::library::store::new_token();
            *state.pending() = Some((token.clone(), parked));
            Ok(ExecuteResponse::Waiting {
                token,
                summary,
                affected,
                sql,
            })
        }
        Err(e) => {
            record_run(&state, &sql, generated, None, None, Some(&e.to_string()));
            // A refusal is a `-- expect:` mismatch — the guard stopping a
            // write on purpose. Anything else is the database saying no.
            let outcome = if expect.is_some() { "refused" } else { "failed" };
            record_write(
                &state,
                &sql,
                kind_name(kind),
                None,
                outcome,
                Some(&e.to_string()),
                None,
            );
            Err(e)
        }
    }
}
```

- [ ] **Step 3: Record the resolution**

In `resolve_write`, replace the recording block with one that writes both logs:

```rust
    match &outcome {
        Ok(result) if commit => {
            record_run(
                &state,
                &sql,
                false,
                Some(0),
                result.affected_rows.map(|n| n as i64),
                None,
            );
            record_write(
                &state,
                &sql,
                "other",
                result.affected_rows.map(|n| n as i64),
                "committed",
                None,
                None,
            );
        }
        Ok(_) => {
            record_run(
                &state,
                &sql,
                false,
                None,
                None,
                Some("discarded — rolled back"),
            );
            record_write(&state, &sql, "other", None, "rolled_back", None, None);
        }
        Err(e) => {
            record_run(&state, &sql, false, None, None, Some(&e.to_string()));
            record_write(
                &state,
                &sql,
                "other",
                None,
                "failed",
                Some(&e.to_string()),
                None,
            );
        }
    }
```

- [ ] **Step 4: Record the grid's batch, with its undo**

Replace `apply_row_edits` in `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub async fn apply_row_edits(
    state: tauri::State<'_, AppState>,
    edit: EditInfo,
    rows: Vec<RowEdit>,
    deletes: Vec<RowDelete>,
    inserts: Vec<RowInsert>,
    before: Vec<crate::edit::RowBefore>,
) -> Result<Vec<AppliedRow>, AppError> {
    let (pool, policy, unlocked_until) = state.pool_and_guard()?;

    let statements = build_batch(&edit, &rows, &deletes, &inserts)?;

    // The same chokepoint every typed statement crosses. The UI hides
    // editing on a locked connection; this does not trust it to.
    let read_write = plan_apply(policy, unlocked_until, Instant::now(), &statements)?;

    // What the batch will look like in the log, and what would put it
    // back. Built before running: the undo is derived from the values
    // the grid held, which the reply is about to overwrite.
    let summary = statements
        .iter()
        .map(|s| s.sql.clone())
        .collect::<Vec<_>>()
        .join("\n");
    let undo = crate::edit::build_undo(&edit, &rows, &before, &deletes);
    let touched = (rows.len() + deletes.len() + inserts.len()) as i64;

    let outcome = apply_edits(&pool, &statements, read_write).await;

    match &outcome {
        Ok(_) => record_write(
            &state,
            &summary,
            "batch",
            Some(touched),
            "committed",
            None,
            undo,
        ),
        Err(e) => record_write(
            &state,
            &summary,
            "batch",
            None,
            "failed",
            Some(&e.to_string()),
            None,
        ),
    }

    outcome
}
```

- [ ] **Step 5: Expose the log**

```rust
#[tauri::command]
pub fn list_writes(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::library::model::WriteRecord>, AppError> {
    state.library.writes()
}
```

Register it in `src-tauri/src/lib.rs`:

```rust
            commands::list_writes,
```

- [ ] **Step 6: Check it compiles**

```bash
cd src-tauri && cargo build && cargo clippy --all-targets -- -D warnings && cargo fmt
```

The frontend will not compile until Task 5 adds `before` to the `applyRowEdits`
call; that is expected at this point.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(exec): record every write, and how it ended"
```

---

## Task 5: The frontend's half of the contract

**Files:**
- Modify: `src/types.ts`, `src/lib/ipc.ts`, `src/App.tsx`

- [ ] **Step 1: Mirror the record**

In `src/types.ts`:

```ts
/** Mirrors Rust `WriteRecord`: one line of the write audit log. */
export interface WriteRecord {
  id: string;
  at: string;
  connection_id: string | null;
  /** Copied in at the time, so the row still names its database. */
  connection_name: string;
  tag: string;
  sql: string;
  kind: string;
  row_count: number | null;
  /** `committed`, `rolled_back`, `refused` or `failed`. */
  outcome: string;
  reason: string | null;
  /** SQL that would put it back, on grid edits only. */
  undo_sql: string | null;
}

/** The values a row held before a batch changed it. */
export interface RowBefore {
  row: number;
  cells: { column: number; value: string | null }[];
}
```

- [ ] **Step 2: Send the previous values, and read the log**

In `src/lib/ipc.ts`, `applyRowEdits` gains the parameter:

```ts
export async function applyRowEdits(
  edit: EditInfo,
  rows: RowEdit[],
  deletes: RowDelete[],
  inserts: RowInsert[],
  before: RowBefore[],
): Promise<AppliedRow[]> {
  return invoke<AppliedRow[]>("apply_row_edits", {
    edit,
    rows,
    deletes,
    inserts,
    before,
  });
}

/** Every write this app has made, newest first. */
export async function listWrites(): Promise<WriteRecord[]> {
  return invoke<WriteRecord[]>("list_writes");
}
```

Add `RowBefore` and `WriteRecord` to the type imports at the top of the file.
The existing signature is at `src/lib/ipc.ts:112` and takes `edit, rows,
deletes, inserts`; only the fifth parameter is new.

- [ ] **Step 3: Build the previous values in App**

In `src/App.tsx`, in the callback that applies edits (`onConfirmEdits`), build
`before` from the result the grid is showing, and pass it:

```tsx
      // What these rows hold right now, for the audit log's undo. Taken
      // from the grid rather than re-read from the database: it is on
      // screen already, and reading it back would be a second round trip
      // to learn what we can see.
      const touched = new Set<number>([
        ...toRowEdits(pending, result).map((r) => r.row),
        ...toRowDeletes(deletes, result).map((d) => d.row),
      ]);
      const before = [...touched].map((row) => ({
        row,
        cells: (result?.columns ?? []).map((_, column) => ({
          column,
          value:
            result?.rows[row]?.[column] === null ||
            result?.rows[row]?.[column] === undefined
              ? null
              : String(result.rows[row][column]),
        })),
      }));
```

The call site is `onConfirmEdits` at `src/App.tsx:667`. It becomes:

```tsx
      const applied = await applyRowEdits(
        result.edit,
        toRowEdits(pending, result),
        toRowDeletes(deletes, result),
        toRowInserts(inserts),
        before,
      );
```

Note that `toRowEdits` and `toRowDeletes` both take `result` as a second
argument here — they read the keys out of it — so `before` is built from the
same `result` and its row indexes line up with theirs by construction.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit -p tsconfig.json && npm test && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/lib/ipc.ts src/App.tsx
git commit -m "feat(edit): send the values a batch is about to overwrite"
```

---

## Task 6: The Writes tab

**Files:**
- Create: `src/lib/writes.ts`, `src/lib/writes.test.ts`, `src/components/WritesList.tsx`
- Modify: `src/components/Sidebar.tsx`, `src/App.tsx`, `src/App.css`

- [ ] **Step 1: Write the failing tests for the pure part**

Create `src/lib/writes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeWrite, matchesWrite } from "./writes";
import type { WriteRecord } from "../types";

function record(over: Partial<WriteRecord>): WriteRecord {
  return {
    id: "id",
    at: "2026-08-21T10:00:00Z",
    connection_id: "conn-a",
    connection_name: "smoke",
    tag: "local",
    sql: "update t set a = 1",
    kind: "update",
    row_count: 3,
    outcome: "committed",
    reason: null,
    undo_sql: null,
    ...over,
  };
}

describe("describeWrite", () => {
  it("says what a committed write did", () => {
    expect(describeWrite(record({ row_count: 3 }))).toBe("3 rows · committed");
  });

  it("counts one row as one row", () => {
    expect(describeWrite(record({ row_count: 1 }))).toBe("1 row · committed");
  });

  it("says a rollback happened rather than staying silent about it", () => {
    // The whole reason rollbacks are recorded: "I nearly did this" is
    // the fact worth having.
    expect(describeWrite(record({ outcome: "rolled_back", row_count: null }))).toBe(
      "discarded",
    );
  });

  it("gives a refusal its reason", () => {
    const text = describeWrite(
      record({
        outcome: "refused",
        row_count: null,
        reason: "-- expect: 1, but 5 rows matched — rolled back",
      }),
    );
    expect(text).toContain("refused");
    expect(text).toContain("expect");
  });

  it("gives a failure its reason", () => {
    const text = describeWrite(
      record({ outcome: "failed", row_count: null, reason: 'relation "t" does not exist' }),
    );
    expect(text).toContain("failed");
    expect(text).toContain("does not exist");
  });

  it("says nothing about a rowcount a DDL statement never had", () => {
    expect(describeWrite(record({ kind: "ddl", row_count: null }))).toBe("committed");
  });
});

describe("matchesWrite", () => {
  it("matches on the SQL, case-insensitively", () => {
    expect(matchesWrite(record({ sql: "DELETE FROM orders" }), "orders")).toBe(true);
    expect(matchesWrite(record({ sql: "DELETE FROM orders" }), "customers")).toBe(false);
  });

  it("matches on the connection it hit", () => {
    // Six months later, "what did I run against production" is the
    // question being asked.
    expect(matchesWrite(record({ connection_name: "railway" }), "railway")).toBe(true);
  });

  it("matches everything on an empty filter", () => {
    expect(matchesWrite(record({}), "")).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run src/lib/writes.test.ts
```

Expected: FAIL — cannot resolve `./writes`.

- [ ] **Step 3: Implement**

Create `src/lib/writes.ts`:

```ts
import type { WriteRecord } from "../types";

/**
 * The one quiet line under a write's SQL.
 *
 * A rollback and a refusal say so plainly. They are recorded precisely
 * because they are interesting later, and a log that showed only the
 * commits would answer "what did I change" while quietly dropping "what
 * did I nearly change".
 */
export function describeWrite(write: WriteRecord): string {
  const rows =
    write.row_count === null
      ? null
      : `${write.row_count} ${write.row_count === 1 ? "row" : "rows"}`;

  if (write.outcome === "rolled_back") return "discarded";
  if (write.outcome === "refused") {
    return write.reason ? `refused · ${write.reason}` : "refused";
  }
  if (write.outcome === "failed") {
    return write.reason ? `failed · ${write.reason}` : "failed";
  }

  return rows ? `${rows} · committed` : "committed";
}

/** Case-insensitive match on the statement and the database it hit. */
export function matchesWrite(write: WriteRecord, filter: string): boolean {
  if (filter === "") return true;
  const needle = filter.toLowerCase();
  return (
    write.sql.toLowerCase().includes(needle) ||
    write.connection_name.toLowerCase().includes(needle)
  );
}
```

- [ ] **Step 4: Run and watch them pass**

```bash
npx vitest run src/lib/writes.test.ts
```

Expected: 9 passed.

- [ ] **Step 5: Build the list**

Create `src/components/WritesList.tsx`:

```tsx
import { useMemo, useState } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { describeWrite, matchesWrite } from "../lib/writes";
import type { Connection, WriteRecord } from "../types";

interface Props {
  writes: WriteRecord[];
  connections: Connection[];
  /** Open a new tab holding this SQL. Never runs it. */
  onOpen: (sql: string) => void;
}

/** The first line with anything on it, which is what a row can show. */
function firstLine(sql: string): string {
  return sql.split("\n").find((l) => l.trim() !== "")?.trim() ?? sql.trim();
}

/**
 * What this app wrote, newest first.
 *
 * Read-only by construction: there is no delete here, and no way to
 * change a row. A log somebody can edit answers a different, weaker
 * question than the one it exists for.
 */
export function WritesList({ writes, connections, onOpen }: Props) {
  const [filter, setFilter] = useState("");
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const rows = useMemo(
    () => writes.filter((w) => matchesWrite(w, filter)),
    [writes, filter],
  );

  return (
    <>
      <div className="schema-toolbar">
        <input
          className="schema-filter"
          placeholder="Filter writes…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
      </div>

      {rows.length === 0 && (
        <p className="tree-empty">
          {writes.length === 0
            ? "Nothing yet. Every write this app makes is recorded here."
            : "Nothing matches."}
        </p>
      )}

      <div className="recent-rows">
        {rows.map((write) => {
          const origin = connections.find((c) => c.id === write.connection_id);
          const colour = origin?.colour;
          return (
            <div
              key={write.id}
              className={`recent-row write-row ${write.outcome}`}
              role="button"
              tabIndex={0}
              title={write.sql}
              onDoubleClick={() => onOpen(write.sql)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onOpen(write.sql);
                }
              }}
              onContextMenu={(e) =>
                openMenu(e, [
                  {
                    label: "Open in a new tab",
                    shortcut: "↵",
                    onSelect: () => onOpen(write.sql),
                  },
                  {
                    label: "Copy SQL",
                    onSelect: () => void navigator.clipboard.writeText(write.sql),
                  },
                  {
                    label: "Open the undo",
                    disabled: write.undo_sql === null,
                    title:
                      write.undo_sql === null
                        ? "only the grid's own edits carry an undo"
                        : undefined,
                    onSelect: () => write.undo_sql && onOpen(write.undo_sql),
                  },
                ])
              }
            >
              <span className="recent-sql">{firstLine(write.sql)}</span>
              <span className="recent-meta">
                <span
                  className="picker-tag overline"
                  style={colour ? { color: colour, borderColor: colour } : undefined}
                >
                  {write.tag}
                </span>
                <span className="recent-summary">{describeWrite(write)}</span>
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

- [ ] **Step 6: Add the third tab**

In `src/components/Sidebar.tsx`, widen the section state and add the tab. The
state becomes:

```tsx
  const [bottom, setBottom] = useState<"queries" | "history" | "writes">(
    "queries",
  );
```

Add to `Props`:

```tsx
  writes: WriteRecord[];
  onOpenWrite: (sql: string) => void;
```

Add the button beside the other two:

```tsx
            <button
              className={bottom === "writes" ? "overline active" : "overline"}
              onClick={() => setBottom("writes")}
            >
              Writes
            </button>
```

and the third branch where the section renders its list:

```tsx
        ) : bottom === "history" ? (
          <RecentList
            items={props.recent}
            connections={props.connections}
            activeConnectionId={props.activeConnectionId}
            onOpen={props.onOpenRecent}
            onForget={props.onForgetRecent}
          />
        ) : (
          <WritesList
            writes={props.writes}
            connections={props.connections}
            onOpen={props.onOpenWrite}
          />
        )}
```

Import `WritesList` and the `WriteRecord` type.

- [ ] **Step 7: Load them in App**

In `src/App.tsx`, beside `recent`:

```tsx
  // Every write this app has made. Reloaded whenever one happens, which
  // is why it hangs off the same places history does.
  const [writes, setWrites] = useState<WriteRecord[]>([]);

  const refreshWrites = useCallback(() => {
    void listWrites().then(setWrites);
  }, []);

  useEffect(() => refreshWrites(), [refreshWrites]);
```

Call `refreshWrites()` everywhere `refreshRecent()` is already called — the end
of `runSql`, `finishPendingWrite`, and after a batch applies in
`onConfirmEdits` — and pass the two new props to `<Sidebar>`:

```tsx
          writes={writes}
          onOpenWrite={(sql) => void openRecent(sql)}
```

`openRecent` already opens a new tab holding SQL without running it, which is
exactly what a write row needs.

- [ ] **Step 8: Style the outcome**

In `src/App.css`, beside the `.recent-row` rules:

```css
/* A refused or failed write reads differently from one that landed. The
   left edge carries it: the list is scanned, not read. */
.write-row.refused,
.write-row.failed {
  border-left: 2px solid var(--error);
}

.write-row.rolled_back {
  border-left: 2px solid var(--border);
}
```

- [ ] **Step 9: Verify**

```bash
npx tsc --noEmit -p tsconfig.json && npm test && npm run build
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add src src-tauri
git commit -m "feat(history): show what this app wrote"
```

---

## Smoke test, for the owner

Against `smoke-test` — **never** `railway`. Run
`./scripts/smoke-db/reset.sh` first, and again at the end.

1. `update customers set is_active = true` on the prod-tagged smoke connection →
   confirm → the Writes tab shows one row: `500 rows · committed`, tagged.
2. Repeat and **discard** → a second row appears, reading `discarded`. Both are
   there: the log does not collapse.
3. `update customers set is_active = true -- expect: 1` → refused → a row
   reading `refused · -- expect: 1, but 500 rows matched`.
4. `update nope set a = 1` → a row reading `failed · relation "nope" does not
   exist`.
5. Edit a cell in the grid and apply → a `batch` row. Right-click → **Open the
   undo** → a new tab holding an `update … set … where "id" = …` that restores
   the old value. Run it and check the cell goes back.
6. Delete a row in the grid and apply → its undo is an `insert` carrying the
   whole row.
7. Insert a row in the grid and apply → recorded, and **Open the undo** is
   disabled with the reason in its tooltip.
8. Delete the smoke connection in the app → its write rows are still listed and
   still say `smoke`. Re-add the connection afterwards.
