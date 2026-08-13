use crate::error::AppError;
use crate::library::db;
use crate::library::model::{Collection, LibraryTree, Query, POSITION_GAP};
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
