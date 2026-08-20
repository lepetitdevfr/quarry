//! The guarded write protocol, against a real Postgres.
//!
//! What matters here cannot be unit-tested: whether an unconfirmed write
//! is visible to anybody else, and whether discarding one really leaves
//! the table alone. Both are facts about transactions, so both need a
//! server.

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

/// How many rows still hold the original value, read on a *different*
/// connection — which is what makes it a test of visibility rather than
/// of our own transaction.
async fn untouched(db: &common::TestDb) -> i64 {
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

    let outcome = run_guarded(
        &db.pool,
        "update t set n = 2",
        Tag::Local,
        WriteKind::Update,
        None,
        None,
    )
    .await
    .expect("should run");

    assert!(matches!(outcome, Outcome::Done(_)));
    assert_eq!(untouched(&db).await, 0, "the update must have committed");
}

#[tokio::test]
async fn a_production_write_waits_and_is_invisible_until_confirmed() {
    let db = fixture().await;

    let outcome = run_guarded(
        &db.pool,
        "update t set n = 2",
        Tag::Prod,
        WriteKind::Update,
        None,
        None,
    )
    .await
    .expect("should run");

    let parked = match outcome {
        Outcome::Waiting {
            parked, affected, ..
        } => {
            assert_eq!(affected, Some(5));
            parked
        }
        Outcome::Done(_) => panic!("production must ask"),
    };

    assert_eq!(
        untouched(&db).await,
        5,
        "an unconfirmed write must not be visible to anybody else"
    );

    resolve(parked, true).await.expect("commit");
    assert_eq!(untouched(&db).await, 0, "confirming must commit it");
}

#[tokio::test]
async fn discarding_a_parked_write_leaves_the_table_alone() {
    let db = fixture().await;

    let outcome = run_guarded(
        &db.pool,
        "delete from t",
        Tag::Prod,
        WriteKind::Delete,
        None,
        None,
    )
    .await
    .expect("should run");

    let parked = match outcome {
        Outcome::Waiting { parked, .. } => parked,
        Outcome::Done(_) => panic!("production must ask"),
    };

    let result = resolve(parked, false).await.expect("rollback");
    assert_eq!(
        result.affected_rows,
        Some(0),
        "a discarded write affected nothing, and must say so"
    );
    assert_eq!(untouched(&db).await, 5, "discarding must roll it back");
}

#[tokio::test]
async fn a_mismatched_expectation_rolls_back_and_names_both_numbers() {
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
    assert!(
        message.contains('1') && message.contains('5'),
        "message was: {message}"
    );
    assert_eq!(
        untouched(&db).await,
        5,
        "a refused write must change nothing"
    );
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
    assert_eq!(untouched(&db).await, 0);
}

#[tokio::test]
async fn a_write_with_returning_is_counted_by_the_rows_it_returns() {
    // `update … returning` reports rows rather than an affected count,
    // and the number shown must still be the number that changed.
    let db = fixture().await;

    let outcome = run_guarded(
        &db.pool,
        "update t set n = 2 returning id",
        Tag::Prod,
        WriteKind::Update,
        None,
        None,
    )
    .await
    .expect("should run");

    match outcome {
        Outcome::Waiting {
            parked, affected, ..
        } => {
            assert_eq!(affected, Some(5));
            resolve(parked, false).await.expect("rollback");
        }
        Outcome::Done(_) => panic!("production must ask"),
    }
}

#[tokio::test]
async fn a_write_that_fails_leaves_no_transaction_open() {
    // The connection goes back to the pool either way; one left inside a
    // failed transaction would poison whoever checks it out next.
    let db = fixture().await;

    let err = run_guarded(
        &db.pool,
        "update t set nope = 1",
        Tag::Local,
        WriteKind::Update,
        None,
        None,
    )
    .await
    .expect_err("the column does not exist");
    assert!(err.to_string().contains("nope"), "message was: {err}");

    // The pool still works, which it would not if a broken transaction
    // had been handed back.
    assert_eq!(untouched(&db).await, 5);
}

#[tokio::test]
async fn resolving_a_transaction_that_has_already_ended_changes_nothing() {
    // The idle timeout is what makes parking safe, so `resolve` has to
    // treat a dead transaction as an outcome rather than a crash.
    let db = fixture().await;

    let outcome = run_guarded(
        &db.pool,
        "update t set n = 2",
        Tag::Prod,
        WriteKind::Update,
        None,
        None,
    )
    .await
    .expect("should run");

    let parked = match outcome {
        Outcome::Waiting { parked, .. } => parked,
        Outcome::Done(_) => panic!("production must ask"),
    };

    // End it out from under the parked handle, the way the server's idle
    // timeout would.
    parked
        .client
        .batch_execute("rollback")
        .await
        .expect("end the transaction");

    let _ = resolve(parked, true).await;
    assert_eq!(
        untouched(&db).await,
        5,
        "a transaction the server ended must not commit afterwards"
    );
}
