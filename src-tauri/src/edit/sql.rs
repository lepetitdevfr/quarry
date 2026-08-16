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

/// One row to delete, identified the same way an edit identifies its row.
#[derive(Debug, Clone, Deserialize)]
pub struct RowDelete {
    pub row: usize,
    pub pk: Vec<String>,
}

/// One row to insert. `cells` holds only the columns the user touched;
/// anything absent is left out of the statement, so the database
/// applies its default.
#[derive(Debug, Clone, Deserialize)]
pub struct RowInsert {
    /// Which staged row this is, so the reply can be matched back to
    /// it. Not a grid index — the row is not in the grid yet.
    pub row: usize,
    pub cells: Vec<CellEdit>,
}

/// What a generated statement does. `Update` and `Insert` carry the
/// result column indexes their RETURNING list names; `Delete` carries
/// none, because the row is going away rather than changing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementKind {
    Update,
    Delete,
    Insert,
}

/// A statement ready to execute, and enough context to patch the grid
/// with what comes back.
#[derive(Debug, Clone, Serialize)]
pub struct Statement {
    pub sql: String,
    /// Bound values. `None` is a real SQL `NULL`.
    pub params: Vec<Option<String>>,
    /// Which row this statement is for: a grid index for an update or
    /// a delete, an index into the staged insert list for an insert,
    /// whose row is not in the grid yet.
    pub row: usize,
    /// Result column indexes, in the order the `RETURNING` list names
    /// them.
    pub returned: Vec<usize>,
    /// Whether this changes the row or removes it.
    pub kind: StatementKind,
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

/// The fixed set of values a column accepts, if it has one.
///
/// The labels come from the driver's own type metadata, resolved from
/// `pg_enum` during `prepare` — the same place `table_oid` comes from.
/// No catalog query, and nothing parsed.
pub fn value_choices(t: &Type) -> Option<Vec<String>> {
    match t.kind() {
        Kind::Enum(labels) => Some(labels.clone()),
        // A domain is a constrained wrapper around another type, so it
        // accepts whatever that type accepts.
        Kind::Domain(inner) => value_choices(inner),
        _ if *t == Type::BOOL => Some(vec!["true".to_string(), "false".to_string()]),
        _ => None,
    }
}

/// The table a statement will name, refusing a result that has none or
/// that is not editable at all.
///
/// Shared by `build_updates` and `build_deletes`: deleting a row needs
/// exactly the conditions updating one needs, so it gets exactly the
/// same refusals.
fn source_table(info: &EditInfo) -> Result<(&String, &String), AppError> {
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

    match (&info.schema, &info.table) {
        (Some(schema), Some(table)) => Ok((schema, table)),
        _ => Err(AppError::Query {
            message: "this result has no source table".to_string(),
            code: None,
            position: None,
        }),
    }
}

/// The `WHERE` conditions matching one row by its primary key, pushing
/// each key value onto `params` as it goes.
///
/// The parameter numbers continue from whatever `params` already holds,
/// which is how an `UPDATE` gets its SET values numbered first.
fn key_conditions(
    info: &EditInfo,
    pk: &[String],
    params: &mut Vec<Option<String>>,
) -> Result<Vec<String>, AppError> {
    if pk.len() != info.pk.len() {
        return Err(AppError::Query {
            message: format!(
                "expected {} primary key value(s), got {}",
                info.pk.len(),
                pk.len()
            ),
            code: None,
            position: None,
        });
    }

    let mut conditions = Vec::new();
    for (key, value) in info.pk.iter().zip(pk.iter()) {
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

    Ok(conditions)
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

    let (schema, table) = source_table(info)?;

    let mut statements = Vec::new();

    for edit in edits {
        // Checked before the empty-cells skip, so a malformed key is
        // refused even on a row that would have generated nothing.
        if edit.pk.len() != info.pk.len() {
            key_conditions(info, &edit.pk, &mut Vec::new())?;
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

        let conditions = key_conditions(info, &edit.pk, &mut params)?;

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
            kind: StatementKind::Update,
        });
    }

    Ok(statements)
}

/// Build one `DELETE` per row.
///
/// Same refusals as `build_updates`: a result that is not editable, or
/// a key of the wrong arity. Per-column verdicts do not come into it —
/// a row with a computed column beside real ones is still deletable.
///
/// The `RETURNING` list names the key columns. It is not for display:
/// it makes a delete report exactly one row through the same rowcount
/// assert the updates go through, so that assert stays one
/// implementation.
pub fn build_deletes(info: &EditInfo, deletes: &[RowDelete]) -> Result<Vec<Statement>, AppError> {
    if deletes.is_empty() {
        return Ok(Vec::new());
    }

    let (schema, table) = source_table(info)?;

    let mut statements = Vec::new();

    for delete in deletes {
        let mut params: Vec<Option<String>> = Vec::new();
        let conditions = key_conditions(info, &delete.pk, &mut params)?;

        let returning: Vec<String> = info.pk.iter().map(|key| quote_ident(&key.name)).collect();

        let sql = format!(
            "delete from {}.{} where {} returning {}",
            quote_ident(schema),
            quote_ident(table),
            conditions.join(" and "),
            returning.join(", ")
        );

        statements.push(Statement {
            sql,
            params,
            row: delete.row,
            // Nothing to patch back: the row is going away.
            returned: Vec::new(),
            kind: StatementKind::Delete,
        });
    }

    Ok(statements)
}

/// Build one `INSERT` per staged row.
///
/// The column list holds only the cells the user touched, which is what
/// lets untouched columns take their defaults. `RETURNING` names every
/// result column that maps to a real table column, so the generated
/// key, the applied defaults and any `BEFORE INSERT` rewrite all reach
/// the grid as what the database actually stored.
pub fn build_inserts(info: &EditInfo, inserts: &[RowInsert]) -> Result<Vec<Statement>, AppError> {
    if inserts.is_empty() {
        return Ok(Vec::new());
    }

    let (schema, table) = source_table(info)?;

    if !info.insertable {
        return Err(AppError::Query {
            message: format!(
                "this result cannot take new rows: {}",
                info.insert_reason
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string())
            ),
            code: None,
            position: None,
        });
    }

    // Every column whose attnum resolved to a real table column, in
    // result order. A computed or duplicated column has no name, so it
    // is skipped — the frontend renders those cells as unknown.
    let returned: Vec<usize> = info
        .columns
        .iter()
        .enumerate()
        .filter(|(_, c)| c.column_name.is_some())
        .map(|(i, _)| i)
        .collect();
    let returning: Vec<String> = returned
        .iter()
        .filter_map(|i| info.columns[*i].column_name.as_ref())
        .map(|name| quote_ident(name))
        .collect();

    if returning.is_empty() {
        return Err(AppError::Query {
            message: "this result has no table columns to return".to_string(),
            code: None,
            position: None,
        });
    }

    let mut statements = Vec::new();

    for insert in inserts {
        let mut params: Vec<Option<String>> = Vec::new();
        let mut names = Vec::new();
        let mut values = Vec::new();

        for cell in &insert.cells {
            let column = info
                .columns
                .get(cell.column)
                .ok_or_else(|| AppError::Query {
                    message: format!("column {} is not in this result", cell.column),
                    code: None,
                    position: None,
                })?;

            let (name, cast) = match (&column.column_name, &column.cast_type) {
                (Some(name), Some(cast)) if column.insertable => (name, cast),
                _ => {
                    return Err(AppError::Query {
                        message: format!("column {} cannot take a value on a new row", cell.column),
                        code: None,
                        position: None,
                    })
                }
            };

            params.push(cell.value.clone());
            names.push(quote_ident(name));
            values.push(format!("${}::text::{}", params.len(), cast));
        }

        // A row with nothing staged is a row of defaults, and
        // `default values` is the statement Postgres provides for it.
        let body = if names.is_empty() {
            "default values".to_string()
        } else {
            format!("({}) values ({})", names.join(", "), values.join(", "))
        };

        let sql = format!(
            "insert into {}.{} {} returning {}",
            quote_ident(schema),
            quote_ident(table),
            body,
            returning.join(", ")
        );

        statements.push(Statement {
            sql,
            params,
            row: insert.row,
            returned: returned.clone(),
            kind: StatementKind::Insert,
        });
    }

    Ok(statements)
}
