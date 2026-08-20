//! What would put a grid edit back.
//!
//! Derived, not captured. The values come from the rows the grid already
//! had on screen, so generating this reads nothing from the database and
//! stores nothing about the user's data that the audit row does not hold
//! anyway. Typed SQL gets no undo for exactly that reason: deriving one
//! would mean reading the affected rows first, which means copying
//! production data into a file in somebody's home directory.
//!
//! The result is text to read and run, not something the app executes.

use crate::edit::decide::EditInfo;
use crate::edit::sql::{quote_ident, CellEdit, RowDelete, RowEdit};
use serde::Deserialize;

/// The values a row held before the batch changed it, as the grid had
/// them.
#[derive(Debug, Clone, Deserialize)]
pub struct RowBefore {
    /// The grid row index, matching `RowEdit::row` and `RowDelete::row`.
    pub row: usize,
    pub cells: Vec<CellEdit>,
}

/// A value as SQL: quoted and cast the way the edit machinery casts, or
/// a bare `null`.
///
/// The cast matters as much as the quoting. Without it Postgres sees an
/// untyped literal, and an undo for an enum or a timestamp column fails
/// where the edit it reverses succeeded.
fn literal(value: Option<&str>, cast_type: Option<&str>) -> String {
    match value {
        None => "null".to_string(),
        Some(text) => {
            let escaped = text.replace('\'', "''");
            match cast_type {
                Some(cast) => format!("'{escaped}'::{cast}"),
                None => format!("'{escaped}'"),
            }
        }
    }
}

/// The `where` clause naming one row by its key.
fn where_key(edit: &EditInfo, pk: &[String]) -> Option<String> {
    if pk.len() != edit.pk.len() {
        return None;
    }

    let parts: Vec<String> = edit
        .pk
        .iter()
        .zip(pk)
        .map(|(column, value)| {
            let cast = edit
                .columns
                .get(column.result_index)
                .and_then(|c| c.cast_type.as_deref());
            format!(
                "{} = {}",
                quote_ident(&column.name),
                literal(Some(value), cast)
            )
        })
        .collect();

    Some(parts.join(" and "))
}

/// SQL that would undo this batch, or `None` when nothing in it is
/// reversible.
///
/// Updates and deletes are. Inserts are not: the batch does not return
/// the key the database assigned, and a guessed key is worse than an
/// honest gap. A row whose previous values were not sent is skipped for
/// the same reason.
pub fn build_undo(
    edit: &EditInfo,
    rows: &[RowEdit],
    before: &[RowBefore],
    deletes: &[RowDelete],
) -> Option<String> {
    let schema = edit.schema.as_ref()?;
    let table = edit.table.as_ref()?;
    let target = format!("{}.{}", quote_ident(schema), quote_ident(table));
    let previous = |row: usize| before.iter().find(|b| b.row == row);

    let mut statements: Vec<String> = Vec::new();

    for edited in rows {
        let (Some(was), Some(key)) = (previous(edited.row), where_key(edit, &edited.pk)) else {
            continue;
        };

        // Only the columns this batch actually changed. An undo that
        // rewrote untouched columns would revert somebody else's
        // concurrent edit along with ours.
        let sets: Vec<String> = edited
            .cells
            .iter()
            .filter_map(|cell| {
                let column = edit.columns.get(cell.column)?;
                let name = column.column_name.as_deref()?;
                let old = was
                    .cells
                    .iter()
                    .find(|c| c.column == cell.column)
                    .and_then(|c| c.value.as_deref());
                Some(format!(
                    "{} = {}",
                    quote_ident(name),
                    literal(old, column.cast_type.as_deref())
                ))
            })
            .collect();

        if !sets.is_empty() {
            statements.push(format!(
                "update {target} set {} where {key};",
                sets.join(", ")
            ));
        }
    }

    for deleted in deletes {
        let Some(was) = previous(deleted.row) else {
            continue;
        };

        let mut names = Vec::new();
        let mut values = Vec::new();
        for cell in &was.cells {
            let Some(column) = edit.columns.get(cell.column) else {
                continue;
            };
            let Some(name) = column.column_name.as_deref() else {
                continue;
            };
            names.push(quote_ident(name));
            values.push(literal(cell.value.as_deref(), column.cast_type.as_deref()));
        }

        if !names.is_empty() {
            statements.push(format!(
                "insert into {target} ({}) values ({});",
                names.join(", "),
                values.join(", ")
            ));
        }
    }

    if statements.is_empty() {
        return None;
    }
    Some(statements.join("\n"))
}
