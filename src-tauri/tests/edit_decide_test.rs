use quarry_lib::edit::{decide_editability, EditInfo, SourceColumn, TableFacts};

/// A `users` table with `id` as its primary key, as the catalog
/// lookup would report it.
fn users_table() -> TableFacts {
    TableFacts {
        relkind: "r".to_string(),
        schema: "public".to_string(),
        table: "users".to_string(),
        columns: vec![
            (1, "id".to_string(), true),
            (2, "email".to_string(), false),
            (3, "plan".to_string(), false),
        ],
    }
}

/// A result column that really is a table column.
fn col(attnum: i16, cast_type: &str) -> SourceColumn {
    SourceColumn {
        table_oid: Some(16385),
        attnum: Some(attnum),
        cast_type: cast_type.to_string(),
    }
}

/// A result column that is an expression: Postgres reports no source.
fn computed(cast_type: &str) -> SourceColumn {
    SourceColumn {
        table_oid: None,
        attnum: None,
        cast_type: cast_type.to_string(),
    }
}

fn reason(info: &EditInfo) -> String {
    info.reason.clone().unwrap_or_default()
}

#[test]
fn a_plain_single_table_select_is_editable() {
    let info = decide_editability(
        &[col(1, "\"int4\""), col(2, "\"text\""), col(3, "\"text\"")],
        Some(&users_table()),
    );

    assert!(info.editable, "reason was: {}", reason(&info));
    assert_eq!(info.schema.as_deref(), Some("public"));
    assert_eq!(info.table.as_deref(), Some("users"));
    // The primary key is found, and it remembers which result column
    // holds its value.
    assert_eq!(info.pk.len(), 1);
    assert_eq!(info.pk[0].name, "id");
    assert_eq!(info.pk[0].result_index, 0);
    // `email` and `plan` are editable; `id` is not, being the key.
    assert!(!info.columns[0].editable);
    assert!(info.columns[1].editable);
    assert_eq!(info.columns[1].column_name.as_deref(), Some("email"));
    assert!(info.columns[2].editable);
}

#[test]
fn a_primary_key_column_is_read_only_and_says_so() {
    let info = decide_editability(
        &[col(1, "\"int4\""), col(2, "\"text\"")],
        Some(&users_table()),
    );

    assert!(!info.columns[0].editable);
    assert_eq!(info.columns[0].reason.as_deref(), Some("primary key"));
}

#[test]
fn an_empty_result_is_not_editable() {
    let info = decide_editability(&[], Some(&users_table()));
    assert!(!info.editable);
}

#[test]
fn a_result_of_only_expressions_is_not_editable() {
    let info = decide_editability(&[computed("\"int8\"")], None);

    assert!(!info.editable);
    assert!(
        reason(&info).contains("computed values"),
        "reason was: {}",
        reason(&info)
    );
}

#[test]
fn a_join_is_not_editable_and_counts_the_tables() {
    let a = SourceColumn {
        table_oid: Some(16385),
        attnum: Some(1),
        cast_type: "\"int4\"".to_string(),
    };
    let b = SourceColumn {
        table_oid: Some(16400),
        attnum: Some(1),
        cast_type: "\"int4\"".to_string(),
    };

    let info = decide_editability(&[a, b], None);

    assert!(!info.editable);
    assert!(
        reason(&info).contains("joins 2 tables"),
        "reason was: {}",
        reason(&info)
    );
}

#[test]
fn a_view_is_not_editable() {
    let mut view = users_table();
    view.relkind = "v".to_string();

    let info = decide_editability(&[col(1, "\"int4\""), col(2, "\"text\"")], Some(&view));

    assert!(!info.editable);
    assert!(
        reason(&info).contains("view"),
        "reason was: {}",
        reason(&info)
    );
}

#[test]
fn a_table_without_a_primary_key_is_not_editable() {
    let mut events = users_table();
    events.table = "events".to_string();
    events.columns = vec![(1, "id".to_string(), false), (2, "body".to_string(), false)];

    let info = decide_editability(&[col(1, "\"int4\""), col(2, "\"text\"")], Some(&events));

    assert!(!info.editable);
    assert!(
        reason(&info).contains("public.events") && reason(&info).contains("no primary key"),
        "reason was: {}",
        reason(&info)
    );
}

#[test]
fn a_missing_primary_key_column_names_what_to_add() {
    // `select email, plan from users` — no `id` in the result, so no
    // WHERE clause can be built.
    let info = decide_editability(
        &[col(2, "\"text\""), col(3, "\"text\"")],
        Some(&users_table()),
    );

    assert!(!info.editable);
    assert!(
        reason(&info).contains("id"),
        "reason was: {}",
        reason(&info)
    );
}

#[test]
fn an_alias_edits_the_real_column_not_the_header() {
    // `select id, email as e from users`: the header is `e`, but the
    // attnum still points at `email`.
    let info = decide_editability(
        &[col(1, "\"int4\""), col(2, "\"text\"")],
        Some(&users_table()),
    );

    assert!(info.editable, "reason was: {}", reason(&info));
    assert_eq!(info.columns[1].column_name.as_deref(), Some("email"));
}

#[test]
fn a_column_selected_twice_is_read_only_in_both_places() {
    // `select id, email, email from users`.
    let info = decide_editability(
        &[col(1, "\"int4\""), col(2, "\"text\""), col(2, "\"text\"")],
        Some(&users_table()),
    );

    assert!(info.editable, "reason was: {}", reason(&info));
    assert!(!info.columns[1].editable);
    assert!(!info.columns[2].editable);
    assert!(
        info.columns[1]
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("twice"),
        "reason was: {:?}",
        info.columns[1].reason
    );
}

#[test]
fn a_computed_column_beside_real_ones_is_the_only_read_only_one() {
    // `select id, email, upper(email) from users`.
    let info = decide_editability(
        &[col(1, "\"int4\""), col(2, "\"text\""), computed("\"text\"")],
        Some(&users_table()),
    );

    assert!(info.editable, "reason was: {}", reason(&info));
    assert!(info.columns[1].editable);
    assert!(!info.columns[2].editable);
    assert_eq!(info.columns[2].reason.as_deref(), Some("computed value"));
}

#[test]
fn a_partitioned_table_is_editable() {
    // relkind 'p' is a partitioned table — an ordinary table for our
    // purposes, and UPDATE routes to the right partition itself.
    let mut partitioned = users_table();
    partitioned.relkind = "p".to_string();

    let info = decide_editability(
        &[col(1, "\"int4\""), col(2, "\"text\"")],
        Some(&partitioned),
    );

    assert!(info.editable, "reason was: {}", reason(&info));
}

#[test]
fn a_composite_primary_key_records_both_columns() {
    let mut memberships = users_table();
    memberships.table = "memberships".to_string();
    memberships.columns = vec![
        (1, "user_id".to_string(), true),
        (2, "group_id".to_string(), true),
        (3, "role".to_string(), false),
    ];

    let info = decide_editability(
        &[col(1, "\"int4\""), col(2, "\"int4\""), col(3, "\"text\"")],
        Some(&memberships),
    );

    assert!(info.editable, "reason was: {}", reason(&info));
    assert_eq!(info.pk.len(), 2);
    assert_eq!(info.pk[0].result_index, 0);
    assert_eq!(info.pk[1].result_index, 1);
}
