use crate::edit::{cast_target, decide_editability, EditInfo, SourceColumn};
use crate::error::AppError;
use crate::exec::value::cell_to_json;
use crate::schema::lookup_table;
use deadpool_postgres::Pool;
use serde::Serialize;
use std::time::Instant;

/// One column's identity, as shown in the grid header.
#[derive(Debug, Clone, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
}

/// A complete result set. Rows are positional to keep the payload small:
/// column names live once in `columns`, not repeated per row.
#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    /// Whether this result can be edited in the grid, and why not when
    /// it cannot. Decided in Rust so the frontend never has to.
    pub edit: EditInfo,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// Rows returned, e.g. by a `SELECT`. Always 0 for a statement with
    /// no result columns (see `affected_rows`).
    pub row_count: usize,
    /// Rows touched by a statement with no result columns, e.g. an
    /// `UPDATE`, `INSERT`, or `DELETE` — from `client.execute`'s return
    /// value. `None` for a statement that returns rows, where
    /// `row_count` is the meaningful number instead.
    pub affected_rows: Option<u64>,
    pub duration_ms: u64,
}

/// Run one SQL statement and collect every row.
///
/// The server-side statement timeout is set once per physical
/// connection (see `conn::pool::build_pool`), not per query here — a
/// runaway query is still killed by Postgres even if the UI never sends
/// a cancel.
///
/// The guard decides `read_write` before this is called; this function
/// only carries it out. See `guard::decide`.
pub async fn run_query(pool: &Pool, sql: &str, read_write: bool) -> Result<QueryResult, AppError> {
    let client = pool.get().await?;

    // On a read-only connection the guard has decided this statement may
    // write, so opt this one transaction out of the session default.
    // Anything that does not need it stays read-only, which keeps the
    // second layer armed for every other path.
    if read_write {
        client.batch_execute("begin read write").await?;
    }

    // Prepare once, up front: this gives us column metadata before
    // running anything, so we know whether the statement returns rows
    // (`SELECT`) or not (`UPDATE`/`INSERT`/`DELETE`/DDL) without a
    // second round-trip, and without ever needing to re-prepare a
    // statement that already executed — which would otherwise let a
    // metadata-only failure be mistaken for the mutation itself failing.
    let stmt = match client.prepare(sql).await {
        Ok(stmt) => stmt,
        Err(e) => {
            // Leave no transaction open on the pooled connection.
            // `RecyclingMethod::Clean` would roll it back on return, but
            // not before another checkout could see it.
            if read_write {
                let _ = client.batch_execute("rollback").await;
            }
            return Err(e.into());
        }
    };
    let columns: Vec<ColumnMeta> = stmt
        .columns()
        .iter()
        .map(|c| ColumnMeta {
            name: c.name().to_string(),
            type_name: friendly_type_name(c.type_()),
        })
        .collect();

    // What Postgres said about where each column came from. `table_oid`
    // and `attnum` are empty for expressions and aggregates — that is
    // the server telling us the column has no row to update, which is
    // more reliable than parsing the SQL back.
    let sources: Vec<SourceColumn> = stmt
        .columns()
        .iter()
        .map(|c| SourceColumn {
            table_oid: c.table_oid(),
            attnum: c.column_id(),
            cast_type: cast_target(c.type_()),
        })
        .collect();

    // One catalog round-trip, and only when every sourced column agrees
    // on one table. A join or an aggregate is refused from the metadata
    // alone and pays nothing.
    let mut oids: Vec<u32> = sources.iter().filter_map(|s| s.table_oid).collect();
    oids.sort_unstable();
    oids.dedup();
    let facts = if oids.len() == 1 {
        // A failed lookup is not a failed query: the rows are fine,
        // they just cannot be edited. `decide_editability` turns `None`
        // into the right refusal.
        lookup_table(pool, oids[0]).await.unwrap_or(None)
    } else {
        None
    };

    let edit = decide_editability(&sources, facts.as_ref());

    let started = Instant::now();

    if columns.is_empty() {
        // No result columns: this is a statement like UPDATE/INSERT/
        // DELETE/DDL, not a SELECT. `query` would report 0 rows
        // regardless of how many were touched; `execute` returns the
        // real affected-row count.
        let affected = match client.execute(&stmt, &[]).await {
            Ok(affected) => affected,
            Err(e) => {
                // Leave no transaction open on the pooled connection.
                // `RecyclingMethod::Clean` would roll it back on return,
                // but not before another checkout could see it.
                if read_write {
                    let _ = client.batch_execute("rollback").await;
                }
                return Err(e.into());
            }
        };
        if read_write {
            client.batch_execute("commit").await?;
        }
        let duration_ms = started.elapsed().as_millis() as u64;
        return Ok(QueryResult {
            columns,
            edit,
            rows: Vec::new(),
            row_count: 0,
            affected_rows: Some(affected),
            duration_ms,
        });
    }

    let rows = match client.query(&stmt, &[]).await {
        Ok(rows) => rows,
        Err(e) => {
            if read_write {
                let _ = client.batch_execute("rollback").await;
            }
            return Err(e.into());
        }
    };
    if read_write {
        client.batch_execute("commit").await?;
    }
    let duration_ms = started.elapsed().as_millis() as u64;

    let converted: Vec<Vec<serde_json::Value>> = rows
        .iter()
        .map(|row| (0..row.len()).map(|i| cell_to_json(row, i)).collect())
        .collect();

    Ok(QueryResult {
        row_count: converted.len(),
        rows: converted,
        columns,
        edit,
        affected_rows: None,
        duration_ms,
    })
}

/// How a type should be spelled in a column header.
///
/// `Type::name()` returns Postgres's internal spelling, which for an
/// array is the element type prefixed with an underscore: `_text`. No
/// user writes that, and the schema tree already shows `text[]` via
/// `format_type`, so the grid would otherwise disagree with the sidebar
/// about the same column.
pub fn friendly_type_name(t: &tokio_postgres::types::Type) -> String {
    match t.kind() {
        tokio_postgres::types::Kind::Array(inner) => format!("{}[]", inner.name()),
        _ => t.name().to_string(),
    }
}
