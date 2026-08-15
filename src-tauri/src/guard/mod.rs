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

        // `EXPLAIN ANALYZE` actually runs the statement it explains —
        // real execution, real timing — so it is treated as a write
        // unconditionally rather than trusted to inherit the inner
        // statement's classification. Plain `EXPLAIN` only plans and
        // never runs anything, so it stays a read no matter what it
        // is explaining.
        Statement::Explain { analyze, .. } => {
            if *analyze {
                Access::Write
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
        // `SELECT ... INTO new_table FROM ...` creates and populates a
        // table — a write wearing a read's syntax, same idea as the
        // data-modifying CTEs above. Without this check it would slip
        // through as a plain `SetExpr::Select`.
        SetExpr::Select(select) if select.into.is_some() => Access::Write,
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
