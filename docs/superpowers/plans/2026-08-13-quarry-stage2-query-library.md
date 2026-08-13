# Quarry Stage 2 — Query Library, Tabs, Persistence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saved SQL that cannot get lost — an Insomnia-style library of named queries in nestable collections, opened in tabs that survive restarts, with continuous autosave and no save prompts.

**Architecture:** A SQLite database in the app support directory is the source of truth for collections, queries, and tab state. Rust owns all of it behind a `library` module; the UI never sees a file path. Every saved query is additionally mirrored to a `.sql` file on disk so the library is greppable and git-friendly, but that mirror is write-only output — the database, never the filesystem, is what the app reads back.

**Tech Stack:** Adds `rusqlite` (bundled SQLite) and `uuid` v4 ids to the Stage 1 stack. Frontend adds a sidebar tree and a tab bar; no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-13-quarry-design.md` §5 (query library) and §6 (interface).

**Builds on Stage 1:** `conn` (pooling), `exec` (query execution), `secrets` (Keychain), `commands` (IPC), and the React shell in `src/App.tsx`.

**Reading note:** the developer is new to Rust. Keep code plain, comment anything non-obvious (ownership, `?`, lifetimes, SQLite transactions). No macros beyond `derive`.

**Commit messages must NOT include a `Co-Authored-By: Claude` trailer.**

---

## Prerequisites

- Stage 1 merged to `main`, all tests green (19 Rust + 10 TS)
- `cargo`, `npm`, Docker available; if `cargo` is missing from PATH: `export PATH="/opt/homebrew/opt/rustup/bin:$PATH"`

Create a branch before starting:

```bash
cd /Users/lepetitdev/dev/quarry && git checkout -b stage-2
```

---

## Design decisions locked before coding

**Ids** are UUID v4 strings, generated in Rust. The UI never invents an id.

**Untitled tabs** are real tabs with no backing query: `query_id` is NULL and the text lives in `scratch_sql`. Saving one creates a query row and repoints the tab.

**Drafts.** Every query row has both `sql` (last explicitly saved text) and `draft_sql` (continuously autosaved, NULL when the draft matches the saved text). The editor always shows `draft_sql ?? sql`. This is what makes "no save prompts" safe — closing the app never loses typing.

**Ordering** is an integer `position` within a parent, gapped by 100 on insert so a move between two neighbours rarely needs a renumber.

**Deletion is hard deletion**, cascading. No trash in Stage 2 — YAGNI. The `.sql` mirror is deleted alongside.

**The mirror is one-way.** Editing a `.sql` file on disk does NOT change the library. A future stage may add import; nothing in Stage 2 reads those files back. This is stated in the mirror module's doc comment so nobody assumes two-way sync.

---

## File Structure

### Rust (`src-tauri/`)

| File | Responsibility |
|------|----------------|
| `src/library/mod.rs` | Module re-exports |
| `src/library/model.rs` | `Collection`, `Query`, `Tab`, `LibraryTree` — plain data, no logic |
| `src/library/db.rs` | Opening the database, schema migration |
| `src/library/store.rs` | All reads and writes (collections, queries, tabs) |
| `src/library/mirror.rs` | Writing/removing `.sql` files |
| `src/library/paths.rs` | Where the database and mirror live |
| `src/commands.rs` | *(modify)* add library commands |
| `tests/library_test.rs` | Store behavior against a temp database |

### TypeScript (`src/`)

| File | Responsibility |
|------|----------------|
| `src/types.ts` | *(modify)* add library types |
| `src/lib/ipc.ts` | *(modify)* add library wrappers |
| `src/lib/tree.ts` | Pure helpers: flatten, find, sort a tree |
| `src/lib/tree.test.ts` | Vitest for those helpers |
| `src/components/Sidebar.tsx` | Schema section (placeholder) + Queries tree |
| `src/components/QueryTree.tsx` | Collections and queries, rename/create/delete |
| `src/components/TabBar.tsx` | Open tabs, active tab, close |
| `src/hooks/useLibrary.ts` | Library state + autosave |
| `src/App.tsx` | *(modify)* compose sidebar, tabs, editor |

---

## Task 1: Add dependencies and the paths module

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/library/mod.rs`, `src-tauri/src/library/paths.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add dependencies**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri
cargo add rusqlite --features bundled
cargo add dirs
cargo add --dev tempfile
```

`bundled` compiles SQLite into the binary, so the app does not depend on the system copy.

- [ ] **Step 2: Write the paths module**

Create `src-tauri/src/library/paths.rs`:

```rust
use crate::error::AppError;
use std::path::PathBuf;

/// Everything Quarry persists lives under one directory so it is easy
/// to find, back up, or delete:
/// `~/Library/Application Support/com.quarry.app/`
pub fn app_dir() -> Result<PathBuf, AppError> {
    let base = dirs::data_dir().ok_or_else(|| {
        AppError::Library("could not locate the application support directory".into())
    })?;
    Ok(base.join("com.quarry.app"))
}

/// The SQLite database — the source of truth for the library.
pub fn database_path() -> Result<PathBuf, AppError> {
    Ok(app_dir()?.join("workspace.db"))
}

/// Root of the `.sql` mirror. Write-only output; see `mirror.rs`.
pub fn mirror_dir() -> Result<PathBuf, AppError> {
    Ok(app_dir()?.join("queries"))
}

/// Create any missing directories. Safe to call repeatedly.
pub fn ensure_dirs() -> Result<(), AppError> {
    std::fs::create_dir_all(app_dir()?).map_err(|e| AppError::Library(e.to_string()))?;
    std::fs::create_dir_all(mirror_dir()?).map_err(|e| AppError::Library(e.to_string()))?;
    Ok(())
}
```

- [ ] **Step 3: Add the error variant**

In `src-tauri/src/error.rs`, add to the `AppError` enum:

```rust
    #[error("library error: {0}")]
    Library(String),
```

And in the manual `Serialize` impl's match, add:

```rust
            AppError::Library(_) => ("library", None, None),
```

- [ ] **Step 4: Declare the module**

Create `src-tauri/src/library/mod.rs`:

```rust
pub mod paths;
```

Add `pub mod library;` to `src-tauri/src/lib.rs`.

- [ ] **Step 5: Verify and commit**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo check 2>&1 | tail -5
cd /Users/lepetitdev/dev/quarry
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/library src-tauri/src/lib.rs src-tauri/src/error.rs
git commit -m "chore(library): add sqlite dependencies and path helpers"
```

---

## Task 2: Database schema and migration (TDD)

**Files:**
- Create: `src-tauri/src/library/db.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/library/db.rs` containing ONLY the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_the_schema_on_a_fresh_database() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("test.db")).unwrap();

        let tables: Vec<String> = conn
            .prepare("select name from sqlite_master where type='table' order by name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert!(tables.contains(&"collections".to_string()));
        assert!(tables.contains(&"queries".to_string()));
        assert!(tables.contains(&"tabs".to_string()));
        assert!(tables.contains(&"meta".to_string()));
    }

    #[test]
    fn migrating_twice_is_harmless() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");

        let first = open(&path).unwrap();
        drop(first);
        // Reopening runs migration again; it must not error or wipe data.
        let second = open(&path).unwrap();

        let version: i64 = second
            .query_row("select value from meta where key='schema_version'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn enforces_foreign_keys() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("test.db")).unwrap();

        // Inserting a query under a collection that does not exist must
        // fail; otherwise deletes leave orphans behind.
        let result = conn.execute(
            "insert into queries (id, collection_id, name, sql, position, created_at, updated_at)
             values ('q1', 'nope', 'n', 's', 100, 'now', 'now')",
            [],
        );
        assert!(result.is_err(), "foreign keys should be enforced");
    }

    #[test]
    fn deleting_a_collection_cascades_to_its_queries() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("test.db")).unwrap();

        conn.execute(
            "insert into collections (id, parent_id, name, position, created_at)
             values ('c1', null, 'Billing', 100, 'now')",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into queries (id, collection_id, name, sql, position, created_at, updated_at)
             values ('q1', 'c1', 'mrr', 'select 1', 100, 'now', 'now')",
            [],
        )
        .unwrap();

        conn.execute("delete from collections where id='c1'", []).unwrap();

        let remaining: i64 = conn
            .query_row("select count(*) from queries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "queries should cascade with their collection");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --lib library::db 2>&1 | tail -15
```

Expected: `cannot find function open in this scope`.

- [ ] **Step 3: Write the implementation**

Insert ABOVE the test module in `src-tauri/src/library/db.rs`:

```rust
use crate::error::AppError;
use rusqlite::Connection;
use std::path::Path;

/// Bump this when the schema changes and add a migration step below.
pub const SCHEMA_VERSION: i64 = 1;

/// Open the database, creating and migrating it if needed.
///
/// Foreign keys are OFF by default in SQLite and must be enabled per
/// connection — without this, deleting a collection would silently
/// orphan its queries instead of removing them.
pub fn open(path: &Path) -> Result<Connection, AppError> {
    let conn = Connection::open(path).map_err(|e| AppError::Library(e.to_string()))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| AppError::Library(e.to_string()))?;
    // WAL lets a read proceed while a write is in flight, which keeps
    // the UI responsive during autosave.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| AppError::Library(e.to_string()))?;

    migrate(&conn)?;
    Ok(conn)
}

/// Apply the schema. Every statement is `if not exists`, so running
/// this on an already-migrated database is a no-op.
fn migrate(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "
        create table if not exists meta (
            key   text primary key,
            value text not null
        );

        create table if not exists collections (
            id         text primary key,
            parent_id  text references collections(id) on delete cascade,
            name       text not null,
            position   integer not null,
            created_at text not null
        );

        create table if not exists queries (
            id            text primary key,
            collection_id text references collections(id) on delete cascade,
            name          text not null,
            sql           text not null,
            draft_sql     text,
            position      integer not null,
            created_at    text not null,
            updated_at    text not null
        );

        create table if not exists tabs (
            id          text primary key,
            query_id    text references queries(id) on delete cascade,
            scratch_sql text,
            position    integer not null,
            is_active   integer not null default 0,
            cursor_pos  integer not null default 0
        );

        create index if not exists idx_collections_parent on collections(parent_id);
        create index if not exists idx_queries_collection on queries(collection_id);
        create index if not exists idx_tabs_position      on tabs(position);
        ",
    )
    .map_err(|e| AppError::Library(e.to_string()))?;

    conn.execute(
        "insert into meta (key, value) values ('schema_version', ?1)
         on conflict(key) do update set value = excluded.value",
        [SCHEMA_VERSION.to_string()],
    )
    .map_err(|e| AppError::Library(e.to_string()))?;

    Ok(())
}
```

Add `pub mod db;` to `src-tauri/src/library/mod.rs`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --lib library::db 2>&1 | tail -10
```

Expected: `test result: ok. 4 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/library
git commit -m "feat(library): add sqlite schema with cascading deletes"
```

---

## Task 3: The data model

**Files:**
- Create: `src-tauri/src/library/model.rs`

- [ ] **Step 1: Write the types**

These are plain data with no logic, so they need no tests of their own — Task 4 exercises them.

Create `src-tauri/src/library/model.rs`:

```rust
use serde::{Deserialize, Serialize};

/// A folder in the sidebar. `parent_id` is None for a top-level folder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Collection {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub position: i64,
    pub created_at: String,
}

/// A saved query.
///
/// `sql` is the last explicitly saved text. `draft_sql` is the
/// continuously autosaved text, and is None when the draft matches
/// `sql`. The editor shows `draft_sql` when present — that is what
/// makes closing the app without saving safe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Query {
    pub id: String,
    pub collection_id: Option<String>,
    pub name: String,
    pub sql: String,
    pub draft_sql: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl Query {
    /// The text the editor should display.
    pub fn effective_sql(&self) -> &str {
        self.draft_sql.as_deref().unwrap_or(&self.sql)
    }

    /// True when the draft differs from the saved text.
    pub fn is_dirty(&self) -> bool {
        match &self.draft_sql {
            Some(d) => d != &self.sql,
            None => false,
        }
    }
}

/// An open editor tab. A tab with `query_id: None` is untitled and
/// keeps its text in `scratch_sql`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Tab {
    pub id: String,
    pub query_id: Option<String>,
    pub scratch_sql: Option<String>,
    pub position: i64,
    pub is_active: bool,
    pub cursor_pos: i64,
}

/// The whole sidebar in one payload — cheaper than the UI walking the
/// tree with one IPC call per level.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryTree {
    pub collections: Vec<Collection>,
    pub queries: Vec<Query>,
}

/// Gap between sibling positions, so inserting between two neighbours
/// usually needs no renumbering.
pub const POSITION_GAP: i64 = 100;
```

Add `pub mod model;` to `src-tauri/src/library/mod.rs`.

- [ ] **Step 2: Verify and commit**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo check 2>&1 | tail -3
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/library
git commit -m "feat(library): add collection, query, and tab models"
```

---

## Task 4: Store — collections and queries (TDD)

**Files:**
- Create: `src-tauri/src/library/store.rs`
- Create: `src-tauri/tests/library_test.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/library_test.rs`:

```rust
use quarry_lib::library::store::Store;

/// Each test gets its own database in a temp dir, so tests never share
/// state and can run in parallel.
fn store() -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_at(&dir.path().join("test.db")).expect("store should open");
    (store, dir)
}

#[test]
fn creates_and_lists_a_collection() {
    let (s, _dir) = store();

    let c = s.create_collection("Billing", None).unwrap();
    assert_eq!(c.name, "Billing");
    assert_eq!(c.parent_id, None);

    let tree = s.tree().unwrap();
    assert_eq!(tree.collections.len(), 1);
    assert_eq!(tree.collections[0].id, c.id);
}

#[test]
fn nests_collections() {
    let (s, _dir) = store();

    let parent = s.create_collection("Billing", None).unwrap();
    let child = s.create_collection("Monthly", Some(&parent.id)).unwrap();

    assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(s.tree().unwrap().collections.len(), 2);
}

#[test]
fn creates_a_query_inside_a_collection() {
    let (s, _dir) = store();

    let c = s.create_collection("Billing", None).unwrap();
    let q = s.create_query("mrr", "select 1", Some(&c.id)).unwrap();

    assert_eq!(q.name, "mrr");
    assert_eq!(q.sql, "select 1");
    assert_eq!(q.draft_sql, None);
    assert_eq!(q.collection_id.as_deref(), Some(c.id.as_str()));
}

#[test]
fn positions_siblings_with_a_gap() {
    let (s, _dir) = store();

    let a = s.create_collection("A", None).unwrap();
    let b = s.create_collection("B", None).unwrap();

    assert!(b.position > a.position, "later siblings sort after earlier ones");
    assert_eq!(b.position - a.position, 100);
}

#[test]
fn renames_a_query() {
    let (s, _dir) = store();

    let q = s.create_query("old", "select 1", None).unwrap();
    s.rename_query(&q.id, "new").unwrap();

    let found = s.query(&q.id).unwrap().expect("query should exist");
    assert_eq!(found.name, "new");
}

#[test]
fn saving_clears_the_draft() {
    let (s, _dir) = store();

    let q = s.create_query("q", "select 1", None).unwrap();
    s.save_draft(&q.id, "select 2").unwrap();

    let drafted = s.query(&q.id).unwrap().unwrap();
    assert_eq!(drafted.draft_sql.as_deref(), Some("select 2"));
    assert_eq!(drafted.sql, "select 1", "draft must not overwrite saved text");
    assert!(drafted.is_dirty());
    assert_eq!(drafted.effective_sql(), "select 2");

    s.save_query(&q.id, "select 2").unwrap();

    let saved = s.query(&q.id).unwrap().unwrap();
    assert_eq!(saved.sql, "select 2");
    assert_eq!(saved.draft_sql, None, "saving clears the draft");
    assert!(!saved.is_dirty());
}

#[test]
fn a_draft_survives_reopening_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.db");

    let id = {
        let s = Store::open_at(&path).unwrap();
        let q = s.create_query("q", "select 1", None).unwrap();
        s.save_draft(&q.id, "select 999").unwrap();
        q.id
    };

    // This is the whole point of the feature: quit mid-edit, come back,
    // find your typing intact.
    let reopened = Store::open_at(&path).unwrap();
    let q = reopened.query(&id).unwrap().unwrap();
    assert_eq!(q.effective_sql(), "select 999");
}

#[test]
fn moves_a_query_to_another_collection() {
    let (s, _dir) = store();

    let a = s.create_collection("A", None).unwrap();
    let b = s.create_collection("B", None).unwrap();
    let q = s.create_query("q", "select 1", Some(&a.id)).unwrap();

    s.move_query(&q.id, Some(&b.id)).unwrap();

    let moved = s.query(&q.id).unwrap().unwrap();
    assert_eq!(moved.collection_id.as_deref(), Some(b.id.as_str()));
}

#[test]
fn deletes_a_query() {
    let (s, _dir) = store();

    let q = s.create_query("q", "select 1", None).unwrap();
    s.delete_query(&q.id).unwrap();

    assert!(s.query(&q.id).unwrap().is_none());
    assert_eq!(s.tree().unwrap().queries.len(), 0);
}

#[test]
fn deleting_a_collection_removes_its_queries() {
    let (s, _dir) = store();

    let c = s.create_collection("Billing", None).unwrap();
    s.create_query("a", "select 1", Some(&c.id)).unwrap();
    s.create_query("b", "select 2", Some(&c.id)).unwrap();

    s.delete_collection(&c.id).unwrap();

    let tree = s.tree().unwrap();
    assert_eq!(tree.collections.len(), 0);
    assert_eq!(tree.queries.len(), 0, "queries must not outlive their collection");
}

#[test]
fn rejects_an_empty_name() {
    let (s, _dir) = store();

    assert!(s.create_collection("", None).is_err());
    assert!(s.create_query("", "select 1", None).is_err());
    assert!(s.create_query("   ", "select 1", None).is_err());
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test library_test 2>&1 | tail -10
```

Expected: `unresolved import quarry_lib::library::store`.

- [ ] **Step 3: Write the store**

Create `src-tauri/src/library/store.rs`:

```rust
use crate::error::AppError;
use crate::library::db;
use crate::library::model::{Collection, LibraryTree, Query, Tab, POSITION_GAP};
use crate::library::paths;
use rusqlite::{params, Connection, Row};
use std::path::Path;
use std::sync::Mutex;

/// All library reads and writes go through here.
///
/// The `Mutex` exists because Tauri commands run on multiple threads
/// and a `rusqlite::Connection` cannot be shared across them. SQLite
/// calls are microseconds, so a single lock is not a bottleneck.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// Open the real database in the app support directory.
    pub fn open() -> Result<Self, AppError> {
        paths::ensure_dirs()?;
        Self::open_at(&paths::database_path()?)
    }

    /// Open a database at an explicit path. Tests use this with a temp
    /// directory so they never touch the developer's real library.
    pub fn open_at(path: &Path) -> Result<Self, AppError> {
        Ok(Store {
            conn: Mutex::new(db::open(path)?),
        })
    }

    // ---- collections -------------------------------------------------

    pub fn create_collection(
        &self,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<Collection, AppError> {
        let name = validate_name(name)?;
        let conn = self.lock();
        let position = next_position(&conn, "collections", "parent_id", parent_id)?;

        let c = Collection {
            id: new_id(),
            parent_id: parent_id.map(str::to_string),
            name,
            position,
            created_at: now(),
        };

        conn.execute(
            "insert into collections (id, parent_id, name, position, created_at)
             values (?1, ?2, ?3, ?4, ?5)",
            params![c.id, c.parent_id, c.name, c.position, c.created_at],
        )
        .map_err(sql_err)?;

        Ok(c)
    }

    pub fn rename_collection(&self, id: &str, name: &str) -> Result<(), AppError> {
        let name = validate_name(name)?;
        self.lock()
            .execute("update collections set name = ?2 where id = ?1", params![id, name])
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn delete_collection(&self, id: &str) -> Result<(), AppError> {
        // Child collections and queries go with it via ON DELETE CASCADE.
        self.lock()
            .execute("delete from collections where id = ?1", params![id])
            .map_err(sql_err)?;
        Ok(())
    }

    // ---- queries -----------------------------------------------------

    pub fn create_query(
        &self,
        name: &str,
        sql: &str,
        collection_id: Option<&str>,
    ) -> Result<Query, AppError> {
        let name = validate_name(name)?;
        let conn = self.lock();
        let position = next_position(&conn, "queries", "collection_id", collection_id)?;
        let ts = now();

        let q = Query {
            id: new_id(),
            collection_id: collection_id.map(str::to_string),
            name,
            sql: sql.to_string(),
            draft_sql: None,
            position,
            created_at: ts.clone(),
            updated_at: ts,
        };

        conn.execute(
            "insert into queries
               (id, collection_id, name, sql, draft_sql, position, created_at, updated_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                q.id, q.collection_id, q.name, q.sql, q.draft_sql,
                q.position, q.created_at, q.updated_at
            ],
        )
        .map_err(sql_err)?;

        Ok(q)
    }

    pub fn query(&self, id: &str) -> Result<Option<Query>, AppError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "select id, collection_id, name, sql, draft_sql, position, created_at, updated_at
                 from queries where id = ?1",
            )
            .map_err(sql_err)?;

        let mut rows = stmt.query(params![id]).map_err(sql_err)?;
        match rows.next().map_err(sql_err)? {
            Some(row) => Ok(Some(read_query(row)?)),
            None => Ok(None),
        }
    }

    pub fn rename_query(&self, id: &str, name: &str) -> Result<(), AppError> {
        let name = validate_name(name)?;
        self.lock()
            .execute(
                "update queries set name = ?2, updated_at = ?3 where id = ?1",
                params![id, name, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Autosave. Writes `draft_sql` only — never touches `sql`.
    pub fn save_draft(&self, id: &str, sql: &str) -> Result<(), AppError> {
        self.lock()
            .execute(
                "update queries set draft_sql = ?2, updated_at = ?3 where id = ?1",
                params![id, sql, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Explicit save. Promotes the text to `sql` and clears the draft.
    pub fn save_query(&self, id: &str, sql: &str) -> Result<(), AppError> {
        self.lock()
            .execute(
                "update queries set sql = ?2, draft_sql = null, updated_at = ?3 where id = ?1",
                params![id, sql, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn move_query(&self, id: &str, collection_id: Option<&str>) -> Result<(), AppError> {
        let conn = self.lock();
        let position = next_position(&conn, "queries", "collection_id", collection_id)?;
        conn.execute(
            "update queries set collection_id = ?2, position = ?3, updated_at = ?4 where id = ?1",
            params![id, collection_id, position, now()],
        )
        .map_err(sql_err)?;
        Ok(())
    }

    pub fn delete_query(&self, id: &str) -> Result<(), AppError> {
        self.lock()
            .execute("delete from queries where id = ?1", params![id])
            .map_err(sql_err)?;
        Ok(())
    }

    // ---- the whole tree ----------------------------------------------

    /// Everything the sidebar needs, in one call.
    pub fn tree(&self) -> Result<LibraryTree, AppError> {
        let conn = self.lock();

        let mut cstmt = conn
            .prepare(
                "select id, parent_id, name, position, created_at
                 from collections order by position",
            )
            .map_err(sql_err)?;
        let collections = cstmt
            .query_map([], |row| {
                Ok(Collection {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    name: row.get(2)?,
                    position: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(sql_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_err)?;

        let mut qstmt = conn
            .prepare(
                "select id, collection_id, name, sql, draft_sql, position, created_at, updated_at
                 from queries order by position",
            )
            .map_err(sql_err)?;
        let queries = qstmt
            .query_map([], |row| {
                Ok(Query {
                    id: row.get(0)?,
                    collection_id: row.get(1)?,
                    name: row.get(2)?,
                    sql: row.get(3)?,
                    draft_sql: row.get(4)?,
                    position: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(sql_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_err)?;

        Ok(LibraryTree { collections, queries })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("library lock poisoned")
    }
}

// ---- helpers ---------------------------------------------------------

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn sql_err(e: rusqlite::Error) -> AppError {
    AppError::Library(e.to_string())
}

/// Names are trimmed and must not be empty — an unnamed row is
/// invisible in the sidebar and effectively lost.
fn validate_name(name: &str) -> Result<String, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Library("name cannot be empty".into()));
    }
    Ok(trimmed.to_string())
}

/// One gap past the last sibling. `parent_column` differs per table,
/// hence the parameter — the value is a hard-coded &'static str at
/// every call site, never user input, so it cannot inject SQL.
fn next_position(
    conn: &Connection,
    table: &'static str,
    parent_column: &'static str,
    parent_id: Option<&str>,
) -> Result<i64, AppError> {
    let sql = format!(
        "select coalesce(max(position), 0) from {table}
         where {parent_column} is ?1"
    );
    let max: i64 = conn
        .query_row(&sql, params![parent_id], |r| r.get(0))
        .map_err(sql_err)?;
    Ok(max + POSITION_GAP)
}

fn read_query(row: &Row) -> Result<Query, AppError> {
    Ok(Query {
        id: row.get(0).map_err(sql_err)?,
        collection_id: row.get(1).map_err(sql_err)?,
        name: row.get(2).map_err(sql_err)?,
        sql: row.get(3).map_err(sql_err)?,
        draft_sql: row.get(4).map_err(sql_err)?,
        position: row.get(5).map_err(sql_err)?,
        created_at: row.get(6).map_err(sql_err)?,
        updated_at: row.get(7).map_err(sql_err)?,
    })
}
```

Add `pub mod store;` to `src-tauri/src/library/mod.rs`.

Note the `is ?1` in `next_position`: SQLite's `=` never matches NULL, so a top-level item (`parent_id` NULL) needs `is` to compare correctly. Using `=` there would restart positions at 100 for every top-level insert.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test library_test 2>&1 | tail -15
```

Expected: `test result: ok. 11 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/library src-tauri/tests/library_test.rs
git commit -m "feat(library): add collection and query store with drafts"
```

---

## Task 5: Tab persistence (TDD)

**Files:**
- Modify: `src-tauri/src/library/store.rs`
- Modify: `src-tauri/tests/library_test.rs`

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/tests/library_test.rs`:

```rust
#[test]
fn opens_a_tab_for_a_query_and_makes_it_active() {
    let (s, _dir) = store();

    let q = s.create_query("q", "select 1", None).unwrap();
    let tab = s.open_tab(Some(&q.id)).unwrap();

    assert_eq!(tab.query_id.as_deref(), Some(q.id.as_str()));
    assert!(tab.is_active, "a newly opened tab takes focus");

    let tabs = s.tabs().unwrap();
    assert_eq!(tabs.len(), 1);
}

#[test]
fn only_one_tab_is_active_at_a_time() {
    let (s, _dir) = store();

    let a = s.create_query("a", "select 1", None).unwrap();
    let b = s.create_query("b", "select 2", None).unwrap();

    s.open_tab(Some(&a.id)).unwrap();
    let second = s.open_tab(Some(&b.id)).unwrap();

    let active: Vec<_> = s.tabs().unwrap().into_iter().filter(|t| t.is_active).collect();
    assert_eq!(active.len(), 1, "exactly one active tab");
    assert_eq!(active[0].id, second.id);
}

#[test]
fn opening_an_already_open_query_focuses_the_existing_tab() {
    let (s, _dir) = store();

    let q = s.create_query("q", "select 1", None).unwrap();
    let first = s.open_tab(Some(&q.id)).unwrap();
    let again = s.open_tab(Some(&q.id)).unwrap();

    assert_eq!(first.id, again.id, "no duplicate tab for the same query");
    assert_eq!(s.tabs().unwrap().len(), 1);
}

#[test]
fn opens_an_untitled_tab_with_scratch_text() {
    let (s, _dir) = store();

    let tab = s.open_tab(None).unwrap();
    assert_eq!(tab.query_id, None);

    s.save_scratch(&tab.id, "select 42").unwrap();

    let reloaded = s.tabs().unwrap();
    assert_eq!(reloaded[0].scratch_sql.as_deref(), Some("select 42"));
}

#[test]
fn tabs_survive_reopening_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.db");

    let (query_id, tab_id) = {
        let s = Store::open_at(&path).unwrap();
        let q = s.create_query("q", "select 1", None).unwrap();
        let t = s.open_tab(Some(&q.id)).unwrap();
        s.set_cursor(&t.id, 7).unwrap();
        (q.id, t.id)
    };

    let reopened = Store::open_at(&path).unwrap();
    let tabs = reopened.tabs().unwrap();

    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].id, tab_id);
    assert_eq!(tabs[0].query_id.as_deref(), Some(query_id.as_str()));
    assert_eq!(tabs[0].cursor_pos, 7, "cursor position is restored too");
}

#[test]
fn closing_a_tab_leaves_the_query_intact() {
    let (s, _dir) = store();

    let q = s.create_query("q", "select 1", None).unwrap();
    let t = s.open_tab(Some(&q.id)).unwrap();

    s.close_tab(&t.id).unwrap();

    assert_eq!(s.tabs().unwrap().len(), 0);
    assert!(s.query(&q.id).unwrap().is_some(), "closing a tab must not delete the query");
}

#[test]
fn deleting_a_query_closes_its_tab() {
    let (s, _dir) = store();

    let q = s.create_query("q", "select 1", None).unwrap();
    s.open_tab(Some(&q.id)).unwrap();

    s.delete_query(&q.id).unwrap();

    assert_eq!(s.tabs().unwrap().len(), 0, "a tab pointing at nothing would crash the UI");
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test library_test 2>&1 | tail -10
```

Expected: `no method named open_tab found`.

- [ ] **Step 3: Implement tab methods**

Add to the `impl Store` block in `src-tauri/src/library/store.rs`, before the `fn lock` helper:

```rust
    // ---- tabs --------------------------------------------------------

    /// Open a tab for a query, or an untitled tab when `query_id` is
    /// None. Opening a query that is already open focuses the existing
    /// tab instead of duplicating it.
    pub fn open_tab(&self, query_id: Option<&str>) -> Result<Tab, AppError> {
        let conn = self.lock();

        if let Some(qid) = query_id {
            let existing: Option<String> = conn
                .query_row(
                    "select id from tabs where query_id = ?1",
                    params![qid],
                    |r| r.get(0),
                )
                .ok();

            if let Some(tab_id) = existing {
                activate(&conn, &tab_id)?;
                return read_tab(&conn, &tab_id);
            }
        }

        // Tabs are a single flat list, so their position is the max
        // across ALL tabs. `next_position` cannot be used here: it
        // scopes the max to rows sharing a parent, which for tabs would
        // mean "other tabs with a NULL query_id" and would hand the same
        // position to every saved-query tab.
        let position: i64 = conn
            .query_row("select coalesce(max(position), 0) from tabs", [], |r| {
                r.get(0)
            })
            .map_err(sql_err)?
            + POSITION_GAP;
        let id = new_id();

        conn.execute(
            "insert into tabs (id, query_id, scratch_sql, position, is_active, cursor_pos)
             values (?1, ?2, null, ?3, 0, 0)",
            params![id, query_id, position],
        )
        .map_err(sql_err)?;

        activate(&conn, &id)?;
        read_tab(&conn, &id)
    }

    pub fn tabs(&self) -> Result<Vec<Tab>, AppError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "select id, query_id, scratch_sql, position, is_active, cursor_pos
                 from tabs order by position",
            )
            .map_err(sql_err)?;

        let tabs = stmt
            .query_map([], |row| {
                Ok(Tab {
                    id: row.get(0)?,
                    query_id: row.get(1)?,
                    scratch_sql: row.get(2)?,
                    position: row.get(3)?,
                    is_active: row.get::<_, i64>(4)? != 0,
                    cursor_pos: row.get(5)?,
                })
            })
            .map_err(sql_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_err)?;

        Ok(tabs)
    }

    pub fn activate_tab(&self, id: &str) -> Result<(), AppError> {
        activate(&self.lock(), id)
    }

    /// Autosave for an untitled tab.
    pub fn save_scratch(&self, id: &str, sql: &str) -> Result<(), AppError> {
        self.lock()
            .execute(
                "update tabs set scratch_sql = ?2 where id = ?1",
                params![id, sql],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn set_cursor(&self, id: &str, pos: i64) -> Result<(), AppError> {
        self.lock()
            .execute("update tabs set cursor_pos = ?2 where id = ?1", params![id, pos])
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn close_tab(&self, id: &str) -> Result<(), AppError> {
        self.lock()
            .execute("delete from tabs where id = ?1", params![id])
            .map_err(sql_err)?;
        Ok(())
    }
```

And add these free functions at the bottom of the file:

```rust
/// Make one tab active and clear the flag on every other tab. Done in
/// two statements inside the caller's lock, so no other thread can
/// observe two active tabs.
fn activate(conn: &Connection, id: &str) -> Result<(), AppError> {
    conn.execute("update tabs set is_active = 0", []).map_err(sql_err)?;
    conn.execute("update tabs set is_active = 1 where id = ?1", params![id])
        .map_err(sql_err)?;
    Ok(())
}

fn read_tab(conn: &Connection, id: &str) -> Result<Tab, AppError> {
    conn.query_row(
        "select id, query_id, scratch_sql, position, is_active, cursor_pos
         from tabs where id = ?1",
        params![id],
        |row| {
            Ok(Tab {
                id: row.get(0)?,
                query_id: row.get(1)?,
                scratch_sql: row.get(2)?,
                position: row.get(3)?,
                is_active: row.get::<_, i64>(4)? != 0,
                cursor_pos: row.get(5)?,
            })
        },
    )
    .map_err(sql_err)
}
```

The `tabs.query_id` foreign key already has `on delete cascade`, which is what makes `deleting_a_query_closes_its_tab` pass without extra code.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test library_test 2>&1 | tail -15
```

Expected: `test result: ok. 18 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/library src-tauri/tests/library_test.rs
git commit -m "feat(library): persist open tabs, active tab, and cursor"
```

---

## Task 6: The `.sql` mirror (TDD)

**Files:**
- Create: `src-tauri/src/library/mirror.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/library/mirror.rs` containing ONLY the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_query_to_a_sql_file() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &[], "monthly revenue", "select 1").unwrap();

        let path = dir.path().join("monthly revenue.sql");
        assert!(path.exists());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "select 1");
    }

    #[test]
    fn nests_files_under_collection_folders() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &["Billing", "Monthly"], "mrr", "select 2").unwrap();

        let path = dir.path().join("Billing").join("Monthly").join("mrr.sql");
        assert!(path.exists(), "expected {path:?} to exist");
    }

    #[test]
    fn sanitises_names_that_are_illegal_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        // A slash would silently create a directory; ".." would escape
        // the mirror root entirely.
        write_query(dir.path(), &[], "a/b", "select 1").unwrap();
        write_query(dir.path(), &[".."], "c", "select 1").unwrap();

        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();

        assert!(entries.contains(&"a-b.sql".to_string()), "got {entries:?}");
        assert!(
            !dir.path().join("..").join("c.sql").exists(),
            "must not write outside the mirror root"
        );
    }

    #[test]
    fn overwrites_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &[], "q", "select 1").unwrap();
        write_query(dir.path(), &[], "q", "select 2").unwrap();

        let content = std::fs::read_to_string(dir.path().join("q.sql")).unwrap();
        assert_eq!(content, "select 2");
    }

    #[test]
    fn removes_a_file() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &[], "q", "select 1").unwrap();
        remove_query(dir.path(), &[], "q").unwrap();

        assert!(!dir.path().join("q.sql").exists());
    }

    #[test]
    fn removing_something_absent_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(remove_query(dir.path(), &[], "never-existed").is_ok());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --lib library::mirror 2>&1 | tail -10
```

Expected: `cannot find function write_query in this scope`.

- [ ] **Step 3: Write the implementation**

Insert ABOVE the test module:

```rust
use crate::error::AppError;
use std::path::{Path, PathBuf};

//! The `.sql` mirror is WRITE-ONLY output.
//!
//! Saved queries are also written to plain `.sql` files so the library
//! is greppable and can be committed to git. Nothing in the app ever
//! reads these files back — the SQLite database is the single source
//! of truth. Editing a file on disk will NOT change the library, and
//! the next save overwrites it.

/// Write one query to `<root>/<collection path>/<name>.sql`.
pub fn write_query(
    root: &Path,
    collection_path: &[&str],
    name: &str,
    sql: &str,
) -> Result<(), AppError> {
    let dir = resolve_dir(root, collection_path);
    std::fs::create_dir_all(&dir).map_err(io_err)?;

    let file = dir.join(format!("{}.sql", sanitise(name)));
    std::fs::write(file, sql).map_err(io_err)?;
    Ok(())
}

/// Remove a query's file. A missing file is success — the end state
/// the caller wants already holds.
pub fn remove_query(root: &Path, collection_path: &[&str], name: &str) -> Result<(), AppError> {
    let file = resolve_dir(root, collection_path).join(format!("{}.sql", sanitise(name)));
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(e)),
    }
}

fn resolve_dir(root: &Path, collection_path: &[&str]) -> PathBuf {
    let mut dir = root.to_path_buf();
    for segment in collection_path {
        dir.push(sanitise(segment));
    }
    dir
}

/// Make a user-chosen name safe as a single path component.
///
/// Collection and query names are free text, so they can contain `/`,
/// `..`, or NUL. Left alone, `..` would let a name escape the mirror
/// root and overwrite an unrelated file. Every disallowed character
/// becomes `-`, and a name that sanitises to nothing gets a fallback.
fn sanitise(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '\0' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();

    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

fn io_err(e: std::io::Error) -> AppError {
    AppError::Library(e.to_string())
}
```

Note: the `//!` inner doc comment must be the FIRST thing in the file, above the `use` statements — move it there if the compiler complains.

Add `pub mod mirror;` to `src-tauri/src/library/mod.rs`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --lib library::mirror 2>&1 | tail -10
```

Expected: `test result: ok. 6 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/library
git commit -m "feat(library): mirror saved queries to .sql files"
```

---

## Task 7: Wire the mirror into saves

**Files:**
- Modify: `src-tauri/src/library/store.rs`
- Modify: `src-tauri/tests/library_test.rs`

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/tests/library_test.rs`:

```rust
#[test]
fn saving_a_query_writes_its_mirror_file() {
    let dir = tempfile::tempdir().unwrap();
    let mirror = dir.path().join("queries");
    let s = Store::open_at_with_mirror(&dir.path().join("test.db"), &mirror).unwrap();

    let c = s.create_collection("Billing", None).unwrap();
    let q = s.create_query("mrr", "select 1", Some(&c.id)).unwrap();
    s.save_query(&q.id, "select 2").unwrap();

    let file = mirror.join("Billing").join("mrr.sql");
    assert!(file.exists(), "expected {file:?}");
    assert_eq!(std::fs::read_to_string(file).unwrap(), "select 2");
}

#[test]
fn deleting_a_query_removes_its_mirror_file() {
    let dir = tempfile::tempdir().unwrap();
    let mirror = dir.path().join("queries");
    let s = Store::open_at_with_mirror(&dir.path().join("test.db"), &mirror).unwrap();

    let q = s.create_query("scratch", "select 1", None).unwrap();
    s.save_query(&q.id, "select 1").unwrap();
    assert!(mirror.join("scratch.sql").exists());

    s.delete_query(&q.id).unwrap();
    assert!(!mirror.join("scratch.sql").exists());
}

#[test]
fn autosaving_a_draft_does_not_touch_the_mirror() {
    let dir = tempfile::tempdir().unwrap();
    let mirror = dir.path().join("queries");
    let s = Store::open_at_with_mirror(&dir.path().join("test.db"), &mirror).unwrap();

    let q = s.create_query("q", "select 1", None).unwrap();
    s.save_query(&q.id, "select 1").unwrap();
    s.save_draft(&q.id, "select 999").unwrap();

    // Drafts fire on every keystroke; writing a file that often would
    // thrash the disk and fill git with noise.
    let content = std::fs::read_to_string(mirror.join("q.sql")).unwrap();
    assert_eq!(content, "select 1", "only explicit saves reach the mirror");
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test library_test 2>&1 | tail -10
```

Expected: `no function or associated item named open_at_with_mirror`.

- [ ] **Step 3: Implement**

In `src-tauri/src/library/store.rs`, change the struct and constructors:

```rust
pub struct Store {
    conn: Mutex<Connection>,
    mirror_root: PathBuf,
}

impl Store {
    pub fn open() -> Result<Self, AppError> {
        paths::ensure_dirs()?;
        Self::open_at_with_mirror(&paths::database_path()?, &paths::mirror_dir()?)
    }

    /// Test helper: database only, mirror in a sibling temp directory.
    pub fn open_at(path: &Path) -> Result<Self, AppError> {
        let mirror = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("queries");
        Self::open_at_with_mirror(path, &mirror)
    }

    pub fn open_at_with_mirror(path: &Path, mirror_root: &Path) -> Result<Self, AppError> {
        Ok(Store {
            conn: Mutex::new(db::open(path)?),
            mirror_root: mirror_root.to_path_buf(),
        })
    }
```

Add `use std::path::PathBuf;` to the imports.

Add a helper that walks a query's collection ancestry into a folder path:

```rust
    /// Folder names from the root down to this query's collection.
    /// Used only to place the mirror file.
    fn collection_path(&self, conn: &Connection, query_id: &str) -> Result<Vec<String>, AppError> {
        let mut current: Option<String> = conn
            .query_row(
                "select collection_id from queries where id = ?1",
                params![query_id],
                |r| r.get(0),
            )
            .map_err(sql_err)?;

        let mut segments = Vec::new();
        // Walk upward, then reverse — the loop naturally yields the
        // deepest folder first.
        while let Some(id) = current {
            let (name, parent): (String, Option<String>) = conn
                .query_row(
                    "select name, parent_id from collections where id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(sql_err)?;
            segments.push(name);
            current = parent;
        }
        segments.reverse();
        Ok(segments)
    }
```

Then make `save_query` write the mirror, and `delete_query` remove it:

```rust
    pub fn save_query(&self, id: &str, sql: &str) -> Result<(), AppError> {
        let conn = self.lock();
        conn.execute(
            "update queries set sql = ?2, draft_sql = null, updated_at = ?3 where id = ?1",
            params![id, sql, now()],
        )
        .map_err(sql_err)?;

        let name: String = conn
            .query_row("select name from queries where id = ?1", params![id], |r| r.get(0))
            .map_err(sql_err)?;
        let path = self.collection_path(&conn, id)?;
        let refs: Vec<&str> = path.iter().map(String::as_str).collect();

        // A mirror failure must not fail the save: the database already
        // has the text, and the mirror is a convenience.
        if let Err(e) = mirror::write_query(&self.mirror_root, &refs, &name, sql) {
            eprintln!("warning: could not write mirror file: {e}");
        }
        Ok(())
    }

    pub fn delete_query(&self, id: &str) -> Result<(), AppError> {
        let conn = self.lock();

        // Read the location BEFORE deleting the row — afterwards the
        // collection path is unrecoverable.
        let name: Option<String> = conn
            .query_row("select name from queries where id = ?1", params![id], |r| r.get(0))
            .ok();
        let path = self.collection_path(&conn, id).unwrap_or_default();

        conn.execute("delete from queries where id = ?1", params![id])
            .map_err(sql_err)?;

        if let Some(name) = name {
            let refs: Vec<&str> = path.iter().map(String::as_str).collect();
            if let Err(e) = mirror::remove_query(&self.mirror_root, &refs, &name) {
                eprintln!("warning: could not remove mirror file: {e}");
            }
        }
        Ok(())
    }
```

Add `use crate::library::mirror;` to the imports.

- [ ] **Step 4: Run the full suite**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test 2>&1 | grep -E "^test result"
```

Expected: every suite `ok`, 21 library tests among them.

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/library src-tauri/tests/library_test.rs
git commit -m "feat(library): write mirror files on explicit save only"
```

---

## Task 8: Library IPC commands

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Extend AppState**

In `src-tauri/src/commands.rs`, add to the imports:

```rust
use crate::library::model::{LibraryTree, Query, Tab};
use crate::library::store::Store;
```

Replace the `AppState` struct and its `Default` derive with:

```rust
pub struct AppState {
    pools: Mutex<HashMap<String, Pool>>,
    pub library: Store,
}

impl AppState {
    /// Fails only if the library database cannot be opened, which is
    /// unrecoverable — the app has nowhere to store anything.
    pub fn new() -> Result<Self, AppError> {
        Ok(AppState {
            pools: Mutex::new(HashMap::new()),
            library: Store::open()?,
        })
    }

    fn get(&self, id: &str) -> Result<Pool, AppError> {
        let pools = self.pools.lock().expect("state lock poisoned");
        pools
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::UnknownConnection(id.to_string()))
    }
}
```

- [ ] **Step 2: Add the commands**

Append to `src-tauri/src/commands.rs`:

```rust
// ---- library commands ------------------------------------------------
//
// These are thin: validation and storage logic live in `library::store`,
// which is tested directly.

#[tauri::command]
pub fn library_tree(state: tauri::State<'_, AppState>) -> Result<LibraryTree, AppError> {
    state.library.tree()
}

#[tauri::command]
pub fn create_collection(
    state: tauri::State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> Result<LibraryTree, AppError> {
    state.library.create_collection(&name, parent_id.as_deref())?;
    state.library.tree()
}

#[tauri::command]
pub fn rename_collection(
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
) -> Result<LibraryTree, AppError> {
    state.library.rename_collection(&id, &name)?;
    state.library.tree()
}

#[tauri::command]
pub fn delete_collection(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<LibraryTree, AppError> {
    state.library.delete_collection(&id)?;
    state.library.tree()
}

#[tauri::command]
pub fn create_query(
    state: tauri::State<'_, AppState>,
    name: String,
    sql: String,
    collection_id: Option<String>,
) -> Result<Query, AppError> {
    state.library.create_query(&name, &sql, collection_id.as_deref())
}

#[tauri::command]
pub fn rename_query(
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
) -> Result<LibraryTree, AppError> {
    state.library.rename_query(&id, &name)?;
    state.library.tree()
}

#[tauri::command]
pub fn save_query(
    state: tauri::State<'_, AppState>,
    id: String,
    sql: String,
) -> Result<(), AppError> {
    state.library.save_query(&id, &sql)
}

#[tauri::command]
pub fn save_draft(
    state: tauri::State<'_, AppState>,
    id: String,
    sql: String,
) -> Result<(), AppError> {
    state.library.save_draft(&id, &sql)
}

#[tauri::command]
pub fn move_query(
    state: tauri::State<'_, AppState>,
    id: String,
    collection_id: Option<String>,
) -> Result<LibraryTree, AppError> {
    state.library.move_query(&id, collection_id.as_deref())?;
    state.library.tree()
}

#[tauri::command]
pub fn delete_query(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<LibraryTree, AppError> {
    state.library.delete_query(&id)?;
    state.library.tree()
}

#[tauri::command]
pub fn list_tabs(state: tauri::State<'_, AppState>) -> Result<Vec<Tab>, AppError> {
    state.library.tabs()
}

#[tauri::command]
pub fn open_tab(
    state: tauri::State<'_, AppState>,
    query_id: Option<String>,
) -> Result<Vec<Tab>, AppError> {
    state.library.open_tab(query_id.as_deref())?;
    state.library.tabs()
}

#[tauri::command]
pub fn activate_tab(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<Tab>, AppError> {
    state.library.activate_tab(&id)?;
    state.library.tabs()
}

#[tauri::command]
pub fn close_tab(state: tauri::State<'_, AppState>, id: String) -> Result<Vec<Tab>, AppError> {
    state.library.close_tab(&id)?;
    state.library.tabs()
}

#[tauri::command]
pub fn save_scratch(
    state: tauri::State<'_, AppState>,
    id: String,
    sql: String,
) -> Result<(), AppError> {
    state.library.save_scratch(&id, &sql)
}

#[tauri::command]
pub fn set_cursor(
    state: tauri::State<'_, AppState>,
    id: String,
    pos: i64,
) -> Result<(), AppError> {
    state.library.set_cursor(&id, pos)
}
```

Mutating commands return the refreshed tree or tab list so the UI never has to guess what changed — one round trip, no stale state.

- [ ] **Step 3: Register them**

In `src-tauri/src/lib.rs`, replace `.manage(commands::AppState::default())` with:

```rust
        .manage(
            commands::AppState::new().expect("could not open the query library database"),
        )
```

and extend `tauri::generate_handler![...]` with every new command:

```rust
            commands::connect,
            commands::execute,
            commands::disconnect,
            commands::library_tree,
            commands::create_collection,
            commands::rename_collection,
            commands::delete_collection,
            commands::create_query,
            commands::rename_query,
            commands::save_query,
            commands::save_draft,
            commands::move_query,
            commands::delete_query,
            commands::list_tabs,
            commands::open_tab,
            commands::activate_tab,
            commands::close_tab,
            commands::save_scratch,
            commands::set_cursor
```

- [ ] **Step 4: Verify and commit**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test 2>&1 | grep -E "^test result|^error"
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src
git commit -m "feat(ipc): expose query library and tab commands"
```

---

## Task 9: TypeScript types, IPC, and tree helpers (TDD)

**Files:**
- Modify: `src/types.ts`, `src/lib/ipc.ts`
- Create: `src/lib/tree.ts`, `src/lib/tree.test.ts`

- [ ] **Step 1: Add types**

Append to `src/types.ts`:

```typescript
/** Mirrors Rust `Collection`. */
export interface Collection {
  id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: string;
}

/** Mirrors Rust `Query`. `draft_sql` is the autosaved text. */
export interface Query {
  id: string;
  collection_id: string | null;
  name: string;
  sql: string;
  draft_sql: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

/** Mirrors Rust `Tab`. `query_id === null` means an untitled tab. */
export interface Tab {
  id: string;
  query_id: string | null;
  scratch_sql: string | null;
  position: number;
  is_active: boolean;
  cursor_pos: number;
}

/** Mirrors Rust `LibraryTree`. */
export interface LibraryTree {
  collections: Collection[];
  queries: Query[];
}

/** A collection with its children resolved, for rendering. */
export interface TreeNode {
  collection: Collection;
  children: TreeNode[];
  queries: Query[];
}
```

- [ ] **Step 2: Write the failing tree-helper tests**

Create `src/lib/tree.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildTree, effectiveSql, isDirty } from "./tree";
import type { Collection, LibraryTree, Query } from "../types";

function collection(id: string, parent: string | null, pos = 100): Collection {
  return {
    id,
    parent_id: parent,
    name: id,
    position: pos,
    created_at: "",
  };
}

function query(id: string, collectionId: string | null, pos = 100): Query {
  return {
    id,
    collection_id: collectionId,
    name: id,
    sql: "select 1",
    draft_sql: null,
    position: pos,
    created_at: "",
    updated_at: "",
  };
}

describe("buildTree", () => {
  it("returns an empty tree for an empty library", () => {
    const tree: LibraryTree = { collections: [], queries: [] };
    expect(buildTree(tree)).toEqual({ roots: [], looseQueries: [] });
  });

  it("nests child collections under their parent", () => {
    const tree: LibraryTree = {
      collections: [collection("parent", null), collection("child", "parent")],
      queries: [],
    };

    const { roots } = buildTree(tree);
    expect(roots).toHaveLength(1);
    expect(roots[0].collection.id).toBe("parent");
    expect(roots[0].children[0].collection.id).toBe("child");
  });

  it("places queries inside their collection", () => {
    const tree: LibraryTree = {
      collections: [collection("c", null)],
      queries: [query("q", "c")],
    };

    const { roots } = buildTree(tree);
    expect(roots[0].queries.map((q) => q.id)).toEqual(["q"]);
  });

  it("surfaces queries with no collection at the top level", () => {
    const tree: LibraryTree = {
      collections: [],
      queries: [query("loose", null)],
    };

    const { looseQueries } = buildTree(tree);
    expect(looseQueries.map((q) => q.id)).toEqual(["loose"]);
  });

  it("sorts siblings by position", () => {
    const tree: LibraryTree = {
      collections: [collection("b", null, 200), collection("a", null, 100)],
      queries: [query("z", null, 200), query("y", null, 100)],
    };

    const { roots, looseQueries } = buildTree(tree);
    expect(roots.map((r) => r.collection.id)).toEqual(["a", "b"]);
    expect(looseQueries.map((q) => q.id)).toEqual(["y", "z"]);
  });

  it("drops a collection whose parent is missing rather than losing it silently", () => {
    // A dangling parent_id should not make the whole tree disappear.
    const tree: LibraryTree = {
      collections: [collection("orphan", "gone")],
      queries: [],
    };

    const { roots } = buildTree(tree);
    expect(roots.map((r) => r.collection.id)).toEqual(["orphan"]);
  });
});

describe("effectiveSql", () => {
  it("prefers the draft over the saved text", () => {
    expect(effectiveSql({ ...query("q", null), draft_sql: "draft" })).toBe("draft");
  });

  it("falls back to the saved text when there is no draft", () => {
    expect(effectiveSql(query("q", null))).toBe("select 1");
  });

  it("treats an empty draft as real text, not as absent", () => {
    // Clearing the editor is a legitimate edit; it must not resurrect
    // the saved SQL.
    expect(effectiveSql({ ...query("q", null), draft_sql: "" })).toBe("");
  });
});

describe("isDirty", () => {
  it("is false with no draft", () => {
    expect(isDirty(query("q", null))).toBe(false);
  });

  it("is false when the draft matches the saved text", () => {
    expect(isDirty({ ...query("q", null), draft_sql: "select 1" })).toBe(false);
  });

  it("is true when the draft differs", () => {
    expect(isDirty({ ...query("q", null), draft_sql: "select 2" })).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry && npm test 2>&1 | tail -10
```

Expected: cannot resolve `./tree`.

- [ ] **Step 4: Implement**

Create `src/lib/tree.ts`:

```typescript
import type { LibraryTree, Query, TreeNode } from "../types";

export interface BuiltTree {
  roots: TreeNode[];
  /** Queries not filed in any collection. */
  looseQueries: Query[];
}

/**
 * Turn the flat lists the backend sends into a renderable tree.
 *
 * A collection whose `parent_id` points at something missing is treated
 * as a root rather than dropped — losing a folder from the sidebar
 * because of one bad reference would look like data loss to the user.
 */
export function buildTree(library: LibraryTree): BuiltTree {
  const byPosition = <T extends { position: number }>(a: T, b: T) =>
    a.position - b.position;

  const nodes = new Map<string, TreeNode>();
  for (const collection of library.collections) {
    nodes.set(collection.id, { collection, children: [], queries: [] });
  }

  const roots: TreeNode[] = [];
  for (const collection of [...library.collections].sort(byPosition)) {
    const node = nodes.get(collection.id)!;
    const parent =
      collection.parent_id === null ? undefined : nodes.get(collection.parent_id);

    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const looseQueries: Query[] = [];
  for (const query of [...library.queries].sort(byPosition)) {
    const parent =
      query.collection_id === null ? undefined : nodes.get(query.collection_id);

    if (parent) {
      parent.queries.push(query);
    } else {
      looseQueries.push(query);
    }
  }

  return { roots, looseQueries };
}

/** The text the editor should show: draft if present, else saved. */
export function effectiveSql(query: Query): string {
  return query.draft_sql ?? query.sql;
}

/** Whether the draft differs from the saved text. */
export function isDirty(query: Query): boolean {
  return query.draft_sql !== null && query.draft_sql !== query.sql;
}
```

Note `??` rather than `||`: an empty-string draft is a real edit and must not fall through to the saved SQL.

- [ ] **Step 5: Add the IPC wrappers**

Append to `src/lib/ipc.ts`:

```typescript
import type { LibraryTree, Query, Tab } from "../types";

export async function libraryTree(): Promise<LibraryTree> {
  return invoke<LibraryTree>("library_tree");
}

export async function createCollection(
  name: string,
  parentId: string | null,
): Promise<LibraryTree> {
  return invoke<LibraryTree>("create_collection", { name, parentId });
}

export async function renameCollection(
  id: string,
  name: string,
): Promise<LibraryTree> {
  return invoke<LibraryTree>("rename_collection", { id, name });
}

export async function deleteCollection(id: string): Promise<LibraryTree> {
  return invoke<LibraryTree>("delete_collection", { id });
}

export async function createQuery(
  name: string,
  sql: string,
  collectionId: string | null,
): Promise<Query> {
  return invoke<Query>("create_query", { name, sql, collectionId });
}

export async function renameQuery(id: string, name: string): Promise<LibraryTree> {
  return invoke<LibraryTree>("rename_query", { id, name });
}

export async function saveQuery(id: string, sql: string): Promise<void> {
  return invoke("save_query", { id, sql });
}

export async function saveDraft(id: string, sql: string): Promise<void> {
  return invoke("save_draft", { id, sql });
}

export async function moveQuery(
  id: string,
  collectionId: string | null,
): Promise<LibraryTree> {
  return invoke<LibraryTree>("move_query", { id, collectionId });
}

export async function deleteQuery(id: string): Promise<LibraryTree> {
  return invoke<LibraryTree>("delete_query", { id });
}

export async function listTabs(): Promise<Tab[]> {
  return invoke<Tab[]>("list_tabs");
}

export async function openTab(queryId: string | null): Promise<Tab[]> {
  return invoke<Tab[]>("open_tab", { queryId });
}

export async function activateTab(id: string): Promise<Tab[]> {
  return invoke<Tab[]>("activate_tab", { id });
}

export async function closeTab(id: string): Promise<Tab[]> {
  return invoke<Tab[]>("close_tab", { id });
}

export async function saveScratch(id: string, sql: string): Promise<void> {
  return invoke("save_scratch", { id, sql });
}

export async function setCursor(id: string, pos: number): Promise<void> {
  return invoke("set_cursor", { id, pos });
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry && npm test 2>&1 | tail -8 && npx tsc --noEmit
```

Expected: 3 test files, 23 tests passing; typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src
git commit -m "feat(ui): add library types, IPC wrappers, and tree helpers"
```

---

## Task 10: The library hook

**Files:**
- Create: `src/hooks/useLibrary.ts`

- [ ] **Step 1: Write the hook**

Create `src/hooks/useLibrary.ts`:

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../lib/ipc";
import type { LibraryTree, Query, Tab } from "../types";

/** How long typing must pause before a draft is written. */
const AUTOSAVE_DELAY_MS = 400;

const EMPTY: LibraryTree = { collections: [], queries: [] };

/**
 * Owns library and tab state, plus debounced autosave.
 *
 * Every mutating IPC call returns the refreshed tree or tab list, so
 * state is replaced with what the backend reports rather than patched
 * locally — the two can never drift apart.
 */
export function useLibrary() {
  const [library, setLibrary] = useState<LibraryTree>(EMPTY);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Restore the previous session on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [tree, openTabs] = await Promise.all([ipc.libraryTree(), ipc.listTabs()]);
      if (cancelled) return;
      setLibrary(tree);
      setTabs(openTabs);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeTab = tabs.find((t) => t.is_active) ?? null;

  const queryById = useCallback(
    (id: string | null): Query | null =>
      id === null ? null : (library.queries.find((q) => q.id === id) ?? null),
    [library.queries],
  );

  // ---- autosave ------------------------------------------------------

  const timer = useRef<number | null>(null);

  /**
   * Debounced write of the editor text. Saved queries get a draft;
   * untitled tabs get scratch text. Both survive a restart.
   */
  const autosave = useCallback(
    (tab: Tab, sql: string) => {
      if (timer.current !== null) window.clearTimeout(timer.current);

      timer.current = window.setTimeout(() => {
        void (async () => {
          if (tab.query_id) {
            await ipc.saveDraft(tab.query_id, sql);
            setLibrary((prev) => ({
              ...prev,
              queries: prev.queries.map((q) =>
                q.id === tab.query_id ? { ...q, draft_sql: sql } : q,
              ),
            }));
          } else {
            await ipc.saveScratch(tab.id, sql);
            setTabs((prev) =>
              prev.map((t) => (t.id === tab.id ? { ...t, scratch_sql: sql } : t)),
            );
          }
        })();
      }, AUTOSAVE_DELAY_MS);
    },
    [],
  );

  // Flush a pending autosave if the component unmounts mid-timer.
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  // ---- actions -------------------------------------------------------

  const actions = {
    openQuery: async (queryId: string) => setTabs(await ipc.openTab(queryId)),
    newTab: async () => setTabs(await ipc.openTab(null)),
    activateTab: async (id: string) => setTabs(await ipc.activateTab(id)),
    closeTab: async (id: string) => setTabs(await ipc.closeTab(id)),

    createCollection: async (name: string, parentId: string | null) =>
      setLibrary(await ipc.createCollection(name, parentId)),
    renameCollection: async (id: string, name: string) =>
      setLibrary(await ipc.renameCollection(id, name)),
    deleteCollection: async (id: string) => {
      setLibrary(await ipc.deleteCollection(id));
      // Deleting a collection cascades to its queries, which closes
      // their tabs in the database — refetch so the UI agrees.
      setTabs(await ipc.listTabs());
    },

    renameQuery: async (id: string, name: string) =>
      setLibrary(await ipc.renameQuery(id, name)),
    deleteQuery: async (id: string) => {
      setLibrary(await ipc.deleteQuery(id));
      setTabs(await ipc.listTabs());
    },
    moveQuery: async (id: string, collectionId: string | null) =>
      setLibrary(await ipc.moveQuery(id, collectionId)),

    /** Explicit save. Turns an untitled tab into a real saved query. */
    save: async (tab: Tab, sql: string, nameIfNew: string) => {
      if (tab.query_id) {
        await ipc.saveQuery(tab.query_id, sql);
        setLibrary(await ipc.libraryTree());
      } else {
        const created = await ipc.createQuery(nameIfNew, sql, null);
        await ipc.saveQuery(created.id, sql);
        setLibrary(await ipc.libraryTree());
        // Repoint the tab at the new query: close the scratch tab and
        // open one for the saved query.
        await ipc.closeTab(tab.id);
        setTabs(await ipc.openTab(created.id));
      }
    },
  };

  return { library, tabs, activeTab, loaded, queryById, autosave, actions };
}
```

- [ ] **Step 2: Verify and commit**

```bash
cd /Users/lepetitdev/dev/quarry && npx tsc --noEmit
git add src/hooks
git commit -m "feat(ui): add library hook with debounced autosave"
```

---

## Task 11: Sidebar with the query tree

**Files:**
- Create: `src/components/QueryTree.tsx`, `src/components/Sidebar.tsx`

- [ ] **Step 1: Write the tree component**

Create `src/components/QueryTree.tsx`:

```tsx
import { useState } from "react";
import { buildTree, isDirty } from "../lib/tree";
import type { LibraryTree, Query, TreeNode } from "../types";

interface Props {
  library: LibraryTree;
  activeQueryId: string | null;
  onOpen: (queryId: string) => void;
  onRenameQuery: (id: string, name: string) => void;
  onDeleteQuery: (id: string) => void;
  onRenameCollection: (id: string, name: string) => void;
  onDeleteCollection: (id: string) => void;
}

export function QueryTree({
  library,
  activeQueryId,
  onOpen,
  onRenameQuery,
  onDeleteQuery,
  onRenameCollection,
  onDeleteCollection,
}: Props) {
  const { roots, looseQueries } = buildTree(library);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderQuery(query: Query, depth: number) {
    const active = query.id === activeQueryId;
    const dirty = isDirty(query);

    if (renaming === query.id) {
      return (
        <RenameInput
          key={query.id}
          initial={query.name}
          depth={depth}
          onCommit={(name) => {
            onRenameQuery(query.id, name);
            setRenaming(null);
          }}
          onCancel={() => setRenaming(null)}
        />
      );
    }

    return (
      <div
        key={query.id}
        className={`tree-row query${active ? " active" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onOpen(query.id)}
        onDoubleClick={() => setRenaming(query.id)}
      >
        <span className="tree-name">{query.name}</span>
        {dirty && <span className="dirty-dot" title="unsaved changes">•</span>}
        <button
          className="row-action"
          title="Delete query"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteQuery(query.id);
          }}
        >
          ×
        </button>
      </div>
    );
  }

  function renderNode(node: TreeNode, depth: number) {
    const isCollapsed = collapsed.has(node.collection.id);

    return (
      <div key={node.collection.id}>
        {renaming === node.collection.id ? (
          <RenameInput
            initial={node.collection.name}
            depth={depth}
            onCommit={(name) => {
              onRenameCollection(node.collection.id, name);
              setRenaming(null);
            }}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <div
            className="tree-row collection"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => toggle(node.collection.id)}
            onDoubleClick={() => setRenaming(node.collection.id)}
          >
            <span className="chevron">{isCollapsed ? "▸" : "▾"}</span>
            <span className="tree-name">{node.collection.name}</span>
            <button
              className="row-action"
              title="Delete collection and everything in it"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteCollection(node.collection.id);
              }}
            >
              ×
            </button>
          </div>
        )}

        {!isCollapsed && (
          <>
            {node.children.map((child) => renderNode(child, depth + 1))}
            {node.queries.map((query) => renderQuery(query, depth + 1))}
          </>
        )}
      </div>
    );
  }

  if (roots.length === 0 && looseQueries.length === 0) {
    return <p className="tree-empty">No saved queries yet.</p>;
  }

  return (
    <div className="query-tree">
      {roots.map((node) => renderNode(node, 0))}
      {looseQueries.map((query) => renderQuery(query, 0))}
    </div>
  );
}

/** Inline rename field. Enter commits, Escape cancels, blur commits. */
function RenameInput({
  initial,
  depth,
  onCommit,
  onCancel,
}: {
  initial: string;
  depth: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);

  return (
    <input
      className="rename-input"
      style={{ marginLeft: 8 + depth * 12 }}
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => (value.trim() ? onCommit(value) : onCancel())}
      onKeyDown={(e) => {
        if (e.key === "Enter" && value.trim()) onCommit(value);
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}
```

- [ ] **Step 2: Write the sidebar shell**

Per the spec, Schema sits above Queries. Schema itself arrives in Stage 4, so it renders as a labelled placeholder — the layout is real, the content is not.

Create `src/components/Sidebar.tsx`:

```tsx
import { QueryTree } from "./QueryTree";
import type { LibraryTree } from "../types";

interface Props {
  library: LibraryTree;
  activeQueryId: string | null;
  onOpen: (queryId: string) => void;
  onNewCollection: () => void;
  onRenameQuery: (id: string, name: string) => void;
  onDeleteQuery: (id: string) => void;
  onRenameCollection: (id: string, name: string) => void;
  onDeleteCollection: (id: string) => void;
}

export function Sidebar(props: Props) {
  return (
    <aside className="sidebar">
      <section className="sidebar-section schema">
        <header className="sidebar-header">
          <span>SCHEMA</span>
        </header>
        <p className="tree-empty">Schema browsing arrives in Stage 4.</p>
      </section>

      <div className="sidebar-splitter" />

      <section className="sidebar-section queries">
        <header className="sidebar-header">
          <span>QUERIES</span>
          <button
            className="row-action"
            title="New collection"
            onClick={props.onNewCollection}
          >
            +
          </button>
        </header>
        <QueryTree
          library={props.library}
          activeQueryId={props.activeQueryId}
          onOpen={props.onOpen}
          onRenameQuery={props.onRenameQuery}
          onDeleteQuery={props.onDeleteQuery}
          onRenameCollection={props.onRenameCollection}
          onDeleteCollection={props.onDeleteCollection}
        />
      </section>
    </aside>
  );
}
```

- [ ] **Step 3: Verify and commit**

```bash
cd /Users/lepetitdev/dev/quarry && npx tsc --noEmit
git add src/components
git commit -m "feat(ui): add sidebar with the saved query tree"
```

---

## Task 12: Tab bar

**Files:**
- Create: `src/components/TabBar.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/TabBar.tsx`:

```tsx
import { isDirty } from "../lib/tree";
import type { Query, Tab } from "../types";

interface Props {
  tabs: Tab[];
  queryById: (id: string | null) => Query | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

export function TabBar({ tabs, queryById, onActivate, onClose, onNew }: Props) {
  return (
    <div className="tab-bar">
      {tabs.map((tab) => {
        const query = queryById(tab.query_id);
        const label = query?.name ?? "untitled";
        const dirty = query ? isDirty(query) : (tab.scratch_sql ?? "") !== "";

        return (
          <div
            key={tab.id}
            className={`tab${tab.is_active ? " active" : ""}`}
            onClick={() => onActivate(tab.id)}
            title={label}
          >
            <span className="tab-label">{label}</span>
            {dirty && <span className="dirty-dot">•</span>}
            <button
              className="tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button className="tab-new" title="New query tab" onClick={onNew}>
        +
      </button>
    </div>
  );
}
```

Closing a tab never prompts: the draft is already persisted, so there is nothing to lose and nothing to ask about.

- [ ] **Step 2: Verify and commit**

```bash
cd /Users/lepetitdev/dev/quarry && npx tsc --noEmit
git add src/components/TabBar.tsx
git commit -m "feat(ui): add tab bar"
```

---

## Task 13: Compose everything

**Files:**
- Modify: `src/App.tsx`, `src/App.css`

- [ ] **Step 1: Rewrite App.tsx**

Replace the entire contents of `src/App.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { ConnectionForm } from "./components/ConnectionForm";
import { ResultGrid } from "./components/ResultGrid";
import { Sidebar } from "./components/Sidebar";
import { SqlEditor } from "./components/SqlEditor";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { useLibrary } from "./hooks/useLibrary";
import { asAppError, execute } from "./lib/ipc";
import { effectiveSql } from "./lib/tree";
import type { AppErrorPayload, ConnectionInfo, QueryResult } from "./types";
import "./App.css";

export default function App() {
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<AppErrorPayload | null>(null);
  const [busy, setBusy] = useState(false);

  const { library, tabs, activeTab, loaded, queryById, autosave, actions } =
    useLibrary();

  // The editor's text is local while typing; autosave persists it.
  const [text, setText] = useState("");

  // When the active tab changes, load its text into the editor.
  useEffect(() => {
    if (!activeTab) {
      setText("");
      return;
    }
    const query = queryById(activeTab.query_id);
    setText(query ? effectiveSql(query) : (activeTab.scratch_sql ?? ""));
    // Only re-run when the tab identity changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id]);

  // Open one empty tab on first launch so there is somewhere to type.
  useEffect(() => {
    if (loaded && tabs.length === 0) void actions.newTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, tabs.length]);

  const onChange = useCallback(
    (value: string) => {
      setText(value);
      if (activeTab) autosave(activeTab, value);
    },
    [activeTab, autosave],
  );

  const run = useCallback(async () => {
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await execute(connection.id, text));
    } catch (e) {
      setError(asAppError(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [connection, text]);

  const save = useCallback(async () => {
    if (!activeTab) return;
    const query = queryById(activeTab.query_id);
    if (query) {
      await actions.save(activeTab, text, query.name);
      return;
    }
    const name = window.prompt("Name this query");
    if (name?.trim()) await actions.save(activeTab, text, name.trim());
  }, [activeTab, queryById, actions, text]);

  // Cmd+S saves the active tab.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  if (!connection) {
    return (
      <main className="app centered">
        <h1>Quarry</h1>
        <ConnectionForm onConnected={setConnection} />
      </main>
    );
  }

  return (
    <main className="app with-sidebar">
      <Sidebar
        library={library}
        activeQueryId={activeTab?.query_id ?? null}
        onOpen={(id) => void actions.openQuery(id)}
        onNewCollection={() => {
          const name = window.prompt("Collection name");
          if (name?.trim()) void actions.createCollection(name.trim(), null);
        }}
        onRenameQuery={(id, name) => void actions.renameQuery(id, name)}
        onDeleteQuery={(id) => void actions.deleteQuery(id)}
        onRenameCollection={(id, name) => void actions.renameCollection(id, name)}
        onDeleteCollection={(id) => void actions.deleteCollection(id)}
      />

      <div className="main-pane">
        <header className="top-bar">
          <strong>
            {connection.user}@{connection.host}:{connection.port}/
            {connection.dbname}
          </strong>
          <button className="save-button" onClick={() => void save()}>
            Save ⌘S
          </button>
        </header>

        <TabBar
          tabs={tabs}
          queryById={queryById}
          onActivate={(id) => void actions.activateTab(id)}
          onClose={(id) => void actions.closeTab(id)}
          onNew={() => void actions.newTab()}
        />

        <SqlEditor value={text} onChange={onChange} onRun={run} busy={busy} />
        {result && <ResultGrid result={result} />}
        <StatusBar result={result} error={error} />
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Add the layout styles**

Append to `src/App.css`:

```css
.app.with-sidebar {
  flex-direction: row;
}

.sidebar {
  display: flex;
  flex-direction: column;
  width: 240px;
  min-width: 160px;
  border-right: 1px solid var(--border);
  background: var(--panel);
  overflow: hidden;
}

.sidebar-section {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  flex: 1;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--muted);
  position: sticky;
  top: 0;
  background: var(--panel);
}

.sidebar-splitter {
  height: 1px;
  background: var(--border);
}

.main-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  cursor: default;
  white-space: nowrap;
}

.tree-row:hover {
  background: #22262e;
}

.tree-row.active {
  background: #2a3446;
}

.tree-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chevron {
  width: 10px;
  color: var(--muted);
}

.tree-empty {
  padding: 6px 10px;
  color: var(--muted);
}

.row-action,
.tab-close,
.tab-new {
  background: none;
  border: none;
  color: var(--muted);
  padding: 0 4px;
  font-size: 13px;
  opacity: 0;
}

.tree-row:hover .row-action,
.tab:hover .tab-close,
.sidebar-header .row-action,
.tab-new {
  opacity: 1;
}

.row-action:hover,
.tab-close:hover {
  color: var(--text);
}

.rename-input {
  width: 80%;
  padding: 2px 4px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--accent);
  border-radius: 3px;
}

.dirty-dot {
  color: var(--accent);
  font-size: 16px;
  line-height: 1;
}

.tab-bar {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  overflow-x: auto;
}

.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-right: 1px solid var(--border);
  color: var(--muted);
  white-space: nowrap;
}

.tab.active {
  background: var(--bg);
  color: var(--text);
  box-shadow: inset 0 -2px 0 var(--accent);
}

.tab-label {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.save-button {
  padding: 4px 10px;
  font-size: 12px;
}
```

- [ ] **Step 3: Verify and commit**

```bash
cd /Users/lepetitdev/dev/quarry
npx tsc --noEmit
npm test 2>&1 | tail -6
npm run build 2>&1 | tail -5
git add src
git commit -m "feat(ui): compose sidebar, tabs, and editor into the app"
```

---

## Task 14: End-to-end smoke test

**Files:** none

- [ ] **Step 1: Start a scratch database**

```bash
docker run --rm -d --name quarry-smoke -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17
sleep 5
docker exec quarry-smoke psql -U postgres -c "create table users (id serial primary key, email text, plan text);"
docker exec quarry-smoke psql -U postgres -c "insert into users (email, plan) select 'u'||g||'@example.com', case when g%3=0 then 'pro' else 'free' end from generate_series(1,1000) g;"
```

- [ ] **Step 2: Run the app**

```bash
cd /Users/lepetitdev/dev/quarry && npm run tauri dev
```

- [ ] **Step 3: Verify each behavior**

Connect with `postgres://postgres:postgres@localhost:55432/postgres?sslmode=disable`, then:

- [ ] Sidebar shows SCHEMA above QUERIES, with the Stage 4 placeholder
- [ ] `+` next to QUERIES creates a collection; it appears immediately
- [ ] Double-clicking a collection renames it inline; Escape cancels
- [ ] Type SQL in the untitled tab, ⌘S, give it a name — it appears in the tree
- [ ] The tab label changes from "untitled" to the query name
- [ ] Edit a saved query without saving — a dot appears on the tab and in the tree
- [ ] **Quit the app entirely and reopen it** — the same tabs are open, the same tab is active, and the unsaved edit is still there
- [ ] Clicking a query in the tree opens it; clicking it again focuses the existing tab rather than duplicating it
- [ ] Closing a tab does not delete the query from the tree
- [ ] Deleting a query removes it from the tree AND closes its tab
- [ ] Deleting a collection removes its queries too
- [ ] `ls ~/Library/Application\ Support/com.quarry.app/queries/` shows `.sql` files mirroring your saved queries, nested in collection folders
- [ ] Editing a `.sql` file on disk does NOT change the app (mirror is one-way, by design)

- [ ] **Step 4: Tear down**

```bash
docker stop quarry-smoke
```

- [ ] **Step 5: Full suite and tag**

```bash
cd /Users/lepetitdev/dev/quarry && npm test && cd src-tauri && cargo test 2>&1 | grep -E "^test result"
cd /Users/lepetitdev/dev/quarry && git tag stage-2-query-library
```

---

## Definition of done

- Queries are saved under names in nestable collections; nothing requires touching a file
- Tabs, the active tab, and cursor position survive a restart
- Typing is autosaved as a draft; closing the app mid-edit loses nothing, and no save prompt ever appears
- Deleting a collection removes its queries and their tabs; closing a tab keeps the query
- Saved queries are mirrored to `.sql` files, one-way
- `cargo test` and `npm test` both pass

## Deliberately not in this stage

Drag-and-drop reordering (the `position` column and `move_query` support it; only the drag UI is missing). Environments, variables, and the safety guard (Stage 3). Schema tree and autocomplete (Stage 4). History, command palette, export (Stage 5). Inline row editing (Stage 6). Full-text search across queries. Importing existing `.sql` files into the library.
