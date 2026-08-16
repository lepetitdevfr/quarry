pub mod apply;
pub mod decide;
pub mod sql;

pub use apply::{apply_edits, plan_apply, AppliedCell, AppliedRow};
pub use decide::{
    decide_editability, ColumnEdit, EditInfo, Identity, PkColumn, SourceColumn, TableColumn,
    TableFacts,
};
pub use sql::{
    build_deletes, build_inserts, build_updates, cast_target, quote_ident, value_choices, CellEdit,
    RowDelete, RowEdit, RowInsert, Statement, StatementKind,
};

use crate::error::AppError;

/// The statements a batch runs, in the order it runs them.
///
/// Updates, then deletes, then inserts. Inserts must come after
/// deletes: deleting a key and re-adding it in one batch collides on
/// the unique index in the other order.
pub fn build_batch(
    edit: &EditInfo,
    rows: &[RowEdit],
    deletes: &[RowDelete],
    inserts: &[RowInsert],
) -> Result<Vec<Statement>, AppError> {
    let mut statements = build_updates(edit, rows)?;
    statements.extend(build_deletes(edit, deletes)?);
    statements.extend(build_inserts(edit, inserts)?);
    Ok(statements)
}
