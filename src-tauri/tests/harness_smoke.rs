mod common;

#[tokio::test]
async fn harness_starts_a_working_postgres() {
    let db = common::start().await;
    let version = quarry_lib::conn::ping(&db.pool)
        .await
        .expect("ping should succeed against the container");
    assert!(
        version.contains("PostgreSQL"),
        "expected a version string, got: {version}"
    );
}
