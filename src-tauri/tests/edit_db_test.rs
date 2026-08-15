mod common;

use quarry_lib::exec::run_query;
use quarry_lib::schema::lookup_table;

/// Create a table and return its oid, the way the result metadata
/// would report it.
async fn oid_of(pool: &deadpool_postgres::Pool, name: &str) -> u32 {
    // Cast to int8, not left as `oid`: `exec::value::cell_to_json` has
    // no arm for the oid type, so it would come back as a string.
    let result = run_query(
        pool,
        &format!("select '{name}'::regclass::oid::int8 as oid"),
        false,
    )
    .await
    .expect("oid lookup should run");
    result.rows[0][0].as_u64().expect("oid should be a number") as u32
}

#[tokio::test]
async fn lookup_table_reports_columns_and_the_primary_key() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text, plan text)",
        false,
    )
    .await
    .expect("create table");

    let oid = oid_of(&db.pool, "people").await;
    let facts = lookup_table(&db.pool, oid)
        .await
        .expect("lookup should run")
        .expect("the table exists");

    assert_eq!(facts.relkind, "r");
    assert_eq!(facts.schema, "public");
    assert_eq!(facts.table, "people");
    assert_eq!(facts.columns.len(), 3);
    assert_eq!(facts.columns[0], (1, "id".to_string(), true));
    assert_eq!(facts.columns[1], (2, "email".to_string(), false));
}

#[tokio::test]
async fn lookup_table_reports_a_view_as_a_view() {
    let db = common::start().await;

    run_query(&db.pool, "create table people (id int primary key)", false)
        .await
        .expect("create table");
    run_query(
        &db.pool,
        "create view people_v as select * from people",
        false,
    )
    .await
    .expect("create view");

    let oid = oid_of(&db.pool, "people_v").await;
    let facts = lookup_table(&db.pool, oid)
        .await
        .expect("lookup should run")
        .expect("the view exists");

    assert_eq!(facts.relkind, "v");
}

#[tokio::test]
async fn lookup_table_skips_dropped_columns() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, junk text, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(&db.pool, "alter table people drop column junk", false)
        .await
        .expect("drop column");

    let oid = oid_of(&db.pool, "people").await;
    let facts = lookup_table(&db.pool, oid)
        .await
        .expect("lookup should run")
        .expect("the table exists");

    // A dropped column keeps its attnum forever. Including it would
    // shift nothing, but it would let a stale attnum match.
    assert_eq!(facts.columns.len(), 2);
    assert!(facts.columns.iter().all(|(_, name, _)| name != "junk"));
}

#[tokio::test]
async fn lookup_table_returns_none_for_an_unknown_oid() {
    let db = common::start().await;

    let facts = lookup_table(&db.pool, 1).await.expect("lookup should run");
    assert!(facts.is_none());
}

#[tokio::test]
async fn a_single_table_select_comes_back_editable() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select should run");

    assert!(result.edit.editable, "reason: {:?}", result.edit.reason);
    assert_eq!(result.edit.table.as_deref(), Some("people"));
    assert_eq!(result.edit.pk[0].result_index, 0);
    assert!(result.edit.columns[1].editable);
}

#[tokio::test]
async fn an_aggregate_comes_back_not_editable() {
    let db = common::start().await;

    run_query(&db.pool, "create table people (id int primary key)", false)
        .await
        .expect("create table");

    let result = run_query(&db.pool, "select count(*) from people", false)
        .await
        .expect("select should run");

    assert!(!result.edit.editable);
    assert!(
        result.edit.reason.unwrap_or_default().contains("computed"),
        "expected a computed-values reason"
    );
}

#[tokio::test]
async fn a_join_comes_back_not_editable() {
    let db = common::start().await;

    run_query(&db.pool, "create table a (id int primary key)", false)
        .await
        .expect("create a");
    run_query(&db.pool, "create table b (id int primary key)", false)
        .await
        .expect("create b");

    let result = run_query(
        &db.pool,
        "select a.id, b.id from a join b on a.id = b.id",
        false,
    )
    .await
    .expect("select should run");

    assert!(!result.edit.editable);
    assert!(
        result
            .edit
            .reason
            .unwrap_or_default()
            .contains("joins 2 tables"),
        "expected a join reason"
    );
}

#[tokio::test]
async fn a_view_comes_back_not_editable() {
    let db = common::start().await;

    run_query(&db.pool, "create table people (id int primary key)", false)
        .await
        .expect("create table");
    run_query(
        &db.pool,
        "create view people_v as select * from people",
        false,
    )
    .await
    .expect("create view");

    let result = run_query(&db.pool, "select id from people_v", false)
        .await
        .expect("select should run");

    assert!(!result.edit.editable);
    assert!(
        result.edit.reason.unwrap_or_default().contains("view"),
        "expected a view reason"
    );
}

#[tokio::test]
async fn a_table_without_a_key_comes_back_not_editable() {
    let db = common::start().await;

    run_query(&db.pool, "create table notes (body text)", false)
        .await
        .expect("create table");

    let result = run_query(&db.pool, "select body from notes", false)
        .await
        .expect("select should run");

    assert!(!result.edit.editable);
    assert!(
        result
            .edit
            .reason
            .unwrap_or_default()
            .contains("no primary key"),
        "expected a no-primary-key reason"
    );
}
