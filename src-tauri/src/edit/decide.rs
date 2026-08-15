//! Deciding whether a result set can be edited, and why not when it
//! cannot.
//!
//! Pure: this file never touches a pool, a connection, or a clock. It
//! takes the metadata Postgres already sent about a result and the
//! facts about one table, and returns a decision. That is what lets the
//! rule table be tested exhaustively rather than representatively —
//! the same reason `guard` is a pure function.

use serde::Serialize;

/// What Postgres reported about one result column, taken from
/// `tokio_postgres::Column`.
///
/// `table_oid` and `attnum` are `None` for anything that is not a plain
/// reference to a table column — an expression, an aggregate, a
/// literal, a function call. The server sends `0` for those and the
/// driver maps it to `None`. This is the whole basis of the feature:
/// we never parse the user's SQL to work out what it selected.
#[derive(Debug, Clone)]
pub struct SourceColumn {
    pub table_oid: Option<u32>,
    pub attnum: Option<i16>,
    /// How to spell this column's type in a cast, already quoted —
    /// e.g. `"int4"` or `"public"."mood"`. Built by `edit::sql::cast_target`.
    pub cast_type: String,
}

/// One table, as the catalog lookup reports it.
///
/// `columns` is `(attnum, name, is_primary_key)`.
#[derive(Debug, Clone)]
pub struct TableFacts {
    pub relkind: String,
    pub schema: String,
    pub table: String,
    pub columns: Vec<(i16, String, bool)>,
}

/// A primary-key column and where its value sits in each result row.
#[derive(Debug, Clone, Serialize)]
pub struct PkColumn {
    pub name: String,
    pub result_index: usize,
}

/// The verdict for one result column.
#[derive(Debug, Clone, Serialize)]
pub struct ColumnEdit {
    pub editable: bool,
    /// The real column name to write in `SET`, which is not always the
    /// header: `select email as e` has header `e` and column `email`.
    pub column_name: Option<String>,
    /// Quoted cast target for the bound value, e.g. `"text"`.
    pub cast_type: Option<String>,
    /// Why this cell cannot be edited. `None` when it can.
    pub reason: Option<String>,
}

/// The verdict for the whole result, shipped to the UI with every query.
#[derive(Debug, Clone, Serialize)]
pub struct EditInfo {
    pub editable: bool,
    /// Why the result cannot be edited at all. `None` when it can.
    pub reason: Option<String>,
    pub schema: Option<String>,
    pub table: Option<String>,
    pub pk: Vec<PkColumn>,
    pub columns: Vec<ColumnEdit>,
}

impl EditInfo {
    /// Not editable, with the sentence the user will read. Every
    /// refusal carries one: "read-only" with no reason is the failure
    /// this design is trying to avoid.
    fn blocked(reason: impl Into<String>, columns: usize) -> Self {
        EditInfo {
            editable: false,
            reason: Some(reason.into()),
            schema: None,
            table: None,
            pk: Vec::new(),
            columns: (0..columns)
                .map(|_| ColumnEdit {
                    editable: false,
                    column_name: None,
                    cast_type: None,
                    reason: None,
                })
                .collect(),
        }
    }
}

/// The distinct table oids present, ignoring computed columns.
fn distinct_oids(columns: &[SourceColumn]) -> Vec<u32> {
    let mut oids: Vec<u32> = columns.iter().filter_map(|c| c.table_oid).collect();
    oids.sort_unstable();
    oids.dedup();
    oids
}

/// Decide whether a result set can be edited.
///
/// `facts` is `Some` only when the caller already established that every
/// sourced column shares one table oid and looked that oid up. Passing
/// `None` still produces the right refusal, so the two halves cannot
/// disagree.
pub fn decide_editability(columns: &[SourceColumn], facts: Option<&TableFacts>) -> EditInfo {
    // Rule 1: nothing to edit.
    if columns.is_empty() {
        return EditInfo::blocked("this statement returned no columns", 0);
    }

    // Rules 2 and 3, from the metadata alone.
    let oids = distinct_oids(columns);
    match oids.len() {
        0 => {
            return EditInfo::blocked(
                "these are computed values, not table columns",
                columns.len(),
            )
        }
        1 => {}
        n => {
            return EditInfo::blocked(
                format!("this result joins {n} tables — an UPDATE cannot tell which row to change"),
                columns.len(),
            )
        }
    }

    let facts = match facts {
        Some(facts) => facts,
        // The caller could not resolve the oid — a dropped table, or a
        // permission problem reading the catalog.
        None => return EditInfo::blocked("could not identify the source table", columns.len()),
    };

    // Rule 4: ordinary tables and partitioned tables only.
    if facts.relkind != "r" && facts.relkind != "p" {
        return EditInfo::blocked("this result comes from a view", columns.len());
    }

    // Rule 5: no key, no WHERE clause.
    let pk_names: Vec<(i16, String)> = facts
        .columns
        .iter()
        .filter(|(_, _, is_pk)| *is_pk)
        .map(|(attnum, name, _)| (*attnum, name.clone()))
        .collect();

    if pk_names.is_empty() {
        return EditInfo::blocked(
            format!("table {}.{} has no primary key", facts.schema, facts.table),
            columns.len(),
        );
    }

    // Rule 6: every key column must be present in the result, or its
    // value is unknown for the rows on screen.
    let mut pk = Vec::new();
    let mut missing = Vec::new();
    for (attnum, name) in &pk_names {
        match columns.iter().position(|c| c.attnum == Some(*attnum)) {
            Some(index) => pk.push(PkColumn {
                name: name.clone(),
                result_index: index,
            }),
            None => missing.push(name.clone()),
        }
    }
    if !missing.is_empty() {
        return EditInfo::blocked(
            format!("add {} to the query to edit these rows", missing.join(", ")),
            columns.len(),
        );
    }

    // Per-column verdicts.
    let column_edits = columns
        .iter()
        .enumerate()
        .map(|(index, c)| {
            let attnum = match c.attnum {
                Some(attnum) => attnum,
                None => {
                    return ColumnEdit {
                        editable: false,
                        column_name: None,
                        cast_type: None,
                        reason: Some("computed value".to_string()),
                    }
                }
            };

            // The same column twice means two SET clauses for one
            // target in one statement, which Postgres rejects — and
            // which of the two edits should win is not answerable.
            let occurrences = columns.iter().filter(|o| o.attnum == Some(attnum)).count();
            if occurrences > 1 {
                return ColumnEdit {
                    editable: false,
                    column_name: None,
                    cast_type: None,
                    reason: Some("this column appears twice in the result".to_string()),
                };
            }

            if pk.iter().any(|k| k.result_index == index) {
                return ColumnEdit {
                    editable: false,
                    column_name: None,
                    cast_type: None,
                    reason: Some("primary key".to_string()),
                };
            }

            match facts.columns.iter().find(|(n, _, _)| *n == attnum) {
                Some((_, name, _)) => ColumnEdit {
                    editable: true,
                    column_name: Some(name.clone()),
                    cast_type: Some(c.cast_type.clone()),
                    reason: None,
                },
                // The result names an attnum the catalog does not have.
                // Should not happen; refusing is the safe direction.
                None => ColumnEdit {
                    editable: false,
                    column_name: None,
                    cast_type: None,
                    reason: Some("unknown column".to_string()),
                },
            }
        })
        .collect();

    EditInfo {
        editable: true,
        reason: None,
        schema: Some(facts.schema.clone()),
        table: Some(facts.table.clone()),
        pk,
        columns: column_edits,
    }
}
