use crate::error::AppError;
use crate::library::db;
use crate::library::mirror;
use crate::library::model::{Collection, LibraryTree, Query, POSITION_GAP};
use crate::library::paths;
use crate::secrets::{Credentials, EphemeralCredentials, Keychain};
use rusqlite::{params, Connection, Row};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub(crate) mod recent;
mod tabs;
mod writes;

/// All library reads and writes go through here.
///
/// The `Mutex` exists because Tauri commands run on multiple threads
/// and a `rusqlite::Connection` cannot be shared across them. SQLite
/// calls are microseconds, so a single lock is not a bottleneck.
pub struct Store {
    conn: Mutex<Connection>,
    mirror_root: PathBuf,
    /// Where connection passwords live. Injected rather than reached for
    /// directly so tests never touch the real Keychain — see
    /// `secrets::Credentials`.
    credentials: Box<dyn Credentials>,
}

impl Store {
    /// Open the real database in the app support directory.
    pub fn open() -> Result<Self, AppError> {
        paths::ensure_dirs()?;
        Self::open_at_with_mirror(&paths::database_path()?, &paths::mirror_dir()?)
    }

    /// Test helper: database only, mirror in a sibling temp directory,
    /// and credentials that live and die with the process.
    ///
    /// The credential store is the point. `cargo test` re-links a
    /// differently-signed binary on every build and macOS ties Keychain
    /// grants to a signature, so any test that reached the real store
    /// prompted the developer on every run, forever.
    pub fn open_at(path: &Path) -> Result<Self, AppError> {
        let mirror = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("queries");
        Self::open_at_with(path, &mirror, Box::new(EphemeralCredentials::default()))
    }

    /// Open a database at an explicit path with an explicit mirror
    /// root, against the real credential store.
    pub fn open_at_with_mirror(path: &Path, mirror_root: &Path) -> Result<Self, AppError> {
        Self::open_at_with(path, mirror_root, Box::new(Keychain))
    }

    fn open_at_with(
        path: &Path,
        mirror_root: &Path,
        credentials: Box<dyn Credentials>,
    ) -> Result<Self, AppError> {
        Ok(Store {
            conn: Mutex::new(db::open(path)?),
            mirror_root: mirror_root.to_path_buf(),
            credentials,
        })
    }

    /// The credential store behind this library, for the commands that
    /// resolve a password before connecting.
    pub fn credentials(&self) -> &dyn Credentials {
        self.credentials.as_ref()
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
            .execute(
                "update collections set name = ?2 where id = ?1",
                params![id, name],
            )
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
                q.id,
                q.collection_id,
                q.name,
                q.sql,
                q.draft_sql,
                q.position,
                q.created_at,
                q.updated_at
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
        let conn = self.lock();
        conn.execute(
            "update queries set sql = ?2, draft_sql = null, updated_at = ?3 where id = ?1",
            params![id, sql, now()],
        )
        .map_err(sql_err)?;

        let name: String = conn
            .query_row("select name from queries where id = ?1", params![id], |r| {
                r.get(0)
            })
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
        let conn = self.lock();

        // Read the location BEFORE deleting the row — afterwards the
        // collection path is unrecoverable.
        let name: Option<String> = conn
            .query_row("select name from queries where id = ?1", params![id], |r| {
                r.get(0)
            })
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

        Ok(LibraryTree {
            collections,
            queries,
        })
    }

    /// The library connection, recovering rather than panicking if the
    /// mutex is poisoned.
    ///
    /// A mutex poisons when a thread panics while holding it. The data
    /// behind this one is a SQLite connection, which is structurally
    /// valid either way — a panic mid-query leaves the connection
    /// usable, and any half-written transaction is rolled back by
    /// SQLite itself. Propagating the poison instead would panic every
    /// later call too, so a single unlucky panic would brick the
    /// library for the rest of the session with no error shown.
    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ---- helpers ---------------------------------------------------------

/// An opaque handle for something held in memory, like a parked write.
///
/// Same generator as `new_id`, named for its use so command code does
/// not reach into a crate-private helper.
pub fn new_token() -> String {
    new_id()
}

pub(crate) fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub(crate) fn sql_err(e: rusqlite::Error) -> AppError {
    AppError::Library(e.to_string())
}

/// Names are trimmed and must not be empty — an unnamed row is
/// invisible in the sidebar and effectively lost.
pub(crate) fn validate_name(name: &str) -> Result<String, AppError> {
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

#[cfg(test)]
mod poison_tests {
    use super::*;

    /// A panic while the library lock is held must not brick every later
    /// call.
    ///
    /// Poisoning is deliberately provoked here rather than waited for:
    /// the critical sections are short and this is unreachable in normal
    /// use, which is exactly why the recovery has to be tested — nothing
    /// else would ever exercise it.
    #[test]
    fn a_poisoned_library_lock_still_serves_the_next_caller() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = Store::open_at(&dir.path().join("library.db")).expect("open");

        // Panic inside a thread while holding the lock. `catch_unwind`
        // keeps the panic from failing the test itself.
        let result = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let _guard = store.lock();
                    panic!("poisoning the lock on purpose");
                })
                .join()
        });
        assert!(result.is_err(), "the thread should have panicked");

        // The recovery under test: the mutex is now poisoned, and the
        // connection behind it is still perfectly usable.
        let tree = store.tree().expect("the library must still be readable");
        assert_eq!(tree.queries.len(), 0);
    }
}
