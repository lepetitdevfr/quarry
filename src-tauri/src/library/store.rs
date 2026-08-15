use crate::error::AppError;
use crate::library::db;
use crate::library::mirror;
use crate::library::model::{Collection, LibraryTree, Query, Tab, TableMode, POSITION_GAP};
use crate::library::paths;
use rusqlite::{params, Connection, Row};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// All library reads and writes go through here.
///
/// The `Mutex` exists because Tauri commands run on multiple threads
/// and a `rusqlite::Connection` cannot be shared across them. SQLite
/// calls are microseconds, so a single lock is not a bottleneck.
pub struct Store {
    conn: Mutex<Connection>,
    mirror_root: PathBuf,
}

impl Store {
    /// Open the real database in the app support directory.
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

    /// Open a database at an explicit path with an explicit mirror
    /// root. Tests use this with a temp directory so they never touch
    /// the developer's real library.
    pub fn open_at_with_mirror(path: &Path, mirror_root: &Path) -> Result<Self, AppError> {
        Ok(Store {
            conn: Mutex::new(db::open(path)?),
            mirror_root: mirror_root.to_path_buf(),
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
                r.get::<_, i64>(0)
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
                "select id, query_id, scratch_sql, position, is_active, cursor_pos,
                        is_preview, title, target_schema, target_table, mode
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
                    is_preview: row.get::<_, i64>(6)? != 0,
                    title: row.get(7)?,
                    target_schema: row.get(8)?,
                    target_table: row.get(9)?,
                    mode: row
                        .get::<_, Option<String>>(10)?
                        .as_deref()
                        .map(TableMode::from_stored),
                })
            })
            .map_err(sql_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_err)?;

        Ok(tabs)
    }

    /// Open a table preview, reusing the existing preview slot if there
    /// is one.
    ///
    /// This is why previews do not pile up: double-clicking ten tables
    /// leaves one tab, not ten. A preview that has been promoted (the
    /// user edited it) is an ordinary tab and is never reused here.
    pub fn open_preview_tab(&self, title: &str, sql: &str) -> Result<Vec<Tab>, AppError> {
        let conn = self.lock();

        let existing: Option<String> = conn
            .query_row("select id from tabs where is_preview = 1 limit 1", [], |r| {
                r.get(0)
            })
            .ok();

        let id = match existing {
            Some(id) => {
                conn.execute(
                    "update tabs set title = ?2, scratch_sql = ?3, cursor_pos = 0
                     where id = ?1",
                    params![id, title, sql],
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
                        is_preview, title)
                     values (?1, null, ?2, ?3, 0, 0, 1, ?4)",
                    params![id, sql, position, title],
                )
                .map_err(sql_err)?;
                id
            }
        };

        activate(&conn, &id)?;
        drop(conn);
        self.tabs()
    }

    /// Turn a preview into an ordinary tab.
    ///
    /// Called on the first edit: once there is work in a tab, the next
    /// preview must open elsewhere rather than overwriting it.
    pub fn promote_tab(&self, id: &str) -> Result<(), AppError> {
        self.lock()
            .execute("update tabs set is_preview = 0 where id = ?1", params![id])
            .map_err(sql_err)?;
        Ok(())
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

    /// Delete a tab. When the closed tab was active and other tabs
    /// remain, activate a neighbour: the one immediately to its left by
    /// `position`, or the leftmost tab if it had none. Runs in a single
    /// transaction so a crash cannot leave zero active tabs while tabs
    /// still exist.
    pub fn close_tab(&self, id: &str) -> Result<(), AppError> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(sql_err)?;

        let was_active: Option<i64> = tx
            .query_row(
                "select is_active from tabs where id = ?1",
                params![id],
                |r| r.get(0),
            )
            .ok();

        let position: Option<i64> = tx
            .query_row("select position from tabs where id = ?1", params![id], |r| {
                r.get(0)
            })
            .ok();

        tx.execute("delete from tabs where id = ?1", params![id])
            .map_err(sql_err)?;

        if was_active == Some(1) {
            let neighbour: Option<String> = if let Some(pos) = position {
                tx.query_row(
                    "select id from tabs where position < ?1 order by position desc limit 1",
                    params![pos],
                    |r| r.get(0),
                )
                .ok()
            } else {
                None
            };

            let target = match neighbour {
                Some(id) => Some(id),
                None => tx
                    .query_row("select id from tabs order by position asc limit 1", [], |r| {
                        r.get(0)
                    })
                    .ok(),
            };

            if let Some(target_id) = target {
                tx.execute("update tabs set is_active = 0", []).map_err(sql_err)?;
                tx.execute(
                    "update tabs set is_active = 1 where id = ?1",
                    params![target_id],
                )
                .map_err(sql_err)?;
            }
        }

        tx.commit().map_err(sql_err)?;
        Ok(())
    }

    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("library lock poisoned")
    }
}

// ---- helpers ---------------------------------------------------------

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
        "select id, query_id, scratch_sql, position, is_active, cursor_pos,
                is_preview, title, target_schema, target_table, mode
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
                is_preview: row.get::<_, i64>(6)? != 0,
                title: row.get(7)?,
                target_schema: row.get(8)?,
                target_table: row.get(9)?,
                mode: row
                    .get::<_, Option<String>>(10)?
                    .as_deref()
                    .map(TableMode::from_stored),
            })
        },
    )
    .map_err(sql_err)
}
