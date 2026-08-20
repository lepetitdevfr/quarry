use crate::error::AppError;
use crate::library::model::{WriteEntry, WriteRecord};
use crate::library::store::{new_id, now, sql_err, Store};
use rusqlite::{params, Row};

impl Store {
    /// Record one write.
    ///
    /// Never collapses, and nothing removes it. That is the whole
    /// difference between this and `recent`: there, a repeated statement
    /// is the same query run again; here, it is a second thing that
    /// happened to a database.
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
