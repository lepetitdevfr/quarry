mod common;

use quarry_lib::edit::{
    apply_edits, build_deletes, build_inserts, build_updates, CellEdit, Identity, RowDelete,
    RowEdit, RowInsert, StatementKind,
};
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
    assert_eq!(facts.columns[0].attnum, 1);
    assert_eq!(facts.columns[0].name, "id");
    assert!(facts.columns[0].is_pk);
    assert_eq!(facts.columns[1].name, "email");
    assert!(!facts.columns[1].is_pk);
}

#[tokio::test]
async fn lookup_table_reports_nullability_defaults_and_identity() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table widgets (
           id     int generated always as identity primary key,
           code   text not null,
           label  text,
           made   timestamptz not null default now(),
           shout  text generated always as (upper(code)) stored
         )",
        false,
    )
    .await
    .expect("create table");

    let oid = oid_of(&db.pool, "widgets").await;
    let facts = lookup_table(&db.pool, oid)
        .await
        .expect("lookup should run")
        .expect("the table exists");

    let by_name = |name: &str| {
        facts
            .columns
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("{name} should be in the catalog"))
            .clone()
    };

    // An identity column: the database supplies the value.
    assert_eq!(by_name("id").identity, Identity::Always);
    assert!(by_name("id").not_null);

    // The one column a user must supply: NOT NULL, no default, not
    // generated. This is what rule 2 of the spec keys off.
    assert!(by_name("code").not_null);
    assert!(!by_name("code").has_default);
    assert_eq!(by_name("code").identity, Identity::None);
    assert!(!by_name("code").generated);

    // Nullable, so it may be left out.
    assert!(!by_name("label").not_null);

    // NOT NULL but defaulted, so it may also be left out.
    assert!(by_name("made").not_null);
    assert!(by_name("made").has_default);

    // A stored generated column cannot be written at all.
    assert!(by_name("shout").generated);
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
    assert!(facts.columns.iter().all(|c| c.name != "junk"));
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

#[tokio::test]
async fn an_edit_lands_and_returns_the_stored_value() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(&db.pool, "insert into people values (1, 'old@x.co')", false)
        .await
        .expect("insert");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select");

    let statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("new@x.co".to_string()),
            }],
        }],
    )
    .expect("should build");

    let applied = apply_edits(&db.pool, &statements, false)
        .await
        .expect("apply should succeed");

    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].row, 0);
    assert_eq!(applied[0].cells[0].column, 1);
    assert_eq!(applied[0].cells[0].value, serde_json::json!("new@x.co"));

    let after = run_query(&db.pool, "select email from people", false)
        .await
        .expect("select");
    assert_eq!(after.rows[0][0], serde_json::json!("new@x.co"));
}

#[tokio::test]
async fn a_trigger_rewrite_comes_back_through_returning() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(&db.pool, "insert into people values (1, 'old@x.co')", false)
        .await
        .expect("insert");
    // A BEFORE UPDATE trigger that lowercases what you typed. The grid
    // must show what the database stored, not what you typed.
    run_query(
        &db.pool,
        "create function lower_email() returns trigger as $$
         begin new.email = lower(new.email); return new; end;
         $$ language plpgsql",
        false,
    )
    .await
    .expect("create function");
    run_query(
        &db.pool,
        "create trigger t before update on people for each row execute function lower_email()",
        false,
    )
    .await
    .expect("create trigger");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select");

    let statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("SHOUTY@X.CO".to_string()),
            }],
        }],
    )
    .expect("should build");

    let applied = apply_edits(&db.pool, &statements, false)
        .await
        .expect("apply should succeed");

    assert_eq!(applied[0].cells[0].value, serde_json::json!("shouty@x.co"));
}

#[tokio::test]
async fn a_vanished_row_rolls_back_the_whole_batch() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(
        &db.pool,
        "insert into people values (1, 'a@x.co'), (2, 'b@x.co')",
        false,
    )
    .await
    .expect("insert");

    let result = run_query(&db.pool, "select id, email from people order by id", false)
        .await
        .expect("select");

    // Row 2 is deleted behind our back, exactly as a concurrent session
    // would.
    run_query(&db.pool, "delete from people where id = 2", false)
        .await
        .expect("delete");

    let statements = build_updates(
        &result.edit,
        &[
            RowEdit {
                row: 0,
                pk: vec!["1".to_string()],
                cells: vec![CellEdit {
                    column: 1,
                    value: Some("changed@x.co".to_string()),
                }],
            },
            RowEdit {
                row: 1,
                pk: vec!["2".to_string()],
                cells: vec![CellEdit {
                    column: 1,
                    value: Some("gone@x.co".to_string()),
                }],
            },
        ],
    )
    .expect("should build");

    let error = apply_edits(&db.pool, &statements, false)
        .await
        .expect_err("a missing row must fail the batch");
    assert!(
        format!("{error}").contains("no longer"),
        "error was: {error}"
    );

    // The edit that *would* have worked must be rolled back too.
    // A partial apply leaves the grid claiming things the database
    // does not agree with.
    let after = run_query(&db.pool, "select email from people where id = 1", false)
        .await
        .expect("select");
    assert_eq!(after.rows[0][0], serde_json::json!("a@x.co"));
}

#[tokio::test]
async fn a_delete_removes_the_row() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(
        &db.pool,
        "insert into people values (1, 'a@x.co'), (2, 'b@x.co')",
        false,
    )
    .await
    .expect("insert");

    let result = run_query(&db.pool, "select id, email from people order by id", false)
        .await
        .expect("select");

    let statements = build_deletes(
        &result.edit,
        &[RowDelete {
            row: 1,
            pk: vec!["2".to_string()],
        }],
    )
    .expect("should build");

    let applied = apply_edits(&db.pool, &statements, false)
        .await
        .expect("apply should succeed");

    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].row, 1);
    assert_eq!(applied[0].kind, StatementKind::Delete);
    // A deleted row has nothing to patch: its RETURNING carried the key,
    // not display data.
    assert!(applied[0].cells.is_empty());

    let after = run_query(&db.pool, "select id from people order by id", false)
        .await
        .expect("select");
    assert_eq!(after.rows.len(), 1);
    assert_eq!(after.rows[0][0], serde_json::json!(1));
}

#[tokio::test]
async fn a_vanished_row_rolls_back_an_accompanying_delete() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(
        &db.pool,
        "insert into people values (1, 'a@x.co'), (2, 'b@x.co')",
        false,
    )
    .await
    .expect("insert");

    let result = run_query(&db.pool, "select id, email from people order by id", false)
        .await
        .expect("select");

    // Row 2 is deleted behind our back, exactly as a concurrent session
    // would.
    run_query(&db.pool, "delete from people where id = 2", false)
        .await
        .expect("delete");

    let mut statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("changed@x.co".to_string()),
            }],
        }],
    )
    .expect("should build");
    statements.extend(
        build_deletes(
            &result.edit,
            &[RowDelete {
                row: 1,
                pk: vec!["2".to_string()],
            }],
        )
        .expect("should build"),
    );

    let error = apply_edits(&db.pool, &statements, false)
        .await
        .expect_err("deleting a row that is already gone must fail the batch");
    assert!(
        format!("{error}").contains("no longer"),
        "error was: {error}"
    );

    // And the update that *would* have worked is rolled back with it.
    let after = run_query(&db.pool, "select email from people where id = 1", false)
        .await
        .expect("select");
    assert_eq!(after.rows[0][0], serde_json::json!("a@x.co"));
}

#[tokio::test]
async fn a_mixed_batch_updates_one_row_and_deletes_another() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(
        &db.pool,
        "insert into people values (1, 'a@x.co'), (2, 'b@x.co')",
        false,
    )
    .await
    .expect("insert");

    let result = run_query(&db.pool, "select id, email from people order by id", false)
        .await
        .expect("select");

    let mut statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("changed@x.co".to_string()),
            }],
        }],
    )
    .expect("should build");
    statements.extend(
        build_deletes(
            &result.edit,
            &[RowDelete {
                row: 1,
                pk: vec!["2".to_string()],
            }],
        )
        .expect("should build"),
    );

    let applied = apply_edits(&db.pool, &statements, false)
        .await
        .expect("apply should succeed");

    assert_eq!(applied.len(), 2);
    assert_eq!(applied[0].kind, StatementKind::Update);
    assert_eq!(applied[0].cells[0].value, serde_json::json!("changed@x.co"));
    assert_eq!(applied[1].kind, StatementKind::Delete);

    let after = run_query(&db.pool, "select id, email from people order by id", false)
        .await
        .expect("select");
    assert_eq!(after.rows.len(), 1);
    assert_eq!(after.rows[0][1], serde_json::json!("changed@x.co"));
}

#[tokio::test]
async fn setting_null_differs_from_setting_an_empty_string() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(
        &db.pool,
        "insert into people values (1, 'a@x.co'), (2, 'b@x.co')",
        false,
    )
    .await
    .expect("insert");

    let result = run_query(&db.pool, "select id, email from people order by id", false)
        .await
        .expect("select");

    let statements = build_updates(
        &result.edit,
        &[
            RowEdit {
                row: 0,
                pk: vec!["1".to_string()],
                cells: vec![CellEdit {
                    column: 1,
                    value: None,
                }],
            },
            RowEdit {
                row: 1,
                pk: vec!["2".to_string()],
                cells: vec![CellEdit {
                    column: 1,
                    value: Some(String::new()),
                }],
            },
        ],
    )
    .expect("should build");

    apply_edits(&db.pool, &statements, false)
        .await
        .expect("apply should succeed");

    let after = run_query(
        &db.pool,
        "select id, email is null as is_null, email from people order by id",
        false,
    )
    .await
    .expect("select");

    assert_eq!(after.rows[0][1], serde_json::json!(true));
    assert_eq!(after.rows[1][1], serde_json::json!(false));
    assert_eq!(after.rows[1][2], serde_json::json!(""));
}

#[tokio::test]
async fn a_bad_value_fails_with_the_postgres_message() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table nums (id int primary key, n int)",
        false,
    )
    .await
    .expect("create table");
    run_query(&db.pool, "insert into nums values (1, 5)", false)
        .await
        .expect("insert");

    let result = run_query(&db.pool, "select id, n from nums", false)
        .await
        .expect("select");

    let statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("not a number".to_string()),
            }],
        }],
    )
    .expect("should build");

    let error = apply_edits(&db.pool, &statements, false)
        .await
        .expect_err("a bad value must fail");
    assert!(
        format!("{error}").contains("invalid input syntax"),
        "error was: {error}"
    );

    // And the old value survives.
    let after = run_query(&db.pool, "select n from nums", false)
        .await
        .expect("select");
    assert_eq!(after.rows[0][0], serde_json::json!(5));
}
#[tokio::test]
async fn postgres_refuses_an_edit_on_a_read_only_pool() {
    // Layer two, standing alone for the *editing* path specifically.
    // `guard_db_test` proves this for `run_query`; this proves it for
    // `apply_edits`, which is a different code path — and being a
    // different code path is the entire reason the write-guard spec
    // built two layers.
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(&db.pool, "insert into people values (1, 'a@x.co')", false)
        .await
        .expect("insert");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select");

    let statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("b@x.co".to_string()),
            }],
        }],
    )
    .expect("should build");

    // A second pool at the same database, read-only — and
    // `read_write: false`, which is what a future code path that
    // forgot the guard would produce.
    let cfg = common::config_for(db.port);
    let locked_pool = quarry_lib::conn::build_pool(&cfg, quarry_lib::guard::Policy::ReadOnly)
        .expect("pool should build");

    let error = apply_edits(&locked_pool, &statements, false)
        .await
        .expect_err("a read-only connection must refuse an edit");
    let message = format!("{error}");
    assert!(
        message.contains("read-only") || message.contains("read only"),
        "expected a read-only refusal from the server, got: {message}"
    );
}

#[tokio::test]
async fn an_unlocked_connection_can_apply_an_edit() {
    // The other half: `BEGIN READ WRITE` must override the session
    // default for the editing path too, or unlocking could never let
    // an edit through.
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(&db.pool, "insert into people values (1, 'a@x.co')", false)
        .await
        .expect("insert");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select");

    let statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("b@x.co".to_string()),
            }],
        }],
    )
    .expect("should build");

    let cfg = common::config_for(db.port);
    let locked_pool = quarry_lib::conn::build_pool(&cfg, quarry_lib::guard::Policy::ReadOnly)
        .expect("pool should build");

    apply_edits(&locked_pool, &statements, true)
        .await
        .expect("an unlocked edit should be permitted");

    let after = run_query(&db.pool, "select email from people", false)
        .await
        .expect("select");
    assert_eq!(after.rows[0][0], serde_json::json!("b@x.co"));
}

#[tokio::test]
async fn an_insert_returns_the_generated_key_and_the_applied_defaults() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (
           id    serial primary key,
           email text not null,
           plan  text default 'free'
         )",
        false,
    )
    .await
    .expect("create table");

    let result = run_query(&db.pool, "select id, email, plan from people", false)
        .await
        .expect("select should run");

    let inserts = vec![RowInsert {
        row: 0,
        cells: vec![CellEdit {
            column: 1,
            value: Some("a@b.c".to_string()),
        }],
    }];
    let statements = build_inserts(&result.edit, &inserts).expect("should build");
    let applied = apply_edits(&db.pool, &statements, true)
        .await
        .expect("insert should apply");

    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].kind, StatementKind::Insert);
    // The generated key and the applied default both come back, so the
    // grid shows what the database stored rather than what was typed.
    assert_eq!(applied[0].cells[0].value, serde_json::json!(1));
    assert_eq!(applied[0].cells[2].value, serde_json::json!("free"));
}

#[tokio::test]
async fn an_explicit_null_overrides_a_default() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id serial primary key, plan text default 'free')",
        false,
    )
    .await
    .expect("create table");

    let result = run_query(&db.pool, "select id, plan from people", false)
        .await
        .expect("select should run");

    let inserts = vec![
        // Untouched: takes the default.
        RowInsert {
            row: 0,
            cells: vec![],
        },
        // Explicitly NULL: overrides it.
        RowInsert {
            row: 1,
            cells: vec![CellEdit {
                column: 1,
                value: None,
            }],
        },
    ];
    let statements = build_inserts(&result.edit, &inserts).expect("should build");
    let applied = apply_edits(&db.pool, &statements, true)
        .await
        .expect("inserts should apply");

    assert_eq!(applied[0].cells[1].value, serde_json::json!("free"));
    assert_eq!(applied[1].cells[1].value, serde_json::Value::Null);
}

#[tokio::test]
async fn a_before_insert_trigger_rewrite_comes_back() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id serial primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(
        &db.pool,
        "create function lower_email() returns trigger as $$
           begin new.email := lower(new.email); return new; end;
         $$ language plpgsql",
        false,
    )
    .await
    .expect("create function");
    run_query(
        &db.pool,
        "create trigger lower_it before insert on people
         for each row execute function lower_email()",
        false,
    )
    .await
    .expect("create trigger");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select should run");

    let inserts = vec![RowInsert {
        row: 0,
        cells: vec![CellEdit {
            column: 1,
            value: Some("LOUD@B.C".to_string()),
        }],
    }];
    let statements = build_inserts(&result.edit, &inserts).expect("should build");
    let applied = apply_edits(&db.pool, &statements, true)
        .await
        .expect("insert should apply");

    assert_eq!(applied[0].cells[1].value, serde_json::json!("loud@b.c"));
}

#[tokio::test]
async fn a_failing_insert_rolls_back_an_update_in_the_same_batch() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id serial primary key, email text not null)",
        false,
    )
    .await
    .expect("create table");
    run_query(
        &db.pool,
        "insert into people (email) values ('first@b.c')",
        false,
    )
    .await
    .expect("seed");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select should run");

    let mut statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("changed@b.c".to_string()),
            }],
        }],
    )
    .expect("should build");
    // NOT NULL with no default, staged as NULL: the server refuses it.
    statements.extend(
        build_inserts(
            &result.edit,
            &[RowInsert {
                row: 0,
                cells: vec![CellEdit {
                    column: 1,
                    value: None,
                }],
            }],
        )
        .expect("should build"),
    );

    apply_edits(&db.pool, &statements, true)
        .await
        .expect_err("the batch must fail");

    let after = run_query(&db.pool, "select email from people order by id", false)
        .await
        .expect("select should run");
    assert_eq!(after.rows.len(), 1, "the insert must not have landed");
    assert_eq!(
        after.rows[0][0],
        serde_json::json!("first@b.c"),
        "the update must have rolled back with it"
    );
}

#[tokio::test]
async fn a_deleted_natural_key_can_be_reinserted_in_one_batch() {
    // This is the ordering decision: inserts run after deletes. Reverse
    // them and this fails on the unique key.
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table codes (code text primary key, label text)",
        false,
    )
    .await
    .expect("create table");
    run_query(&db.pool, "insert into codes values ('FR', 'France')", false)
        .await
        .expect("seed");

    let result = run_query(&db.pool, "select code, label from codes", false)
        .await
        .expect("select should run");

    let mut statements = build_deletes(
        &result.edit,
        &[RowDelete {
            row: 0,
            pk: vec!["FR".to_string()],
        }],
    )
    .expect("should build");
    statements.extend(
        build_inserts(
            &result.edit,
            &[RowInsert {
                row: 0,
                cells: vec![
                    CellEdit {
                        column: 0,
                        value: Some("FR".to_string()),
                    },
                    CellEdit {
                        column: 1,
                        value: Some("France (new)".to_string()),
                    },
                ],
            }],
        )
        .expect("should build"),
    );

    apply_edits(&db.pool, &statements, true)
        .await
        .expect("delete then insert should apply");

    let after = run_query(&db.pool, "select label from codes", false)
        .await
        .expect("select should run");
    assert_eq!(after.rows.len(), 1);
    assert_eq!(after.rows[0][0], serde_json::json!("France (new)"));
}

#[tokio::test]
async fn an_insert_a_trigger_swallows_rolls_back_the_batch() {
    // A `BEFORE INSERT` trigger returning NULL skips the row without
    // raising: the statement succeeds and RETURNING yields nothing. The
    // rowcount assert is the only thing standing between that and a
    // grid showing a row the table does not hold — so this is what
    // exercises it, rather than a server error, which fails earlier.
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id serial primary key, email text not null)",
        false,
    )
    .await
    .expect("create table");
    run_query(
        &db.pool,
        "insert into people (email) values ('first@b.c')",
        false,
    )
    .await
    .expect("seed");
    run_query(
        &db.pool,
        "create function swallow() returns trigger as $$
           begin return null; end;
         $$ language plpgsql",
        false,
    )
    .await
    .expect("create function");
    run_query(
        &db.pool,
        "create trigger swallow_it before insert on people
         for each row execute function swallow()",
        false,
    )
    .await
    .expect("create trigger");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select should run");

    let mut statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("changed@b.c".to_string()),
            }],
        }],
    )
    .expect("should build");
    statements.extend(
        build_inserts(
            &result.edit,
            &[RowInsert {
                row: 0,
                cells: vec![CellEdit {
                    column: 1,
                    value: Some("swallowed@b.c".to_string()),
                }],
            }],
        )
        .expect("should build"),
    );

    apply_edits(&db.pool, &statements, true)
        .await
        .expect_err("an insert that affected no row must fail the batch");

    let after = run_query(&db.pool, "select email from people order by id", false)
        .await
        .expect("select should run");
    assert_eq!(after.rows.len(), 1, "the insert must not have landed");
    assert_eq!(
        after.rows[0][0],
        serde_json::json!("first@b.c"),
        "the update must have rolled back with it"
    );
}
