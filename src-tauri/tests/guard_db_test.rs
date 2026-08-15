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
