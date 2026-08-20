//! Running a write inside a transaction that waits for a decision.
//!
//! The shape exists so the number on screen is the number that gets
//! committed. Counting first and executing afterwards would show a
//! figure from a different moment than the write; running twice would do
//! the same and cost double. Holding the transaction is only safe
//! because Postgres, not this code, enforces the deadline — see
//! `conn::pool::startup_options`.

use crate::edit::decide_editability;
use crate::error::AppError;
use crate::exec::QueryResult;
use crate::guard::plan::{verdict, Verdict, WriteKind};
use crate::library::model::Tag;
use deadpool_postgres::{Object, Pool};

/// A transaction left open, waiting for the user.
pub struct Parked {
    /// Held out of the pool. Dropping it ends the transaction, which is
    /// what makes quitting the app or switching connections safe with
    /// one of these outstanding.
    pub client: Object,
    pub sql: String,
    pub affected: Option<u64>,
}

/// What running a guarded write produced.
pub enum Outcome {
    /// Committed already — indistinguishable from an unguarded run.
    Done(QueryResult),
    /// Waiting for a decision. The caller parks it and shows `summary`.
    Waiting {
        parked: Parked,
        summary: String,
        affected: Option<u64>,
    },
}

/// A result for a statement that returned no rows, only a count.
///
/// The edit verdict is the empty one: there are no columns, so there is
/// nothing on screen to edit, and `decide_editability` says so for us
/// rather than this inventing a second answer.
fn affected_only(affected: Option<u64>, duration_ms: u64) -> QueryResult {
    QueryResult {
        columns: Vec::new(),
        edit: decide_editability(&[], None),
        rows: Vec::new(),
        row_count: 0,
        affected_rows: affected,
        duration_ms,
    }
}

/// Run one write inside a transaction, then ask `verdict` what to do.
///
/// `object` describes what DDL names, from the schema cache; `None` for
/// everything else.
pub async fn run_guarded(
    pool: &Pool,
    sql: &str,
    tag: Tag,
    kind: WriteKind,
    expect: Option<u64>,
    object: Option<&str>,
) -> Result<Outcome, AppError> {
    let client = pool.get().await?;
    let started = std::time::Instant::now();

    // `begin read write` rather than a bare `begin`: on a locked
    // connection the session default is read-only, and the guard has
    // already decided this statement may write.
    client.batch_execute("begin read write").await?;

    let affected = match execute_in_transaction(&client, sql).await {
        Ok(affected) => affected,
        Err(e) => {
            // Leave nothing open on a connection about to go back to the
            // pool.
            let _ = client.batch_execute("rollback").await;
            return Err(e);
        }
    };

    let elapsed = started.elapsed().as_millis() as u64;

    match verdict(tag, kind, affected, expect, object) {
        Verdict::Commit => {
            client.batch_execute("commit").await?;
            Ok(Outcome::Done(affected_only(affected, elapsed)))
        }
        Verdict::Refuse { reason } => {
            let _ = client.batch_execute("rollback").await;
            Err(AppError::Query {
                message: reason,
                code: None,
                position: None,
            })
        }
        Verdict::Ask { summary } => Ok(Outcome::Waiting {
            parked: Parked {
                client,
                sql: sql.to_string(),
                affected,
            },
            summary,
            affected,
        }),
    }
}

/// Execute the statement and report how many rows it touched.
///
/// A write with `RETURNING` reports rows rather than an affected count,
/// so the number of rows returned is the number changed.
async fn execute_in_transaction(client: &Object, sql: &str) -> Result<Option<u64>, AppError> {
    let stmt = client.prepare(sql).await?;
    if stmt.columns().is_empty() {
        Ok(Some(client.execute(&stmt, &[]).await?))
    } else {
        Ok(Some(client.query(&stmt, &[]).await?.len() as u64))
    }
}

/// Finish a parked transaction.
///
/// Postgres may have ended it already — the idle timeout exists exactly
/// so it can — and that is an outcome to report, not a crash. Rolling
/// back reports zero rows affected, because zero is what happened.
pub async fn resolve(parked: Parked, commit: bool) -> Result<QueryResult, AppError> {
    let verb = if commit { "commit" } else { "rollback" };

    match parked.client.batch_execute(verb).await {
        Ok(()) if commit => Ok(affected_only(parked.affected, 0)),
        Ok(()) => Ok(affected_only(Some(0), 0)),
        Err(e) => Err(AppError::Query {
            message: format!("this write was already closed — it did not run ({e})"),
            code: None,
            position: None,
        }),
    }
}
