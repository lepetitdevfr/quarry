//! Running generated `UPDATE`s in one transaction.
//!
//! The impure half of the module. Everything it runs was built by
//! `edit::sql`, which is pure and tested separately.

use crate::edit::sql::{Statement, StatementKind};
use crate::error::AppError;
use crate::exec::value::cell_to_json;
use crate::guard::{decide, Decision, Policy};
use deadpool_postgres::Pool;
use serde::Serialize;
use std::time::Instant;
use tokio_postgres::types::ToSql;

/// Decide whether this batch may run, and whether it needs to opt out
/// of the read-only session default.
///
/// Generated `UPDATE`s cross the same chokepoint as everything the user
/// types. The write-guard spec predicted this path: "Inline editing,
/// two stages away, will issue UPDATEs through a path that does not
/// exist yet." This is that path, and it does not get its own rules.
///
/// Pure so it can be tested without a Tauri `State`. The command only
/// carries out what this returns.
pub fn plan_apply(
    policy: Policy,
    unlocked_until: Option<Instant>,
    now: Instant,
    statements: &[Statement],
) -> Result<bool, AppError> {
    // An empty batch is still asked: the gate must not depend on the
    // payload being non-empty.
    let sql = statements
        .iter()
        .map(|s| s.sql.as_str())
        .collect::<Vec<_>>()
        .join(";\n");
    // With no statements there is nothing for the classifier to read,
    // and an empty buffer classifies as a read — which would let a
    // locked connection through. Name the intent instead.
    let sql = if sql.is_empty() {
        "update".to_string()
    } else {
        sql
    };

    match decide(policy, unlocked_until, now, &sql) {
        Decision::Allow { read_write } => Ok(read_write),
        Decision::Deny => Err(AppError::WriteBlocked(
            "this connection is locked — unlock it to edit rows".to_string(),
        )),
    }
}

/// One cell as the database now holds it.
#[derive(Debug, Serialize)]
pub struct AppliedCell {
    pub column: usize,
    pub value: serde_json::Value,
}

/// What one statement did, so the grid can patch that row.
#[derive(Debug, Serialize)]
pub struct AppliedRow {
    pub row: usize,
    pub cells: Vec<AppliedCell>,
    /// What the statement did, so the grid knows whether to patch the
    /// row, drop it, or append it. One field rather than a pair of
    /// flags: "deleted and inserted" must not be representable.
    pub kind: StatementKind,
}

/// Apply every statement in one transaction.
///
/// Each must affect exactly one row. Anything else — zero because the
/// row was deleted, more than one because the key is not what we think
/// it is, or an error from the server — rolls the whole batch back.
/// A partial apply would leave the grid asserting values the database
/// does not hold, which is the worst outcome available here.
///
/// `read_write` mirrors `exec::run_query`: on a read-only connection
/// the session default is `default_transaction_read_only=on`, and an
/// unlocked write has to opt out of it explicitly.
pub async fn apply_edits(
    pool: &Pool,
    statements: &[Statement],
    read_write: bool,
) -> Result<Vec<AppliedRow>, AppError> {
    if statements.is_empty() {
        return Ok(Vec::new());
    }

    let client = pool.get().await?;

    let begin = if read_write {
        "begin read write"
    } else {
        "begin"
    };
    client.batch_execute(begin).await?;

    let mut applied = Vec::new();

    for statement in statements {
        match run_one(&client, statement).await {
            Ok(row) => applied.push(row),
            Err(e) => {
                // Leave no transaction open on the pooled connection:
                // `RecyclingMethod::Clean` would roll it back on
                // return, but not before another checkout could see it.
                // Same reasoning as `exec::run_query`.
                let _ = client.batch_execute("rollback").await;
                return Err(e);
            }
        }
    }

    client.batch_execute("commit").await?;
    Ok(applied)
}

async fn run_one(
    client: &deadpool_postgres::Client,
    statement: &Statement,
) -> Result<AppliedRow, AppError> {
    // `query` wants `&[&(dyn ToSql + Sync)]`, and what we hold is
    // `Vec<Option<String>>`. `Option<String>` implements `ToSql` —
    // `None` binds a real SQL NULL — so this borrows each element and
    // widens it to a trait object. The intermediate `Vec` has to exist
    // as a named binding: building it inline would drop it while the
    // slice still borrowed from it.
    let params: Vec<&(dyn ToSql + Sync)> = statement
        .params
        .iter()
        .map(|p| p as &(dyn ToSql + Sync))
        .collect();

    let rows = client.query(&statement.sql, &params).await?;

    if rows.len() != 1 {
        return Err(AppError::Query {
            message: format!(
                "row {} no longer matches one row in the table — it was changed or deleted \
                 by someone else. Nothing was applied.",
                statement.row + 1
            ),
            code: None,
            position: None,
        });
    }

    let cells = match statement.kind {
        // A delete's RETURNING carries its key, not display data, and
        // the row it named is about to leave the grid. Collecting cells
        // from it would hand the frontend values to patch into a row
        // that is gone.
        StatementKind::Delete => Vec::new(),
        _ => statement
            .returned
            .iter()
            .enumerate()
            .map(|(i, column)| AppliedCell {
                column: *column,
                value: cell_to_json(&rows[0], i),
            })
            .collect(),
    };

    Ok(AppliedRow {
        row: statement.row,
        cells,
        kind: statement.kind,
    })
}
