mod common;

use quarry_lib::conn::{build_pool, ping, ConnectionConfig, SslMode};
use quarry_lib::guard::Policy;

/// Reproduces the bug this change fixes: a saved connection with no
/// password configured for a server that requires one.
///
/// `build_pool` never touches the network, so it succeeds regardless of
/// whether a password was supplied — the failure only shows up once we
/// actually try to use the pool. The testcontainers Postgres image (like
/// the fixture the bug was diagnosed against) demands SCRAM
/// authentication, so connecting with `password: None` fails at
/// `ping`'s first checkout, and tokio-postgres reports it as "invalid
/// configuration" — a message that names neither a wrong password nor a
/// missing one. `connect_saved` (src-tauri/src/commands.rs) relies on
/// exactly this: it distinguishes "no password was ever supplied" from
/// other errors by whether the attempt was made without one, and maps
/// that case to `AppError::PasswordRequired` instead of forwarding this
/// unhelpful driver message to the UI.
#[tokio::test]
async fn connecting_with_no_password_fails() {
    let db = common::start().await;

    let cfg = ConnectionConfig {
        host: "localhost".to_string(),
        port: db.port,
        user: "postgres".to_string(),
        dbname: "postgres".to_string(),
        password: None,
        sslmode: SslMode::Disable,
    };

    // build_pool is purely local setup — it never contacts the server,
    // so it succeeds even though the config is missing a password the
    // server will demand.
    let pool = build_pool(&cfg, Policy::Free).expect("build_pool should succeed even without a password");

    let err = ping(&pool)
        .await
        .expect_err("ping should fail: the server requires a password we didn't supply");

    // Documented here so a future reader isn't left guessing why
    // `connect_saved` treats "no password" specially instead of trying
    // to pattern-match this message: tokio-postgres's own wording gives
    // no indication that a password is the issue.
    let message = err.to_string();
    assert!(
        message.contains("invalid configuration"),
        "expected tokio-postgres's generic auth-config failure, got: {message}"
    );
}
