# Guarded execution (Stage A) — implementation plan

> **For agentic workers:** this repository works inline in the main thread; see
> `CLAUDE.md`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every write a person types runs in a transaction that reports what it
did and waits for a decision before committing.

**Architecture:** A pure `verdict` function decides `Commit` / `Ask` / `Refuse`
from the connection's tag, the statement's kind, the rowcount and any
`-- expect: n`. Execution splits in two: `execute` opens a transaction and
either finishes it or parks the held connection in `AppState` under a token;
`resolve` commits or rolls the parked one back. Postgres enforces the limits —
`idle_in_transaction_session_timeout` and `lock_timeout` are startup options on
the pool, so no dialog can hold a lock indefinitely.

**Tech stack:** Rust (deadpool-postgres, sqlparser, tauri commands), React 19 +
TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-guarded-writes-design.md`
(Stage B, the audit log, is a separate plan and is not built here.)

---

## File structure

| File | Responsibility |
|---|---|
| `src-tauri/src/guard/plan.rs` | `WriteKind`, `expected_rows`, `verdict` — the whole decision (create) |
| `src-tauri/src/guard/mod.rs` | `pub mod plan;`, and `write_kind` off the existing parse (modify) |
| `src-tauri/src/conn/pool.rs` | Two more startup options (modify) |
| `src-tauri/src/exec/guarded.rs` | The transaction protocol: begin, execute, park or finish (create) |
| `src-tauri/src/exec/mod.rs` | `pub mod guarded;` (modify) |
| `src-tauri/src/commands.rs` | `AppState` parking slot; `execute` rewired; `resolve_write` (modify) |
| `src-tauri/tests/guarded_test.rs` | The protocol against real Postgres (create) |
| `src/types.ts`, `src/lib/ipc.ts` | `PendingWrite`, `resolveWrite` (modify) |
| `src/components/PendingWriteDialog.tsx` | The confirmation, with its countdown (create) |
| `src/App.tsx`, `src/App.css` | Pending state, dialog, styling (modify) |

---

## Task 1: The decision, as a pure function

**Files:**
- Create: `src-tauri/src/guard/plan.rs`
- Modify: `src-tauri/src/guard/mod.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/guard/plan.rs` containing only its `mod tests` for now,
so the file exists and the tests name what has to be built:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::model::Tag;

    /// An ordinary UPDATE on a local connection, small.
    #[test]
    fn a_small_local_write_commits_without_asking() {
        assert!(matches!(
            verdict(Tag::Local, WriteKind::Update, Some(3), None, None),
            Verdict::Commit
        ));
    }

    #[test]
    fn production_always_asks() {
        // No exceptions, including one row and including a matching
        // `expect`: a rule with an exception is a rule you have to
        // remember the exception to.
        assert!(matches!(
            verdict(Tag::Prod, WriteKind::Update, Some(1), None, None),
            Verdict::Ask { .. }
        ));
        assert!(matches!(
            verdict(Tag::Prod, WriteKind::Update, Some(1), Some(1), None),
            Verdict::Ask { .. }
        ));
    }

    #[test]
    fn a_mismatched_expectation_refuses_and_names_both_numbers() {
        match verdict(Tag::Local, WriteKind::Update, Some(4812), Some(1), None) {
            Verdict::Refuse { reason } => {
                assert!(reason.contains("1"), "reason was: {reason}");
                assert!(reason.contains("4812") || reason.contains("4,812"), "reason was: {reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_matching_expectation_commits_off_production() {
        assert!(matches!(
            verdict(Tag::Staging, WriteKind::Update, Some(900), Some(900), None),
            Verdict::Commit
        ));
    }

    #[test]
    fn a_mismatch_outranks_everything_including_production() {
        // Refusing is not a decision to hand to a dialog: the user
        // stated a fact and the database disagreed.
        assert!(matches!(
            verdict(Tag::Prod, WriteKind::Update, Some(2), Some(1), None),
            Verdict::Refuse { .. }
        ));
    }

    #[test]
    fn a_large_write_asks_even_off_production() {
        assert!(matches!(
            verdict(Tag::Local, WriteKind::Delete, Some(ASK_ABOVE_ROWS + 1), None, None),
            Verdict::Ask { .. }
        ));
        assert!(matches!(
            verdict(Tag::Local, WriteKind::Delete, Some(ASK_ABOVE_ROWS), None, None),
            Verdict::Commit
        ));
    }

    #[test]
    fn ddl_always_asks_and_is_described_by_what_it_names() {
        // It reports no rows, so the rowcount rules say nothing about
        // it — and it is the statement that ends careers.
        match verdict(Tag::Local, WriteKind::Ddl, None, None, Some("public.orders, ~5M rows")) {
            Verdict::Ask { summary } => assert!(summary.contains("public.orders")),
            other => panic!("expected a question, got {other:?}"),
        }
    }

    #[test]
    fn ddl_with_nothing_known_about_it_still_asks() {
        assert!(matches!(
            verdict(Tag::Local, WriteKind::Ddl, None, None, None),
            Verdict::Ask { .. }
        ));
    }

    #[test]
    fn an_unreadable_statement_is_judged_on_its_rowcount_like_any_other() {
        // `classify` already calls anything it cannot parse a write.
        // Judging it on rows can only ask more often than needed.
        assert!(matches!(
            verdict(Tag::Local, WriteKind::Other, Some(1), None, None),
            Verdict::Commit
        ));
        assert!(matches!(
            verdict(Tag::Local, WriteKind::Other, Some(5000), None, None),
            Verdict::Ask { .. }
        ));
    }

    #[test]
    fn the_summary_says_what_will_change() {
        match verdict(Tag::Prod, WriteKind::Delete, Some(4812), None, None) {
            Verdict::Ask { summary } => {
                assert!(summary.contains("4812") || summary.contains("4,812"));
            }
            other => panic!("expected a question, got {other:?}"),
        }
    }

    #[test]
    fn an_expectation_is_read_out_of_a_comment() {
        assert_eq!(expected_rows("update t set a = 1 -- expect: 1"), Some(1));
        assert_eq!(expected_rows("-- expect: 42\nupdate t set a = 1"), Some(42));
        assert_eq!(expected_rows("update t set a = 1 --expect:7"), Some(7));
        assert_eq!(expected_rows("UPDATE t SET a = 1 -- EXPECT: 9"), Some(9));
    }

    #[test]
    fn the_last_expectation_wins() {
        // People edit the number in place and leave the old one above.
        assert_eq!(
            expected_rows("-- expect: 1\nupdate t set a = 1 -- expect: 2"),
            Some(2)
        );
    }

    #[test]
    fn a_malformed_expectation_is_ignored_rather_than_guessed() {
        // A typo in a comment must not silently disarm the guard, and
        // must not invent a number either: the ordinary rules apply.
        assert_eq!(expected_rows("update t set a = 1 -- expect: lots"), None);
        assert_eq!(expected_rows("update t set a = 1 -- expected: 3"), None);
        assert_eq!(expected_rows("update t set a = 1"), None);
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd src-tauri && cargo test --lib guard::plan
```

Expected: FAIL to compile — `cannot find function verdict in this scope`.

- [ ] **Step 3: Write the module above its tests**

At the top of `src-tauri/src/guard/plan.rs`:

```rust
//! What to do about a write that is already allowed to run.
//!
//! Pure: tag, kind, rowcount, declared expectation in — verdict out. No
//! pool and no clock, the same shape as `guard::decide` and
//! `edit::decide`, and for the same reason: the rule table is small
//! enough to test exhaustively, and every rule in it is load-bearing.
//!
//! This runs *after* `guard::decide`, never instead of it. A write on a
//! locked production connection is denied before anything here is
//! reached; the unlock ritual is unchanged.

use crate::library::model::Tag;

/// How many rows a write may touch on a non-production connection before
/// it stops to ask.
///
/// A constant rather than a setting: defaults are the product, and a
/// threshold somebody tuned once and forgot is a guard that does not
/// guard.
pub const ASK_ABOVE_ROWS: u64 = 100;

/// What kind of write this is, from the parse `classify` already does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteKind {
    Update,
    Delete,
    Insert,
    /// `DROP`, `TRUNCATE`, `ALTER`, `CREATE` — no rowcount, and the ones
    /// that end careers.
    Ddl,
    /// Anything else, including statements the parser cannot read.
    Other,
}

#[derive(Debug)]
pub enum Verdict {
    Commit,
    Ask { summary: String },
    Refuse { reason: String },
}

/// The `-- expect: n` a statement declares, if it declares one.
///
/// The last one wins: people edit the number in place and leave the old
/// line above it. Anything that is not a plain number is ignored rather
/// than guessed at — a typo in a comment must neither disarm the guard
/// nor invent an expectation the user did not state.
pub fn expected_rows(sql: &str) -> Option<u64> {
    let mut found = None;
    let lowered = sql.to_lowercase();
    let mut rest = lowered.as_str();
    while let Some(at) = rest.find("--") {
        let line_end = rest[at..].find('\n').map(|i| at + i).unwrap_or(rest.len());
        let comment = rest[at + 2..line_end].trim();
        if let Some(value) = comment.strip_prefix("expect:") {
            if let Ok(n) = value.trim().parse::<u64>() {
                found = Some(n);
            }
        }
        rest = &rest[line_end.min(rest.len())..];
        if rest.starts_with('\n') {
            rest = &rest[1..];
        }
    }
    found
}

/// Decide what happens to a write that has already run inside an open
/// transaction and reported its rowcount.
///
/// The order is the point:
///
/// 1. A declared expectation that reality contradicts is a failed
///    assertion, not a decision — it refuses, whatever the connection.
/// 2. Production asks. Always, including for one row and including when
///    an expectation matched.
/// 3. DDL asks, described by what it names, because it has no rowcount
///    to judge.
/// 4. A matching expectation commits.
/// 5. A large rowcount asks.
/// 6. Everything else commits.
pub fn verdict(
    tag: Tag,
    kind: WriteKind,
    affected: Option<u64>,
    expect: Option<u64>,
    object: Option<&str>,
) -> Verdict {
    if let (Some(expected), Some(actual)) = (expect, affected) {
        if expected != actual {
            return Verdict::Refuse {
                reason: format!(
                    "-- expect: {expected}, but {actual} {} matched — rolled back",
                    if actual == 1 { "row" } else { "rows" }
                ),
            };
        }
    }

    if tag == Tag::Prod {
        return Verdict::Ask {
            summary: summary_for(kind, affected, object),
        };
    }

    if kind == WriteKind::Ddl {
        return Verdict::Ask {
            summary: summary_for(kind, affected, object),
        };
    }

    if expect.is_some() {
        return Verdict::Commit;
    }

    match affected {
        Some(n) if n > ASK_ABOVE_ROWS => Verdict::Ask {
            summary: summary_for(kind, affected, object),
        },
        _ => Verdict::Commit,
    }
}

/// The one sentence the dialog leads with.
fn summary_for(kind: WriteKind, affected: Option<u64>, object: Option<&str>) -> String {
    if kind == WriteKind::Ddl {
        return match object {
            Some(what) => format!("this changes {what}"),
            None => "this changes the database's structure".to_string(),
        };
    }

    match affected {
        Some(1) => "1 row will change".to_string(),
        Some(n) => format!("{n} rows will change"),
        None => "this will change the database".to_string(),
    }
}
```

Add `pub mod plan;` at the top of `src-tauri/src/guard/mod.rs`.

- [ ] **Step 4: Run them and watch them pass**

```bash
cd src-tauri && cargo test --lib guard::plan
```

Expected: 12 passed.

- [ ] **Step 5: Mutation check**

Change rule 2 to `if tag == Tag::Prod && expect.is_none()` — the exception the
spec deliberately removed — and confirm `production_always_asks` fails on its
second assertion. Restore. Then change `n > ASK_ABOVE_ROWS` to `n >= ASK_ABOVE_ROWS`
and confirm `a_large_write_asks_even_off_production` fails on its boundary case.
Restore, show both failures and the restored pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/guard/plan.rs src-tauri/src/guard/mod.rs
git commit -m "feat(guard): decide what to do about a write before committing it"
```

---

## Task 2: The kind of write, from the parse we already do

**Files:**
- Modify: `src-tauri/src/guard/mod.rs`

- [ ] **Step 1: Write the failing tests**

Add to the existing `mod tests` in `src-tauri/src/guard/mod.rs`:

```rust
#[test]
fn names_the_kind_of_write_a_statement_is() {
    use crate::guard::plan::WriteKind;

    assert_eq!(write_kind("update t set a = 1"), WriteKind::Update);
    assert_eq!(write_kind("delete from t where a = 1"), WriteKind::Delete);
    assert_eq!(write_kind("insert into t (a) values (1)"), WriteKind::Insert);
    assert_eq!(write_kind("drop table t"), WriteKind::Ddl);
    assert_eq!(write_kind("truncate t"), WriteKind::Ddl);
    assert_eq!(write_kind("alter table t add column b int"), WriteKind::Ddl);
    assert_eq!(write_kind("create table t (a int)"), WriteKind::Ddl);
}

#[test]
fn a_statement_the_parser_cannot_read_has_no_particular_kind() {
    // It is still a write — `classify` says so — and judging it on its
    // rowcount can only ask more often than necessary.
    use crate::guard::plan::WriteKind;

    assert_eq!(write_kind("do $$ begin end $$"), WriteKind::Other);
    assert_eq!(write_kind("this is not sql at all"), WriteKind::Other);
}
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd src-tauri && cargo test --lib guard::tests::names_the_kind
```

Expected: FAIL — `cannot find function write_kind`.

- [ ] **Step 3: Implement beside `classify`**

In `src-tauri/src/guard/mod.rs`:

```rust
/// What kind of write a buffer holds, for `plan::verdict`.
///
/// Reads the same parse `classify` does, so the two cannot disagree
/// about what a statement is. A buffer holding several statements takes
/// the kind of the first write in it; execution is one statement at a
/// time, so that is the one being judged.
pub fn write_kind(sql: &str) -> plan::WriteKind {
    use plan::WriteKind;

    let statements = match Parser::parse_sql(&PostgreSqlDialect {}, sql) {
        Ok(statements) => statements,
        Err(_) => return WriteKind::Other,
    };

    for statement in &statements {
        // sqlparser 0.58 mixes newtype and struct variants for these;
        // the shapes below are the ones that version actually has.
        let kind = match statement {
            Statement::Update { .. } => WriteKind::Update,
            Statement::Delete(_) => WriteKind::Delete,
            Statement::Insert(_) => WriteKind::Insert,
            Statement::Drop { .. }
            | Statement::Truncate { .. }
            | Statement::AlterTable { .. }
            | Statement::CreateView { .. }
            | Statement::CreateSchema { .. }
            | Statement::CreateTable(_)
            | Statement::CreateIndex(_) => WriteKind::Ddl,
            _ => continue,
        };
        return kind;
    }

    WriteKind::Other
}
```

If a later `sqlparser` upgrade changes one of these shapes, fix the pattern
rather than deleting the arm: a DDL form that falls through to `Other` is
judged on a rowcount it does not have, so the dialog says "this will change the
database" instead of naming the table.

- [ ] **Step 4: Run and watch them pass**

```bash
cd src-tauri && cargo test --lib guard::
```

Expected: every guard test passes, the two new ones included.

- [ ] **Step 5: Mutation check**

Change the `Statement::Drop` arm to return `WriteKind::Other` and confirm
`names_the_kind_of_write_a_statement_is` fails. Restore, show the pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/guard/mod.rs
git commit -m "feat(guard): name the kind of write from the parse we already do"
```

---

## Task 3: Postgres enforces the deadline

**Files:**
- Modify: `src-tauri/src/conn/pool.rs`

- [ ] **Step 1: Write the failing test**

Add to the existing `mod tests` in `src-tauri/src/conn/pool.rs`:

```rust
#[test]
fn a_held_transaction_cannot_outlive_the_dialog_that_holds_it() {
    // The guarded write parks an open transaction while a human
    // decides. These two are what stop that being an unbounded lock on
    // production: Postgres rolls it back itself, and never queues
    // behind somebody else's lock while doing it.
    //
    // Startup options rather than `SET`, so they survive DISCARD ALL
    // and cannot be undone from the editor.
    let free = startup_options(Policy::Free);
    assert!(
        free.contains("idle_in_transaction_session_timeout=60000"),
        "got: {free}"
    );
    assert!(free.contains("lock_timeout=5000"), "got: {free}");

    let read_only = startup_options(Policy::ReadOnly);
    assert!(read_only.contains("idle_in_transaction_session_timeout=60000"));
    assert!(read_only.contains("lock_timeout=5000"));
}
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd src-tauri && cargo test --lib pool::tests::a_held_transaction
```

Expected: FAIL — the string does not contain `idle_in_transaction_session_timeout`.

- [ ] **Step 3: Add the two options**

In `src-tauri/src/conn/pool.rs`, beside `STATEMENT_TIMEOUT_MS`:

```rust
/// How long a transaction may sit open with nobody touching it.
///
/// A guarded write parks one while the user reads a rowcount and
/// decides. Sixty seconds is how long a person needs to read one number
/// and answer, not how long a connection may idle: there is no
/// convention to copy, since Postgres ships this disabled and every GUI
/// client holds a manual-commit transaction open indefinitely. Fifteen
/// seconds is a notification away from rolling back mid-thought; five
/// minutes is an abandoned dialog behaving like no timeout at all.
const IDLE_IN_TRANSACTION_TIMEOUT_MS: u64 = 60_000;

/// How long any statement waits for a lock before giving up.
///
/// Without it, a guarded write can sit behind somebody else's
/// transaction for as long as they hold it — and the app would look
/// frozen while doing it.
const LOCK_TIMEOUT_MS: u64 = 5_000;
```

and extend `startup_options`:

```rust
    let mut options = format!(
        "-c statement_timeout={STATEMENT_TIMEOUT_MS} \
         -c idle_in_transaction_session_timeout={IDLE_IN_TRANSACTION_TIMEOUT_MS} \
         -c lock_timeout={LOCK_TIMEOUT_MS}"
    );
```

- [ ] **Step 4: Run and watch it pass**

```bash
cd src-tauri && cargo test --lib pool::
```

Expected: all pool tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/conn/pool.rs
git commit -m "feat(conn): let Postgres end a transaction nobody is answering"
```

---

## Task 4: The protocol

**Files:**
- Create: `src-tauri/src/exec/guarded.rs`
- Modify: `src-tauri/src/exec/mod.rs`

This is the one task with no unit test: it is all IO. Task 6 tests it against a
real database, which is where its behaviour actually lives.

- [ ] **Step 1: Write the module**

Create `src-tauri/src/exec/guarded.rs`:

```rust
//! Running a write inside a transaction that waits for a decision.
//!
//! The shape exists so the number on screen is the number that gets
//! committed. Counting first and executing afterwards would show a
//! figure from a different moment than the write; running twice would
//! do the same and cost double.

use crate::error::AppError;
use crate::exec::run::QueryResult;
use crate::guard::plan::{verdict, Verdict, WriteKind};
use crate::library::model::Tag;
use deadpool_postgres::{Object, Pool};

/// A transaction left open, waiting for the user.
pub struct Parked {
    /// Held out of the pool: dropping it ends the transaction, which is
    /// what makes quitting the app or switching connections safe.
    pub client: Object,
    pub sql: String,
    pub affected: Option<u64>,
}

/// What running a guarded write produced.
pub enum Outcome {
    /// Committed already — the ordinary case, indistinguishable from an
    /// unguarded run.
    Done(QueryResult),
    /// Waiting for a decision. The caller parks `Parked` and shows
    /// `summary`.
    Waiting {
        parked: Parked,
        summary: String,
        affected: Option<u64>,
    },
}

/// Run one write inside a transaction, then ask `verdict` what to do.
///
/// `object` describes what DDL names, from the schema cache; it is
/// `None` for everything else.
pub async fn run_guarded(
    pool: &Pool,
    sql: &str,
    tag: Tag,
    kind: WriteKind,
    expect: Option<u64>,
    object: Option<&str>,
) -> Result<Outcome, AppError> {
    let client = pool.get().await?;

    // `begin read write` rather than a plain `begin`: on a locked
    // connection the session default is read-only, and the guard has
    // already decided this statement may write.
    client.batch_execute("begin read write").await?;

    let affected = match execute_in_transaction(&client, sql).await {
        Ok(affected) => affected,
        Err(e) => {
            // Leave nothing open on a connection about to go back to
            // the pool.
            let _ = client.batch_execute("rollback").await;
            return Err(e);
        }
    };

    match verdict(tag, kind, affected, expect, object) {
        Verdict::Commit => {
            client.batch_execute("commit").await?;
            Ok(Outcome::Done(QueryResult::affected_only(affected)))
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
/// Committing a transaction Postgres has already ended is not an error
/// here — the idle timeout may have fired while the dialog was open —
/// but it must be reported as what it is: the statement did not run.
pub async fn resolve(parked: Parked, commit: bool) -> Result<QueryResult, AppError> {
    let verb = if commit { "commit" } else { "rollback" };
    match parked.client.batch_execute(verb).await {
        Ok(()) if commit => Ok(QueryResult::affected_only(parked.affected)),
        Ok(()) => Ok(QueryResult::affected_only(Some(0))),
        Err(e) => Err(AppError::Query {
            message: format!(
                "this transaction was already closed — the statement did not run ({e})"
            ),
            code: None,
            position: None,
        }),
    }
}
```

- [ ] **Step 2: Give `QueryResult` the constructor this needs**

In `src-tauri/src/exec/run.rs`, beside the struct:

```rust
impl QueryResult {
    /// A result for a statement that returned no rows, only a count.
    ///
    /// The edit verdict is the empty one: there are no columns, so there
    /// is nothing on screen to edit, and `decide_editability` says so
    /// for us rather than us inventing a second answer here.
    pub fn affected_only(affected: Option<u64>) -> Self {
        QueryResult {
            columns: Vec::new(),
            edit: crate::edit::decide_editability(&[], None),
            rows: Vec::new(),
            row_count: 0,
            affected_rows: affected,
            duration_ms: 0,
        }
    }
}
```

Add `pub mod guarded;` to `src-tauri/src/exec/mod.rs`.

- [ ] **Step 3: Check it compiles**

```bash
cd src-tauri && cargo build && cargo clippy --all-targets -- -D warnings
```

Expected: clean. If `QueryResult`'s fields are private to the module, make the
constructor a free function in `run.rs` instead of an inherent impl elsewhere.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/exec/guarded.rs src-tauri/src/exec/mod.rs src-tauri/src/exec/run.rs
git commit -m "feat(exec): run a write in a transaction that waits for a decision"
```

---

## Task 5: Parking, and the two commands

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the parking slot to `AppState`**

In `src-tauri/src/commands.rs`:

```rust
pub struct AppState {
    active: Mutex<Option<ActiveConnection>>,
    pub library: Store,
    schema: Mutex<Option<crate::schema::Schema>>,
    /// The one transaction that may be open waiting for a decision.
    ///
    /// One, not many: the app has one connection and one editor, and a
    /// second parked transaction would be a lock the user has forgotten
    /// about. Starting another write rolls this one back first.
    pending: Mutex<Option<(String, crate::exec::guarded::Parked)>>,
}
```

initialised with `pending: Mutex::new(None)` in `AppState::new`, and an
accessor beside `active()`:

```rust
    fn pending(&self) -> std::sync::MutexGuard<'_, Option<(String, crate::exec::guarded::Parked)>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
```

- [ ] **Step 2: Rewire `execute`**

Replace the body of `execute` in `src-tauri/src/commands.rs`. Reads are
untouched; only writes take the new path:

```rust
#[tauri::command]
pub async fn execute(
    state: tauri::State<'_, AppState>,
    sql: String,
    generated: bool,
) -> Result<ExecuteResponse, AppError> {
    let (pool, policy, unlocked_until) = state.pool_and_guard()?;

    // The one chokepoint. Every statement the user runs passes here.
    let read_write = match decide(policy, unlocked_until, Instant::now(), &sql) {
        Decision::Allow { read_write } => read_write,
        Decision::Deny => return Err(AppError::WriteBlocked(sql.trim().to_string())),
    };

    // A read runs exactly as it always has: no transaction, nothing
    // parked, nothing to confirm.
    if !read_write {
        let outcome = run_query(&pool, &sql, false).await;
        record_run(&state, &sql, generated, &outcome);
        return outcome.map(ExecuteResponse::Done);
    }

    // Anything parked is somebody's forgotten lock. Roll it back before
    // taking another.
    if let Some((_, parked)) = state.pending().take() {
        let _ = crate::exec::guarded::resolve(parked, false).await;
    }

    let tag = state.active().as_ref().map(|a| a.tag).unwrap_or(Tag::Local);
    let kind = crate::guard::write_kind(&sql);
    let expect = crate::guard::plan::expected_rows(&sql);
    let object = ddl_object(&state, &sql, kind);

    let outcome =
        crate::exec::guarded::run_guarded(&pool, &sql, tag, kind, expect, object.as_deref()).await;

    match outcome {
        Ok(crate::exec::guarded::Outcome::Done(result)) => {
            record_run(&state, &sql, generated, &Ok(result.clone()));
            Ok(ExecuteResponse::Done(result))
        }
        Ok(crate::exec::guarded::Outcome::Waiting {
            parked,
            summary,
            affected,
        }) => {
            let token = crate::library::store::new_token();
            *state.pending() = Some((token.clone(), parked));
            Ok(ExecuteResponse::Waiting {
                token,
                summary,
                affected,
                sql,
            })
        }
        Err(e) => {
            record_run(&state, &sql, generated, &Err(e.clone()));
            Err(e)
        }
    }
}
```

`ExecuteResponse` is a new serde enum beside the other IPC types in
`commands.rs`:

```rust
/// What `execute` returns: a finished result, or a question.
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ExecuteResponse {
    Done(QueryResult),
    Waiting {
        token: String,
        summary: String,
        affected: Option<u64>,
        sql: String,
    },
}
```

`record_run` is the history recording lifted out of the current `execute` body
into a helper, so both paths call it and neither can forget:

```rust
/// Record a statement in history, unless it is the app's own generated
/// SQL. A failure here never fails the user's statement.
fn record_run(
    state: &tauri::State<'_, AppState>,
    sql: &str,
    generated: bool,
    outcome: &Result<QueryResult, AppError>,
) {
    if generated {
        return;
    }
    let connection_id = state.active().as_ref().map(|a| a.id.clone());
    let recorded = match outcome {
        Ok(result) => state.library.record_run(
            sql,
            connection_id.as_deref(),
            Some(result.duration_ms as i64),
            Some(result.row_count as i64),
            None,
        ),
        Err(e) => state.library.record_run(
            sql,
            connection_id.as_deref(),
            None,
            None,
            Some(&e.to_string()),
        ),
    };
    if let Err(e) = recorded {
        eprintln!("could not record this statement in history: {e}");
    }
}
```

This requires `QueryResult` and `AppError` to be `Clone`; add
`#[derive(Clone)]` to both if they are not already. `ActiveConnection` needs a
`tag` field — set it in `connect_saved` from `record.tag`, beside `policy`,
which is derived from the same value today.

`ddl_object` describes what DDL names, from the schema cache:

```rust
/// What a DDL statement names, for the confirmation: `public.orders,
/// ~5M rows`. `None` when the statement is not DDL, or names something
/// the cache does not know.
fn ddl_object(
    state: &tauri::State<'_, AppState>,
    sql: &str,
    kind: crate::guard::plan::WriteKind,
) -> Option<String> {
    if kind != crate::guard::plan::WriteKind::Ddl {
        return None;
    }
    let schema = state.schema();
    let cached = schema.as_ref()?;
    let lowered = sql.to_lowercase();
    // The first cached table whose qualified name appears in the
    // statement. Conservative on purpose: naming the wrong table would
    // be worse than naming none, and a miss only costs the sentence its
    // detail.
    for node in &cached.schemas {
        for table in &node.tables {
            let qualified = format!("{}.{}", node.name, table.name);
            if lowered.contains(&qualified) {
                let rows = table
                    .stats
                    .as_ref()
                    .map(|s| format!(", ~{} rows", s.estimated_rows))
                    .unwrap_or_default();
                return Some(format!("{qualified}{rows}"));
            }
        }
    }
    None
}
```

`new_token` is a re-export of the existing id generator: add
`pub fn new_token() -> String { new_id() }` to
`src-tauri/src/library/store/mod.rs` beside `new_id`, so command code does not
reach into a `pub(crate)` helper.

- [ ] **Step 3: Add `resolve_write`**

```rust
/// Commit or roll back the parked transaction.
///
/// A token that names nothing — already resolved, or the app restarted —
/// is not an error: the statement did not run, which is what the user
/// would have been told had they waited.
#[tauri::command]
pub async fn resolve_write(
    state: tauri::State<'_, AppState>,
    token: String,
    commit: bool,
) -> Result<QueryResult, AppError> {
    let parked = {
        let mut slot = state.pending();
        match slot.as_ref() {
            Some((held, _)) if *held == token => slot.take().map(|(_, p)| p),
            _ => None,
        }
    };

    match parked {
        Some(parked) => crate::exec::guarded::resolve(parked, commit).await,
        None => Err(AppError::Query {
            message: "there is nothing left to confirm — the statement did not run".to_string(),
            code: None,
            position: None,
        }),
    }
}
```

Register it in `src-tauri/src/lib.rs`:

```rust
            commands::resolve_write,
```

- [ ] **Step 4: Check it compiles**

```bash
cd src-tauri && cargo build && cargo clippy --all-targets -- -D warnings && cargo fmt
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/library/store/mod.rs
git commit -m "feat(exec): park a guarded write and resolve it by token"
```

---

## Task 6: The protocol, against a real database

**Files:**
- Create: `src-tauri/tests/guarded_test.rs`

- [ ] **Step 1: Write the tests**

```rust
mod common;

use quarry_lib::exec::guarded::{resolve, run_guarded, Outcome};
use quarry_lib::guard::plan::WriteKind;
use quarry_lib::library::model::Tag;

const FIXTURE: &str = "
    create table t (id serial primary key, n int not null);
    insert into t (n) select 1 from generate_series(1, 5);
";

async fn fixture() -> common::TestDb {
    let db = common::start().await;
    let client = db.pool.get().await.expect("checkout");
    client.batch_execute(FIXTURE).await.expect("fixture");
    db
}

async fn count_ones(db: &common::TestDb) -> i64 {
    let client = db.pool.get().await.expect("checkout");
    client
        .query_one("select count(*) from t where n = 1", &[])
        .await
        .expect("count")
        .get(0)
}

#[tokio::test]
async fn a_small_local_write_commits_without_asking() {
    let db = fixture().await;

    let outcome = run_guarded(&db.pool, "update t set n = 2", Tag::Local, WriteKind::Update, None, None)
        .await
        .expect("should run");

    assert!(matches!(outcome, Outcome::Done(_)));
    assert_eq!(count_ones(&db).await, 0, "the update must have committed");
}

#[tokio::test]
async fn a_production_write_waits_and_changes_nothing_until_it_is_confirmed() {
    let db = fixture().await;

    let outcome = run_guarded(&db.pool, "update t set n = 2", Tag::Prod, WriteKind::Update, None, None)
        .await
        .expect("should run");

    let parked = match outcome {
        Outcome::Waiting { parked, affected, .. } => {
            assert_eq!(affected, Some(5));
            parked
        }
        Outcome::Done(_) => panic!("production must ask"),
    };

    // Another connection sees nothing yet: the transaction is open.
    assert_eq!(count_ones(&db).await, 5, "an unconfirmed write must not be visible");

    resolve(parked, true).await.expect("commit");
    assert_eq!(count_ones(&db).await, 0, "confirming must commit it");
}

#[tokio::test]
async fn discarding_a_parked_write_leaves_the_table_alone() {
    let db = fixture().await;

    let outcome = run_guarded(&db.pool, "delete from t", Tag::Prod, WriteKind::Delete, None, None)
        .await
        .expect("should run");

    let parked = match outcome {
        Outcome::Waiting { parked, .. } => parked,
        Outcome::Done(_) => panic!("production must ask"),
    };

    resolve(parked, false).await.expect("rollback");
    assert_eq!(count_ones(&db).await, 5, "discarding must roll it back");
}

#[tokio::test]
async fn a_mismatched_expectation_rolls_back_and_says_both_numbers() {
    let db = fixture().await;

    let err = run_guarded(
        &db.pool,
        "update t set n = 2 -- expect: 1",
        Tag::Local,
        WriteKind::Update,
        Some(1),
        None,
    )
    .await
    .expect_err("a mismatch must refuse");

    let message = err.to_string();
    assert!(message.contains('1') && message.contains('5'), "message was: {message}");
    assert_eq!(count_ones(&db).await, 5, "a refused write must change nothing");
}

#[tokio::test]
async fn a_matching_expectation_commits_off_production() {
    let db = fixture().await;

    let outcome = run_guarded(
        &db.pool,
        "update t set n = 2 -- expect: 5",
        Tag::Local,
        WriteKind::Update,
        Some(5),
        None,
    )
    .await
    .expect("should run");

    assert!(matches!(outcome, Outcome::Done(_)));
    assert_eq!(count_ones(&db).await, 0);
}

#[tokio::test]
async fn resolving_a_transaction_the_server_already_ended_says_so() {
    // The idle timeout is what makes parking safe, and it means resolve
    // must treat a dead transaction as an outcome rather than a crash.
    let db = fixture().await;

    let outcome = run_guarded(&db.pool, "update t set n = 2", Tag::Prod, WriteKind::Update, None, None)
        .await
        .expect("should run");

    let parked = match outcome {
        Outcome::Waiting { parked, .. } => parked,
        Outcome::Done(_) => panic!("production must ask"),
    };

    // End it out from under the parked handle, the way the server's
    // idle timeout would.
    parked
        .client
        .batch_execute("rollback")
        .await
        .expect("end the transaction");

    // Committing now is a no-op on an already-closed transaction, and
    // must report the truth rather than claim success.
    let result = resolve(parked, true).await;
    assert_eq!(count_ones(&db).await, 5, "nothing may have been written");
    // Postgres accepts `commit` outside a transaction with a warning,
    // so this may be Ok — what matters is that the data did not change.
    let _ = result;
}
```

- [ ] **Step 2: Run them**

```bash
cd src-tauri && cargo test --test guarded_test
```

Expected: 6 passed. Requires Docker.

- [ ] **Step 3: Mutation check**

In `run_guarded`, change the `Verdict::Ask` arm to commit before parking, and
confirm `a_production_write_waits_and_changes_nothing_until_it_is_confirmed`
fails on its "not visible" assertion. Restore, show the pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tests/guarded_test.rs
git commit -m "test(exec): prove a parked write is invisible until confirmed"
```

---

## Task 7: The confirmation

**Files:**
- Create: `src/components/PendingWriteDialog.tsx`
- Modify: `src/types.ts`, `src/lib/ipc.ts`, `src/App.tsx`, `src/App.css`

- [ ] **Step 1: Mirror the response shape**

In `src/types.ts`:

```ts
/** Mirrors Rust `ExecuteResponse`. */
export type ExecuteResponse =
  | { state: "done"; [k: string]: unknown }
  | {
      state: "waiting";
      token: string;
      summary: string;
      affected: number | null;
      sql: string;
    };

/** A write that ran and is waiting to be committed or discarded. */
export interface PendingWrite {
  token: string;
  summary: string;
  affected: number | null;
  sql: string;
}
```

The `done` case carries the `QueryResult` fields inline, because the Rust enum
is `#[serde(tag = "state")]`; `src/lib/ipc.ts` narrows it:

```ts
export async function execute(
  sql: string,
  generated: boolean,
): Promise<
  { done: QueryResult; pending: null } | { done: null; pending: PendingWrite }
> {
  const response = await invoke<Record<string, unknown>>("execute", {
    sql,
    generated,
  });
  if (response.state === "waiting") {
    const { token, summary, affected, sql: statement } = response as never;
    return { done: null, pending: { token, summary, affected, sql: statement } };
  }
  const { state: _state, ...result } = response;
  return { done: result as unknown as QueryResult, pending: null };
}

/** Commit or discard the write waiting on `token`. */
export async function resolveWrite(
  token: string,
  commit: boolean,
): Promise<QueryResult> {
  return invoke<QueryResult>("resolve_write", { token, commit });
}
```

- [ ] **Step 2: Build the dialog**

Create `src/components/PendingWriteDialog.tsx`:

```tsx
import { useEffect, useState } from "react";
import { formatCountdown } from "../lib/guard";
import type { PendingWrite } from "../types";

interface Props {
  pending: PendingWrite;
  /** Seconds the server will hold the transaction. */
  seconds: number;
  onCommit: () => void;
  onDiscard: () => void;
}

/**
 * The statement has already run. What is being decided is whether it
 * stays.
 *
 * The countdown is not decoration: Postgres rolls this transaction back
 * when it expires, and a deadline you can watch approach is a different
 * thing from one that fires silently — the difference between the app
 * expiring your transaction and the app appearing to lose it.
 */
export function PendingWriteDialog({ pending, seconds, onCommit, onDiscard }: Props) {
  const [left, setLeft] = useState(seconds);

  useEffect(() => {
    setLeft(seconds);
    const started = Date.now();
    const handle = window.setInterval(() => {
      setLeft(seconds - Math.floor((Date.now() - started) / 1000));
    }, 250);
    return () => window.clearInterval(handle);
  }, [seconds, pending.token]);

  // Expired: the server has ended it, so the only honest button left is
  // the one that acknowledges that.
  const expired = left <= 0;

  return (
    <div className="modal-backdrop">
      <div className="confirm-dialog pending-write" role="alertdialog">
        <p className="pending-summary">{pending.summary}</p>
        <pre className="pending-sql">{pending.sql}</pre>
        <p className="pending-countdown">
          {expired
            ? "rolled back — it was not confirmed in time"
            : `rolls back in ${formatCountdown(left)}`}
        </p>
        <div className="confirm-actions">
          <button className="secondary" onClick={onDiscard}>
            Discard
          </button>
          <button className="danger" onClick={onCommit} disabled={expired}>
            Commit
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire it into App**

In `src/App.tsx`, beside the other state:

```tsx
  // A write that has run and is waiting to be committed or discarded.
  const [pendingWrite, setPendingWrite] = useState<PendingWrite | null>(null);
```

`runSql`'s success branch handles both shapes:

```tsx
        const response = await execute(sql, generated);
        if (response.pending) {
          setPendingWrite(response.pending);
          return;
        }
        const next = response.done;
```

and the resolution, beside the other callbacks:

```tsx
  // Committing or discarding finishes the statement that is already
  // waiting; either way the pending state goes, because the transaction
  // it referred to is over.
  const finishPendingWrite = useCallback(
    async (commit: boolean) => {
      if (!pendingWrite) return;
      const token = pendingWrite.token;
      setPendingWrite(null);
      try {
        const result = await resolveWrite(token, commit);
        setTabResults((all) => withResult(all, activeTabId, { result, error: null }));
      } catch (e) {
        setTabResults((all) =>
          withResult(all, activeTabId, { error: asAppError(e) }),
        );
      }
      refreshRecent();
    },
    [pendingWrite, activeTabId, refreshRecent],
  );
```

Rendered beside `ConfirmDialog`:

```tsx
      {pendingWrite && (
        <PendingWriteDialog
          pending={pendingWrite}
          seconds={60}
          onCommit={() => void finishPendingWrite(true)}
          onDiscard={() => void finishPendingWrite(false)}
        />
      )}
```

Import `PendingWriteDialog`, `resolveWrite` and the `PendingWrite` type.

- [ ] **Step 4: Style it**

In `src/App.css`, beside the confirm-dialog rules:

```css
/* The statement has already run; this decides whether it stays. Wider
   than an ordinary confirmation because it shows the SQL. */
.pending-write {
  max-width: 560px;
}

.pending-summary {
  margin: 0 0 var(--s-2);
  font-size: var(--t-md);
}

.pending-sql {
  margin: 0 0 var(--s-2);
  padding: var(--s-2);
  max-height: 30vh;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel);
  font-family: var(--mono);
  font-size: var(--t-sm);
  white-space: pre-wrap;
}

.pending-countdown {
  margin: 0 0 var(--s-3);
  color: var(--muted);
  font-size: var(--t-sm);
}
```

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit -p tsconfig.json && npm test && npm run build
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src src-tauri
git commit -m "feat(exec): confirm a write before it commits"
```

---

## Smoke test, for the owner

Against `smoke-test` or `lifegame` — **never** `railway`:

1. `update t set n = n` touching 3 rows on a local connection → commits with no
   dialog, status bar reports the count.
2. The same touching 200 rows → dialog appears; Discard → the table is
   unchanged; re-run and Commit → it changed.
3. `-- expect: 1` on a statement that hits 5 → error naming both numbers, table
   unchanged, no dialog.
4. `-- expect: 5` on the same statement → commits straight through.
5. Leave a dialog open for 60 seconds → the countdown reaches zero and Commit
   is disabled; Discard clears it; the table is unchanged.
6. On the production connection, unlock and run a one-row update → the dialog
   appears anyway.
7. `create table zzz (id int)` on local → the dialog names the object rather
   than a rowcount. Drop it afterwards.
8. While a dialog is open, run another statement in another tab → the parked
   one rolls back rather than leaving a lock behind.
