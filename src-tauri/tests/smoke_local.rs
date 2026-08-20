//! End-to-end checks against a hand-started Postgres, used for the
//! Stage 1 smoke test. These are `#[ignore]`d because they need a
//! database this test file does not create — CI must not depend on it.
//!
//! Start the database first:
//!
//! ```sh
//! docker run --rm -d --name quarry-smoke \
//!   -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17
//! ```
//!
//! Then run: `cargo test --test smoke_local -- --ignored --nocapture`

use quarry_lib::conn::{build_pool, ping, ConnectionConfig};
use quarry_lib::exec::run_query;
use quarry_lib::guard::Policy;

const URL: &str = "postgres://postgres:postgres@localhost:55432/postgres?sslmode=disable";

fn pool() -> deadpool_postgres::Pool {
    let cfg = ConnectionConfig::from_url(URL).expect("URL should parse");
    build_pool(&cfg, Policy::Free).expect("pool should build")
}

#[tokio::test]
#[ignore]
async fn connects_and_reports_server_version() {
    let version = ping(&pool(), "test").await.expect("ping should succeed");
    println!("server: {version}");
    assert!(version.contains("PostgreSQL"));
}

#[tokio::test]
#[ignore]
async fn reads_fifty_thousand_rows() {
    let result = run_query(&pool(), "select * from users", false)
        .await
        .expect("query should succeed");

    println!(
        "rows={} cols={} duration={}ms",
        result.row_count,
        result.columns.len(),
        result.duration_ms
    );

    assert_eq!(result.row_count, 50_002);
    assert_eq!(result.columns.len(), 6);
}

#[tokio::test]
#[ignore]
async fn null_and_empty_string_stay_distinguishable() {
    // The grid renders these differently; if the backend collapsed them
    // the UI could not tell a missing value from a present empty one.
    let result = run_query(
        &pool(),
        "select email from users where plan = 'edge' order by email nulls last",
        false,
    )
    .await
    .expect("query should succeed");

    assert_eq!(result.row_count, 2);
    assert_eq!(result.rows[0][0], serde_json::json!(""));
    assert_eq!(result.rows[1][0], serde_json::Value::Null);
}

#[tokio::test]
#[ignore]
async fn jsonb_survives_the_round_trip() {
    let result = run_query(&pool(), "select meta from users where id = 1", false)
        .await
        .expect("query should succeed");

    assert_eq!(result.rows[0][0], serde_json::json!({"n": 1}));
}

#[tokio::test]
#[ignore]
async fn a_missing_table_reports_its_sqlstate() {
    let err = run_query(&pool(), "select * from nope", false)
        .await
        .expect_err("query should fail");

    // Serialize the way the UI receives it, so this asserts on the real
    // IPC payload rather than the internal Rust shape.
    let payload = serde_json::to_value(&err).expect("error should serialize");
    println!("error payload: {payload}");

    assert_eq!(payload["kind"], "query");
    assert_eq!(payload["code"], "42P01", "SQLSTATE for undefined_table");
    assert!(payload["message"]
        .as_str()
        .unwrap_or_default()
        .contains("nope"));
    assert!(
        payload["position"].as_u64().is_some(),
        "position should survive to the UI so the editor can underline"
    );
}

#[tokio::test]
#[ignore]
async fn an_empty_result_still_reports_its_columns() {
    let result = run_query(&pool(), "select id, email from users where false", false)
        .await
        .expect("query should succeed");

    assert_eq!(result.row_count, 0);
    assert_eq!(result.columns.len(), 2);
    assert_eq!(result.columns[0].name, "id");
    assert_eq!(result.columns[1].name, "email");
}
