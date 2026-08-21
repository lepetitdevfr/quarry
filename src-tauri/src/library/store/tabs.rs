use crate::error::AppError;
use crate::library::model::{Tab, TabPin, TableMode, POSITION_GAP};
use crate::library::store::recent::record_closed_in;
use crate::library::store::{new_id, sql_err, Store};
use rusqlite::{named_params, params, Connection, Row};

impl Store {
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
        let position = next_tab_position(&conn)?;
        let id = new_id();

        conn.execute(
            "insert into tabs (id, query_id, scratch_sql, position, is_active, cursor_pos)
             values (:id, :query_id, null, :position, 0, 0)",
            named_params! {
                ":id": id,
                ":query_id": query_id,
                ":position": position,
            },
        )
        .map_err(sql_err)?;

        activate(&conn, &id)?;
        read_tab(&conn, &id)
    }

    /// Point an untitled tab at a query that has just been created from
    /// its text.
    ///
    /// The alternative — close the scratch tab, open one for the query —
    /// was worse in two ways: the close recorded the text in History as
    /// unsaved work, which is precisely what it is not, and the new tab
    /// id made the editor reseed from the database mid-save. Repointing
    /// keeps the tab and its position; only what it is bound to changes.
    ///
    /// Deliberately does not activate the tab: a save routinely lands
    /// after the user has clicked away, because the naming field commits
    /// on blur, and pulling the window back would fight them for the
    /// focus they just moved.
    pub fn attach_query(&self, tab_id: &str, query_id: &str) -> Result<(), AppError> {
        let conn = self.lock();
        conn.execute(
            "update tabs
                set query_id = :query_id, scratch_sql = null, title = null,
                    is_preview = 0
              where id = :id",
            named_params! { ":id": tab_id, ":query_id": query_id },
        )
        .map_err(sql_err)?;
        Ok(())
    }

    /// Open the tab showing one of the app's own records, or focus it
    /// if it is already open.
    ///
    /// One tab per record, never two: they show the same thing, and a
    /// second copy of a list is a second place to look.
    pub fn open_record_tab(&self, record: &str) -> Result<Vec<Tab>, AppError> {
        let conn = self.lock();

        let existing: Option<String> = conn
            .query_row(
                "select id from tabs where record = ?1",
                params![record],
                |r| r.get(0),
            )
            .ok();

        let id = match existing {
            Some(id) => id,
            None => {
                let id = new_id();
                let position = next_tab_position(&conn)?;
                conn.execute(
                    "insert into tabs
                       (id, query_id, scratch_sql, position, is_active, cursor_pos,
                        is_preview, title, record)
                     values (:id, null, null, :position, 0, 0, 0, :title, :record)",
                    named_params! {
                        ":id": id,
                        ":position": position,
                        ":title": record,
                        ":record": record,
                    },
                )
                .map_err(sql_err)?;
                id
            }
        };

        activate(&conn, &id)?;
        drop(conn);
        self.tabs()
    }

    pub fn tabs(&self) -> Result<Vec<Tab>, AppError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(&format!("select {TAB_COLUMNS} from tabs order by position"))
            .map_err(sql_err)?;

        let tabs = stmt
            .query_map([], tab_from_row)
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

        let id = match preview_slot(&conn) {
            Some(id) => {
                conn.execute(
                    "update tabs
                        set title = :title, scratch_sql = :sql, cursor_pos = 0,
                            target_schema = null, target_table = null, mode = null
                      where id = :id",
                    named_params! {
                        ":id": id,
                        ":title": title,
                        ":sql": sql,
                    },
                )
                .map_err(sql_err)?;
                id
            }
            None => {
                let id = new_id();
                let position = next_tab_position(&conn)?;

                conn.execute(
                    "insert into tabs
                       (id, query_id, scratch_sql, position, is_active, cursor_pos,
                        is_preview, title)
                     values (:id, null, :sql, :position, 0, 0, 1, :title)",
                    named_params! {
                        ":id": id,
                        ":sql": sql,
                        ":position": position,
                        ":title": title,
                    },
                )
                .map_err(sql_err)?;
                id
            }
        };

        activate(&conn, &id)?;
        drop(conn);
        self.tabs()
    }

    /// Open a tab targeting a table, reusing the preview slot unless
    /// `pin` is `Pinned`.
    ///
    /// `Pinned` is what a double-click passes: an explicit "keep this
    /// one", so the next single-click in the tree opens elsewhere instead
    /// of overwriting it. The preview slot is shared with query previews,
    /// so this clears `scratch_sql` on the reuse path — otherwise a
    /// table tab would still be carrying the previous preview's SQL —
    /// and `query_id`, so a reused saved-query preview stops pointing at
    /// its query.
    pub fn open_table_tab(
        &self,
        schema: &str,
        table: &str,
        mode: TableMode,
        pin: TabPin,
    ) -> Result<Vec<Tab>, AppError> {
        let conn = self.lock();

        let is_preview = pin.is_preview();

        let id = match preview_slot(&conn) {
            Some(id) => {
                conn.execute(
                    "update tabs
                        set title = :title, target_schema = :schema,
                            target_table = :table, mode = :mode,
                            scratch_sql = null, query_id = null,
                            cursor_pos = 0, is_preview = :is_preview
                      where id = :id",
                    named_params! {
                        ":id": id,
                        ":title": table,
                        ":schema": schema,
                        ":table": table,
                        ":mode": mode.as_str(),
                        ":is_preview": is_preview,
                    },
                )
                .map_err(sql_err)?;
                id
            }
            None => {
                let id = new_id();
                let position = next_tab_position(&conn)?;

                conn.execute(
                    "insert into tabs
                       (id, query_id, scratch_sql, position, is_active, cursor_pos,
                        is_preview, title, target_schema, target_table, mode)
                     values (:id, null, null, :position, 0, 0, :is_preview,
                             :title, :schema, :table, :mode)",
                    named_params! {
                        ":id": id,
                        ":position": position,
                        ":is_preview": is_preview,
                        ":title": table,
                        ":schema": schema,
                        ":table": table,
                        ":mode": mode.as_str(),
                    },
                )
                .map_err(sql_err)?;
                id
            }
        };

        activate(&conn, &id)?;
        // `self.tabs()` takes the same lock this guard holds, so it must
        // be released first or the call would deadlock.
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

    /// Switch a table tab between structure and data.
    ///
    /// Toggling also pins the tab: choosing a face for a specific table
    /// is a deliberate act, so the tab stops being disposable — the same
    /// rule that promotes a query preview on its first edit.
    pub fn set_tab_mode(&self, id: &str, mode: TableMode) -> Result<Vec<Tab>, AppError> {
        // The `self.lock()` guard is a temporary: it lives only to the end
        // of this statement, so it is already released before `self.tabs()`
        // takes the same lock. `promote_tab` above has the same shape.
        self.lock()
            .execute(
                "update tabs set mode = :mode, is_preview = 0 where id = :id",
                named_params! { ":id": id, ":mode": mode.as_str() },
            )
            .map_err(sql_err)?;
        self.tabs()
    }

    pub fn activate_tab(&self, id: &str) -> Result<(), AppError> {
        activate(&self.lock(), id)
    }

    /// Autosave for an untitled tab.
    pub fn save_scratch(&self, id: &str, sql: &str) -> Result<(), AppError> {
        self.lock()
            .execute(
                "update tabs set scratch_sql = :sql where id = :id",
                named_params! { ":id": id, ":sql": sql },
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn set_cursor(&self, id: &str, pos: i64) -> Result<(), AppError> {
        self.lock()
            .execute(
                "update tabs set cursor_pos = ?2 where id = ?1",
                params![id, pos],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Delete a tab. When the closed tab was active and other tabs
    /// remain, activate a neighbour: the one immediately to its left by
    /// `position`, or the leftmost tab if it had none. Runs in a single
    /// transaction so a crash cannot leave zero active tabs while tabs
    /// still exist.
    /// `connection_id` is whatever was live at the time, and is context
    /// rather than provenance: a tab is not bound to a connection, but
    /// the database you were looking at when you closed it is the best
    /// answer to where the text belonged.
    pub fn close_tab(&self, id: &str, connection_id: Option<&str>) -> Result<(), AppError> {
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
            .query_row(
                "select position from tabs where id = ?1",
                params![id],
                |r| r.get(0),
            )
            .ok();

        // What the tab was holding, if losing it would lose anything. A
        // saved query's text lives in `queries`, so closing its tab
        // costs nothing and a `recent` row would duplicate work that was
        // never at risk.
        let keepable: Option<(String, Option<String>)> = tx
            .query_row(
                "select scratch_sql, title from tabs
                 where id = ?1 and query_id is null and scratch_sql is not null",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok()
            // Emptiness is decided in Rust, not in SQL: SQLite's `trim`
            // strips spaces and nothing else, so a tab holding a newline
            // would have counted as work and filled the list with blanks.
            .filter(|(sql, _): &(String, Option<String>)| !sql.trim().is_empty());

        // Inside this transaction on purpose: the kept text and the
        // deletion have to land together or neither, or a crash between
        // them is exactly the loss this exists to prevent.
        if let Some((sql, title)) = keepable {
            record_closed_in(&tx, &sql, connection_id, title.as_deref())?;
        }

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
                    .query_row(
                        "select id from tabs order by position asc limit 1",
                        [],
                        |r| r.get(0),
                    )
                    .ok(),
            };

            if let Some(target_id) = target {
                tx.execute("update tabs set is_active = 0", [])
                    .map_err(sql_err)?;
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
}

/// The one preview slot, if a tab currently holds it.
fn preview_slot(conn: &Connection) -> Option<String> {
    conn.query_row(
        "select id from tabs where is_preview = 1 limit 1",
        [],
        |r| r.get(0),
    )
    .ok()
}

/// One gap past the rightmost tab. Tabs have no parent column, so this
/// is simpler than `next_position`.
fn next_tab_position(conn: &Connection) -> Result<i64, AppError> {
    let max: i64 = conn
        .query_row("select coalesce(max(position), 0) from tabs", [], |r| {
            r.get(0)
        })
        .map_err(sql_err)?;
    Ok(max + POSITION_GAP)
}

/// Make one tab active and clear the flag on every other tab.
///
/// One statement rather than a clear-then-set pair: the pair commits an
/// intermediate state with no tab active, which a crash in the gap would
/// make durable. Here every row's flag is rewritten in the same
/// autocommitted statement, so that state never exists on disk.
fn activate(conn: &Connection, id: &str) -> Result<(), AppError> {
    conn.execute("update tabs set is_active = (id = ?1)", params![id])
        .map_err(sql_err)?;
    Ok(())
}

/// The tab columns. Both places that select a tab share this, so every
/// name `tab_from_row` reads below is guaranteed to be in the result.
const TAB_COLUMNS: &str = "id, query_id, scratch_sql, position, is_active, cursor_pos,
     is_preview, title, target_schema, target_table, mode, record";

fn tab_from_row(row: &Row) -> rusqlite::Result<Tab> {
    // Read out early: whether there is a target decides how a missing
    // mode is filled in below.
    let target_table: Option<String> = row.get("target_table")?;

    Ok(Tab {
        id: row.get("id")?,
        query_id: row.get("query_id")?,
        scratch_sql: row.get("scratch_sql")?,
        position: row.get("position")?,
        is_active: row.get::<_, i64>("is_active")? != 0,
        cursor_pos: row.get("cursor_pos")?,
        is_preview: row.get::<_, i64>("is_preview")? != 0,
        title: row.get("title")?,
        record: row.get("record")?,
        target_schema: row.get("target_schema")?,
        // `mode` is NULL on an ordinary query tab, so the decode only
        // runs when there is actually a mode stored. A tab that DOES
        // have a target but no stored mode is a broken row rather than a
        // real state — `Tab` says the two go together — so rather than
        // hand the UI a target it cannot render, fall back to Structure,
        // which reads the cached schema and runs no SQL.
        mode: match row.get::<_, Option<String>>("mode")? {
            Some(stored) => Some(TableMode::from_stored(&stored)),
            None if target_table.is_some() => Some(TableMode::Structure),
            None => None,
        },
        target_table,
    })
}

fn read_tab(conn: &Connection, id: &str) -> Result<Tab, AppError> {
    conn.query_row(
        &format!("select {TAB_COLUMNS} from tabs where id = ?1"),
        params![id],
        tab_from_row,
    )
    .map_err(sql_err)
}
