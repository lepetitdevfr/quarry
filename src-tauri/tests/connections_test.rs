use quarry_lib::conn::config::SslMode;
use quarry_lib::library::model::{ConnectionInput, Tag};
use quarry_lib::library::store::Store;

fn store() -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_at(&dir.path().join("w.db")).unwrap();
    (store, dir)
}

fn input(name: &str, tag: Tag) -> ConnectionInput {
    ConnectionInput {
        name: name.to_string(),
        host: "localhost".to_string(),
        port: 5432,
        user: "postgres".to_string(),
        dbname: "postgres".to_string(),
        sslmode: SslMode::Disable,
        tag,
        colour: None,
        password: None,
    }
}

#[test]
fn creates_and_lists_a_connection() {
    let (store, _dir) = store();

    store.create_connection(input("dev", Tag::Local)).unwrap();
    let all = store.connections().unwrap();

    assert_eq!(all.len(), 1);
    assert_eq!(all[0].name, "dev");
    assert_eq!(all[0].tag, Tag::Local);
    assert_eq!(all[0].port, 5432);
    assert_eq!(all[0].sslmode, SslMode::Disable);
    assert!(all[0].last_used_at.is_none(), "never used yet");
}

#[test]
fn defaults_the_colour_from_the_tag() {
    let (store, _dir) = store();

    let c = store.create_connection(input("prod", Tag::Prod)).unwrap();

    assert_eq!(c.colour, Tag::Prod.default_colour());
}

#[test]
fn keeps_an_explicit_colour() {
    let (store, _dir) = store();

    let mut i = input("dev", Tag::Local);
    i.colour = Some("#123456".to_string());
    let c = store.create_connection(i).unwrap();

    assert_eq!(c.colour, "#123456");
}

#[test]
fn rejects_an_empty_name() {
    let (store, _dir) = store();

    assert!(store.create_connection(input("   ", Tag::Local)).is_err());
}

#[test]
fn updates_a_connection() {
    let (store, _dir) = store();
    let c = store.create_connection(input("dev", Tag::Local)).unwrap();

    let mut i = input("dev-renamed", Tag::Staging);
    i.dbname = "other".to_string();
    store.update_connection(&c.id, i).unwrap();

    let all = store.connections().unwrap();
    assert_eq!(all[0].name, "dev-renamed");
    assert_eq!(all[0].tag, Tag::Staging);
    assert_eq!(all[0].dbname, "other");
}

#[test]
fn deletes_a_connection() {
    let (store, _dir) = store();
    let c = store.create_connection(input("dev", Tag::Local)).unwrap();

    store.delete_connection(&c.id).unwrap();

    assert!(store.connections().unwrap().is_empty());
}

#[test]
fn orders_by_most_recently_used_then_name() {
    let (store, _dir) = store();
    let a = store.create_connection(input("alpha", Tag::Local)).unwrap();
    let b = store.create_connection(input("beta", Tag::Local)).unwrap();
    let _c = store.create_connection(input("gamma", Tag::Local)).unwrap();

    store.touch_connection(&b.id).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    store.touch_connection(&a.id).unwrap();

    let names: Vec<String> = store
        .connections()
        .unwrap()
        .into_iter()
        .map(|c| c.name)
        .collect();

    // Used ones first, most recent first; never-used sort last by name.
    assert_eq!(names, vec!["alpha", "beta", "gamma"]);
}

#[test]
fn reads_a_single_connection() {
    let (store, _dir) = store();
    let c = store.create_connection(input("dev", Tag::Local)).unwrap();

    let found = store.connection(&c.id).unwrap();

    assert_eq!(found.name, "dev");
}

#[test]
fn reading_a_missing_connection_is_an_error() {
    let (store, _dir) = store();

    assert!(store.connection("nope").is_err());
}

#[test]
fn a_connection_survives_reopening_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("w.db");

    {
        let store = Store::open_at(&path).unwrap();
        store.create_connection(input("dev", Tag::Local)).unwrap();
    }

    let store = Store::open_at(&path).unwrap();
    assert_eq!(store.connections().unwrap().len(), 1);
}

#[test]
fn deleting_a_connection_removes_its_keychain_entry() {
    let (store, _dir) = store();
    let c = store.create_connection(input("dev", Tag::Local)).unwrap();

    quarry_lib::secrets::save_password(&c.id, "hunter2").unwrap();
    assert_eq!(
        quarry_lib::secrets::load_password(&c.id)
            .unwrap()
            .as_deref(),
        Some("hunter2"),
    );

    store.delete_connection(&c.id).unwrap();

    assert_eq!(
        quarry_lib::secrets::load_password(&c.id).unwrap(),
        None,
        "a deleted connection must not leave a credential behind",
    );
}

// ---- password resolution ---------------------------------------------
//
// `connect_saved` must prefer a password the user just typed over
// whatever the Keychain holds, and must not consult the Keychain at all
// in that case. The Keychain read is exactly what fails after a rebuild
// (macOS ties entries to the signing identity that created them), so a
// read that runs anyway makes the "enter the password again" retry
// impossible to complete.

#[test]
fn a_typed_password_wins_without_reading_the_keychain() {
    let mut consulted = false;
    let resolved = quarry_lib::commands::resolve_password(Some("typed".into()), || {
        consulted = true;
        Err(quarry_lib::error::AppError::Keychain("denied".into()))
    })
    .unwrap();

    assert_eq!(resolved.as_deref(), Some("typed"));
    assert!(
        !consulted,
        "a supplied password must not trigger a Keychain read, which is the \
         thing that fails after a rebuild"
    );
}

#[test]
fn an_empty_typed_password_falls_back_to_the_keychain() {
    // The field submits "" when the user just hits return; that is not
    // a password, it is the absence of one.
    let resolved =
        quarry_lib::commands::resolve_password(Some("".into()), || Ok(Some("stored".into())))
            .unwrap();

    assert_eq!(resolved.as_deref(), Some("stored"));
}

#[test]
fn a_keychain_failure_is_surfaced_when_nothing_was_typed() {
    // With no password to fall back on, the Keychain error is the whole
    // story and must reach the user.
    let result = quarry_lib::commands::resolve_password(None, || {
        Err(quarry_lib::error::AppError::Keychain("denied".into()))
    });

    assert!(
        result.is_err(),
        "a bare Keychain denial must not be swallowed"
    );
}

#[test]
fn no_password_anywhere_is_not_an_error() {
    let resolved = quarry_lib::commands::resolve_password(None, || Ok(None)).unwrap();
    assert_eq!(resolved, None);
}
