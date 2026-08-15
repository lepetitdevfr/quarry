use quarry_lib::edit::decide::{ColumnEdit, EditInfo, PkColumn};
use quarry_lib::edit::sql::{build_updates, cast_target, quote_ident, CellEdit, RowEdit};
use tokio_postgres::types::Type;

fn editable(name: &str, cast_type: &str) -> ColumnEdit {
    ColumnEdit {
        editable: true,
        column_name: Some(name.to_string()),
        cast_type: Some(cast_type.to_string()),
        reason: None,
    }
}

fn read_only() -> ColumnEdit {
    ColumnEdit {
        editable: false,
        column_name: None,
        cast_type: None,
        reason: Some("primary key".to_string()),
    }
}

/// `select id, email, plan from users`, id being the key.
fn users() -> EditInfo {
    EditInfo {
        editable: true,
        reason: None,
        schema: Some("public".to_string()),
        table: Some("users".to_string()),
        pk: vec![PkColumn {
            name: "id".to_string(),
            result_index: 0,
        }],
        columns: vec![
            read_only(),
            editable("email", "\"pg_catalog\".\"text\""),
            editable("plan", "\"pg_catalog\".\"text\""),
        ],
    }
}

#[test]
fn a_plain_type_casts_through_text() {
    assert_eq!(cast_target(&Type::INT4), "\"pg_catalog\".\"int4\"");
    assert_eq!(cast_target(&Type::TEXT), "\"pg_catalog\".\"text\"");
}

#[test]
fn an_array_type_keeps_its_brackets() {
    // Not `_text`, which is the internal spelling and casts to nothing
    // the user would recognise.
    assert_eq!(cast_target(&Type::TEXT_ARRAY), "\"pg_catalog\".\"text\"[]");
}

#[test]
fn an_identifier_is_quoted_and_embedded_quotes_are_doubled() {
    assert_eq!(quote_ident("users"), "\"users\"");
    assert_eq!(quote_ident("my\"table"), "\"my\"\"table\"");
}

#[test]
fn one_edited_cell_becomes_one_update() {
    let edits = vec![RowEdit {
        row: 4,
        pk: vec!["7".to_string()],
        cells: vec![CellEdit {
            column: 1,
            value: Some("a@b.co".to_string()),
        }],
    }];

    let statements = build_updates(&users(), &edits).expect("should build");

    assert_eq!(statements.len(), 1);
    assert_eq!(
        statements[0].sql,
        "update \"public\".\"users\" set \"email\" = $1::text::\"pg_catalog\".\"text\" \
         where \"id\" = $2::text::\"pg_catalog\".\"text\" \
         returning \"email\""
    );
    assert_eq!(
        statements[0].params,
        vec![Some("a@b.co".to_string()), Some("7".to_string())]
    );
    assert_eq!(statements[0].row, 4);
    assert_eq!(statements[0].returned, vec![1]);
}

#[test]
fn two_cells_in_one_row_become_one_statement() {
    let edits = vec![RowEdit {
        row: 0,
        pk: vec!["7".to_string()],
        cells: vec![
            CellEdit {
                column: 1,
                value: Some("a@b.co".to_string()),
            },
            CellEdit {
                column: 2,
                value: Some("pro".to_string()),
            },
        ],
    }];

    let statements = build_updates(&users(), &edits).expect("should build");

    assert_eq!(statements.len(), 1);
    assert!(
        statements[0].sql.contains("set \"email\" = $1")
            && statements[0].sql.contains(", \"plan\" = $2"),
        "sql was: {}",
        statements[0].sql
    );
    assert_eq!(statements[0].returned, vec![1, 2]);
}

#[test]
fn two_rows_become_two_statements() {
    let edits = vec![
        RowEdit {
            row: 0,
            pk: vec!["7".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("a@b.co".to_string()),
            }],
        },
        RowEdit {
            row: 1,
            pk: vec!["8".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("c@d.co".to_string()),
            }],
        },
    ];

    let statements = build_updates(&users(), &edits).expect("should build");
    assert_eq!(statements.len(), 2);
}

#[test]
fn null_binds_as_null_not_as_the_word() {
    let edits = vec![RowEdit {
        row: 0,
        pk: vec!["7".to_string()],
        cells: vec![CellEdit {
            column: 1,
            value: None,
        }],
    }];

    let statements = build_updates(&users(), &edits).expect("should build");
    assert_eq!(statements[0].params[0], None);
}

#[test]
fn a_composite_key_puts_every_column_in_the_where() {
    let info = EditInfo {
        editable: true,
        reason: None,
        schema: Some("public".to_string()),
        table: Some("memberships".to_string()),
        pk: vec![
            PkColumn {
                name: "user_id".to_string(),
                result_index: 0,
            },
            PkColumn {
                name: "group_id".to_string(),
                result_index: 1,
            },
        ],
        columns: vec![
            read_only(),
            read_only(),
            editable("role", "\"pg_catalog\".\"text\""),
        ],
    };

    let edits = vec![RowEdit {
        row: 0,
        pk: vec!["7".to_string(), "9".to_string()],
        cells: vec![CellEdit {
            column: 2,
            value: Some("admin".to_string()),
        }],
    }];

    let statements = build_updates(&info, &edits).expect("should build");
    assert!(
        statements[0].sql.contains("where \"user_id\" = $2")
            && statements[0].sql.contains("and \"group_id\" = $3"),
        "sql was: {}",
        statements[0].sql
    );
    assert_eq!(
        statements[0].params,
        vec![
            Some("admin".to_string()),
            Some("7".to_string()),
            Some("9".to_string())
        ]
    );
}

#[test]
fn editing_a_read_only_column_is_refused() {
    // The UI does not offer this. The generator refuses it anyway: a
    // frontend bug must not be able to write to a primary key.
    let edits = vec![RowEdit {
        row: 0,
        pk: vec!["7".to_string()],
        cells: vec![CellEdit {
            column: 0,
            value: Some("99".to_string()),
        }],
    }];

    let error = build_updates(&users(), &edits).expect_err("must refuse");
    assert!(
        format!("{error}").contains("not editable"),
        "error was: {error}"
    );
}

#[test]
fn a_wrong_number_of_key_values_is_refused() {
    let edits = vec![RowEdit {
        row: 0,
        pk: vec![],
        cells: vec![CellEdit {
            column: 1,
            value: Some("a@b.co".to_string()),
        }],
    }];

    let error = build_updates(&users(), &edits).expect_err("must refuse");
    assert!(
        format!("{error}").contains("primary key"),
        "error was: {error}"
    );
}

#[test]
fn a_result_that_is_not_editable_generates_nothing() {
    let mut info = users();
    info.editable = false;
    info.reason = Some("this result comes from a view".to_string());

    let edits = vec![RowEdit {
        row: 0,
        pk: vec!["7".to_string()],
        cells: vec![CellEdit {
            column: 1,
            value: Some("a@b.co".to_string()),
        }],
    }];

    build_updates(&info, &edits).expect_err("must refuse");
}

#[test]
fn no_edits_generate_no_statements() {
    let statements = build_updates(&users(), &[]).expect("should build");
    assert!(statements.is_empty());
}
