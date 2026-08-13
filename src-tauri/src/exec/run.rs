use crate::error::AppError;
use crate::exec::value::cell_to_json;
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
/// Stage 3 inserts the safety guard immediately above the `query` call.
/// Stage 1 has no policy enforcement — do not connect this to a
/// production database yet.
pub async fn run_query(pool: &Pool, sql: &str) -> Result<QueryResult, AppError> {
    let client = pool.get().await?;

    // Prepare once, up front: this gives us column metadata before
    // running anything, so we know whether the statement returns rows
    // (`SELECT`) or not (`UPDATE`/`INSERT`/`DELETE`/DDL) without a
    // second round-trip, and without ever needing to re-prepare a
    // statement that already executed — which would otherwise let a
    // metadata-only failure be mistaken for the mutation itself failing.
    let stmt = client.prepare(sql).await?;
    let columns: Vec<ColumnMeta> = stmt
        .columns()
        .iter()
        .map(|c| ColumnMeta {
            name: c.name().to_string(),
            type_name: c.type_().name().to_string(),
        })
        .collect();

    let started = Instant::now();

    if columns.is_empty() {
        // No result columns: this is a statement like UPDATE/INSERT/
        // DELETE/DDL, not a SELECT. `query` would report 0 rows
        // regardless of how many were touched; `execute` returns the
        // real affected-row count.
        let affected = client.execute(&stmt, &[]).await?;
        let duration_ms = started.elapsed().as_millis() as u64;
        return Ok(QueryResult {
            columns,
            rows: Vec::new(),
            row_count: 0,
            affected_rows: Some(affected),
            duration_ms,
        });
    }

    let rows = client.query(&stmt, &[]).await?;
    let duration_ms = started.elapsed().as_millis() as u64;

    let converted: Vec<Vec<serde_json::Value>> = rows
        .iter()
        .map(|row| (0..row.len()).map(|i| cell_to_json(row, i)).collect())
        .collect();

    Ok(QueryResult {
        row_count: converted.len(),
        rows: converted,
        columns,
        affected_rows: None,
        duration_ms,
    })
}
