//! `sslmode` must be enforced, not merely attempted.
//!
//! The testcontainer Postgres is built without TLS support, which makes
//! it the perfect subject: a client that honours `require` cannot talk
//! to it at all, while one that only *prefers* TLS quietly falls back to
//! an unencrypted socket and succeeds.
//!
//! That silent fallback is the bug these tests exist to prevent. A user
//! who picks "require" is asserting the traffic must be encrypted; if we
//! connect in plaintext anyway, we have lied to them.

mod common;

use quarry_lib::conn::{build_pool, ping, ConnectionConfig};
use quarry_lib::guard::Policy;

fn config_for(port: u16, sslmode: &str) -> ConnectionConfig {
    let url = format!("postgres://postgres:postgres@localhost:{port}/postgres?sslmode={sslmode}");
    ConnectionConfig::from_url(&url).expect("test URL should parse")
}

#[tokio::test]
async fn require_refuses_a_server_without_tls() {
    let db = common::start().await;

    let pool =
        build_pool(&config_for(db.port, "require"), Policy::Free).expect("pool should build");
    let result = ping(&pool, "test").await;

    assert!(
        result.is_err(),
        "sslmode=require connected to a server with no TLS — the connection \
         silently fell back to plaintext, which is exactly what require forbids",
    );
}

#[tokio::test]
async fn prefer_falls_back_to_plaintext() {
    let db = common::start().await;

    // The counterpart to the test above: `prefer` is allowed to fall
    // back, and must still connect. If this ever fails, the fix above
    // has been over-applied and every non-TLS database is unreachable.
    let pool = build_pool(&config_for(db.port, "prefer"), Policy::Free).expect("pool should build");
    let version = ping(&pool, "test")
        .await
        .expect("prefer should fall back and connect");

    assert!(version.contains("PostgreSQL"));
}

#[tokio::test]
async fn disable_connects_without_tls() {
    let db = common::start().await;

    let pool =
        build_pool(&config_for(db.port, "disable"), Policy::Free).expect("pool should build");
    let version = ping(&pool, "test").await.expect("disable should connect");

    assert!(version.contains("PostgreSQL"));
}

#[tokio::test]
async fn verify_full_refuses_a_server_without_tls() {
    let db = common::start().await;

    // Same shape as `require_refuses_a_server_without_tls`: the
    // testcontainer has no TLS at all, so `verify-full` must refuse it
    // just as `require` does. This does not exercise the certificate
    // verification path itself (see the module doc comment on the
    // coverage gap there) — it only proves `verify-full` still mandates
    // TLS and does not fall back to plaintext.
    let pool =
        build_pool(&config_for(db.port, "verify-full"), Policy::Free).expect("pool should build");
    let result = ping(&pool, "test").await;

    assert!(
        result.is_err(),
        "sslmode=verify-full connected to a server with no TLS — the connection \
         silently fell back to plaintext, which is exactly what verify-full forbids",
    );
}
