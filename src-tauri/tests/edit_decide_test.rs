use quarry_lib::edit::{
    decide_editability, EditInfo, Identity, SourceColumn, TableColumn, TableFacts,
};

/// An ordinary nullable column with no default.
fn tc(attnum: i16, name: &str, is_pk: bool) -> TableColumn {
    TableColumn {
        attnum,
        name: name.to_string(),
        is_pk,
        not_null: false,
        has_default: false,
        identity: Identity::None,
        generated: false,
    }
}

/// A `users` table with `id` as its primary key, as the catalog
/// lookup would report it.
fn users_table() -> TableFacts {
    TableFacts {
        relkind: "r".to_string(),
        schema: "public".to_string(),
        table: "users".to_string(),
        columns: vec![
            tc(1, "id", true),
            tc(2, "email", false),
            tc(3, "plan", false),
        ],
    }
}

/// A table that exercises every insert verdict at once.
fn widgets_table() -> TableFacts {
    TableFacts {
        relkind: "r".to_string(),
        schema: "public".to_string(),
        table: "widgets".to_string(),
        columns: vec![
            TableColumn {
                attnum: 1,
                name: "id".to_string(),
                is_pk: true,
                not_null: true,
                has_default: false,
                identity: Identity::Always,
                generated: false,
            },
            TableColumn {
                attnum: 2,
                name: "code".to_string(),
                is_pk: false,
                not_null: true,
                has_default: false,
                identity: Identity::None,
                generated: false,
            },
            TableColumn {
                attnum: 3,
                name: "label".to_string(),
                is_pk: false,
                not_null: false,
                has_default: false,
                identity: Identity::None,
                generated: false,
            },
            TableColumn {
                attnum: 4,
                name: "shout".to_string(),
                is_pk: false,
                not_null: false,
                has_default: false,
                identity: Identity::None,
                generated: true,
            },
        ],
    }
}

/// A result column that really is a table column.
fn col(attnum: i16, cast_type: &str) -> SourceColumn {
    SourceColumn {
        table_oid: Some(16385),
        attnum: Some(attnum),
        cast_type: cast_type.to_string(),
        choices: None,
    }
}

/// A result column that is an expression: Postgres reports no source.
fn computed(cast_type: &str) -> SourceColumn {
    SourceColumn {
        table_oid: None,
        attnum: None,
        cast_type: cast_type.to_string(),
        choices: None,
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
        choices: None,
    };
    let b = SourceColumn {
        table_oid: Some(16400),
        attnum: Some(1),
        cast_type: "\"int4\"".to_string(),
        choices: None,
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
    events.columns = vec![tc(1, "id", false), tc(2, "body", false)];

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
        tc(1, "user_id", true),
        tc(2, "group_id", true),
        tc(3, "role", false),
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

#[test]
fn a_result_holding_every_required_column_is_insertable() {
    let info = decide_editability(
        &[col(1, "\"int4\""), col(2, "\"text\""), col(3, "\"text\"")],
        Some(&widgets_table()),
    );

    assert!(info.insertable, "reason was: {:?}", info.insert_reason);
    // An identity primary key is generated, so it takes no value.
    assert!(!info.columns[0].insertable);
    assert_eq!(
        info.columns[0].insert_reason.as_deref(),
        Some("generated by the database")
    );
    assert!(info.columns[1].insertable);
    assert!(info.columns[2].insertable);
}

#[test]
fn a_missing_required_column_blocks_insert_but_not_edit() {
    // `select id, label from widgets` — `code` is NOT NULL with no
    // default and is not in the result, so a new row cannot supply it.
    let info = decide_editability(
        &[col(1, "\"int4\""), col(3, "\"text\"")],
        Some(&widgets_table()),
    );

    assert!(info.editable, "editing is unaffected");
    assert!(!info.insertable);
    assert_eq!(
        info.insert_reason.as_deref(),
        Some("add code to the query to insert rows — it is NOT NULL with no default")
    );
}

#[test]
fn a_duplicated_required_column_blocks_insert() {
    // `select id, code, code from widgets`: which of the two supplies
    // the value is not answerable.
    let info = decide_editability(
        &[col(1, "\"int4\""), col(2, "\"text\""), col(2, "\"text\"")],
        Some(&widgets_table()),
    );

    assert!(!info.insertable);
    assert_eq!(
        info.insert_reason.as_deref(),
        Some("code appears twice in the result")
    );
}

#[test]
fn a_stored_generated_column_takes_no_value() {
    let info = decide_editability(
        &[col(1, "\"int4\""), col(2, "\"text\""), col(4, "\"text\"")],
        Some(&widgets_table()),
    );

    assert!(!info.columns[2].insertable);
    assert_eq!(
        info.columns[2].insert_reason.as_deref(),
        Some("generated by the database")
    );
}

#[test]
fn a_natural_primary_key_can_be_typed_on_a_new_row() {
    // No default and no identity: nobody generates it, so insert is
    // impossible unless the user supplies it.
    let mut facts = widgets_table();
    facts.columns[0].identity = Identity::None;

    let info = decide_editability(&[col(1, "\"text\""), col(2, "\"text\"")], Some(&facts));

    assert!(info.columns[0].insertable, "a natural key must be typeable");
    // Still read-only on an existing row: that rule is unchanged.
    assert!(!info.columns[0].editable);
}

#[test]
fn a_computed_column_takes_no_value_on_a_new_row() {
    let info = decide_editability(
        &[col(1, "\"int4\""), col(2, "\"text\""), computed("\"text\"")],
        Some(&widgets_table()),
    );

    assert!(!info.columns[2].insertable);
    assert_eq!(
        info.columns[2].insert_reason.as_deref(),
        Some("computed value")
    );
}

#[test]
fn a_result_that_cannot_be_edited_cannot_take_rows_either() {
    // A view: rule 1 of the insert table reuses the editing refusal
    // verbatim rather than inventing a second sentence for it.
    let mut facts = users_table();
    facts.relkind = "v".to_string();

    let info = decide_editability(&[col(1, "\"int4\"")], Some(&facts));

    assert!(!info.insertable);
    assert_eq!(info.insert_reason, info.reason);
}

#[test]
fn a_key_column_still_reports_its_real_name() {
    // RETURNING has to name the generated key, so `column_name` is
    // filled for every resolved column now, editable or not.
    let info = decide_editability(
        &[col(1, "\"int4\""), col(2, "\"text\"")],
        Some(&users_table()),
    );

    assert_eq!(info.columns[0].column_name.as_deref(), Some("id"));
    assert!(!info.columns[0].editable, "it is still read-only");
}

#[test]
fn choices_reach_the_column_verdict() {
    let mut source = col(2, "\"public\".\"mood\"");
    source.choices = Some(vec!["sad".to_string(), "ok".to_string()]);

    let info = decide_editability(&[col(1, "\"int4\""), source], Some(&users_table()));

    assert_eq!(
        info.columns[1].choices.as_deref(),
        Some(["sad".to_string(), "ok".to_string()].as_slice())
    );
}

#[test]
fn a_stored_generated_column_is_read_only() {
    // Postgres refuses `update t set shout = …` on a generated column
    // with "can only be updated to DEFAULT", so offering an editor there
    // sends the user to a server error for something knowable up front.
    let info = decide_editability(
        &[col(1, "\"int4\""), col(2, "\"text\""), col(4, "\"text\"")],
        Some(&widgets_table()),
    );

    assert!(!info.columns[2].editable);
    assert_eq!(
        info.columns[2].reason.as_deref(),
        Some("generated by the database")
    );
    // The rest of the result is unaffected: one generated column does not
    // make its neighbours read-only.
    assert!(info.columns[1].editable);
}
