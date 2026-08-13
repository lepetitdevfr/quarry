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
    pub row_count: usize,
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

    let started = Instant::now();
    let rows = client.query(sql, &[]).await?;
    let duration_ms = started.elapsed().as_millis() as u64;

    // Column metadata comes from the first row. An empty result still
    // needs headers, so fall back to preparing the statement.
    let columns: Vec<ColumnMeta> = match rows.first() {
        Some(row) => row
            .columns()
            .iter()
            .map(|c| ColumnMeta {
                name: c.name().to_string(),
                type_name: c.type_().name().to_string(),
            })
            .collect(),
        None => {
            let stmt = client.prepare(sql).await?;
            stmt.columns()
                .iter()
                .map(|c| ColumnMeta {
                    name: c.name().to_string(),
                    type_name: c.type_().name().to_string(),
                })
                .collect()
        }
    };

    let converted: Vec<Vec<serde_json::Value>> = rows
        .iter()
        .map(|row| (0..row.len()).map(|i| cell_to_json(row, i)).collect())
        .collect();

    Ok(QueryResult {
        row_count: converted.len(),
        rows: converted,
        columns,
        duration_ms,
    })
}
