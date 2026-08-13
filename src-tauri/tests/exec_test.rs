mod common;

use quarry_lib::exec::run_query;
use serde_json::json;

#[tokio::test]
async fn converts_every_supported_type() {
    let db = common::start().await;

    let sql = "SELECT
        true::bool                              as a_bool,
        42::int2                                as a_int2,
        42::int4                                as a_int4,
        42::int8                                as a_int8,
        1.5::float4                             as a_float4,
        1.5::float8                             as a_float8,
        '12.34'::numeric                        as a_numeric,
        'hello'::text                           as a_text,
        'vc'::varchar                           as a_varchar,
        '2026-01-04'::date                      as a_date,
        '2026-01-04 10:30:00'::timestamp        as a_timestamp,
        '{\"k\": 1}'::jsonb                     as a_jsonb,
        '00000000-0000-0000-0000-000000000001'::uuid as a_uuid,
        null::text                              as a_null,
        ''::text                                as an_empty_string";

    let result = run_query(&db.pool, sql).await.expect("query should succeed");

    assert_eq!(result.row_count, 1);
    let row = &result.rows[0];
    let col = |name: &str| {
        let i = result
            .columns
            .iter()
            .position(|c| c.name == name)
            .unwrap_or_else(|| panic!("no column {name}"));
        row[i].clone()
    };

    assert_eq!(col("a_bool"), json!(true));
    assert_eq!(col("a_int2"), json!(42));
    assert_eq!(col("a_int4"), json!(42));
    assert_eq!(col("a_int8"), json!(42));
    assert_eq!(col("a_float4"), json!(1.5));
    assert_eq!(col("a_float8"), json!(1.5));
    assert_eq!(col("a_numeric"), json!("12.34"));
    assert_eq!(col("a_text"), json!("hello"));
    assert_eq!(col("a_varchar"), json!("vc"));
    assert_eq!(col("a_date"), json!("2026-01-04"));
    assert_eq!(col("a_timestamp"), json!("2026-01-04T10:30:00"));
    assert_eq!(col("a_jsonb"), json!({"k": 1}));
    assert_eq!(
        col("a_uuid"),
        json!("00000000-0000-0000-0000-000000000001")
    );

    // The distinction the UI depends on: NULL and '' must not collapse.
    assert_eq!(col("a_null"), serde_json::Value::Null);
    assert_eq!(col("an_empty_string"), json!(""));
}

#[tokio::test]
async fn reports_column_names_and_types() {
    let db = common::start().await;

    let result = run_query(&db.pool, "SELECT 1 as n, 'x' as s")
        .await
        .expect("query should succeed");

    assert_eq!(result.columns.len(), 2);
    assert_eq!(result.columns[0].name, "n");
    assert_eq!(result.columns[0].type_name, "int4");
    assert_eq!(result.columns[1].name, "s");
    assert_eq!(result.columns[1].type_name, "text");
}

#[tokio::test]
async fn returns_an_empty_result_without_error() {
    let db = common::start().await;

    let result = run_query(&db.pool, "SELECT 1 WHERE false")
        .await
        .expect("query should succeed");

    assert_eq!(result.row_count, 0);
    assert!(result.rows.is_empty());
    assert_eq!(result.columns.len(), 1);
}

#[tokio::test]
async fn surfaces_postgres_errors_with_code_and_position() {
    let db = common::start().await;

    let err = run_query(&db.pool, "SELECT * FROM table_that_does_not_exist")
        .await
        .expect_err("query should fail");

    let msg = err.to_string();
    assert!(
        msg.contains("table_that_does_not_exist"),
        "message should name the missing table, got: {msg}"
    );
}

#[tokio::test]
async fn unsupported_types_do_not_crash_the_query() {
    let db = common::start().await;

    // point has no Rust mapping in our conversion table.
    let result = run_query(&db.pool, "SELECT '(1,2)'::point as p")
        .await
        .expect("query should still succeed");

    let cell = &result.rows[0][0];
    assert!(
        cell.as_str().unwrap_or("").contains("unsupported"),
        "expected a placeholder string, got: {cell}"
    );
}
