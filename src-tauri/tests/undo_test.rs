//! What would put a grid edit back.
//!
//! The undo is text somebody will read and run, so these tests assert the
//! statement rather than a shape: an undo that is subtly wrong is worse
//! than none, because it will be trusted.

use quarry_lib::edit::{
    build_undo, CellEdit, ColumnEdit, EditInfo, PkColumn, RowBefore, RowDelete, RowEdit,
};

fn column(name: &str, cast: &str, editable: bool) -> ColumnEdit {
    ColumnEdit {
        editable,
        column_name: Some(name.to_string()),
        cast_type: Some(cast.to_string()),
        reason: None,
        insertable: editable,
        insert_reason: None,
        choices: None,
        has_default: false,
    }
}

/// A `users` result with `id` as its key and two editable columns.
fn users() -> EditInfo {
    EditInfo {
        editable: true,
        reason: None,
        insertable: true,
        insert_reason: None,
        schema: Some("public".to_string()),
        table: Some("users".to_string()),
        pk: vec![PkColumn {
            name: "id".to_string(),
            result_index: 0,
        }],
        columns: vec![
            column("id", "\"int4\"", false),
            column("email", "\"text\"", true),
            column("plan", "\"text\"", true),
        ],
    }
}

fn before(row: usize, cells: &[(usize, Option<&str>)]) -> RowBefore {
    RowBefore {
        row,
        cells: cells
            .iter()
            .map(|(column, value)| CellEdit {
                column: *column,
                value: value.map(str::to_string),
            })
            .collect(),
    }
}

fn edit_of(row: usize, pk: &str, column: usize, to: &str) -> RowEdit {
    RowEdit {
        row,
        pk: vec![pk.to_string()],
        cells: vec![CellEdit {
            column,
            value: Some(to.to_string()),
        }],
    }
}

#[test]
fn an_updates_undo_puts_the_old_value_back() {
    let undo = build_undo(
        &users(),
        &[edit_of(0, "7", 1, "new@example.com")],
        &[before(0, &[(1, Some("old@example.com"))])],
        &[],
    )
    .expect("an update is reversible");

    assert!(undo.contains("update \"public\".\"users\""), "got:\n{undo}");
    assert!(
        undo.contains("set \"email\" = 'old@example.com'::\"text\""),
        "got:\n{undo}"
    );
    assert!(
        undo.contains("where \"id\" = '7'::\"int4\""),
        "got:\n{undo}"
    );
}

#[test]
fn only_the_columns_the_batch_changed_are_reverted() {
    // An undo that rewrote untouched columns would revert somebody
    // else's concurrent edit along with ours.
    let undo = build_undo(
        &users(),
        &[edit_of(0, "7", 1, "new@example.com")],
        &[before(
            0,
            &[(1, Some("old@example.com")), (2, Some("free"))],
        )],
        &[],
    )
    .expect("reversible");

    assert!(undo.contains("\"email\""), "got:\n{undo}");
    assert!(!undo.contains("\"plan\""), "got:\n{undo}");
}

#[test]
fn a_null_it_used_to_hold_comes_back_as_null_not_as_the_word() {
    let undo = build_undo(
        &users(),
        &[edit_of(0, "7", 2, "pro")],
        &[before(0, &[(2, None)])],
        &[],
    )
    .expect("reversible");

    assert!(undo.contains("set \"plan\" = null"), "got:\n{undo}");
    assert!(!undo.contains("'null'"), "got:\n{undo}");
}

#[test]
fn a_quote_in_the_old_value_is_escaped() {
    // An unescaped quote makes the undo either invalid or, worse, a
    // different statement than the one intended.
    let undo = build_undo(
        &users(),
        &[edit_of(0, "7", 1, "x")],
        &[before(0, &[(1, Some("O'Brien"))])],
        &[],
    )
    .expect("reversible");

    assert!(undo.contains("'O''Brien'"), "got:\n{undo}");
}

#[test]
fn a_deletes_undo_puts_the_whole_row_back() {
    let undo = build_undo(
        &users(),
        &[],
        &[before(
            1,
            &[(0, Some("9")), (1, Some("gone@example.com")), (2, None)],
        )],
        &[RowDelete {
            row: 1,
            pk: vec!["9".to_string()],
        }],
    )
    .expect("a delete is reversible");

    assert!(
        undo.contains("insert into \"public\".\"users\""),
        "got:\n{undo}"
    );
    assert!(undo.contains("\"id\", \"email\", \"plan\""), "got:\n{undo}");
    assert!(
        undo.contains("'9'::\"int4\", 'gone@example.com'::\"text\", null"),
        "got:\n{undo}"
    );
}

#[test]
fn an_insert_has_no_undo_because_its_key_is_not_known() {
    // The batch does not return the key the database assigned, and a
    // guessed key is worse than an honest gap.
    assert_eq!(build_undo(&users(), &[], &[], &[]), None);
}

#[test]
fn a_row_with_no_recorded_previous_values_is_skipped_rather_than_guessed() {
    assert_eq!(
        build_undo(&users(), &[edit_of(0, "7", 1, "new@example.com")], &[], &[]),
        None
    );
}

#[test]
fn every_changed_row_gets_its_own_statement() {
    let undo = build_undo(
        &users(),
        &[edit_of(0, "7", 1, "a"), edit_of(1, "8", 1, "b")],
        &[
            before(0, &[(1, Some("was-a"))]),
            before(1, &[(1, Some("was-b"))]),
        ],
        &[],
    )
    .expect("reversible");

    assert_eq!(undo.lines().count(), 2, "got:\n{undo}");
    assert!(undo.contains("'was-a'"), "got:\n{undo}");
    assert!(undo.contains("'was-b'"), "got:\n{undo}");
}

#[test]
fn a_result_with_no_table_has_no_undo() {
    // Nothing to write it against. This is the shape a refused edit
    // already has, so it must not panic.
    let mut edit = users();
    edit.table = None;

    assert_eq!(
        build_undo(
            &edit,
            &[edit_of(0, "7", 1, "x")],
            &[before(0, &[(1, Some("y"))])],
            &[]
        ),
        None
    );
}
