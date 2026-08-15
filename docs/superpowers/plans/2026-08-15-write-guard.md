# Production Write-Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production connections reject writes until explicitly unlocked, enforced both by a statement classifier in Rust and by Postgres itself.

**Architecture:** A pure `guard` module classifies SQL with `sqlparser` and decides allow/deny from policy plus unlock deadline — no database, no state, so it is testable in bulk. Enforcement is two independent layers: prod pools carry `-c default_transaction_read_only=on`, and an unlocked connection opts out per transaction with `BEGIN READ WRITE`. Policy derives from the existing `Tag`, so there is no migration.

**Tech Stack:** Rust, `sqlparser`, tokio-postgres/deadpool, React 19, TypeScript 7.

**Spec:** `docs/superpowers/specs/2026-08-15-write-guard-design.md`

---

## Baselines

Rust 148 tests passing, TypeScript 128 passing, `npx tsc --noEmit` and `npm run build` clean.

**Do not run `cargo clippy` or `cargo fmt`.** Both fail at baseline for reasons recorded in `docs/BACKLOG.md`. If you run clippy to check your own work, the only acceptable new output is the two known `dead_code` errors in `src-tauri/tests/common/mod.rs` and nothing else.

No migration in this stage — policy derives from the existing tag — so no workspace backup is needed.

Some tests here need Docker running (testcontainers).

## A note on `sqlparser` versions

`sqlparser`'s `Statement` and `SetExpr` enums change shape between releases. The classifier is written to survive that: **it names only the read variants and sends everything else to `Write` via a `_` arm.** If a variant in the code below does not exist in the version you install, adapt the pattern — but keep that shape. Never add a `_ => Read` arm anywhere; an unrecognised statement must always be a write.

## File Structure

**Create:**
- `src-tauri/src/guard/mod.rs` — `Access`, `Policy`, classification, the allow/deny decision
- `src-tauri/tests/guard_test.rs` — classifier and decision tests, no database
- `src-tauri/tests/guard_db_test.rs` — the two real-Postgres tests
- `src/components/UnlockDialog.tsx` — typed-name confirmation
- `src/lib/guard.ts` + `.test.ts` — countdown formatting

**Modify:**
- `src-tauri/Cargo.toml` — `sqlparser`
- `src-tauri/src/lib.rs` — register `guard`, three new commands
- `src-tauri/src/error.rs` — `AppError::WriteBlocked`
- `src-tauri/src/conn/pool.rs` — `build_pool` takes a policy
- `src-tauri/src/exec/run.rs` — `run_query` takes `read_write`
- `src-tauri/src/commands.rs` — enforcement, unlock, relock, status
- `src-tauri/tests/common/mod.rs`, `exec_test.rs`, `tls_test.rs`, `tls_verify_test.rs`, `harness_smoke.rs`, `missing_password_test.rs`, `schema_test.rs` — `build_pool` call sites
- `src/types.ts`, `src/lib/ipc.ts`, `src/App.tsx`, `src/App.css`

---

### Task 1: Classify a statement

**Files:**
- Create: `src-tauri/src/guard/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod guard;`)
- Modify: `src-tauri/Cargo.toml`
- Test: `src-tauri/tests/guard_test.rs`

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml`, after `rusqlite`:

```toml
sqlparser = "0.58"
```

If that version does not resolve, use the latest 0.x and read the version note above before writing the match arms.

- [ ] **Step 2: Write the failing test**

Create `src-tauri/tests/guard_test.rs`:

```rust
use quarry_lib::guard::{classify, Access};

/// Reads. Each of these must be runnable on a locked production
/// connection — that is the whole point of classifying rather than
/// blocking everything.
#[test]
fn plain_reads_are_reads() {
    for sql in [
        "select 1",
        "select * from users where id = 3",
        "select count(*) from orders group by status having count(*) > 2",
        "table users",
        "values (1), (2)",
        "show statement_timeout",
        "explain select * from users",
        "with recent as (select * from orders limit 10) select * from recent",
        "select * from a union select * from b",
    ] {
        assert_eq!(classify(sql), Access::Read, "should be a read: {sql}");
    }
}

/// Writes. A miss here runs a mutation on production.
#[test]
fn mutations_are_writes() {
    for sql in [
        "insert into users (id) values (1)",
        "update users set name = 'x'",
        "delete from users",
        "truncate users",
        "drop table users",
        "create table t (id int)",
        "alter table users add column x int",
        "create index on users (id)",
        "grant select on users to bob",
        "call do_something()",
        "do $$ begin end $$",
        "copy users from '/tmp/x.csv'",
    ] {
        assert_eq!(classify(sql), Access::Write, "should be a write: {sql}");
    }
}

/// The subtle ones. Each of these looks like a read at a glance and is
/// not — they are the reason this is a parser and not a keyword check.
#[test]
fn statements_that_look_like_reads_but_write() {
    for sql in [
        // Takes row locks.
        "select * from users for update",
        "select * from users for share",
        // Runs the statement it is explaining.
        "explain analyze select * from users",
        // A data-modifying CTE: the outer statement is a SELECT.
        "with moved as (delete from users returning *) select * from moved",
        "with added as (insert into users (id) values (1) returning *) select * from added",
        "with bumped as (update users set n = n + 1 returning *) select * from bumped",
    ] {
        assert_eq!(classify(sql), Access::Write, "should be a write: {sql}");
    }
}

#[test]
fn unparseable_sql_is_a_write() {
    // The spec's rule: what cannot be classified cannot be run on a
    // locked connection. Wrong in the safe direction.
    for sql in [
        "this is not sql",
        "select * from",
        "sel ect 1",
    ] {
        assert_eq!(classify(sql), Access::Write, "should be a write: {sql}");
    }
}

#[test]
fn empty_input_is_a_read() {
    // Nothing to run, so nothing to guard. Denying this would produce a
    // confusing error on an empty editor.
    assert_eq!(classify(""), Access::Read);
    assert_eq!(classify("   \n  "), Access::Read);
    assert_eq!(classify("-- just a comment"), Access::Read);
}

#[test]
fn a_buffer_is_a_write_if_any_statement_writes() {
    // The whole buffer is judged together: one write condemns it.
    assert_eq!(classify("select 1; select 2"), Access::Read);
    assert_eq!(classify("select 1; delete from users"), Access::Write);
    assert_eq!(classify("delete from users; select 1"), Access::Write);
}
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd src-tauri && cargo test --test guard_test
```

Expected: compile error — no `guard` module.

- [ ] **Step 4: Implement**

Create `src-tauri/src/guard/mod.rs`:

```rust
use sqlparser::ast::{Query, SetExpr, Statement};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;

/// What a statement does to the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

/// Classify a whole editor buffer.
///
/// One write condemns the buffer: the statements would run against the
/// same connection, so allowing the reads and refusing the writes would
/// half-run the user's intent.
///
/// **Anything unparseable is a write.** `sqlparser` does not cover every
/// Postgres syntax, so this refuses some harmless reads on a locked
/// connection — the escape hatch is unlocking. That is the deliberate
/// trade: a guard wrong in the safe direction is annoying, one wrong in
/// the other direction is why the feature exists.
pub fn classify(sql: &str) -> Access {
    // An empty buffer has nothing to guard. Denying it would put an
    // error in front of an empty editor.
    if sql.trim().is_empty() {
        return Access::Read;
    }

    let statements = match Parser::parse_sql(&PostgreSqlDialect {}, sql) {
        Ok(statements) => statements,
        Err(_) => return Access::Write,
    };

    // A buffer of only comments parses to no statements at all.
    if statements.is_empty() {
        return Access::Read;
    }

    if statements.iter().any(|s| classify_statement(s) == Access::Write) {
        Access::Write
    } else {
        Access::Read
    }
}

/// Only read forms are named. Everything else — all DML, all DDL,
/// `TRUNCATE`, `CALL`, `DO`, `GRANT`, `COPY`, and any statement a future
/// `sqlparser` version adds — falls through to `Write`.
///
/// Never add a `_ => Access::Read` arm here. The `_` arm is what keeps
/// this safe as the parser's enum grows.
fn classify_statement(statement: &Statement) -> Access {
    match statement {
        Statement::Query(query) => classify_query(query),

        // `EXPLAIN ANALYZE` actually runs the statement, so it inherits
        // whatever that statement does. Plain `EXPLAIN` only plans it.
        Statement::Explain {
            analyze, statement, ..
        } => {
            if *analyze {
                classify_statement(statement)
            } else {
                Access::Read
            }
        }

        Statement::ShowVariable { .. } => Access::Read,

        _ => Access::Write,
    }
}

fn classify_query(query: &Query) -> Access {
    // `FOR UPDATE` / `FOR SHARE` take row locks, which is a write in
    // every sense that matters on production.
    if !query.locks.is_empty() {
        return Access::Write;
    }

    // A data-modifying CTE hides a write inside a statement whose outer
    // form is a SELECT: `with x as (delete ...) select * from x`.
    if let Some(with) = &query.with {
        for cte in &with.cte_tables {
            if classify_query(&cte.query) == Access::Write {
                return Access::Write;
            }
        }
    }

    classify_set_expr(&query.body)
}

fn classify_set_expr(body: &SetExpr) -> Access {
    match body {
        SetExpr::Select(_) => Access::Read,
        SetExpr::Query(query) => classify_query(query),
        SetExpr::SetOperation { left, right, .. } => {
            if classify_set_expr(left) == Access::Write
                || classify_set_expr(right) == Access::Write
            {
                Access::Write
            } else {
                Access::Read
            }
        }
        SetExpr::Values(_) => Access::Read,
        SetExpr::Table(_) => Access::Read,

        // `SetExpr::Insert` and `SetExpr::Update` land here, as does
        // anything a later version adds.
        _ => Access::Write,
    }
}
```

Register the module in `src-tauri/src/lib.rs`, after `pub mod exec;`:

```rust
pub mod guard;
```

- [ ] **Step 5: Run the tests**

```bash
cd src-tauri && cargo test --test guard_test
```

Expected: 6 passed. If a match arm does not compile, re-read the version note at the top of this plan — adapt the variant names, never the `_ => Write` shape.

- [ ] **Step 6: Prove the subtle cases actually bite**

These are the tests that justify using a parser at all, so verify they fail when the logic is removed. One at a time, restoring after each:

1. Delete the `if !query.locks.is_empty()` block → `statements_that_look_like_reads_but_write` must FAIL.
2. Delete the `if let Some(with)` block → the same test must FAIL.
3. Change the `Explain` arm to always return `Access::Read` → the same test must FAIL.
4. Change `Err(_) => return Access::Write` to `Err(_) => return Access::Read` → `unparseable_sql_is_a_write` must FAIL.

Report all four results. A guard whose tests pass without the guard is the one outcome this stage cannot ship.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/guard/mod.rs src-tauri/src/lib.rs src-tauri/tests/guard_test.rs
git commit -m "feat(guard): classify SQL as read or write"
```

---

### Task 2: Policy and the allow/deny decision

**Files:**
- Modify: `src-tauri/src/guard/mod.rs`
- Test: `src-tauri/tests/guard_test.rs`

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/tests/guard_test.rs`:

```rust
use quarry_lib::guard::{decide, Decision, Policy};
use quarry_lib::library::model::Tag;
use std::time::{Duration, Instant};

#[test]
fn policy_comes_from_the_tag() {
    assert_eq!(Policy::for_tag(Tag::Local), Policy::Free);
    assert_eq!(Policy::for_tag(Tag::Staging), Policy::Free);
    assert_eq!(Policy::for_tag(Tag::Prod), Policy::ReadOnly);
}

#[test]
fn a_free_connection_allows_everything() {
    let now = Instant::now();
    assert_eq!(
        decide(Policy::Free, None, now, "delete from users"),
        Decision::Allow { read_write: true },
    );
}

#[test]
fn a_locked_connection_allows_reads_and_denies_writes() {
    let now = Instant::now();

    assert_eq!(
        decide(Policy::ReadOnly, None, now, "select 1"),
        Decision::Allow { read_write: false },
    );
    assert_eq!(
        decide(Policy::ReadOnly, None, now, "delete from users"),
        Decision::Deny,
    );
}

#[test]
fn an_unlocked_connection_allows_writes_until_the_deadline() {
    let now = Instant::now();
    let deadline = now + Duration::from_secs(60);

    assert_eq!(
        decide(Policy::ReadOnly, Some(deadline), now, "delete from users"),
        Decision::Allow { read_write: true },
    );
}

#[test]
fn an_expired_unlock_denies_again() {
    // The deadline is checked against the clock on every statement, so
    // an unlock cannot outlive its window just because the UI still
    // shows a banner.
    let now = Instant::now();
    let expired = now - Duration::from_secs(1);

    assert_eq!(
        decide(Policy::ReadOnly, Some(expired), now, "delete from users"),
        Decision::Deny,
    );
}

#[test]
fn a_read_on_a_locked_connection_never_opts_out_of_read_only() {
    // `read_write: false` is what keeps the BEGIN READ WRITE wrapper off
    // a statement that does not need it — the second layer stays armed.
    let now = Instant::now();
    let deadline = now + Duration::from_secs(60);

    assert_eq!(
        decide(Policy::ReadOnly, Some(deadline), now, "select 1"),
        Decision::Allow { read_write: false },
    );
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd src-tauri && cargo test --test guard_test
```

Expected: compile error — `decide`, `Decision`, `Policy` do not exist.

- [ ] **Step 3: Implement**

Add to the top of `src-tauri/src/guard/mod.rs`:

```rust
use crate::library::model::Tag;
use std::time::Instant;

/// What a connection is allowed to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    /// Everything runs. Local and staging.
    Free,
    /// Writes rejected until unlocked. Production.
    ReadOnly,
}

impl Policy {
    /// Derived from the tag rather than stored, so there is no column
    /// that could disagree with the tag the user sees. `Tag::from_stored`
    /// already resolves anything unrecognised to `Prod`, so a corrupted
    /// row lands locked rather than open.
    pub fn for_tag(tag: Tag) -> Self {
        match tag {
            Tag::Prod => Policy::ReadOnly,
            Tag::Local | Tag::Staging => Policy::Free,
        }
    }
}

/// The guard's verdict for one buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow {
        /// Whether execution should wrap the statement in
        /// `BEGIN READ WRITE`, opting out of the session's read-only
        /// default. False for reads even on an unlocked connection, so
        /// the second layer stays armed for anything that does not
        /// actually need to write.
        read_write: bool,
    },
    Deny,
}

/// Decide whether a buffer may run.
///
/// `now` is passed in rather than read here so the decision stays a pure
/// function of its inputs and the expiry can be tested without sleeping.
pub fn decide(
    policy: Policy,
    unlocked_until: Option<Instant>,
    now: Instant,
    sql: &str,
) -> Decision {
    if policy == Policy::Free {
        return Decision::Allow { read_write: true };
    }

    if classify(sql) == Access::Read {
        return Decision::Allow { read_write: false };
    }

    // A write on a locked connection: allowed only inside a live unlock
    // window. The deadline is checked against the clock every time, so a
    // stale banner in the UI cannot extend it.
    match unlocked_until {
        Some(deadline) if deadline > now => Decision::Allow { read_write: true },
        _ => Decision::Deny,
    }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd src-tauri && cargo test --test guard_test
```

Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/guard/mod.rs src-tauri/tests/guard_test.rs
git commit -m "feat(guard): decide from policy and unlock deadline"
```

---

### Task 3: The denial error

**Files:**
- Modify: `src-tauri/src/error.rs`

No test: this is a variant plus a serialization arm, both exercised by Task 6's enforcement and by the frontend. That matches how `AppError::Export` was added last stage.

- [ ] **Step 1: Add the variant**

In `src-tauri/src/error.rs`, after `Export`:

```rust
    #[error("this connection is read-only: {0}")]
    WriteBlocked(String),
```

and in the `Serialize` impl's match:

```rust
            AppError::WriteBlocked(_) => ("write_blocked", None, None),
```

The distinct `kind` is what lets the UI render this as a guard denial offering Unlock, rather than as a generic query failure. A denial that looks like a syntax error teaches the user to distrust the guard.

- [ ] **Step 2: Build**

```bash
cd src-tauri && cargo build
```

Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/error.rs
git commit -m "feat(guard): add a distinct error for a blocked write"
```

---

### Task 4: The session read-only default

**Files:**
- Modify: `src-tauri/src/conn/pool.rs`
- Modify: every `build_pool` call site (see Step 3)

- [ ] **Step 1: Write the failing test**

Add to the `tests` module at the bottom of `src-tauri/src/conn/pool.rs`:

```rust
    /// The second layer of the guard. This is the option that protects
    /// against code paths which forget to ask the classifier — including
    /// ones not written yet.
    #[test]
    fn a_read_only_pool_asks_postgres_to_refuse_writes() {
        let cfg = ConnectionConfig {
            host: "localhost".to_string(),
            port: 5432,
            user: "postgres".to_string(),
            dbname: "postgres".to_string(),
            password: None,
            sslmode: SslMode::Disable,
        };

        assert!(startup_options(Policy::ReadOnly)
            .contains("default_transaction_read_only=on"));
        assert!(!startup_options(Policy::Free)
            .contains("default_transaction_read_only"));

        // Both still carry the statement timeout, which is not part of
        // the guard and must not be lost.
        assert!(startup_options(Policy::ReadOnly).contains("statement_timeout"));
        assert!(startup_options(Policy::Free).contains("statement_timeout"));

        assert!(build_pool(&cfg, Policy::ReadOnly).is_ok());
    }
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd src-tauri && cargo test --lib a_read_only_pool
```

Expected: compile error — `startup_options` does not exist and `build_pool` takes one argument.

- [ ] **Step 3: Implement**

In `src-tauri/src/conn/pool.rs`, add the import and the helper above `build_pool`:

```rust
use crate::guard::Policy;

/// The `-c` flags applied at connection time.
///
/// These survive for the life of the physical connection *and* the
/// `DISCARD ALL` that runs when it returns to the pool — because they
/// are the values `DISCARD ALL` resets to. That is what makes
/// `default_transaction_read_only` a real protection rather than a
/// session setting a stray `SET` could undo.
fn startup_options(policy: Policy) -> String {
    let mut options = format!("-c statement_timeout={STATEMENT_TIMEOUT_MS}");

    if policy == Policy::ReadOnly {
        // Layer two of the guard. Every transaction on this connection
        // starts read-only; only an explicit `BEGIN READ WRITE` opts
        // out, which execution does exactly while unlocked.
        options.push_str(" -c default_transaction_read_only=on");
    }

    options
}
```

Change the signature and the assignment:

```rust
pub fn build_pool(cfg: &ConnectionConfig, policy: Policy) -> Result<Pool, AppError> {
```

```rust
    pc.options = Some(startup_options(policy));
```

- [ ] **Step 4: Update every call site**

```bash
cd /Users/lepetitdev/dev/quarry && grep -rn "build_pool(" src-tauri/src src-tauri/tests
```

Pass `Policy::Free` everywhere except `connect_saved` in `commands.rs`, which Task 6 changes to derive from the tag — for now give it `Policy::Free` so the tree compiles, and Task 6 replaces it. In `src-tauri/tests/common/mod.rs` and the other test binaries, `Policy::Free` is correct: those harnesses test connection and execution, not the guard.

The existing `builds_pools_for_every_sslmode` test in `pool.rs` also calls `build_pool` — give it `Policy::Free`.

- [ ] **Step 5: Run everything**

```bash
cd src-tauri && cargo test
```

Expected: 149 passed (148 baseline plus this one), 0 failed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/conn/pool.rs src-tauri/src/commands.rs src-tauri/tests
git commit -m "feat(guard): start production pools read-only"
```

---

### Task 5: Opt out per transaction

**Files:**
- Modify: `src-tauri/src/exec/run.rs`
- Modify: `src-tauri/src/commands.rs` (the `execute` call site), `src-tauri/tests/exec_test.rs`

- [ ] **Step 1: Change the signature**

`run_query` gains a `read_write` flag. In `src-tauri/src/exec/run.rs`:

```rust
pub async fn run_query(
    pool: &Pool,
    sql: &str,
    read_write: bool,
) -> Result<QueryResult, AppError> {
    let client = pool.get().await?;

    // On a read-only connection the guard has decided this statement may
    // write, so opt this one transaction out of the session default.
    // Anything that does not need it stays read-only, which keeps the
    // second layer armed for every other path.
    if read_write {
        client.batch_execute("begin read write").await?;
    }
```

The existing body follows unchanged until the two return points, which must now commit. Replace the early return for the no-columns case:

```rust
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
            rows: Vec::new(),
            row_count: 0,
            affected_rows: Some(affected),
            duration_ms,
        });
    }
```

and the row-returning path:

```rust
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
```

Also handle a failure of `prepare` itself, which happens before either branch — wrap it the same way:

```rust
    let stmt = match client.prepare(sql).await {
        Ok(stmt) => stmt,
        Err(e) => {
            if read_write {
                let _ = client.batch_execute("rollback").await;
            }
            return Err(e.into());
        }
    };
```

Update the doc comment's stale line — it currently says "Stage 3 inserts the safety guard immediately above the `query` call. Stage 1 has no policy enforcement — do not connect this to a production database yet." Replace with:

```rust
/// The guard decides `read_write` before this is called; this function
/// only carries it out. See `guard::decide`.
```

- [ ] **Step 2: Update the call sites**

`commands.rs::execute` — Task 6 rewrites this properly; for now pass `true` so the tree compiles.

`src-tauri/tests/exec_test.rs` — every `run_query(&db.pool, sql)` becomes `run_query(&db.pool, sql, false)`. Those tests run reads against a `Policy::Free` pool, so `false` is right and also proves reads work without the wrapper.

- [ ] **Step 3: Run the tests**

```bash
cd src-tauri && cargo test
```

Expected: 149 passed, 0 failed. Requires Docker.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/exec/run.rs src-tauri/src/commands.rs src-tauri/tests/exec_test.rs
git commit -m "feat(guard): opt a writing statement out of read-only"
```

---

### Task 6: Enforce at the chokepoint

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Carry the policy on the active connection**

Add to `ActiveConnection`:

```rust
pub struct ActiveConnection {
    pub id: String,
    pub pool: Pool,
    pub info: ConnectionInfo,
    pub policy: Policy,
    /// When the current unlock expires. `None` means locked.
    ///
    /// Deliberately not persisted: restarting relocks, which is the
    /// point. An `Instant` rather than a wall clock, so changing the
    /// system time cannot extend an unlock.
    pub unlocked_until: Option<Instant>,
}
```

with imports at the top of the file:

```rust
use crate::guard::{decide, Decision, Policy};
use std::time::{Duration, Instant};
```

- [ ] **Step 2: Set it when connecting**

In `connect_saved`, replace the `build_pool(&cfg)?` call:

```rust
    let policy = Policy::for_tag(record.tag);
    let pool = build_pool(&cfg, policy)?;
```

and the `set_active` call:

```rust
    state.set_active(Some(ActiveConnection {
        id: id.clone(),
        pool,
        info: info.clone(),
        policy,
        // A fresh connection is always locked, whatever the previous
        // one was.
        unlocked_until: None,
    }));
```

`record.tag` is already on the `Connection` record read at the top of the function.

- [ ] **Step 3: Add a state accessor**

`AppState::pool` currently returns only the pool. Add beside it:

```rust
    /// The pool plus the guard state, read under one lock so the policy
    /// cannot change between the check and the execution.
    fn pool_and_guard(&self) -> Result<(Pool, Policy, Option<Instant>), AppError> {
        let active = self.active.lock().expect("state lock poisoned");
        active
            .as_ref()
            .map(|a| (a.pool.clone(), a.policy, a.unlocked_until))
            .ok_or_else(|| AppError::Connection("not connected to a database".into()))
    }
```

- [ ] **Step 4: Enforce**

Replace `execute`:

```rust
#[tauri::command]
pub async fn execute(
    state: tauri::State<'_, AppState>,
    sql: String,
) -> Result<QueryResult, AppError> {
    let (pool, policy, unlocked_until) = state.pool_and_guard()?;

    // The one chokepoint. Every statement the user runs passes here.
    let read_write = match decide(policy, unlocked_until, Instant::now(), &sql) {
        Decision::Allow { read_write } => read_write,
        Decision::Deny => {
            return Err(AppError::WriteBlocked(sql.trim().to_string()))
        }
    };

    run_query(&pool, &sql, read_write).await
}
```

- [ ] **Step 5: Unlock, relock, status**

Add after `execute`:

```rust
/// How long an unlock lasts. Fixed from the moment of unlocking rather
/// than sliding: a sliding window can be kept alive indefinitely, which
/// is the state this feature exists to prevent.
const UNLOCK_MINUTES: u64 = 30;

/// What the UI needs to render the guard's state.
#[derive(Clone, Serialize)]
pub struct GuardStatus {
    /// "free" or "read_only".
    pub policy: String,
    /// Seconds left on the unlock, or None when locked.
    pub unlocked_seconds_remaining: Option<u64>,
}

#[tauri::command]
pub fn guard_status(
    state: tauri::State<'_, AppState>,
) -> Result<Option<GuardStatus>, AppError> {
    let active = state.active.lock().expect("state lock poisoned");
    Ok(active.as_ref().map(|a| GuardStatus {
        policy: match a.policy {
            Policy::Free => "free".to_string(),
            Policy::ReadOnly => "read_only".to_string(),
        },
        unlocked_seconds_remaining: a.unlocked_until.and_then(|deadline| {
            deadline
                .checked_duration_since(Instant::now())
                .map(|left| left.as_secs())
        }),
    }))
}

/// Unlock the active connection for a fixed window.
///
/// `typed_name` must match the connection's name exactly. The point is
/// not authentication — anyone at the keyboard can read the name — but
/// deliberateness: typing it is impossible to do by reflex, which a
/// confirmation button is not.
#[tauri::command]
pub fn unlock(
    state: tauri::State<'_, AppState>,
    typed_name: String,
) -> Result<(), AppError> {
    // Read the id and release the lock before touching the library:
    // holding the `active` mutex across a SQLite call would nest two
    // locks for no reason, and nested locks are how ordering bugs start.
    let id = {
        let active = state.active.lock().expect("state lock poisoned");
        active
            .as_ref()
            .map(|a| a.id.clone())
            .ok_or_else(|| AppError::Connection("not connected to a database".into()))?
    };

    let record = state.library.connection(&id)?;
    if typed_name.trim() != record.name {
        return Err(AppError::WriteBlocked(format!(
            "type the connection name exactly to unlock: {}",
            record.name
        )));
    }

    let mut active = state.active.lock().expect("state lock poisoned");
    // Re-check identity: the user could have switched connections while
    // the dialog was open, and unlocking a different database than the
    // one they named is exactly the accident this feature prevents.
    match active.as_mut() {
        Some(connection) if connection.id == id => {
            connection.unlocked_until =
                Some(Instant::now() + Duration::from_secs(UNLOCK_MINUTES * 60));
            Ok(())
        }
        _ => Err(AppError::Connection(
            "the connection changed while unlocking".into(),
        )),
    }
}

#[tauri::command]
pub fn relock(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let mut active = state.active.lock().expect("state lock poisoned");
    if let Some(connection) = active.as_mut() {
        connection.unlocked_until = None;
    }
    Ok(())
}
```

- [ ] **Step 6: Register the commands**

In `src-tauri/src/lib.rs`, after `commands::write_text_file,`:

```rust
            commands::guard_status,
            commands::unlock,
            commands::relock,
```

- [ ] **Step 7: Build and test**

```bash
cd src-tauri && cargo build && cargo test
```

Expected: compiles; 149 passed.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(guard): block writes on a locked connection"
```

---

### Task 7: Prove the second layer against a real Postgres

**Files:**
- Create: `src-tauri/tests/guard_db_test.rs`

This is the task the spec singles out. The entire unlock flow rests on `BEGIN READ WRITE` overriding the session default, and layer two is only a real protection if the server refuses writes on its own. Neither is assumed.

- [ ] **Step 1: Write the test**

```rust
mod common;

use quarry_lib::conn::build_pool;
use quarry_lib::exec::run_query;
use quarry_lib::guard::Policy;

/// Layer two, standing alone: with the classifier bypassed entirely,
/// Postgres itself must refuse the write.
#[tokio::test]
async fn postgres_refuses_a_write_on_a_read_only_pool() {
    let db = common::start().await;

    // Build a second pool at the same database, this time read-only.
    let cfg = common::config_for(db.port);
    let pool = build_pool(&cfg, Policy::ReadOnly).expect("pool should build");

    // `read_write: false` means no BEGIN READ WRITE — exactly what a
    // future code path that forgot the guard would produce.
    let result = run_query(&pool, "create table guard_probe (id int)", false).await;

    let error = result.expect_err("a read-only connection must refuse DDL");
    let message = format!("{error}");
    assert!(
        message.contains("read-only") || message.contains("read only"),
        "expected a read-only refusal from the server, got: {message}"
    );
}

/// The unlock path: an explicit `BEGIN READ WRITE` must override the
/// session default, or unlocking could never work.
#[tokio::test]
async fn begin_read_write_overrides_the_session_default() {
    let db = common::start().await;

    let cfg = common::config_for(db.port);
    let pool = build_pool(&cfg, Policy::ReadOnly).expect("pool should build");

    // Same pool, same read-only default — but this time opting out, as
    // an unlocked connection does.
    run_query(&pool, "create table guard_probe (id int)", true)
        .await
        .expect("BEGIN READ WRITE should permit the write");

    // And it really committed, rather than being rolled back.
    let check = run_query(
        &pool,
        "select count(*) from information_schema.tables where table_name = 'guard_probe'",
        false,
    )
    .await
    .expect("the check query is a read");

    assert_eq!(check.rows.len(), 1);
    assert_eq!(check.rows[0][0], serde_json::json!(1));
}
```

- [ ] **Step 2: Add the config helper**

`common::start()` builds its own config internally. Add to `src-tauri/tests/common/mod.rs`:

```rust
/// The same connection config `start` used, so a test can build a second
/// pool — with a different policy — against the same container.
pub fn config_for(port: u16) -> ConnectionConfig {
    let url = format!("postgres://postgres:postgres@localhost:{port}/postgres?sslmode=disable");
    ConnectionConfig::from_url(&url).expect("test URL should parse")
}
```

- [ ] **Step 3: Run them**

```bash
cd src-tauri && cargo test --test guard_db_test
```

Expected: 2 passed. Requires Docker.

**If `begin_read_write_overrides_the_session_default` fails, stop and report it.** The whole unlock design depends on that behaviour; discovering it is false is a design problem, not a bug to code around.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tests/guard_db_test.rs src-tauri/tests/common/mod.rs
git commit -m "test(guard): prove Postgres enforces read-only itself"
```

---

### Task 8: Frontend types, IPC, and the countdown

**Files:**
- Modify: `src/types.ts`, `src/lib/ipc.ts`
- Create: `src/lib/guard.ts`, `src/lib/guard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatCountdown } from "./guard";

describe("formatCountdown", () => {
  it("formats minutes and seconds", () => {
    expect(formatCountdown(1800)).toBe("30:00");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(9)).toBe("0:09");
  });

  it("never shows a negative time", () => {
    // The banner ticks locally between polls, so it can run past the
    // real deadline. Showing "-0:03" would look broken; the server is
    // the authority either way.
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- guard
```

Expected: FAIL — cannot resolve `./guard`.

- [ ] **Step 3: Implement**

Create `src/lib/guard.ts`:

```ts
/**
 * Seconds as `m:ss` for the unlock banner.
 *
 * Clamped at zero: the banner counts down locally between polls, so it
 * can tick past the real deadline. The server re-checks on every
 * statement regardless, so a display that reached zero is never the
 * thing keeping a connection safe.
 */
export function formatCountdown(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Add types and IPC**

In `src/types.ts`:

```ts
/** Mirrors Rust `GuardStatus`. */
export interface GuardStatus {
  policy: "free" | "read_only";
  /** Seconds left on the unlock; null when locked. */
  unlocked_seconds_remaining: number | null;
}
```

In `src/lib/ipc.ts`:

```ts
export async function guardStatus(): Promise<GuardStatus | null> {
  return invoke<GuardStatus | null>("guard_status");
}

export async function unlock(typedName: string): Promise<void> {
  return invoke("unlock", { typedName });
}

export async function relock(): Promise<void> {
  return invoke("relock");
}
```

Add `GuardStatus` to that file's type import.

- [ ] **Step 5: Verify**

```bash
npm test -- guard && npx tsc --noEmit
```

Expected: 2 passed, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/guard.ts src/lib/guard.test.ts src/types.ts src/lib/ipc.ts
git commit -m "feat(guard): expose guard status to the UI"
```

---

### Task 9: The unlock dialog and banner

**Files:**
- Create: `src/components/UnlockDialog.tsx`
- Modify: `src/App.tsx`, `src/App.css`

- [ ] **Step 1: The dialog**

Create `src/components/UnlockDialog.tsx`:

```tsx
import { useState } from "react";

interface Props {
  connectionName: string;
  onConfirm: (typedName: string) => void;
  onCancel: () => void;
}

/**
 * Unlocking requires typing the connection's name.
 *
 * Not authentication — anyone at the keyboard can read the name off the
 * header. The point is deliberateness: a button can be clicked by
 * reflex, a name cannot be typed by reflex.
 */
export function UnlockDialog({ connectionName, onConfirm, onCancel }: Props) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === connectionName;

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Unlock {connectionName}</h2>
        <p className="modal-body">
          This is a production connection. Writes are blocked until you
          unlock it, and it relocks automatically after 30 minutes.
        </p>
        <p className="modal-body">
          Type <strong>{connectionName}</strong> to confirm.
        </p>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches) onConfirm(typed);
            if (e.key === "Escape") onCancel();
          }}
          spellCheck={false}
        />
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button
            className="danger"
            disabled={!matches}
            onClick={() => onConfirm(typed)}
          >
            Unlock
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `App`**

Add the imports:

```tsx
import { UnlockDialog } from "./components/UnlockDialog";
import { formatCountdown } from "./lib/guard";
import { guardStatus, relock, unlock } from "./lib/ipc";
import type { GuardStatus } from "./types";
```

State and polling, after the sort state:

```tsx
  const [guard, setGuard] = useState<GuardStatus | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);

  // Polled once a second while connected: the countdown has to tick, and
  // the server is the only authority on whether the unlock is still
  // live. A local timer alone would keep showing time remaining after an
  // expiry the server had already enforced.
  useEffect(() => {
    if (!connection) {
      setGuard(null);
      return;
    }
    let cancelled = false;
    async function poll() {
      try {
        const status = await guardStatus();
        if (!cancelled) setGuard(status);
      } catch {
        // A failed poll is not worth an error banner; the next one
        // will either succeed or the connection is gone anyway.
      }
    }
    void poll();
    const handle = window.setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [connection]);

  const locked =
    guard?.policy === "read_only" &&
    guard.unlocked_seconds_remaining === null;
  const unlocked =
    guard?.policy === "read_only" &&
    guard.unlocked_seconds_remaining !== null;

  const doUnlock = useCallback(async (typedName: string) => {
    try {
      await unlock(typedName);
      setUnlockOpen(false);
      setGuard(await guardStatus());
    } catch (e) {
      setError(asAppError(e));
    }
  }, []);
```

- [ ] **Step 3: The banner and the red chrome**

In the render, immediately inside `<div className="main-pane">`:

```tsx
        {unlocked && (
          <div className="unlock-banner">
            <span>
              Unlocked for writes ·{" "}
              {formatCountdown(guard?.unlocked_seconds_remaining ?? 0)}
            </span>
            <button
              onClick={() => {
                void relock().then(async () => setGuard(await guardStatus()));
              }}
            >
              Relock
            </button>
          </div>
        )}
```

Put the red chrome on the outer element, so an unlocked production connection is unmistakable across the whole window rather than in one corner:

```tsx
    <main className={`app with-sidebar${unlocked ? " unlocked" : ""}`}>
```

- [ ] **Step 4: Render the denial with an Unlock action**

Where the query error is rendered, special-case the guard's kind. Find the `StatusBar` usage and add above it:

```tsx
        {error?.kind === "write_blocked" && locked && (
          <div className="guard-denial">
            <span>{error.message}</span>
            <button onClick={() => setUnlockOpen(true)}>Unlock…</button>
          </div>
        )}
```

and render the dialog beside the other modals:

```tsx
      {unlockOpen && connection && (
        <UnlockDialog
          connectionName={
            connections.find((c) => c.id === connection.id)?.name ?? ""
          }
          onConfirm={(name) => void doUnlock(name)}
          onCancel={() => setUnlockOpen(false)}
        />
      )}
```

- [ ] **Step 5: Styles**

Append to `src/App.css`, checking the `:root` names first:

```css
/* ---- write guard ------------------------------------------------ */

/* An unlocked production connection is stated by the whole window, not
   by one badge in a corner. */
.app.unlocked {
  box-shadow: inset 0 0 0 2px var(--error);
}

.unlock-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
  padding: var(--s-1) var(--s-3);
  background: color-mix(in srgb, var(--error) 18%, transparent);
  color: var(--text);
  font-size: var(--t-sm);
}

.unlock-banner button {
  height: 22px;
  padding: 0 var(--s-2);
  background: none;
  border: 1px solid var(--error);
  border-radius: 4px;
  color: var(--text);
  font-size: var(--t-sm);
}

.guard-denial {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border-top: 1px solid var(--border);
  color: var(--error);
  font-size: var(--t-sm);
}

.modal button.danger {
  background: var(--error);
}
```

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit && npm test && npm run build
```

Expected: clean, 130 TS tests passing (128 baseline plus 2 from Task 8).

- [ ] **Step 7: Commit**

```bash
git add src/components/UnlockDialog.tsx src/App.tsx src/App.css
git commit -m "feat(guard): unlock a production connection from the UI"
```

---

### Task 10: Verify

- [ ] **Step 1: Everything**

```bash
cd src-tauri && cargo test
```

```bash
cd /Users/lepetitdev/dev/quarry && npx tsc --noEmit && npm test && npm run build
```

Expected: **Rust 163 passed** — 148 baseline, plus 12 in `guard_test`, 1 in `pool.rs`, and 2 in `guard_db_test`. **TypeScript 130.** Both clean. A different number means a task's tests did not all land; find out which before moving on.

- [ ] **Step 2: Confirm the guard cannot be bypassed by a second execute path**

```bash
grep -rn "run_query(" src-tauri/src
```

Expected: exactly two call sites — the definition in `exec/run.rs` and `commands.rs::execute`. If a third appears, it bypasses `decide` and must go through it.

- [ ] **Step 3: Hand over for smoke testing**

Report the counts and what to try by hand, on the `railway` PROD connection:

- Run a `SELECT` — works normally, no banner.
- Run `create table zzz_probe (id int)` — denied, with the guard's own message and an Unlock button.
- Click Unlock, type the wrong name — the button stays disabled.
- Type `railway` exactly — unlocks, red chrome appears, banner counts down.
- Run the `create table` again — succeeds.
- Click Relock — chrome and banner disappear; the same statement is denied again.
- Switch to the `lifegame` LOCAL connection — no banner, writes work, nothing changed.
- Reconnect to `railway` — locked again, because unlock is never persisted.

---

## Notes for the implementer

- **Never write a `_ => Access::Read` arm.** The classifier is safe because unknown statements fall through to `Write`. That is the single most important line-level rule in this stage.
- **The two layers are independent on purpose.** Do not "simplify" by dropping the session default and relying on the classifier, or vice versa. Task 7 exists to prove each stands alone.
- **`Instant`, not wall-clock time**, for the unlock deadline: changing the system clock must not extend an unlock.
- **The frontend countdown is decoration.** Rust re-checks the deadline on every statement. Never let the UI's number be the thing that authorises a write.
- **Do not run `cargo clippy` or `cargo fmt`.** Known-failing at baseline; see `docs/BACKLOG.md`.
