use quarry_lib::edit::plan_apply;
use quarry_lib::edit::sql::{Statement, StatementKind};
use quarry_lib::guard::Policy;
use std::time::{Duration, Instant};

fn one_update() -> Vec<Statement> {
    vec![Statement {
        sql: "update \"public\".\"users\" set \"email\" = $1::text::\"pg_catalog\".\"text\" \
              where \"id\" = $2::text::\"pg_catalog\".\"text\" returning \"email\""
            .to_string(),
        params: vec![Some("a@b.co".to_string()), Some("1".to_string())],
        row: 0,
        returned: vec![1],
        kind: StatementKind::Update,
    }]
}

#[test]
fn a_free_connection_applies() {
    let now = Instant::now();
    let read_write = plan_apply(Policy::Free, None, now, &one_update()).expect("free must allow");
    // `decide` grants `read_write` unconditionally on a free connection
    // — pinned by `a_free_connection_allows_everything` in guard_test —
    // and this forwards that answer rather than inventing its own, the
    // same as `commands::execute`. On a free connection the session was
    // never read-only, so the explicit BEGIN READ WRITE costs nothing.
    assert!(read_write);
}

#[test]
fn a_locked_connection_refuses() {
    let now = Instant::now();
    let error = plan_apply(Policy::ReadOnly, None, now, &one_update())
        .expect_err("a locked connection must refuse an edit");
    assert!(
        format!("{error}").contains("read-only"),
        "error was: {error}"
    );
}

#[test]
fn an_unlocked_connection_applies_and_opts_out() {
    let now = Instant::now();
    let deadline = now + Duration::from_secs(600);
    let read_write =
        plan_apply(Policy::ReadOnly, Some(deadline), now, &one_update()).expect("unlocked allows");
    assert!(read_write, "an unlocked write needs BEGIN READ WRITE");
}

#[test]
fn an_expired_unlock_refuses() {
    let now = Instant::now();
    let deadline = now - Duration::from_secs(1);
    plan_apply(Policy::ReadOnly, Some(deadline), now, &one_update())
        .expect_err("an expired unlock must refuse");
}

#[test]
fn nothing_to_apply_is_still_refused_while_locked() {
    // An empty batch is harmless, but answering "fine" on a locked
    // connection would mean the gate depends on the payload.
    let now = Instant::now();
    plan_apply(Policy::ReadOnly, None, now, &[]).expect_err("locked refuses regardless");
}
