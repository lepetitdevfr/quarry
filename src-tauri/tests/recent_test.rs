//! History: what the app keeps of work you ran or closed.
//!
//! No Docker here — this is the workspace SQLite, not a user database.

use quarry_lib::conn::config::SslMode;
use quarry_lib::library::model::{ConnectionInput, Tag};
use quarry_lib::library::store::Store;
use tempfile::tempdir;

/// A store with two real connections in it.
///
/// Real ones, not made-up ids: `recent.connection_id` is a foreign key,
/// which is what makes deleting a connection blank the column instead
/// of taking the work with it.
fn store() -> (Store, String, String, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let store = Store::open_at(&dir.path().join("library.db")).unwrap();
    let a = store.create_connection(input("alpha")).unwrap().id;
    let b = store.create_connection(input("beta")).unwrap().id;
    (store, a, b, dir)
}

fn input(name: &str) -> ConnectionInput {
    ConnectionInput {
        name: name.to_string(),
        host: "localhost".to_string(),
        port: 5432,
        user: "postgres".to_string(),
        dbname: "postgres".to_string(),
        sslmode: SslMode::Disable,
        tag: Tag::Local,
        colour: None,
        password: None,
    }
}

#[test]
fn a_run_is_recorded_with_its_result() {
    let (store, conn_a, _conn_b, _dir) = store();

    store
        .record_run("select 1", Some(&conn_a), Some(12), Some(1), None)
        .unwrap();

    let all = store.recent().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].sql, "select 1");
    assert_eq!(all[0].kind, "run");
    assert_eq!(all[0].run_count, 1);
    assert_eq!(all[0].duration_ms, Some(12));
    assert_eq!(all[0].error, None);
}

#[test]
fn a_failed_run_is_recorded_with_its_error() {
    // The query you spent ten minutes failing to get right is work.
    let (store, conn_a, _conn_b, _dir) = store();

    store
        .record_run("slect 1", Some(&conn_a), None, None, Some("syntax error"))
        .unwrap();

    let all = store.recent().unwrap();
    assert_eq!(all[0].error.as_deref(), Some("syntax error"));
}

#[test]
fn re_running_the_same_statement_collapses_and_counts() {
    let (store, conn_a, _conn_b, _dir) = store();

    store
        .record_run("select 1", Some(&conn_a), Some(10), Some(1), None)
        .unwrap();
    store
        .record_run("select 1", Some(&conn_a), Some(20), Some(1), None)
        .unwrap();
    store
        .record_run("select 1", Some(&conn_a), Some(30), Some(1), None)
        .unwrap();

    let all = store.recent().unwrap();
    assert_eq!(all.len(), 1, "a debugging loop must not fill the list");
    assert_eq!(all[0].run_count, 3);
    assert_eq!(all[0].duration_ms, Some(30), "the last run's timing wins");
}

#[test]
fn the_same_statement_against_another_connection_is_another_row() {
    // Same text, different database, different work.
    let (store, conn_a, conn_b, _dir) = store();

    store
        .record_run("select 1", Some(&conn_a), Some(10), Some(1), None)
        .unwrap();
    store
        .record_run("select 1", Some(&conn_b), Some(10), Some(1), None)
        .unwrap();

    assert_eq!(store.recent().unwrap().len(), 2);
}

#[test]
fn two_closed_drafts_with_the_same_text_stay_two_rows() {
    // Collapsing them would lose one piece of work.
    let (store, conn_a, _conn_b, _dir) = store();

    store
        .record_closed("select 1", Some(&conn_a), None)
        .unwrap();
    store
        .record_closed("select 1", Some(&conn_a), None)
        .unwrap();

    let all = store.recent().unwrap();
    assert_eq!(all.len(), 2);
    assert!(all.iter().all(|r| r.kind == "closed"));
}

#[test]
fn a_closed_tab_keeps_its_title() {
    let (store, conn_a, _conn_b, _dir) = store();

    store
        .record_closed("select 1", Some(&conn_a), Some("scratch"))
        .unwrap();

    assert_eq!(store.recent().unwrap()[0].title.as_deref(), Some("scratch"));
}

#[test]
fn deleting_a_row_removes_only_that_row() {
    let (store, conn_a, _conn_b, _dir) = store();
    store
        .record_run("select 1", Some(&conn_a), Some(1), Some(1), None)
        .unwrap();
    store
        .record_run("select 2", Some(&conn_a), Some(1), Some(1), None)
        .unwrap();

    let target = store.recent().unwrap()[0].id.clone();
    store.delete_recent(&target).unwrap();

    let left = store.recent().unwrap();
    assert_eq!(left.len(), 1);
    assert_ne!(left[0].id, target);
}

#[test]
fn rows_come_back_newest_first() {
    let (store, conn_a, _conn_b, _dir) = store();
    store
        .record_run("select 1", Some(&conn_a), Some(1), Some(1), None)
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    store
        .record_run("select 2", Some(&conn_a), Some(1), Some(1), None)
        .unwrap();

    let all = store.recent().unwrap();
    assert_eq!(all[0].sql, "select 2");
}

#[test]
fn deleting_a_connection_keeps_the_work_written_against_it() {
    // The work outlives its origin. Deleting a connection must cost you
    // the origin chip on a row, never the query you wrote.
    let (store, conn_a, _conn_b, _dir) = store();
    store
        .record_run("select 1", Some(&conn_a), Some(1), Some(1), None)
        .unwrap();

    store.delete_connection(&conn_a).unwrap();

    let all = store.recent().unwrap();
    assert_eq!(all.len(), 1, "the row must survive its connection");
    assert_eq!(all[0].connection_id, None);
    assert_eq!(all[0].sql, "select 1");
}

#[test]
fn closing_a_scratch_tab_keeps_its_text() {
    // The defect: closing a tab used to destroy what you had typed,
    // with no recovery of any kind.
    let (store, conn_a, _conn_b, _dir) = store();
    let tab = store.open_tab(None).unwrap();
    store.save_scratch(&tab.id, "select 42").unwrap();

    store.close_tab(&tab.id, Some(&conn_a)).unwrap();

    let all = store.recent().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].sql, "select 42");
    assert_eq!(all[0].kind, "closed");
    assert_eq!(all[0].connection_id.as_deref(), Some(conn_a.as_str()));
}

#[test]
fn closing_an_empty_tab_records_nothing() {
    // There is nothing to recover, and a list of blank rows is noise.
    let (store, _conn_a, _conn_b, _dir) = store();
    let tab = store.open_tab(None).unwrap();

    store.close_tab(&tab.id, None).unwrap();

    assert!(store.recent().unwrap().is_empty());
}

#[test]
fn closing_a_saved_querys_tab_records_nothing() {
    // Its text is in `queries`; a recent row would duplicate work that
    // was never at risk.
    let (store, _conn_a, _conn_b, _dir) = store();
    let query = store.create_query("saved", "select 42", None).unwrap();
    let tab = store.open_tab(Some(&query.id)).unwrap();
    store.save_scratch(&tab.id, "select 42").unwrap();

    store.close_tab(&tab.id, None).unwrap();

    assert!(store.recent().unwrap().is_empty());
}

#[test]
fn closing_a_tab_holding_only_whitespace_records_nothing() {
    // A tab you typed a newline into and abandoned is not work. This is
    // distinct from the empty case: `scratch_sql` is NULL on a fresh
    // tab and a real string here, so only one of the two guards catches
    // each.
    let (store, _conn_a, _conn_b, _dir) = store();
    let tab = store.open_tab(None).unwrap();
    store.save_scratch(&tab.id, "  \n\t ").unwrap();

    store.close_tab(&tab.id, None).unwrap();

    assert!(store.recent().unwrap().is_empty());
}
