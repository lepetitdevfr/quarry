//! The write audit log. No Docker here — this is the workspace SQLite.

use quarry_lib::conn::config::SslMode;
use quarry_lib::library::model::{ConnectionInput, Tag, WriteEntry};
use quarry_lib::library::store::Store;
use tempfile::tempdir;

fn store() -> (Store, String, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let store = Store::open_at(&dir.path().join("library.db")).unwrap();
    let id = store
        .create_connection(ConnectionInput {
            name: "smoke".to_string(),
            host: "localhost".to_string(),
            port: 5432,
            user: "postgres".to_string(),
            dbname: "postgres".to_string(),
            sslmode: SslMode::Disable,
            tag: Tag::Local,
            colour: None,
            password: None,
        })
        .unwrap()
        .id;
    (store, id, dir)
}

fn entry(sql: &str, outcome: &str, connection_id: Option<&str>) -> WriteEntry {
    WriteEntry {
        connection_id: connection_id.map(str::to_string),
        connection_name: "smoke".to_string(),
        tag: "local".to_string(),
        sql: sql.to_string(),
        kind: "update".to_string(),
        row_count: Some(3),
        outcome: outcome.to_string(),
        reason: None,
        undo_sql: None,
    }
}

#[test]
fn a_committed_write_is_recorded() {
    let (store, conn_id, _dir) = store();

    store
        .record_write(entry("update t set a = 1", "committed", Some(&conn_id)))
        .unwrap();

    let all = store.writes().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].sql, "update t set a = 1");
    assert_eq!(all[0].outcome, "committed");
    assert_eq!(all[0].row_count, Some(3));
    assert_eq!(all[0].connection_name, "smoke");
}

#[test]
fn a_rollback_is_recorded_as_deliberately_as_a_commit() {
    // "I nearly truncated orders and stopped" is exactly the fact worth
    // having six months later.
    let (store, conn_id, _dir) = store();

    store
        .record_write(entry("truncate orders", "rolled_back", Some(&conn_id)))
        .unwrap();

    assert_eq!(store.writes().unwrap()[0].outcome, "rolled_back");
}

#[test]
fn identical_writes_never_collapse() {
    // Unlike history: every occurrence here is a separate fact.
    let (store, conn_id, _dir) = store();

    store
        .record_write(entry("update t set a = 1", "committed", Some(&conn_id)))
        .unwrap();
    store
        .record_write(entry("update t set a = 1", "committed", Some(&conn_id)))
        .unwrap();

    assert_eq!(store.writes().unwrap().len(), 2);
}

#[test]
fn deleting_a_connection_keeps_the_writes_made_against_it() {
    // The audit outlives the connection and still names the database:
    // that is why the name and tag are copied in rather than joined.
    let (store, conn_id, _dir) = store();
    store
        .record_write(entry("delete from t", "committed", Some(&conn_id)))
        .unwrap();

    store.delete_connection(&conn_id).unwrap();

    let all = store.writes().unwrap();
    assert_eq!(all.len(), 1, "the audit row must survive");
    assert_eq!(all[0].connection_id, None);
    assert_eq!(
        all[0].connection_name, "smoke",
        "it must still say which database it hit"
    );
    assert_eq!(all[0].tag, "local");
}

#[test]
fn writes_come_back_newest_first() {
    let (store, conn_id, _dir) = store();
    store
        .record_write(entry("update t set a = 1", "committed", Some(&conn_id)))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    store
        .record_write(entry("update t set a = 2", "committed", Some(&conn_id)))
        .unwrap();

    assert_eq!(store.writes().unwrap()[0].sql, "update t set a = 2");
}

#[test]
fn a_write_carries_its_undo_when_there_is_one() {
    let (store, conn_id, _dir) = store();
    let mut e = entry("update t set a = 1", "committed", Some(&conn_id));
    e.undo_sql = Some("update t set a = 0 where id = 1;".to_string());
    e.kind = "batch".to_string();

    store.record_write(e).unwrap();

    assert_eq!(
        store.writes().unwrap()[0].undo_sql.as_deref(),
        Some("update t set a = 0 where id = 1;")
    );
}

#[test]
fn a_refusal_records_its_reason() {
    let (store, conn_id, _dir) = store();
    let mut e = entry("update t set a = 1", "refused", Some(&conn_id));
    e.reason = Some("-- expect: 1, but 5 rows matched — rolled back".to_string());
    e.row_count = Some(5);

    store.record_write(e).unwrap();

    let all = store.writes().unwrap();
    assert_eq!(all[0].outcome, "refused");
    assert!(all[0].reason.as_deref().unwrap().contains("expect"));
}
