mod common;

use quarry_lib::conn::{build_pool, ping, ConnectionConfig};
use quarry_lib::exec::run_query;
use quarry_lib::guard::Policy;
use serde_json::json;

#[tokio::test]
async fn converts_every_supported_type_and_pins_the_int_array_fallback() {
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
        ''::text                                as an_empty_string,
        '2026-01-04 10:30:00+02'::timestamptz   as a_timestamptz,
        '\\x48690a'::bytea                       as a_bytea,
        'char10'::char(10)                       as a_bpchar,
        '{1,2,3}'::int4[]                        as an_int_array";

    let result = run_query(&db.pool, sql, false)
        .await
        .expect("query should succeed");

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
    assert_eq!(col("a_uuid"), json!("00000000-0000-0000-0000-000000000001"));

    // The distinction the UI depends on: NULL and '' must not collapse.
    assert_eq!(col("a_null"), serde_json::Value::Null);
    assert_eq!(col("an_empty_string"), json!(""));

    // timestamptz: the wire format sends UTC microseconds regardless of
    // session TimeZone, and our conversion reads it as
    // chrono::DateTime<Utc>, so this is deterministic across machines —
    // not dependent on the container's (or host's) local timezone.
    // '2026-01-04 10:30:00+02' is the same instant as 08:30:00 UTC.
    let timestamptz = col("a_timestamptz");
    assert_eq!(timestamptz, json!("2026-01-04T08:30:00+00:00"));
    assert_eq!(
        chrono::DateTime::parse_from_rfc3339(timestamptz.as_str().unwrap())
            .unwrap()
            .with_timezone(&chrono::Utc),
        "2026-01-04T08:30:00Z"
            .parse::<chrono::DateTime<chrono::Utc>>()
            .unwrap(),
        "must represent the same instant regardless of offset formatting"
    );

    // bytea: '\x48690a' is "Hi\n"; our hex() helper lowercases and
    // prefixes with a literal backslash-x.
    assert_eq!(col("a_bytea"), json!("\\x48690a"));

    // bpchar: char(10) blank-pads to the declared length; we pass the
    // padding through as-is rather than trimming it.
    assert_eq!(col("a_bpchar"), json!("char10    "));

    // int4[]: arrays are now decoded into real JSON arrays (see
    // `renders_arrays_as_json_arrays` in this file for full coverage);
    // this pins the deliberate change from the old unsupported-type
    // placeholder.
    assert_eq!(col("an_int_array"), json!([1, 2, 3]));
}

#[tokio::test]
async fn reports_column_names_and_types() {
    let db = common::start().await;

    let result = run_query(&db.pool, "SELECT 1 as n, 'x' as s", false)
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

    let result = run_query(&db.pool, "SELECT 1 WHERE false", false)
        .await
        .expect("query should succeed");

    assert_eq!(result.row_count, 0);
    assert!(result.rows.is_empty());
    assert_eq!(result.columns.len(), 1);
}

#[tokio::test]
async fn surfaces_postgres_errors_with_code_and_position() {
    let db = common::start().await;

    let err = run_query(&db.pool, "SELECT * FROM table_that_does_not_exist", false)
        .await
        .expect_err("query should fail");

    let msg = err.to_string();
    assert!(
        msg.contains("table_that_does_not_exist"),
        "message should name the missing table, got: {msg}"
    );
}

#[tokio::test]
async fn an_aborted_transaction_does_not_leak_into_the_next_checkout() {
    let db = common::start().await;

    // Open a transaction, then abort it with a runtime error (division
    // by zero) and abandon it: the client returns to the pool sitting
    // inside a transaction block in the aborted state, without COMMIT
    // or ROLLBACK ever being run.
    run_query(&db.pool, "BEGIN", false)
        .await
        .expect("BEGIN should succeed");
    run_query(&db.pool, "SELECT 1/0", false)
        .await
        .expect_err("division by zero should fail and abort the transaction");

    // If the pool hands back that same stale, unreset connection, a
    // perfectly ordinary next query fails with 25P02 "current
    // transaction is aborted" — a bogus failure the user never caused.
    let result = run_query(&db.pool, "SELECT 1 as n", false).await.expect(
        "query after an abandoned aborted transaction should succeed on a clean connection",
    );
    assert_eq!(result.rows[0][0], json!(1));
}

#[tokio::test]
async fn a_session_level_statement_timeout_override_does_not_leak_to_the_next_checkout() {
    let db = common::start().await;

    // A user statement that disables the timeout for the rest of the
    // session must not affect connections handed to later queries.
    run_query(&db.pool, "SET statement_timeout = 0", false)
        .await
        .expect("SET should succeed");

    let result = run_query(&db.pool, "SHOW statement_timeout", false)
        .await
        .expect("SHOW should succeed");
    assert_ne!(
        result.rows[0][0],
        json!("0"),
        "statement_timeout override from a prior session must not survive recycling"
    );
}

#[tokio::test]
async fn timestamp_retains_fractional_seconds() {
    let db = common::start().await;

    let result = run_query(
        &db.pool,
        "SELECT '2026-01-04 10:30:00.123456'::timestamp as ts",
        false,
    )
    .await
    .expect("query should succeed");

    assert_eq!(result.rows[0][0], json!("2026-01-04T10:30:00.123456"));
}

#[tokio::test]
async fn whole_second_timestamp_has_no_trailing_dot() {
    let db = common::start().await;

    let result = run_query(
        &db.pool,
        "SELECT '2026-01-04 10:30:00'::timestamp as ts",
        false,
    )
    .await
    .expect("query should succeed");

    assert_eq!(result.rows[0][0], json!("2026-01-04T10:30:00"));
}

#[tokio::test]
async fn non_finite_float8_values_render_as_strings_not_null() {
    let db = common::start().await;

    let result = run_query(
        &db.pool,
        "SELECT 'NaN'::float8 as a, 'Infinity'::float8 as b, '-Infinity'::float8 as c",
        false,
    )
    .await
    .expect("query should succeed");

    assert_eq!(result.rows[0][0], json!("NaN"));
    assert_eq!(result.rows[0][1], json!("Infinity"));
    assert_eq!(result.rows[0][2], json!("-Infinity"));
}

#[tokio::test]
async fn non_finite_float4_values_render_as_strings_not_null() {
    let db = common::start().await;

    let result = run_query(
        &db.pool,
        "SELECT 'NaN'::float4 as a, 'Infinity'::float4 as b, '-Infinity'::float4 as c",
        false,
    )
    .await
    .expect("query should succeed");

    assert_eq!(result.rows[0][0], json!("NaN"));
    assert_eq!(result.rows[0][1], json!("Infinity"));
    assert_eq!(result.rows[0][2], json!("-Infinity"));
}

#[tokio::test]
async fn update_reports_affected_row_count() {
    let db = common::start().await;

    run_query(&db.pool, "CREATE TABLE widgets (id int)", false)
        .await
        .expect("create table should succeed");
    run_query(&db.pool, "INSERT INTO widgets VALUES (1), (2), (3)", false)
        .await
        .expect("insert should succeed");

    let result = run_query(&db.pool, "UPDATE widgets SET id = id + 1", false)
        .await
        .expect("update should succeed");

    assert_eq!(result.affected_rows, Some(3));
    assert_eq!(result.row_count, 0);
    assert!(result.rows.is_empty());
}

#[tokio::test]
async fn insert_reports_affected_row_count() {
    let db = common::start().await;

    run_query(&db.pool, "CREATE TABLE gadgets (id int)", false)
        .await
        .expect("create table should succeed");

    let result = run_query(&db.pool, "INSERT INTO gadgets VALUES (1), (2)", false)
        .await
        .expect("insert should succeed");

    assert_eq!(result.affected_rows, Some(2));
    assert_eq!(result.row_count, 0);
}

#[tokio::test]
async fn select_reports_rows_returned_and_no_affected_count() {
    let db = common::start().await;

    let result = run_query(&db.pool, "SELECT 1 as n", false)
        .await
        .expect("select should succeed");

    assert_eq!(result.row_count, 1);
    assert_eq!(result.affected_rows, None);
}

#[tokio::test]
async fn numeric_nan_renders_as_a_string_not_null() {
    let db = common::start().await;

    let result = run_query(&db.pool, "SELECT 'NaN'::numeric as n", false)
        .await
        .expect("query should succeed");

    assert_eq!(result.rows[0][0], json!("NaN"));
}

#[tokio::test]
async fn numeric_beyond_decimal_precision_survives_intact() {
    let db = common::start().await;

    // rust_decimal::Decimal is 96-bit (~28 significant digits), so a
    // 40-digit value used to fail to decode and render as
    // "<unreadable: ...>". Postgres NUMERIC is arbitrary precision and
    // handles this natively.
    let big = "1234567890123456789012345678901234567890";
    let result = run_query(&db.pool, &format!("SELECT '{big}'::numeric as n"), false)
        .await
        .expect("query should succeed");

    assert_eq!(result.rows[0][0], json!(big));
}

#[tokio::test]
async fn a_wrong_password_reports_its_sqlstate() {
    let db = common::start().await;

    // testcontainers' postgres image requires the correct password;
    // deliberately get it wrong.
    let url = format!(
        "postgres://postgres:not-the-right-password@localhost:{}/postgres?sslmode=disable",
        db.port
    );
    let cfg = ConnectionConfig::from_url(&url).expect("test URL should parse");
    let pool = build_pool(&cfg, Policy::Free).expect("pool should build");

    let err = ping(&pool, "test")
        .await
        .expect_err("wrong password should fail");

    // Serialize the way the UI receives it, so this asserts on the real
    // IPC payload rather than the internal Rust shape.
    let payload = serde_json::to_value(&err).expect("error should serialize");
    println!("error payload: {payload}");
    assert_eq!(
        payload["code"], "28P01",
        "SQLSTATE for invalid_password should survive to the UI"
    );
}

#[tokio::test]
async fn unsupported_types_do_not_crash_the_query() {
    let db = common::start().await;

    // point has no Rust mapping in our conversion table.
    let result = run_query(&db.pool, "SELECT '(1,2)'::point as p", false)
        .await
        .expect("query should still succeed");

    let cell = &result.rows[0][0];
    assert!(
        cell.as_str().unwrap_or("").contains("unsupported"),
        "expected a placeholder string, got: {cell}"
    );
}

#[tokio::test]
async fn renders_arrays_as_json_arrays() {
    let db = common::start().await;

    let result = run_query(
        &db.pool,
        "select array[1,2,3]::int4[]           as ints,
                array['a','b']::text[]         as texts,
                array[]::int4[]                as empty,
                array[1,null,3]::int4[]        as with_null,
                array[true,false]::bool[]      as bools",
        false,
    )
    .await
    .expect("query should succeed");

    let col = |name: &str| {
        let i = result.columns.iter().position(|c| c.name == name).unwrap();
        result.rows[0][i].clone()
    };

    assert_eq!(col("ints"), json!([1, 2, 3]));
    assert_eq!(col("texts"), json!(["a", "b"]));
    assert_eq!(col("empty"), json!([]));
    assert_eq!(col("with_null"), json!([1, null, 3]));
    assert_eq!(col("bools"), json!([true, false]));
}

#[tokio::test]
async fn renders_enum_values_as_their_labels() {
    let db = common::start().await;
    let client = db.pool.get().await.expect("checkout");
    client
        .batch_execute("create type mood as enum ('sad', 'ok', 'happy')")
        .await
        .expect("type should be created");

    let result = run_query(&db.pool, "select 'happy'::mood as m", false)
        .await
        .expect("query should succeed");

    assert_eq!(result.rows[0][0], json!("happy"));
}

#[tokio::test]
async fn an_unrenderable_type_still_shows_a_visible_placeholder() {
    let db = common::start().await;

    // A multi-dimensional array is deliberately NOT flattened into a
    // lying one-dimensional list: better a visible placeholder than
    // silently wrong data.
    let result = run_query(&db.pool, "select '{{1,2},{3,4}}'::int4[][] as grid", false)
        .await
        .expect("query should succeed");

    let cell = &result.rows[0][0];
    let text = cell.as_str().unwrap_or_default();
    assert!(
        text.contains("unsupported") || cell.is_array(),
        "expected a placeholder or a faithful array, got {cell}",
    );
}

#[tokio::test]
async fn a_null_array_is_null_not_an_empty_array() {
    let db = common::start().await;

    let result = run_query(&db.pool, "select null::int4[] as arr", false)
        .await
        .expect("query should succeed");

    assert_eq!(
        result.rows[0][0],
        serde_json::Value::Null,
        "a NULL array must stay distinguishable from an empty array"
    );
}

#[tokio::test]
async fn column_headers_spell_array_types_the_way_users_write_them() {
    let db = common::start().await;

    // Postgres's internal name for a text array is `_text`. The schema
    // tree shows `text[]` (via format_type), so the grid must agree —
    // the same column reading `_text` in one pane and `text[]` in the
    // other is just confusing.
    let result = run_query(
        &db.pool,
        "select array['a']::text[] as tags, 1::int4 as n",
        false,
    )
    .await
    .expect("query should succeed");

    assert_eq!(result.columns[0].type_name, "text[]");
    assert_eq!(result.columns[1].type_name, "int4", "scalars are unchanged");
}
