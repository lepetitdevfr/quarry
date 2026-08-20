mod common;

use quarry_lib::commands::test_connection;
use quarry_lib::conn::SslMode;
use quarry_lib::library::model::{ConnectionInput, Tag};

/// The form's fields, pointed at the throwaway database.
fn input(port: u16, password: Option<&str>) -> ConnectionInput {
    ConnectionInput {
        name: "typed but not saved".to_string(),
        host: "localhost".to_string(),
        port,
        user: "postgres".to_string(),
        dbname: "postgres".to_string(),
        sslmode: SslMode::Disable,
        tag: Tag::Local,
        colour: None,
        password: password.map(str::to_string),
    }
}

/// Saving used to be the only way to find out whether a connection
/// worked: wrong credentials were discovered after committing them to
/// disk and clicking the row.
#[tokio::test]
async fn a_reachable_server_answers_with_its_version() {
    let db = common::start().await;

    let version = test_connection(input(db.port, Some("postgres")), None)
        .await
        .expect("the fixture database is reachable");

    assert!(
        version.contains("PostgreSQL"),
        "a success should name the server that answered, got: {version}"
    );
}

#[tokio::test]
async fn a_wrong_password_fails_the_test_rather_than_the_save() {
    let db = common::start().await;

    let err = test_connection(input(db.port, Some("not-the-password")), None)
        .await
        .expect_err("a wrong password must not report success");

    let message = err.to_string();
    assert!(
        message.to_lowercase().contains("password"),
        "the reason should name the password, got: {message}"
    );
}

/// The whole point of testing before saving: nothing is written and
/// nothing is connected. A successful test leaves the app exactly as
/// disconnected as it was.
#[tokio::test]
async fn a_successful_test_stores_nothing_and_connects_nothing() {
    let db = common::start().await;

    test_connection(input(db.port, Some("postgres")), None)
        .await
        .expect("the fixture database is reachable");

    // `test_connection` takes no application state at all — it cannot
    // reach the active connection slot or the library. This asserts the
    // signature rather than the behaviour, which is the strongest thing
    // a test can say about an absence: if a later change gives it state,
    // this stops compiling.
    let _: fn(ConnectionInput, Option<String>) -> _ = test_connection;
}
