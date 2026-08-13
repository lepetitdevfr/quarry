# Saved Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save connection configurations and switch between databases from a header dropdown, with passwords in the Keychain and no auto-connect on launch.

**Architecture:** Connections become a fifth table in the existing workspace SQLite database, managed by a `library::connections` store module following the same pattern as collections and queries. `AppState` drops its pool map for a single active connection, which removes the `connection_id` argument from `execute` and deletes the `UnknownConnection` error path. The UI gains a picker (shown on launch and from a header dropdown) and an editor.

**Tech Stack:** Rust (`rusqlite`, `deadpool-postgres`, `security-framework`), React 19 + TypeScript 7, Tauri 2.

**Spec:** `docs/superpowers/specs/2026-08-14-saved-connections-design.md`

---

## Prerequisites

- On `main`, clean tree, 102 tests passing (80 Rust + 22 TS)
- If `cargo` is missing: `export PATH="/opt/homebrew/opt/rustup/bin:$PATH"`
- Docker running (integration tests use testcontainers)
- **Commit messages must NOT include a `Co-Authored-By: Claude` trailer**

Create a branch:

```bash
cd /Users/lepetitdev/dev/quarry && git checkout -b stage-3-connections
```

---

## Migration safety

The developer has a real workspace database at
`~/Library/Application Support/com.quarry.app/workspace.db` containing saved
queries and tabs. `migrate()` uses `create table if not exists`, so adding a
table is additive — but Task 1 includes an explicit test that a v1 database
keeps its rows, because losing the user's library would be unrecoverable.

---

## File Structure

### Rust (`src-tauri/`)

| File | Responsibility |
|------|----------------|
| `src/library/model.rs` | *(modify)* add `Connection`, `ConnectionInput`, `Tag` |
| `src/library/db.rs` | *(modify)* add the `connections` table, bump `SCHEMA_VERSION` to 2 |
| `src/library/connections.rs` | Connection CRUD, `last_used_at`, Keychain cleanup |
| `src/library/mod.rs` | *(modify)* declare `connections` |
| `src/conn/config.rs` | *(modify)* `SslMode::as_str` / `from_str` for storage |
| `src/commands.rs` | *(modify)* single-active `AppState`, connection commands |
| `src/lib.rs` | *(modify)* register new commands |
| `tests/connections_test.rs` | Store behavior against a temp database |

### TypeScript (`src/`)

| File | Responsibility |
|------|----------------|
| `src/types.ts` | *(modify)* `Connection`, `ConnectionInput`, `Tag` |
| `src/lib/ipc.ts` | *(modify)* connection wrappers; `execute` loses its id |
| `src/lib/connections.ts` | Pure helpers: sort, parse a URL into form fields |
| `src/lib/connections.test.ts` | Vitest for those helpers |
| `src/hooks/useConnections.ts` | Connection state and actions |
| `src/components/ConnectionPicker.tsx` | Launch panel + header dropdown list |
| `src/components/ConnectionEditor.tsx` | Create/edit form |
| `src/components/ConnectionForm.tsx` | *(delete)* replaced by the editor |
| `src/App.tsx` | *(modify)* boot to the picker, header dropdown, clear results |

---

## Task 1: Add the connections table

**Files:**
- Modify: `src-tauri/src/library/db.rs`
- Test: `src-tauri/src/library/db.rs` (its existing `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing tests**

Add to the existing test module in `src-tauri/src/library/db.rs`:

```rust
    #[test]
    fn creates_the_connections_table() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("w.db")).unwrap();

        let count: i64 = conn
            .query_row(
                "select count(*) from sqlite_master
                 where type = 'table' and name = 'connections'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(count, 1);
    }

    #[test]
    fn upgrading_a_v1_database_keeps_existing_rows() {
        // The developer has a real library on disk. Adding a table must
        // never cost them their saved queries.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("w.db");

        {
            let conn = open(&path).unwrap();
            conn.execute(
                "insert into queries (id, collection_id, name, sql, draft_sql,
                                      position, created_at, updated_at)
                 values ('q1', null, 'keeper', 'select 1', null, 100, 'now', 'now')",
                [],
            )
            .unwrap();
            conn.execute("update meta set value = '1' where key = 'schema_version'", [])
                .unwrap();
        }

        // Reopening runs migrate() again, as a version upgrade would.
        let conn = open(&path).unwrap();

        let name: String = conn
            .query_row("select name from queries where id = 'q1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "keeper");

        let version: String = conn
            .query_row("select value from meta where key = 'schema_version'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(version, "2");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --lib library::db 2>&1 | tail -15
```

Expected: `creates_the_connections_table` fails (count is 0) and
`upgrading_a_v1_database_keeps_existing_rows` fails on the version assertion.

- [ ] **Step 3: Add the table and bump the version**

In `src-tauri/src/library/db.rs`, change the `SCHEMA_VERSION` constant to `2`,
then add this to the `execute_batch` string in `migrate`, after the `tabs`
table:

```sql
        create table if not exists connections (
            id           text primary key,
            name         text not null,
            host         text not null,
            port         integer not null,
            "user"       text not null,
            dbname       text not null,
            sslmode      text not null,
            tag          text not null,
            colour       text not null,
            last_used_at text,
            created_at   text not null
        );
```

`user` is quoted because it is a SQL keyword.

Add this index alongside the existing ones:

```sql
        create index if not exists idx_connections_last_used on connections(last_used_at);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --lib library::db 2>&1 | tail -12
```

Expected: `test result: ok. 6 passed` (4 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/library/db.rs
git commit -m "feat(library): add the connections table"
```

---

## Task 2: Connection model

**Files:**
- Modify: `src-tauri/src/library/model.rs`
- Modify: `src-tauri/src/conn/config.rs`

- [ ] **Step 1: Add string conversion for SslMode**

`SslMode` must round-trip through a text column. Add to
`src-tauri/src/conn/config.rs`, inside `impl SslMode` (create the impl block if
there is none):

```rust
impl SslMode {
    /// Stored form. Kept in sync with `from_str` below.
    pub fn as_str(&self) -> &'static str {
        match self {
            SslMode::Disable => "disable",
            SslMode::Prefer => "prefer",
            SslMode::Require => "require",
        }
    }

    /// Parse the stored form. Anything unrecognised becomes `Prefer`,
    /// matching what `from_url` does with an unknown sslmode.
    pub fn from_stored(s: &str) -> Self {
        match s {
            "disable" => SslMode::Disable,
            "require" => SslMode::Require,
            _ => SslMode::Prefer,
        }
    }
}
```

- [ ] **Step 2: Add a round-trip test**

Add to the test module in `src-tauri/src/conn/config.rs`:

```rust
    #[test]
    fn sslmode_round_trips_through_its_stored_form() {
        for mode in [SslMode::Disable, SslMode::Prefer, SslMode::Require] {
            assert_eq!(SslMode::from_stored(mode.as_str()), mode);
        }
    }

    #[test]
    fn an_unknown_stored_sslmode_falls_back_to_prefer() {
        assert_eq!(SslMode::from_stored("nonsense"), SslMode::Prefer);
    }
```

- [ ] **Step 3: Run the tests**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --lib conn::config 2>&1 | tail -8
```

Expected: `test result: ok. 10 passed` (8 existing + 2 new).

- [ ] **Step 4: Add the connection types**

Append to `src-tauri/src/library/model.rs`:

```rust
use crate::conn::config::SslMode;

/// What kind of environment a connection points at.
///
/// Nothing enforces this yet — the write-guard is a later stage. It
/// exists now so the guard needs no schema migration, and so the UI can
/// make production visually obvious today.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tag {
    Local,
    Staging,
    Prod,
}

impl Tag {
    pub fn as_str(&self) -> &'static str {
        match self {
            Tag::Local => "local",
            Tag::Staging => "staging",
            Tag::Prod => "prod",
        }
    }

    /// Unrecognised values become `Prod`. Erring toward the most
    /// cautious tag means a corrupted row shows as dangerous rather
    /// than looking safe.
    pub fn from_stored(s: &str) -> Self {
        match s {
            "local" => Tag::Local,
            "staging" => Tag::Staging,
            _ => Tag::Prod,
        }
    }

    /// Default colour when the user does not pick one.
    pub fn default_colour(&self) -> &'static str {
        match self {
            Tag::Local => "#4ade80",
            Tag::Staging => "#fbbf24",
            Tag::Prod => "#f26d6d",
        }
    }
}

/// A saved connection. The password is NOT here — it lives in the
/// Keychain under this record's id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub dbname: String,
    pub sslmode: SslMode,
    pub tag: Tag,
    pub colour: String,
    pub last_used_at: Option<String>,
    pub created_at: String,
}

/// The fields the UI submits when creating or editing a connection.
/// `password` is optional: absent means "leave the Keychain entry
/// alone" on edit, and "no password" on create.
#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub dbname: String,
    pub sslmode: SslMode,
    pub tag: Tag,
    pub colour: Option<String>,
    pub password: Option<String>,
}
```

- [ ] **Step 5: Verify it compiles**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo check 2>&1 | tail -5
```

Expected: `Finished`, no errors. If `Serialize`/`Deserialize` are not already
imported in `model.rs`, add `use serde::{Deserialize, Serialize};`.

- [ ] **Step 6: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/library/model.rs src-tauri/src/conn/config.rs
git commit -m "feat(library): add connection, tag, and sslmode storage types"
```

---

## Task 3: Connection store (TDD)

**Files:**
- Create: `src-tauri/src/library/connections.rs`
- Modify: `src-tauri/src/library/mod.rs`
- Create: `src-tauri/tests/connections_test.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/connections_test.rs`:

```rust
use quarry_lib::conn::config::SslMode;
use quarry_lib::library::model::{ConnectionInput, Tag};
use quarry_lib::library::store::Store;

fn store() -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_at(&dir.path().join("w.db")).unwrap();
    (store, dir)
}

fn input(name: &str, tag: Tag) -> ConnectionInput {
    ConnectionInput {
        name: name.to_string(),
        host: "localhost".to_string(),
        port: 5432,
        user: "postgres".to_string(),
        dbname: "postgres".to_string(),
        sslmode: SslMode::Disable,
        tag,
        colour: None,
        password: None,
    }
}

#[test]
fn creates_and_lists_a_connection() {
    let (store, _dir) = store();

    store.create_connection(input("dev", Tag::Local)).unwrap();
    let all = store.connections().unwrap();

    assert_eq!(all.len(), 1);
    assert_eq!(all[0].name, "dev");
    assert_eq!(all[0].tag, Tag::Local);
    assert_eq!(all[0].port, 5432);
    assert_eq!(all[0].sslmode, SslMode::Disable);
    assert!(all[0].last_used_at.is_none(), "never used yet");
}

#[test]
fn defaults_the_colour_from_the_tag() {
    let (store, _dir) = store();

    let c = store.create_connection(input("prod", Tag::Prod)).unwrap();

    assert_eq!(c.colour, Tag::Prod.default_colour());
}

#[test]
fn keeps_an_explicit_colour() {
    let (store, _dir) = store();

    let mut i = input("dev", Tag::Local);
    i.colour = Some("#123456".to_string());
    let c = store.create_connection(i).unwrap();

    assert_eq!(c.colour, "#123456");
}

#[test]
fn rejects_an_empty_name() {
    let (store, _dir) = store();

    assert!(store.create_connection(input("   ", Tag::Local)).is_err());
}

#[test]
fn updates_a_connection() {
    let (store, _dir) = store();
    let c = store.create_connection(input("dev", Tag::Local)).unwrap();

    let mut i = input("dev-renamed", Tag::Staging);
    i.dbname = "other".to_string();
    store.update_connection(&c.id, i).unwrap();

    let all = store.connections().unwrap();
    assert_eq!(all[0].name, "dev-renamed");
    assert_eq!(all[0].tag, Tag::Staging);
    assert_eq!(all[0].dbname, "other");
}

#[test]
fn deletes_a_connection() {
    let (store, _dir) = store();
    let c = store.create_connection(input("dev", Tag::Local)).unwrap();

    store.delete_connection(&c.id).unwrap();

    assert!(store.connections().unwrap().is_empty());
}

#[test]
fn orders_by_most_recently_used_then_name() {
    let (store, _dir) = store();
    let a = store.create_connection(input("alpha", Tag::Local)).unwrap();
    let b = store.create_connection(input("beta", Tag::Local)).unwrap();
    let _c = store.create_connection(input("gamma", Tag::Local)).unwrap();

    store.touch_connection(&b.id).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    store.touch_connection(&a.id).unwrap();

    let names: Vec<String> = store
        .connections()
        .unwrap()
        .into_iter()
        .map(|c| c.name)
        .collect();

    // Used ones first, most recent first; never-used sort last by name.
    assert_eq!(names, vec!["alpha", "beta", "gamma"]);
}

#[test]
fn reads_a_single_connection() {
    let (store, _dir) = store();
    let c = store.create_connection(input("dev", Tag::Local)).unwrap();

    let found = store.connection(&c.id).unwrap();

    assert_eq!(found.name, "dev");
}

#[test]
fn reading_a_missing_connection_is_an_error() {
    let (store, _dir) = store();

    assert!(store.connection("nope").is_err());
}

#[test]
fn a_connection_survives_reopening_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("w.db");

    {
        let store = Store::open_at(&path).unwrap();
        store.create_connection(input("dev", Tag::Local)).unwrap();
    }

    let store = Store::open_at(&path).unwrap();
    assert_eq!(store.connections().unwrap().len(), 1);
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test connections_test 2>&1 | tail -15
```

Expected: compilation failure — `no method named create_connection found for struct Store`.

- [ ] **Step 3: Write the store module**

Create `src-tauri/src/library/connections.rs`:

```rust
//! Connection records.
//!
//! These are `impl Store` blocks living in their own file to keep
//! `store.rs` focused on collections, queries, and tabs.
//!
//! Passwords are never stored here. They live in the macOS Keychain
//! under the connection's id, and `delete_connection` removes the
//! Keychain entry alongside the row — a deleted connection must not
//! leave a credential behind.

use crate::conn::config::SslMode;
use crate::error::AppError;
use crate::library::model::{Connection, ConnectionInput, Tag};
use crate::library::store::{new_id, now_iso, sql_err, validate_name, Store};
use rusqlite::{params, Row};

impl Store {
    pub fn connections(&self) -> Result<Vec<Connection>, AppError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "select id, name, host, port, \"user\", dbname, sslmode, tag,
                        colour, last_used_at, created_at
                 from connections
                 order by last_used_at is null, last_used_at desc, name",
            )
            .map_err(sql_err)?;

        let rows = stmt
            .query_map([], read_connection)
            .map_err(sql_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_err)?;

        Ok(rows)
    }

    pub fn connection(&self, id: &str) -> Result<Connection, AppError> {
        self.lock()
            .query_row(
                "select id, name, host, port, \"user\", dbname, sslmode, tag,
                        colour, last_used_at, created_at
                 from connections where id = ?1",
                params![id],
                read_connection,
            )
            .map_err(|_| AppError::Library(format!("no such connection: {id}")))
    }

    pub fn create_connection(
        &self,
        input: ConnectionInput,
    ) -> Result<Connection, AppError> {
        let name = validate_name(&input.name)?;
        let colour = input
            .colour
            .clone()
            .unwrap_or_else(|| input.tag.default_colour().to_string());

        let c = Connection {
            id: new_id(),
            name,
            host: input.host,
            port: input.port,
            user: input.user,
            dbname: input.dbname,
            sslmode: input.sslmode,
            tag: input.tag,
            colour,
            last_used_at: None,
            created_at: now_iso(),
        };

        self.lock()
            .execute(
                "insert into connections
                   (id, name, host, port, \"user\", dbname, sslmode, tag,
                    colour, last_used_at, created_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, null, ?10)",
                params![
                    c.id,
                    c.name,
                    c.host,
                    c.port,
                    c.user,
                    c.dbname,
                    c.sslmode.as_str(),
                    c.tag.as_str(),
                    c.colour,
                    c.created_at,
                ],
            )
            .map_err(sql_err)?;

        Ok(c)
    }

    pub fn update_connection(
        &self,
        id: &str,
        input: ConnectionInput,
    ) -> Result<(), AppError> {
        let name = validate_name(&input.name)?;
        let colour = input
            .colour
            .clone()
            .unwrap_or_else(|| input.tag.default_colour().to_string());

        let changed = self
            .lock()
            .execute(
                "update connections
                 set name = ?2, host = ?3, port = ?4, \"user\" = ?5, dbname = ?6,
                     sslmode = ?7, tag = ?8, colour = ?9
                 where id = ?1",
                params![
                    id,
                    name,
                    input.host,
                    input.port,
                    input.user,
                    input.dbname,
                    input.sslmode.as_str(),
                    input.tag.as_str(),
                    colour,
                ],
            )
            .map_err(sql_err)?;

        if changed == 0 {
            return Err(AppError::Library(format!("no such connection: {id}")));
        }
        Ok(())
    }

    /// Delete the record and its Keychain entry.
    ///
    /// The credential is removed first: if that fails we stop, because
    /// deleting the row would orphan a password with no way to reach it
    /// from the UI again.
    pub fn delete_connection(&self, id: &str) -> Result<(), AppError> {
        crate::secrets::delete_password(id)?;

        self.lock()
            .execute("delete from connections where id = ?1", params![id])
            .map_err(sql_err)?;

        Ok(())
    }

    /// Stamp this connection as the most recently used one.
    pub fn touch_connection(&self, id: &str) -> Result<(), AppError> {
        self.lock()
            .execute(
                "update connections set last_used_at = ?2 where id = ?1",
                params![id, now_iso()],
            )
            .map_err(sql_err)?;
        Ok(())
    }
}

fn read_connection(row: &Row) -> rusqlite::Result<Connection> {
    let sslmode: String = row.get(6)?;
    let tag: String = row.get(7)?;

    Ok(Connection {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get(3)?,
        user: row.get(4)?,
        dbname: row.get(5)?,
        sslmode: SslMode::from_stored(&sslmode),
        tag: Tag::from_stored(&tag),
        colour: row.get(8)?,
        last_used_at: row.get(9)?,
        created_at: row.get(10)?,
    })
}
```

- [ ] **Step 4: Export the helpers this module needs**

`connections.rs` uses `new_id`, `now_iso`, `sql_err`, `validate_name`, and
`Store::lock` from `store.rs`. Check their current visibility:

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && grep -n "fn new_id\|fn now_iso\|fn sql_err\|fn validate_name\|fn lock" src/library/store.rs
```

Any of these that are private need `pub(crate)`. Change only the visibility
keyword — do not alter the function bodies. If a helper has a different name
(for example a timestamp helper called something other than `now_iso`), use the
real name in `connections.rs` and note the difference in your report.

- [ ] **Step 5: Declare the module**

Add to `src-tauri/src/library/mod.rs`:

```rust
pub mod connections;
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test connections_test 2>&1 | tail -18
```

Expected: `test result: ok. 10 passed; 0 failed`.

- [ ] **Step 7: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/library
git add src-tauri/tests/connections_test.rs
git commit -m "feat(library): add the connection store"
```

---

## Task 4: Keychain cleanup on delete (TDD)

Deleting a connection must not leave its password in the Keychain. Task 3 wrote
that behavior; this task proves it against the real Keychain.

**Files:**
- Modify: `src-tauri/tests/connections_test.rs`

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/tests/connections_test.rs`:

```rust
#[test]
fn deleting_a_connection_removes_its_keychain_entry() {
    let (store, _dir) = store();
    let c = store.create_connection(input("dev", Tag::Local)).unwrap();

    quarry_lib::secrets::save_password(&c.id, "hunter2").unwrap();
    assert_eq!(
        quarry_lib::secrets::load_password(&c.id).unwrap().as_deref(),
        Some("hunter2"),
    );

    store.delete_connection(&c.id).unwrap();

    assert_eq!(
        quarry_lib::secrets::load_password(&c.id).unwrap(),
        None,
        "a deleted connection must not leave a credential behind",
    );
}
```

- [ ] **Step 2: Run it**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test connections_test deleting_a_connection 2>&1 | tail -10
```

Expected: PASS, because Task 3 implemented it. If it fails, the Keychain call in
`delete_connection` is wrong — fix `delete_connection`, not the test.

This test writes to the real login Keychain under service `com.quarry.app` with
a UUID account, and cleans up after itself. If macOS blocks Keychain access
non-interactively, report `DONE_WITH_CONCERNS` with the exact error rather than
marking the test `#[ignore]` silently.

- [ ] **Step 3: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/tests/connections_test.rs
git commit -m "test(library): prove deleting a connection clears its credential"
```

---

## Task 5: Single active connection

The riskiest task: it rewrites Stage 1 state. `execute` loses its
`connection_id`, and `AppError::UnknownConnection` disappears.

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/error.rs`

- [ ] **Step 1: Replace AppState**

In `src-tauri/src/commands.rs`, replace the `AppState` struct, its `impl`, and
the `ConnectionInfo` struct with:

```rust
/// The one live database connection, if any.
///
/// Quarry connects to a single database at a time: switching closes the
/// previous pool. That is why this is an `Option<ActiveConnection>` and
/// not a map — a map would imply several live connections and invite
/// callers to pass the wrong id.
pub struct ActiveConnection {
    pub id: String,
    pub pool: Pool,
    pub info: ConnectionInfo,
}

pub struct AppState {
    active: Mutex<Option<ActiveConnection>>,
    pub library: Store,
}

impl AppState {
    /// Fails only if the library database cannot be opened, which is
    /// unrecoverable — the app has nowhere to store anything.
    pub fn new() -> Result<Self, AppError> {
        Ok(AppState {
            active: Mutex::new(None),
            library: Store::open()?,
        })
    }

    /// Clone the live pool, or report that nothing is connected.
    ///
    /// The guard is dropped before returning, so no lock is ever held
    /// across an `.await` in the async command handlers.
    fn pool(&self) -> Result<Pool, AppError> {
        let active = self.active.lock().expect("state lock poisoned");
        active
            .as_ref()
            .map(|a| a.pool.clone())
            .ok_or_else(|| AppError::Connection("not connected to a database".into()))
    }

    /// Install a new active connection, closing whatever it replaces.
    fn set_active(&self, next: Option<ActiveConnection>) {
        let previous = std::mem::replace(
            &mut *self.active.lock().expect("state lock poisoned"),
            next,
        );

        // `Pool` does not close its sockets when dropped, so an
        // un-closed pool leaves idle connections open on the server
        // until its last internal clone goes away.
        if let Some(old) = previous {
            old.pool.close();
        }
    }
}

/// What the UI gets back after a successful connect.
#[derive(Clone, Serialize)]
pub struct ConnectionInfo {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub dbname: String,
    pub user: String,
    pub server_version: String,
}
```

- [ ] **Step 2: Delete the old connect command and rewrite execute/disconnect**

Delete the entire `connect` command (the URL-based one). Replace `execute` and
`disconnect` with:

```rust
#[tauri::command]
pub async fn execute(
    state: tauri::State<'_, AppState>,
    sql: String,
) -> Result<QueryResult, AppError> {
    let pool = state.pool()?;
    run_query(&pool, &sql).await
}

#[tauri::command]
pub fn disconnect(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    state.set_active(None);
    Ok(())
}

#[tauri::command]
pub fn active_connection(
    state: tauri::State<'_, AppState>,
) -> Result<Option<ConnectionInfo>, AppError> {
    let active = state.active.lock().expect("state lock poisoned");
    Ok(active.as_ref().map(|a| a.info.clone()))
}
```

- [ ] **Step 3: Remove the dead error variant**

In `src-tauri/src/error.rs`, delete the `UnknownConnection` variant and its arm
in the `Serialize` impl. Nothing constructs it now.

- [ ] **Step 4: Verify the crate compiles**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo check 2>&1 | tail -20
```

Expected: errors only from `lib.rs` still registering the deleted `connect`
command. Fix by removing `commands::connect` from `generate_handler!` and adding
`commands::active_connection`. Then `cargo check` clean.

- [ ] **Step 5: Run the full Rust suite**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test 2>&1 | grep -E "^test result|^error"
```

Expected: every suite `ok`. The library and exec tests do not touch `AppState`,
so nothing should regress. If something fails, fix the code — do not adjust the
test.

- [ ] **Step 6: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/commands.rs src-tauri/src/error.rs src-tauri/src/lib.rs
git commit -m "refactor(ipc): hold one active connection instead of a pool map"
```

---

## Task 6: Connection commands

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the commands**

Append to `src-tauri/src/commands.rs`:

```rust
use crate::library::model::{Connection, ConnectionInput};

#[tauri::command]
pub fn list_connections(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Connection>, AppError> {
    state.library.connections()
}

#[tauri::command]
pub fn create_connection(
    state: tauri::State<'_, AppState>,
    input: ConnectionInput,
) -> Result<Vec<Connection>, AppError> {
    let password = input.password.clone();
    let created = state.library.create_connection(input)?;

    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        state.library.save_connection_password(&created.id, &pw)?;
    }

    state.library.connections()
}

#[tauri::command]
pub fn update_connection(
    state: tauri::State<'_, AppState>,
    id: String,
    input: ConnectionInput,
) -> Result<Vec<Connection>, AppError> {
    let password = input.password.clone();
    state.library.update_connection(&id, input)?;

    // An empty or absent password means "leave the stored one alone",
    // so editing a host does not silently wipe the credential.
    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        state.library.save_connection_password(&id, &pw)?;
    }

    state.library.connections()
}

#[tauri::command]
pub fn delete_connection(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<Connection>, AppError> {
    // Disconnect first if this is the live one, otherwise the pool
    // would outlive the record it came from.
    let is_active = state
        .active
        .lock()
        .expect("state lock poisoned")
        .as_ref()
        .is_some_and(|a| a.id == id);
    if is_active {
        state.set_active(None);
    }

    state.library.delete_connection(&id)?;
    state.library.connections()
}

/// Connect to a saved connection, replacing any current one.
///
/// `password` is only for the case where the Keychain has no entry —
/// normally it is omitted and the stored credential is used. A supplied
/// password is saved on success, so the prompt happens at most once.
#[tauri::command]
pub async fn connect_saved(
    state: tauri::State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> Result<ConnectionInfo, AppError> {
    let record = state.library.connection(&id)?;

    let stored = crate::secrets::load_password(&id)?;
    let password = password.filter(|p| !p.is_empty()).or(stored);

    let cfg = ConnectionConfig {
        host: record.host.clone(),
        port: record.port,
        user: record.user.clone(),
        dbname: record.dbname.clone(),
        password: password.clone(),
        sslmode: record.sslmode,
    };

    // Build and verify BEFORE touching the active slot: a failed
    // connect must leave the user disconnected, never half-switched.
    let pool = build_pool(&cfg)?;
    let server_version = ping(&pool).await?;

    let info = ConnectionInfo {
        id: id.clone(),
        host: record.host,
        port: record.port,
        dbname: record.dbname,
        user: record.user,
        server_version,
    };

    state.set_active(Some(ActiveConnection {
        id: id.clone(),
        pool,
        info: info.clone(),
    }));

    if let Some(pw) = password {
        state.library.save_connection_password(&id, &pw)?;
    }
    state.library.touch_connection(&id)?;

    Ok(info)
}
```

- [ ] **Step 2: Add the password helper to the store**

Append to `src-tauri/src/library/connections.rs`, inside the `impl Store` block:

```rust
    /// Store a connection's password in the Keychain.
    ///
    /// Lives on `Store` so every credential write goes through the same
    /// place as the record itself, rather than being scattered across
    /// command handlers.
    pub fn save_connection_password(
        &self,
        id: &str,
        password: &str,
    ) -> Result<(), AppError> {
        crate::secrets::save_password(id, password)
    }
```

- [ ] **Step 3: Register the commands**

In `src-tauri/src/lib.rs`, add to `generate_handler!`:

```rust
            commands::list_connections,
            commands::create_connection,
            commands::update_connection,
            commands::delete_connection,
            commands::connect_saved,
            commands::active_connection,
```

- [ ] **Step 4: Verify and run the suite**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test 2>&1 | grep -E "^test result|^error"
```

Expected: all suites `ok`, no regressions.

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src
git commit -m "feat(ipc): expose connection management and switching"
```

---

## Task 7: TypeScript types, IPC, and helpers (TDD)

**Files:**
- Modify: `src/types.ts`
- Modify: `src/lib/ipc.ts`
- Create: `src/lib/connections.ts`
- Create: `src/lib/connections.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/connections.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { colourForTag, parseConnectionUrl } from "./connections";

describe("parseConnectionUrl", () => {
  it("fills every field from a full URL", () => {
    expect(parseConnectionUrl("postgres://alice:pw@db.example.com:6432/kolecto")).toEqual({
      host: "db.example.com",
      port: 6432,
      user: "alice",
      dbname: "kolecto",
      sslmode: "prefer",
      password: "pw",
    });
  });

  it("applies postgres defaults for missing parts", () => {
    expect(parseConnectionUrl("postgres:///mydb")).toEqual({
      host: "localhost",
      port: 5432,
      user: "postgres",
      dbname: "mydb",
      sslmode: "prefer",
      password: null,
    });
  });

  it("reads sslmode from the query string", () => {
    const parsed = parseConnectionUrl("postgres://localhost/db?sslmode=require");
    expect(parsed?.sslmode).toBe("require");
  });

  it("returns null for something that is not a postgres URL", () => {
    expect(parseConnectionUrl("mysql://localhost/db")).toBeNull();
    expect(parseConnectionUrl("not a url")).toBeNull();
  });
});

describe("colourForTag", () => {
  it("gives each tag a distinct default", () => {
    const colours = new Set([
      colourForTag("local"),
      colourForTag("staging"),
      colourForTag("prod"),
    ]);
    expect(colours.size).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry && npm test 2>&1 | tail -10
```

Expected: cannot resolve `./connections`.

- [ ] **Step 3: Add the types**

Append to `src/types.ts`:

```typescript
export type Tag = "local" | "staging" | "prod";

export type SslMode = "disable" | "prefer" | "require";

/** Mirrors Rust `Connection`. The password is never sent to the UI. */
export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  dbname: string;
  sslmode: SslMode;
  tag: Tag;
  colour: string;
  last_used_at: string | null;
  created_at: string;
}

/** Mirrors Rust `ConnectionInput`. */
export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  user: string;
  dbname: string;
  sslmode: SslMode;
  tag: Tag;
  colour: string | null;
  /** Absent or empty means "leave the stored password alone". */
  password: string | null;
}
```

- [ ] **Step 4: Write the helpers**

Create `src/lib/connections.ts`:

```typescript
import type { SslMode, Tag } from "../types";

/** Default colours, matching `Tag::default_colour` in Rust. */
const TAG_COLOURS: Record<Tag, string> = {
  local: "#4ade80",
  staging: "#fbbf24",
  prod: "#f26d6d",
};

export function colourForTag(tag: Tag): string {
  return TAG_COLOURS[tag];
}

export interface ParsedUrl {
  host: string;
  port: number;
  user: string;
  dbname: string;
  sslmode: SslMode;
  password: string | null;
}

/**
 * Parse a `postgres://` URL into form fields.
 *
 * This mirrors `ConnectionConfig::from_url` in Rust so pasting a URL
 * fills the form. The Rust side remains the authority at connect time;
 * this is only for convenience while typing.
 */
export function parseConnectionUrl(raw: string): ParsedUrl | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;

  const dbname = url.pathname.replace(/^\//, "");
  if (dbname === "") return null;

  const sslmodeParam = url.searchParams.get("sslmode");
  const sslmode: SslMode =
    sslmodeParam === "disable"
      ? "disable"
      : sslmodeParam === "require" ||
          sslmodeParam === "verify-ca" ||
          sslmodeParam === "verify-full"
        ? "require"
        : "prefer";

  return {
    // An empty hostname means the URL had none, e.g. postgres:///mydb.
    host: url.hostname === "" ? "localhost" : decodeURIComponent(url.hostname),
    port: url.port === "" ? 5432 : Number(url.port),
    user: url.username === "" ? "postgres" : decodeURIComponent(url.username),
    dbname: decodeURIComponent(dbname),
    sslmode,
    password: url.password === "" ? null : decodeURIComponent(url.password),
  };
}
```

- [ ] **Step 5: Add the IPC wrappers**

In `src/lib/ipc.ts`, change `execute` (it no longer takes a connection id) and
delete the old `connect` wrapper:

```typescript
export async function execute(sql: string): Promise<QueryResult> {
  return invoke<QueryResult>("execute", { sql });
}
```

Then append:

```typescript
import type { Connection, ConnectionInput } from "../types";

export async function listConnections(): Promise<Connection[]> {
  return invoke<Connection[]>("list_connections");
}

export async function createConnection(
  input: ConnectionInput,
): Promise<Connection[]> {
  return invoke<Connection[]>("create_connection", { input });
}

export async function updateConnection(
  id: string,
  input: ConnectionInput,
): Promise<Connection[]> {
  return invoke<Connection[]>("update_connection", { id, input });
}

export async function deleteConnection(id: string): Promise<Connection[]> {
  return invoke<Connection[]>("delete_connection", { id });
}

export async function connectSaved(
  id: string,
  password?: string,
): Promise<ConnectionInfo> {
  return invoke<ConnectionInfo>("connect_saved", { id, password });
}

export async function activeConnection(): Promise<ConnectionInfo | null> {
  return invoke<ConnectionInfo | null>("active_connection");
}
```

Update the existing `disconnect` wrapper to take no argument:

```typescript
export async function disconnect(): Promise<void> {
  return invoke("disconnect");
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry && npm test 2>&1 | tail -8
```

Expected: `Test Files 4 passed`, `Tests 27 passed` (22 existing + 5 new).

`npx tsc --noEmit` will still fail here because `App.tsx` calls `execute` with
two arguments — Task 10 fixes that. Do not "fix" it by reverting the signature.

- [ ] **Step 7: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/types.ts src/lib/ipc.ts src/lib/connections.ts src/lib/connections.test.ts
git commit -m "feat(ui): add connection types, IPC wrappers, and URL parsing"
```

---

## Task 8: The connections hook

**Files:**
- Create: `src/hooks/useConnections.ts`

- [ ] **Step 1: Write the hook**

Create `src/hooks/useConnections.ts`:

```typescript
import { useCallback, useEffect, useState } from "react";
import * as ipc from "../lib/ipc";
import type { Connection, ConnectionInfo, ConnectionInput } from "../types";

/**
 * Owns the saved-connection list and which one is live.
 *
 * The app never connects on its own: `active` starts null on every
 * launch and only a deliberate `connect` call fills it.
 */
export function useConnections() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [active, setActive] = useState<ConnectionInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await ipc.listConnections();
      if (cancelled) return;
      setConnections(list);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async (id: string, password?: string) => {
    setConnecting(true);
    try {
      const info = await ipc.connectSaved(id, password);
      setActive(info);
      // Connecting changes last_used_at, which changes the order.
      setConnections(await ipc.listConnections());
      return info;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await ipc.disconnect();
    setActive(null);
  }, []);

  const actions = {
    connect,
    disconnect,
    create: async (input: ConnectionInput) =>
      setConnections(await ipc.createConnection(input)),
    update: async (id: string, input: ConnectionInput) =>
      setConnections(await ipc.updateConnection(id, input)),
    remove: async (id: string) => {
      setConnections(await ipc.deleteConnection(id));
      // Deleting the live connection disconnects it backend-side.
      setActive(await ipc.activeConnection());
    },
  };

  return { connections, active, connecting, loaded, actions };
}
```

- [ ] **Step 2: Verify it compiles in isolation**

```bash
cd /Users/lepetitdev/dev/quarry && npx tsc --noEmit 2>&1 | grep -v "App.tsx" | head -10
```

Expected: no errors outside `App.tsx` (which Task 10 fixes).

- [ ] **Step 3: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/hooks/useConnections.ts
git commit -m "feat(ui): add the connections hook"
```

---

## Task 9: Picker and editor components

**Files:**
- Create: `src/components/ConnectionPicker.tsx`
- Create: `src/components/ConnectionEditor.tsx`
- Delete: `src/components/ConnectionForm.tsx`

- [ ] **Step 1: Write the picker**

Create `src/components/ConnectionPicker.tsx`:

```tsx
import { useEffect, useRef } from "react";
import type { Connection } from "../types";

interface Props {
  connections: Connection[];
  activeId: string | null;
  connecting: boolean;
  onPick: (id: string) => void;
  onNew: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  /** Rendered as a centred launch panel rather than a dropdown. */
  standalone?: boolean;
}

export function ConnectionPicker({
  connections,
  activeId,
  connecting,
  onPick,
  onNew,
  onEdit,
  onDelete,
  standalone = false,
}: Props) {
  const firstRef = useRef<HTMLButtonElement>(null);

  // Focus the most recently used connection so Enter connects to it.
  // Fast for the common case, but still a deliberate keystroke — the
  // app never connects on its own.
  useEffect(() => {
    if (standalone) firstRef.current?.focus();
  }, [standalone]);

  return (
    <div className={`connection-picker${standalone ? " standalone" : ""}`}>
      {connections.length === 0 && (
        <p className="picker-empty">No saved connections yet.</p>
      )}

      <ul className="picker-list">
        {connections.map((c, i) => (
          <li key={c.id}>
            <button
              ref={i === 0 ? firstRef : undefined}
              className={`picker-row${c.id === activeId ? " active" : ""}`}
              disabled={connecting}
              onClick={() => onPick(c.id)}
            >
              <span className="dot" style={{ background: c.colour }} />
              <span className="picker-name">{c.name}</span>
              <span className="picker-tag">{c.tag}</span>
              <span className="picker-target">
                {c.user}@{c.host}:{c.port}/{c.dbname}
              </span>
            </button>
            <button
              className="row-action"
              title="Edit connection"
              onClick={() => onEdit(c.id)}
            >
              ✎
            </button>
            <button
              className="row-action"
              title="Delete connection"
              onClick={() => onDelete(c.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <button className="picker-new" onClick={onNew}>
        + New connection…
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Write the editor**

Create `src/components/ConnectionEditor.tsx`:

```tsx
import { useState } from "react";
import { colourForTag, parseConnectionUrl } from "../lib/connections";
import type { Connection, ConnectionInput, SslMode, Tag } from "../types";

interface Props {
  /** Absent when creating. */
  existing?: Connection;
  onSave: (input: ConnectionInput) => void;
  onCancel: () => void;
}

const TAGS: Tag[] = ["local", "staging", "prod"];
const SSL_MODES: SslMode[] = ["disable", "prefer", "require"];

export function ConnectionEditor({ existing, onSave, onCancel }: Props) {
  const [name, setName] = useState(existing?.name ?? "");
  const [host, setHost] = useState(existing?.host ?? "localhost");
  const [port, setPort] = useState(String(existing?.port ?? 5432));
  const [user, setUser] = useState(existing?.user ?? "postgres");
  const [dbname, setDbname] = useState(existing?.dbname ?? "postgres");
  const [sslmode, setSslmode] = useState<SslMode>(existing?.sslmode ?? "prefer");
  const [tag, setTag] = useState<Tag>(existing?.tag ?? "local");
  const [password, setPassword] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  function applyUrl(raw: string) {
    if (raw.trim() === "") return;
    const parsed = parseConnectionUrl(raw);
    if (!parsed) {
      setUrlError("Not a postgres:// URL");
      return;
    }
    setUrlError(null);
    setHost(parsed.host);
    setPort(String(parsed.port));
    setUser(parsed.user);
    setDbname(parsed.dbname);
    setSslmode(parsed.sslmode);
    if (parsed.password) setPassword(parsed.password);
    if (name.trim() === "") setName(parsed.dbname);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 5432,
      user: user.trim(),
      dbname: dbname.trim(),
      sslmode,
      tag,
      colour: colourForTag(tag),
      // Empty means "leave the stored password alone" when editing.
      password: password === "" ? null : password,
    });
  }

  return (
    <form className="connection-editor" onSubmit={submit}>
      <h2>{existing ? "Edit connection" : "New connection"}</h2>

      <label htmlFor="url">Paste a connection URL</label>
      <input
        id="url"
        type="text"
        placeholder="postgres://user:password@localhost:5432/dbname"
        spellCheck={false}
        onChange={(e) => applyUrl(e.target.value)}
      />
      {urlError && <p className="error">{urlError}</p>}

      <label htmlFor="name">Name</label>
      <input id="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />

      <div className="field-row">
        <div>
          <label htmlFor="host">Host</label>
          <input id="host" value={host} onChange={(e) => setHost(e.target.value)} />
        </div>
        <div>
          <label htmlFor="port">Port</label>
          <input id="port" value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
      </div>

      <div className="field-row">
        <div>
          <label htmlFor="user">User</label>
          <input id="user" value={user} onChange={(e) => setUser(e.target.value)} />
        </div>
        <div>
          <label htmlFor="dbname">Database</label>
          <input id="dbname" value={dbname} onChange={(e) => setDbname(e.target.value)} />
        </div>
      </div>

      <label htmlFor="password">
        Password {existing && <span className="hint">(blank keeps the saved one)</span>}
      </label>
      <input
        id="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      <div className="field-row">
        <div>
          <label htmlFor="tag">Environment</label>
          <select id="tag" value={tag} onChange={(e) => setTag(e.target.value as Tag)}>
            {TAGS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="sslmode">SSL mode</label>
          <select
            id="sslmode"
            value={sslmode}
            onChange={(e) => setSslmode(e.target.value as SslMode)}
          >
            {SSL_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="editor-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={name.trim() === ""}>
          Save
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: Write the password retry**

When a connect fails with `28P01` — a wrong password, or no Keychain entry at
all — the user should be able to supply one on the spot instead of going off to
edit the connection.

Create `src/components/PasswordRetry.tsx`:

```tsx
import { useState } from "react";

interface Props {
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export function PasswordRetry({ onSubmit, onCancel }: Props) {
  const [password, setPassword] = useState("");

  return (
    <form
      className="password-retry"
      onSubmit={(e) => {
        e.preventDefault();
        if (password !== "") onSubmit(password);
      }}
    >
      <label htmlFor="retry-password">Password</label>
      <input
        id="retry-password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      {/* Saved to the Keychain on success, so this asks at most once. */}
      <div className="editor-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={password === ""}>
          Connect
        </button>
      </div>
    </form>
  );
}
```

Add its styles to `src/App.css`:

```css
.password-retry {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 460px;
  margin-top: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}

.password-retry input {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
}
```

- [ ] **Step 4: Delete the old form**

```bash
cd /Users/lepetitdev/dev/quarry && rm src/components/ConnectionForm.tsx
```

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add -u src/components
git add src/components/ConnectionPicker.tsx src/components/ConnectionEditor.tsx
git add src/components/PasswordRetry.tsx src/App.css
git commit -m "feat(ui): add the connection picker, editor, and password retry"
```

---

## Task 10: Compose it

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [ ] **Step 1: Rewrite the connection parts of App.tsx**

In `src/App.tsx`:

1. Replace the `ConnectionForm` import with:

```tsx
import { ConnectionEditor } from "./components/ConnectionEditor";
import { ConnectionPicker } from "./components/ConnectionPicker";
import { PasswordRetry } from "./components/PasswordRetry";
import { useConnections } from "./hooks/useConnections";
import type { Connection, ConnectionInput } from "./types";
```

`AppErrorPayload` is already imported in `App.tsx` from Stage 1 — keep it, the
connect-error state uses it.

2. Replace the `connection` state with the hook, and add editor/picker state:

```tsx
  const {
    connections,
    active: connection,
    connecting,
    loaded: connectionsLoaded,
    actions: connActions,
  } = useConnections();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [connectError, setConnectError] = useState<AppErrorPayload | null>(null);
  // Set when a connect failed for a credential reason, so the user can
  // supply a password inline instead of having to edit the connection.
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
```

3. `execute` now takes only the SQL. Change the `run` callback's call to:

```tsx
      setResult(await execute(text));
```

4. Add switching, which clears results so rows from the previous database can
   never sit under a new connection's name:

```tsx
  const switchTo = useCallback(
    async (id: string, password?: string) => {
      setConnectError(null);
      try {
        await connActions.connect(id, password);
        setResult(null);
        setError(null);
        setPickerOpen(false);
        setPasswordFor(null);
      } catch (e) {
        // Stay disconnected and say why: believing you switched when
        // you did not is the dangerous state.
        const err = asAppError(e);
        setConnectError(err);
        // 28P01 is invalid_password. A missing Keychain entry produces
        // the same failure, so offer the password inline rather than
        // making the user go and edit the connection.
        setPasswordFor(err.code === "28P01" ? id : null);
      }
    },
    [connActions],
  );

  const saveConnection = useCallback(
    async (input: ConnectionInput) => {
      if (editing && editing !== "new") await connActions.update(editing.id, input);
      else await connActions.create(input);
      setEditing(null);
    },
    [editing, connActions],
  );
```

5. Replace the disconnected early-return with the launch picker:

```tsx
  if (!connection) {
    return (
      <main className="app centered">
        <h1>Quarry</h1>
        {editing || (connectionsLoaded && connections.length === 0) ? (
          <ConnectionEditor
            existing={editing && editing !== "new" ? editing : undefined}
            onSave={(input) => void saveConnection(input)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <>
            <ConnectionPicker
              standalone
              connections={connections}
              activeId={null}
              connecting={connecting}
              onPick={(id) => void switchTo(id)}
              onNew={() => setEditing("new")}
              onEdit={(id) =>
                setEditing(connections.find((c) => c.id === id) ?? "new")
              }
              onDelete={(id) =>
                setConfirmRequest({
                  message: "Delete this connection and its saved password?",
                  confirmLabel: "Delete",
                  onConfirm: () => {
                    void connActions.remove(id);
                    setConfirmRequest(null);
                  },
                })
              }
            />
            {connectError && (
              <p className="error">
                {connectError.code && (
                  <span className="sqlstate">{connectError.code}</span>
                )}
                {connectError.message}
              </p>
            )}
            {passwordFor && (
              <PasswordRetry
                onSubmit={(pw) => void switchTo(passwordFor, pw)}
                onCancel={() => setPasswordFor(null)}
              />
            )}
          </>
        )}
        {confirmRequest && (
          <ConfirmDialog
            message={confirmRequest.message}
            confirmLabel={confirmRequest.confirmLabel}
            onConfirm={confirmRequest.onConfirm}
            onCancel={() => setConfirmRequest(null)}
          />
        )}
      </main>
    );
  }
```

6. In the connected view's header, replace the static connection label with the
   dropdown trigger, tinted by tag colour:

```tsx
        <div className="connection-menu">
          <button
            className="connection-trigger"
            onClick={() => setPickerOpen((open) => !open)}
          >
            <span
              className="dot"
              style={{
                background:
                  connections.find((c) => c.id === connection.id)?.colour ?? "#888",
              }}
            />
            {connections.find((c) => c.id === connection.id)?.name ?? connection.dbname}
            <span className="caret">▾</span>
          </button>
          <span className="connection-target">
            {connection.user}@{connection.host}:{connection.port}/{connection.dbname}
          </span>

          {pickerOpen && (
            <ConnectionPicker
              connections={connections}
              activeId={connection.id}
              connecting={connecting}
              onPick={(id) => void switchTo(id)}
              onNew={() => {
                setPickerOpen(false);
                setEditing("new");
              }}
              onEdit={(id) => {
                setPickerOpen(false);
                setEditing(connections.find((c) => c.id === id) ?? "new");
              }}
              onDelete={(id) =>
                setConfirmRequest({
                  message: "Delete this connection and its saved password?",
                  confirmLabel: "Delete",
                  onConfirm: () => {
                    void connActions.remove(id);
                    setConfirmRequest(null);
                  },
                })
              }
            />
          )}
        </div>
```

7. Give the header its tag stripe by adding this just inside the `<header>`:

```tsx
          <span
            className="tag-stripe"
            style={{
              background:
                connections.find((c) => c.id === connection.id)?.colour ?? "transparent",
            }}
          />
```

8. Render the editor over the connected view when `editing` is set, by adding
   this next to the existing `confirmRequest` render:

```tsx
      {editing && (
        <div className="modal-backdrop">
          <ConnectionEditor
            existing={editing !== "new" ? editing : undefined}
            onSave={(input) => void saveConnection(input)}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}
```

- [ ] **Step 2: Add the styles**

Append to `src/App.css`:

```css
.connection-menu {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
}

.connection-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: var(--text);
  font-weight: 600;
  padding: 4px 8px;
}

.connection-trigger:hover {
  background: var(--border);
}

.connection-target {
  color: var(--muted);
  font-family: ui-monospace, "SF Mono", monospace;
}

.tag-stripe {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.connection-picker {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 20;
  min-width: 340px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 8px 24px rgb(0 0 0 / 40%);
}

.connection-picker.standalone {
  position: static;
  width: 460px;
  box-shadow: none;
}

.picker-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.picker-list li {
  display: flex;
  align-items: center;
}

.picker-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  padding: 6px 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
  border-radius: 6px;
}

.picker-row:hover,
.picker-row:focus-visible {
  background: var(--border);
}

.picker-row.active {
  outline: 1px solid var(--accent);
}

.picker-name {
  font-weight: 500;
}

.picker-tag {
  color: var(--muted);
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.06em;
}

.picker-target {
  margin-left: auto;
  color: var(--muted);
  font-family: ui-monospace, monospace;
  font-size: 11px;
}

.picker-empty {
  margin: 8px;
  color: var(--muted);
}

.picker-new {
  width: 100%;
  margin-top: 6px;
  background: transparent;
  color: var(--accent);
  text-align: left;
}

.connection-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 460px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}

.connection-editor h2 {
  margin: 0 0 8px;
  font-size: 15px;
}

.connection-editor input,
.connection-editor select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
}

.field-row {
  display: flex;
  gap: 10px;
}

.field-row > div {
  flex: 1;
}

.hint {
  color: var(--muted);
  font-weight: 400;
}

.editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

button.secondary {
  background: transparent;
  color: var(--text);
  border: 1px solid var(--border);
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 50%);
}
```

- [ ] **Step 3: Verify everything compiles and passes**

```bash
cd /Users/lepetitdev/dev/quarry
npx tsc --noEmit
npm test 2>&1 | tail -6
npm run build 2>&1 | tail -5
```

Expected: `tsc` silent, 27 tests passing, build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/App.tsx src/App.css
git commit -m "feat(ui): pick a connection on launch and switch from the header"
```

---

## Task 11: End-to-end smoke test

**Files:** none

- [ ] **Step 1: Start two databases**

Two so switching is observable.

```bash
docker rm -f quarry-dev quarry-prod >/dev/null 2>&1
docker run --rm -d --name quarry-dev -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17
docker run --rm -d --name quarry-prod -e POSTGRES_PASSWORD=postgres -p 55433:5432 postgres:17
sleep 6
docker exec quarry-dev psql -U postgres -c "create table widgets (id serial primary key, name text);"
docker exec quarry-dev psql -U postgres -c "insert into widgets (name) values ('from-dev');"
docker exec quarry-prod psql -U postgres -c "create table widgets (id serial primary key, name text);"
docker exec quarry-prod psql -U postgres -c "insert into widgets (name) values ('from-prod');"
```

- [ ] **Step 2: Run the app**

```bash
cd /Users/lepetitdev/dev/quarry && npm run tauri dev
```

- [ ] **Step 3: Verify each behavior**

- [ ] Launch shows the connection editor (no connections saved yet)
- [ ] Paste `postgres://postgres:postgres@localhost:55432/postgres?sslmode=disable`, name it `dev`, tag `local`, save
- [ ] Add a second: port `55433`, name `prod`, tag `prod`
- [ ] Quit and relaunch — the **picker** appears listing both, and the app does **not** connect on its own
- [ ] Connect to `dev`; the header shows a green dot and a green stripe
- [ ] `select * from widgets` returns `from-dev`
- [ ] Switch to `prod` from the header dropdown; results clear immediately
- [ ] `select * from widgets` returns `from-prod` — proving the switch was real
- [ ] The header stripe is now red
- [ ] Quit, relaunch: `prod` is at the top of the picker (most recently used)
- [ ] Open tabs and their text survived the restart
- [ ] Edit `dev`, leave the password blank, save, connect — still works (the stored password survived)
- [ ] Delete `dev`'s Keychain entry by hand (`security delete-generic-password -s com.quarry.app -a <its id>`), then connect: the inline password field appears, and entering `postgres` connects and saves it so the next connect does not ask
- [ ] Delete `prod`, confirm, and verify it is gone from the list
- [ ] Verify its credential is gone: `security find-generic-password -s com.quarry.app` shows no entry for that id

- [ ] **Step 4: Tear down**

```bash
docker stop quarry-dev quarry-prod
```

- [ ] **Step 5: Run everything one final time**

```bash
cd /Users/lepetitdev/dev/quarry && npm test && npx tsc --noEmit && cd src-tauri && cargo test 2>&1 | grep -E "^test result"
```

- [ ] **Step 6: Tag**

```bash
cd /Users/lepetitdev/dev/quarry
git tag stage-3-saved-connections
```

---

## Definition of done

- Connections are saved, edited, and deleted; passwords live in the Keychain
- Launch shows a picker; the app never connects on its own
- Switching from the header disconnects the old database and clears results
- A failed switch leaves you disconnected with the SQLSTATE visible
- Deleting a connection removes its Keychain entry
- A connect rejected for a bad or missing password offers an inline retry, and
  the supplied password is saved so it asks at most once
- `AppState` holds one active connection; `UnknownConnection` is gone
- All tests pass: 95 Rust (80 existing + 2 schema + 2 sslmode + 11 connections),
  27 TS (22 existing + 5 connection helpers)

## Deliberately not in this stage

Environments and `{{variables}}`; the write-guard (the `tag` field is
groundwork only — nothing enforces it yet); more than one live connection;
connection folders; importing from DBeaver or `.pgpass`. Deferred UI work stays
in `docs/BACKLOG.md`.
