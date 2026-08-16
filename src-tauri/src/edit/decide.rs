//! Deciding whether a result set can be edited, and why not when it
//! cannot.
//!
//! Pure: this file never touches a pool, a connection, or a clock. It
//! takes the metadata Postgres already sent about a result and the
//! facts about one table, and returns a decision. That is what lets the
//! rule table be tested exhaustively rather than representatively —
//! the same reason `guard` is a pure function.

use serde::{Deserialize, Serialize};

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
    /// The values this column accepts, if it is an enum or a boolean.
    /// Built by `edit::sql::value_choices` from the same metadata.
    pub choices: Option<Vec<String>>,
}

/// How Postgres generates a column's values, if it does.
///
/// A three-variant enum rather than the raw `char` Postgres reports,
/// so every match on it is exhaustive: add a variant later and the
/// compiler names every place that has to handle it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Identity {
    None,
    Always,
    ByDefault,
}

impl Identity {
    /// Map `pg_attribute.attidentity`, which is the empty string when
    /// the column is not an identity column.
    pub fn from_catalog(value: &str) -> Identity {
        match value {
            "a" => Identity::Always,
            "d" => Identity::ByDefault,
            _ => Identity::None,
        }
    }
}

/// One column of one table, as the catalog lookup reports it.
///
/// A struct rather than the tuple this used to be: seven positional
/// fields cannot be read at a glance, and a swapped pair compiles
/// silently — the same defect `docs/BACKLOG.md` records for
/// `tab_from_row`.
#[derive(Debug, Clone)]
pub struct TableColumn {
    pub attnum: i16,
    pub name: String,
    pub is_pk: bool,
    pub not_null: bool,
    pub has_default: bool,
    pub identity: Identity,
    /// A `GENERATED ALWAYS AS (…) STORED` column, which cannot be
    /// written at all.
    pub generated: bool,
}

/// One table, as the catalog lookup reports it.
#[derive(Debug, Clone)]
pub struct TableFacts {
    pub relkind: String,
    pub schema: String,
    pub table: String,
    pub columns: Vec<TableColumn>,
}

/// A primary-key column and where its value sits in each result row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PkColumn {
    pub name: String,
    pub result_index: usize,
}

/// The verdict for one result column.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnEdit {
    pub editable: bool,
    /// The real column name to write in `SET`, which is not always the
    /// header: `select email as e` has header `e` and column `email`.
    pub column_name: Option<String>,
    /// Quoted cast target for the bound value, e.g. `"text"`.
    pub cast_type: Option<String>,
    /// Why this cell cannot be edited. `None` when it can.
    pub reason: Option<String>,
    /// Whether a new row may supply a value for this column.
    pub insertable: bool,
    /// Why this cell cannot take a value on a new row. `None` when it
    /// can.
    pub insert_reason: Option<String>,
    /// The values this column accepts, if it is an enum or a boolean.
    pub choices: Option<Vec<String>>,
    /// Whether the database fills this column in when a new row leaves
    /// it out. The grid needs it to say whether an untouched cell means
    /// "default" or "NULL", which are different promises.
    pub has_default: bool,
}

/// The verdict for the whole result, shipped to the UI with every query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditInfo {
    pub editable: bool,
    /// Why the result cannot be edited at all. `None` when it can.
    pub reason: Option<String>,
    /// Whether this result can take new rows at all.
    pub insertable: bool,
    /// Why this result cannot take new rows. `None` when it can.
    pub insert_reason: Option<String>,
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
        let reason = reason.into();
        EditInfo {
            editable: false,
            reason: Some(reason.clone()),
            // Rule 1 of the insert table: an unusable result stays
            // unusable for inserts, for the same reason, verbatim.
            insertable: false,
            insert_reason: Some(reason),
            schema: None,
            table: None,
            pk: Vec::new(),
            columns: (0..columns)
                .map(|_| ColumnEdit {
                    editable: false,
                    column_name: None,
                    cast_type: None,
                    reason: None,
                    insertable: false,
                    insert_reason: None,
                    choices: None,
                    has_default: false,
                })
                .collect(),
        }
    }
}

/// Whether a column must be supplied for an `INSERT` to succeed.
///
/// Everything else either accepts NULL or has something that fills it
/// in, so leaving it out of the statement is safe.
fn is_required(c: &TableColumn) -> bool {
    c.not_null && !c.has_default && c.identity == Identity::None && !c.generated
}

/// Whether the database supplies this column's value itself, which
/// means the user must not.
fn is_generated(c: &TableColumn) -> bool {
    c.generated || c.identity == Identity::Always
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
        .filter(|c| c.is_pk)
        .map(|c| (c.attnum, c.name.clone()))
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

    // Insert rules 2 and 3: every column a new row must supply has to
    // be present in the result exactly once, or the row cannot be
    // built from this grid.
    let mut insert_reason = None;
    for required in facts.columns.iter().filter(|c| is_required(c)) {
        let occurrences = columns
            .iter()
            .filter(|c| c.attnum == Some(required.attnum))
            .count();
        if occurrences == 0 {
            insert_reason = Some(format!(
                "add {} to the query to insert rows — it is NOT NULL with no default",
                required.name
            ));
            break;
        }
        if occurrences > 1 {
            insert_reason = Some(format!("{} appears twice in the result", required.name));
            break;
        }
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
                        insertable: false,
                        insert_reason: Some("computed value".to_string()),
                        choices: None,
                        has_default: false,
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
                    insertable: false,
                    insert_reason: Some("this column appears twice in the result".to_string()),
                    choices: None,
                    has_default: false,
                };
            }

            let is_key = pk.iter().any(|k| k.result_index == index);

            match facts.columns.iter().find(|c| c.attnum == attnum) {
                Some(column) => {
                    // A serial or identity key stays read-only for
                    // insert too: typing one invites a collision and
                    // leaves the sequence behind the table. A natural
                    // key with neither is the one place insert diverges
                    // from "primary keys are read-only" — on a new row
                    // there is no original value to preserve.
                    let key_is_generated =
                        column.is_pk && (column.has_default || column.identity != Identity::None);
                    let insertable = !is_generated(column) && !key_is_generated;
                    let has_default =
                        column.has_default || column.identity != Identity::None || column.generated;

                    if is_key {
                        ColumnEdit {
                            editable: false,
                            column_name: Some(column.name.clone()),
                            // A key is never written, but it is always
                            // *matched* on, and `build_updates` casts
                            // the bound key value through this. Leaving
                            // it empty falls back to text, and `"id" =
                            // $2::text::text` against an integer column
                            // is `operator does not exist: integer =
                            // text`. `editable: false` is what stops a
                            // write; the cast is orthogonal to that.
                            cast_type: Some(c.cast_type.clone()),
                            reason: Some("primary key".to_string()),
                            insertable,
                            insert_reason: if insertable {
                                None
                            } else {
                                Some("generated by the database".to_string())
                            },
                            choices: c.choices.clone(),
                            has_default,
                        }
                    } else {
                        // A generated column cannot be written on an
                        // existing row either: Postgres answers an UPDATE
                        // with "can only be updated to DEFAULT". Same
                        // helper the insert verdict uses, so the two
                        // cannot disagree about what "generated" means.
                        let writable = !is_generated(column);
                        ColumnEdit {
                            editable: writable,
                            column_name: Some(column.name.clone()),
                            cast_type: Some(c.cast_type.clone()),
                            reason: if writable {
                                None
                            } else {
                                Some("generated by the database".to_string())
                            },
                            insertable,
                            insert_reason: if insertable {
                                None
                            } else {
                                Some("generated by the database".to_string())
                            },
                            choices: c.choices.clone(),
                            has_default,
                        }
                    }
                }
                // The result names an attnum the catalog does not have.
                // Should not happen; refusing is the safe direction.
                None => ColumnEdit {
                    editable: false,
                    column_name: None,
                    cast_type: None,
                    reason: Some("unknown column".to_string()),
                    insertable: false,
                    insert_reason: Some("unknown column".to_string()),
                    choices: None,
                    has_default: false,
                },
            }
        })
        .collect();

    EditInfo {
        editable: true,
        reason: None,
        insertable: insert_reason.is_none(),
        insert_reason,
        schema: Some(facts.schema.clone()),
        table: Some(facts.table.clone()),
        pk,
        columns: column_edits,
    }
}
