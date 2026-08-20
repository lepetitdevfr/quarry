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
    /// different queries rather than one repeated forty times. The cost
    /// — the individual timings — is knowingly traded away.
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
            params![
                new_id(),
                sql,
                connection_id,
                stamp,
                duration_ms,
                row_count,
                error
            ],
        )
        .map_err(sql_err)?;
        Ok(())
    }

    /// Record the unsaved text of a tab being closed.
    ///
    /// Identical text against the same connection moves the existing row
    /// forward rather than adding another. Two byte-identical drafts are
    /// indistinguishable, so keeping both preserves nothing — and
    /// without this, recovering a draft from History and closing it
    /// again left a copy behind every time.
    pub fn record_closed(
        &self,
        sql: &str,
        connection_id: Option<&str>,
        title: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self.lock();
        record_closed_in(&conn, sql, connection_id, title)
    }

    /// Every row, newest first.
    ///
    /// Ordering beyond that — the active connection's work first — is
    /// decided in `src/lib/recent.ts`, where it can be tested without a
    /// database and where the filter it shares a screen with lives.
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

/// The insert-or-touch behind `record_closed`, taking a connection so
/// `close_tab` can call it inside the transaction that deletes the tab:
/// the kept text and the deletion have to land together or neither.
///
/// Written as update-then-insert rather than `on conflict`, because the
/// match has to treat two absent connections as the same one and SQLite
/// treats NULLs as distinct in a unique index. `is` is its null-safe
/// comparison.
pub(crate) fn record_closed_in(
    conn: &rusqlite::Connection,
    sql: &str,
    connection_id: Option<&str>,
    title: Option<&str>,
) -> Result<(), AppError> {
    let stamp = now();
    let touched = conn
        .execute(
            "update recent set last_at = ?3, title = coalesce(?4, title)
             where kind = 'closed' and sql = ?1 and connection_id is ?2",
            params![sql, connection_id, stamp, title],
        )
        .map_err(sql_err)?;

    if touched == 0 {
        conn.execute(
            "insert into recent
                (id, kind, sql, connection_id, title, first_at, last_at, run_count)
             values (?1, 'closed', ?2, ?3, ?4, ?5, ?5, 0)",
            params![new_id(), sql, connection_id, title, stamp],
        )
        .map_err(sql_err)?;
    }
    Ok(())
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
