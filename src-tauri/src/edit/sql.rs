//! Generating `UPDATE` statements from staged cell edits.
//!
//! Pure, like `decide`: strings in, strings out, no pool. The apply
//! path and the "View SQL" preview both call this, so what the user is
//! shown is what runs — a preview that can drift from the real
//! statement is worse than no preview.

use crate::edit::decide::EditInfo;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use tokio_postgres::types::{Kind, Type};

/// One cell the user changed. `column` indexes the result's columns.
#[derive(Debug, Clone, Deserialize)]
pub struct CellEdit {
    pub column: usize,
    /// The typed text, or `None` for an explicit SQL `NULL`.
    pub value: Option<String>,
}

/// Every change staged against one row.
#[derive(Debug, Clone, Deserialize)]
pub struct RowEdit {
    /// Which grid row this is, so the reply can patch it back.
    pub row: usize,
    /// One text value per primary-key column, in `EditInfo.pk` order.
    pub pk: Vec<String>,
    pub cells: Vec<CellEdit>,
}

/// A statement ready to execute, and enough context to patch the grid
/// with what comes back.
#[derive(Debug, Clone, Serialize)]
pub struct Statement {
    pub sql: String,
    /// Bound values. `None` is a real SQL `NULL`.
    pub params: Vec<Option<String>>,
    /// The grid row this statement updates.
    pub row: usize,
    /// Result column indexes, in the order the `RETURNING` list names
    /// them.
    pub returned: Vec<usize>,
}

/// Quote an identifier for inclusion in SQL.
///
/// Doubling embedded quotes is what stops a table named `my"table` —
/// legal Postgres — from ending the quoted name early. This is the one
/// path in the app that writes SQL the user did not, so it is the one
/// place that has to be careful about this.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// How to spell a type in a cast, schema-qualified and quoted.
///
/// Arrays get bracket suffixes rather than the internal `_text`
/// spelling, matching what `exec::run::friendly_type_name` shows in the
/// column header.
pub fn cast_target(t: &Type) -> String {
    match t.kind() {
        Kind::Array(inner) => format!("{}[]", cast_target(inner)),
        _ => format!("{}.{}", quote_ident(t.schema()), quote_ident(t.name())),
    }
}

/// Build one `UPDATE` per edited row.
///
/// Refuses anything the UI should never have offered — a read-only
/// column, a key of the wrong arity, a result that is not editable at
/// all. The frontend already prevents these; refusing here means a
/// frontend bug cannot become a wrong write.
pub fn build_updates(info: &EditInfo, edits: &[RowEdit]) -> Result<Vec<Statement>, AppError> {
    if edits.is_empty() {
        return Ok(Vec::new());
    }

    if !info.editable {
        return Err(AppError::Query {
            message: format!(
                "this result is not editable: {}",
                info.reason.clone().unwrap_or_else(|| "unknown".to_string())
            ),
            code: None,
            position: None,
        });
    }

    let (schema, table) = match (&info.schema, &info.table) {
        (Some(schema), Some(table)) => (schema, table),
        _ => {
            return Err(AppError::Query {
                message: "this result has no source table".to_string(),
                code: None,
                position: None,
            })
        }
    };

    let mut statements = Vec::new();

    for edit in edits {
        if edit.pk.len() != info.pk.len() {
            return Err(AppError::Query {
                message: format!(
                    "expected {} primary key value(s), got {}",
                    info.pk.len(),
                    edit.pk.len()
                ),
                code: None,
                position: None,
            });
        }
        if edit.cells.is_empty() {
            continue;
        }

        // Parameters are numbered across the whole statement: the SET
        // values first, then the key values.
        let mut params: Vec<Option<String>> = Vec::new();
        let mut assignments = Vec::new();
        let mut returned = Vec::new();

        for cell in &edit.cells {
            let column = info
                .columns
                .get(cell.column)
                .ok_or_else(|| AppError::Query {
                    message: format!("column {} is not in this result", cell.column),
                    code: None,
                    position: None,
                })?;

            let (name, cast) = match (&column.column_name, &column.cast_type) {
                (Some(name), Some(cast)) if column.editable => (name, cast),
                _ => {
                    return Err(AppError::Query {
                        message: format!("column {} is not editable", cell.column),
                        code: None,
                        position: None,
                    })
                }
            };

            params.push(cell.value.clone());
            assignments.push(format!(
                "{} = ${}::text::{}",
                quote_ident(name),
                params.len(),
                cast
            ));
            returned.push(cell.column);
        }

        let mut conditions = Vec::new();
        for (key, value) in info.pk.iter().zip(edit.pk.iter()) {
            // The key value is cast through text too, so a uuid or a
            // bigint key needs no special handling here.
            let key_cast = info
                .columns
                .get(key.result_index)
                .and_then(|c| c.cast_type.clone())
                // A key column is read-only, so `decide` left its
                // cast_type empty. Text is the honest fallback: the
                // value arrives as text and Postgres will coerce it
                // when comparing against the real column type.
                .unwrap_or_else(|| "\"pg_catalog\".\"text\"".to_string());
            params.push(Some(value.clone()));
            conditions.push(format!(
                "{} = ${}::text::{}",
                quote_ident(&key.name),
                params.len(),
                key_cast
            ));
        }

        let returning: Vec<String> = edit
            .cells
            .iter()
            .filter_map(|c| info.columns.get(c.column))
            .filter_map(|c| c.column_name.as_ref())
            .map(|name| quote_ident(name))
            .collect();

        let sql = format!(
            "update {}.{} set {} where {} returning {}",
            quote_ident(schema),
            quote_ident(table),
            assignments.join(", "),
            conditions.join(" and "),
            returning.join(", ")
        );

        statements.push(Statement {
            sql,
            params,
            row: edit.row,
            returned,
        });
    }

    Ok(statements)
}
