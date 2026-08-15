# Inline Row Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit cells in the result grid, stage the changes as highlighted pending diffs, and apply them as generated `UPDATE`s in one transaction — disabled entirely on a locked connection.

**Architecture:** Row identity comes from `tokio_postgres::Column::table_oid()`/`column_id()`, which Postgres populates on every `prepare` and leaves empty for expressions. A new `edit` module holds two pure files (`decide.rs` decides editability, `sql.rs` generates statements) and one impure one (`apply.rs` runs them in a transaction with a rowcount assert). The frontend keeps every decision in `src/lib/pendingEdits.ts`; the grid component only renders.

**Tech Stack:** Rust (`tokio-postgres`, `deadpool-postgres`, `serde`), Tauri 2 commands, React 19 + TypeScript, Vitest, `testcontainers` for the Postgres tests.

**Spec:** `docs/superpowers/specs/2026-08-16-inline-row-editing-design.md`

**Before starting:**
- Branch is `inline-row-editing`, already created off `main`.
- Docker must be running for any task with an integration test (Tasks 3, 5, 7, 8).
- `cargo clippy` and `cargo fmt` FAIL at baseline in this repo. Do not run them, do not chase them. `cargo test` and `npm test` are the checks.
- No `Co-Authored-By` trailers in commits.

---

### Task 1: `edit::decide` — the editability rule table

The pure heart of the feature. No pool, no async, no state — just column metadata in, a decision out. Every rule from spec §3 gets one test.

**Files:**
- Create: `src-tauri/src/edit/mod.rs`
- Create: `src-tauri/src/edit/decide.rs`
- Modify: `src-tauri/src/lib.rs` (register the module)
- Test: `src-tauri/tests/edit_decide_test.rs`

- [ ] **Step 1: Add the module to the crate**

In `src-tauri/src/lib.rs`, beside the existing `pub mod exec;` / `pub mod guard;` lines, add:

```rust
pub mod edit;
```

Create `src-tauri/src/edit/mod.rs`:

```rust
pub mod decide;

pub use decide::{decide_editability, ColumnEdit, EditInfo, PkColumn, SourceColumn, TableFacts};
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/tests/edit_decide_test.rs`:

```rust
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
    let info = decide_editability(&[col(1, "\"int4\""), col(2, "\"text\"")], Some(&users_table()));

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
    let info = decide_editability(&[col(2, "\"text\""), col(3, "\"text\"")], Some(&users_table()));

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
    let info = decide_editability(&[col(1, "\"int4\""), col(2, "\"text\"")], Some(&users_table()));

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

    let info = decide_editability(&[col(1, "\"int4\""), col(2, "\"text\"")], Some(&partitioned));

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
```

- [ ] **Step 2b: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --test edit_decide_test`
Expected: FAIL to compile — `could not find 'edit' in 'quarry_lib'` or `cannot find function 'decide_editability'`.

- [ ] **Step 3: Write the implementation**

Create `src-tauri/src/edit/decide.rs`:

```rust
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
            format!(
                "table {}.{} has no primary key",
                facts.schema, facts.table
            ),
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
        .map(|c| {
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

            if pk.iter().any(|k| k.result_index == index_of(columns, c)) {
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

/// Position of `needle` within `columns`, by identity of position.
///
/// `columns.iter().map(...)` hands out `&SourceColumn` without an index,
/// and two columns can be equal by value (`select email, email`), so
/// comparing values would find the wrong one. Comparing the pointer is
/// exact: it is the same element of the same slice.
fn index_of(columns: &[SourceColumn], needle: &SourceColumn) -> usize {
    columns
        .iter()
        .position(|c| std::ptr::eq(c, needle))
        .expect("the column came from this slice")
}
```

**Rust note (for the beginner):** `std::ptr::eq` compares *addresses*, not contents. It is used here because `select email, email` produces two `SourceColumn`s that are equal by value but are different elements, and we need to know *which* element we are looking at. An alternative is to iterate with `.enumerate()` and pass the index down; that is arguably plainer, and if the pointer comparison reads as clever rather than clear, rewrite the `map` as `columns.iter().enumerate().map(|(index, c)| ...)` and drop `index_of` entirely. Prefer whichever the reviewer finds more readable — behaviour is identical.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --test edit_decide_test`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/edit src-tauri/src/lib.rs src-tauri/tests/edit_decide_test.rs
git commit -m "feat(edit): decide which result sets and cells are editable"
```

---

### Task 2: `edit::sql` — cast targets, quoting, and statement generation

Still pure. Turns pending cells into `UPDATE`s with bound parameters.

**Files:**
- Create: `src-tauri/src/edit/sql.rs`
- Modify: `src-tauri/src/edit/mod.rs`
- Test: `src-tauri/tests/edit_sql_test.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/edit_sql_test.rs`:

```rust
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
    assert_eq!(
        cast_target(&Type::TEXT_ARRAY),
        "\"pg_catalog\".\"text\"[]"
    );
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
        statements[0].sql.contains("set \"email\" = $1") && statements[0].sql.contains(", \"plan\" = $2"),
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
        columns: vec![read_only(), read_only(), editable("role", "\"pg_catalog\".\"text\"")],
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
        statements[0].sql.contains("where \"user_id\" = $2") && statements[0].sql.contains("and \"group_id\" = $3"),
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
    assert!(format!("{error}").contains("not editable"), "error was: {error}");
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --test edit_sql_test`
Expected: FAIL to compile — `could not find 'sql' in 'edit'`.

- [ ] **Step 3: Write the implementation**

Create `src-tauri/src/edit/sql.rs`:

```rust
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
            let column = info.columns.get(cell.column).ok_or_else(|| AppError::Query {
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
```

Add to `src-tauri/src/edit/mod.rs`:

```rust
pub mod decide;
pub mod sql;

pub use decide::{decide_editability, ColumnEdit, EditInfo, PkColumn, SourceColumn, TableFacts};
pub use sql::{build_updates, cast_target, quote_ident, CellEdit, RowEdit, Statement};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --test edit_sql_test`
Expected: PASS, 11 tests.

If `cast_target(&Type::INT4)` returns something other than `"pg_catalog"."int4"`, print it and align the test with reality rather than forcing the code — the schema of a built-in is whatever `tokio-postgres` reports.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/edit src-tauri/tests/edit_sql_test.rs
git commit -m "feat(edit): generate UPDATE statements from staged cell edits"
```

---

### Task 3: `schema::lookup_table` — resolve an oid against the catalog

**Files:**
- Modify: `src-tauri/src/schema/introspect.rs`
- Modify: `src-tauri/src/schema/mod.rs` (export it)
- Test: `src-tauri/tests/edit_db_test.rs` (new file; more tests land here in Tasks 5 and 7)

Requires Docker.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/tests/edit_db_test.rs`:

```rust
mod common;

use quarry_lib::exec::run_query;
use quarry_lib::schema::lookup_table;

/// Create a table and return its oid, the way the result metadata
/// would report it.
async fn oid_of(pool: &deadpool_postgres::Pool, name: &str) -> u32 {
    // Cast to int8, not left as `oid`: `exec::value::cell_to_json` has
    // no arm for the oid type, so it would come back as a string.
    let result = run_query(
        pool,
        &format!("select '{name}'::regclass::oid::int8 as oid"),
        false,
    )
    .await
    .expect("oid lookup should run");
    result.rows[0][0]
        .as_u64()
        .expect("oid should be a number") as u32
}

#[tokio::test]
async fn lookup_table_reports_columns_and_the_primary_key() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text, plan text)",
        false,
    )
    .await
    .expect("create table");

    let oid = oid_of(&db.pool, "people").await;
    let facts = lookup_table(&db.pool, oid)
        .await
        .expect("lookup should run")
        .expect("the table exists");

    assert_eq!(facts.relkind, "r");
    assert_eq!(facts.schema, "public");
    assert_eq!(facts.table, "people");
    assert_eq!(facts.columns.len(), 3);
    assert_eq!(facts.columns[0], (1, "id".to_string(), true));
    assert_eq!(facts.columns[1], (2, "email".to_string(), false));
}

#[tokio::test]
async fn lookup_table_reports_a_view_as_a_view() {
    let db = common::start().await;

    run_query(&db.pool, "create table people (id int primary key)", false)
        .await
        .expect("create table");
    run_query(&db.pool, "create view people_v as select * from people", false)
        .await
        .expect("create view");

    let oid = oid_of(&db.pool, "people_v").await;
    let facts = lookup_table(&db.pool, oid)
        .await
        .expect("lookup should run")
        .expect("the view exists");

    assert_eq!(facts.relkind, "v");
}

#[tokio::test]
async fn lookup_table_skips_dropped_columns() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, junk text, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(&db.pool, "alter table people drop column junk", false)
        .await
        .expect("drop column");

    let oid = oid_of(&db.pool, "people").await;
    let facts = lookup_table(&db.pool, oid)
        .await
        .expect("lookup should run")
        .expect("the table exists");

    // A dropped column keeps its attnum forever. Including it would
    // shift nothing, but it would let a stale attnum match.
    assert_eq!(facts.columns.len(), 2);
    assert!(facts.columns.iter().all(|(_, name, _)| name != "junk"));
}

#[tokio::test]
async fn lookup_table_returns_none_for_an_unknown_oid() {
    let db = common::start().await;

    let facts = lookup_table(&db.pool, 1).await.expect("lookup should run");
    assert!(facts.is_none());
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --test edit_db_test`
Expected: FAIL to compile — `cannot find function 'lookup_table'`.

- [ ] **Step 3: Write the implementation**

Append to `src-tauri/src/schema/introspect.rs`:

```rust
use crate::edit::TableFacts;

/// Resolve one table oid into the facts editing needs: what kind of
/// relation it is, its qualified name, and its columns with their
/// primary-key flags.
///
/// Returns `Ok(None)` when the oid names nothing — a table dropped
/// between running the query and asking about it, which is a refusal to
/// edit rather than an error to show.
///
/// The `is_pk` subquery is the same one the schema tree uses above, so
/// the two cannot disagree about what a primary key is.
pub async fn lookup_table(pool: &Pool, oid: u32) -> Result<Option<TableFacts>, AppError> {
    let client = pool.get().await?;

    let rows = client
        .query(
            "select c.relkind::text        as relkind,
                    n.nspname               as schema,
                    c.relname               as table_name,
                    a.attnum                as attnum,
                    a.attname               as column_name,
                    exists (
                      select 1 from pg_constraint pc
                      where pc.conrelid = c.oid
                        and pc.contype = 'p'
                        and a.attnum = any (pc.conkey)
                    )                       as is_pk
             from   pg_class c
             join   pg_namespace n on n.oid = c.relnamespace
             join   pg_attribute a on a.attrelid = c.oid
             where  c.oid = $1
               and  a.attnum > 0
               and  not a.attisdropped
             order by a.attnum",
            // Postgres oids are unsigned, Rust's postgres types are
            // signed — `u32` has no `ToSql`. `Type::OID` accepts a u32
            // via the `Oid` alias, so pass it as one.
            &[&oid],
        )
        .await?;

    if rows.is_empty() {
        return Ok(None);
    }

    let first = &rows[0];
    Ok(Some(TableFacts {
        relkind: first.get("relkind"),
        schema: first.get("schema"),
        table: first.get("table_name"),
        columns: rows
            .iter()
            .map(|row| {
                (
                    row.get::<_, i16>("attnum"),
                    row.get::<_, String>("column_name"),
                    row.get::<_, bool>("is_pk"),
                )
            })
            .collect(),
    }))
}
```

Export it from `src-tauri/src/schema/mod.rs` beside the existing introspection exports:

```rust
pub use introspect::lookup_table;
```

**If `&[&oid]` does not compile** (`the trait ToSql is not implemented for u32`): `tokio_postgres::types::Oid` is a type alias for `u32` and does implement it, so the fix is to make the parameter type explicit — `let oid: tokio_postgres::types::Oid = oid;` before the query. Do not change the query to `$1::text` or cast the value to `i32`; oids above 2^31 exist.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --test edit_db_test`
Expected: PASS, 4 tests. Docker must be running.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/schema src-tauri/tests/edit_db_test.rs
git commit -m "feat(schema): resolve a table oid into editing facts"
```

---

### Task 4: Ship the decision with every query result

`run_query` collects the source metadata, looks the table up when the oids agree, and puts an `EditInfo` on `QueryResult`.

**Files:**
- Modify: `src-tauri/src/exec/run.rs`
- Test: `src-tauri/tests/edit_db_test.rs` (append)

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/tests/edit_db_test.rs`:

```rust
#[tokio::test]
async fn a_single_table_select_comes_back_editable() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select should run");

    assert!(result.edit.editable, "reason: {:?}", result.edit.reason);
    assert_eq!(result.edit.table.as_deref(), Some("people"));
    assert_eq!(result.edit.pk[0].result_index, 0);
    assert!(result.edit.columns[1].editable);
}

#[tokio::test]
async fn an_aggregate_comes_back_not_editable() {
    let db = common::start().await;

    run_query(&db.pool, "create table people (id int primary key)", false)
        .await
        .expect("create table");

    let result = run_query(&db.pool, "select count(*) from people", false)
        .await
        .expect("select should run");

    assert!(!result.edit.editable);
    assert!(
        result.edit.reason.unwrap_or_default().contains("computed"),
        "expected a computed-values reason"
    );
}

#[tokio::test]
async fn a_join_comes_back_not_editable() {
    let db = common::start().await;

    run_query(&db.pool, "create table a (id int primary key)", false)
        .await
        .expect("create a");
    run_query(&db.pool, "create table b (id int primary key)", false)
        .await
        .expect("create b");

    let result = run_query(
        &db.pool,
        "select a.id, b.id from a join b on a.id = b.id",
        false,
    )
    .await
    .expect("select should run");

    assert!(!result.edit.editable);
    assert!(
        result.edit.reason.unwrap_or_default().contains("joins 2 tables"),
        "expected a join reason"
    );
}

#[tokio::test]
async fn a_view_comes_back_not_editable() {
    let db = common::start().await;

    run_query(&db.pool, "create table people (id int primary key)", false)
        .await
        .expect("create table");
    run_query(&db.pool, "create view people_v as select * from people", false)
        .await
        .expect("create view");

    let result = run_query(&db.pool, "select id from people_v", false)
        .await
        .expect("select should run");

    assert!(!result.edit.editable);
    assert!(
        result.edit.reason.unwrap_or_default().contains("view"),
        "expected a view reason"
    );
}

#[tokio::test]
async fn a_table_without_a_key_comes_back_not_editable() {
    let db = common::start().await;

    run_query(&db.pool, "create table notes (body text)", false)
        .await
        .expect("create table");

    let result = run_query(&db.pool, "select body from notes", false)
        .await
        .expect("select should run");

    assert!(!result.edit.editable);
    assert!(
        result.edit.reason.unwrap_or_default().contains("no primary key"),
        "expected a no-primary-key reason"
    );
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --test edit_db_test`
Expected: FAIL to compile — `no field 'edit' on type 'QueryResult'`.

- [ ] **Step 3: Write the implementation**

In `src-tauri/src/exec/run.rs`, add the imports:

```rust
use crate::edit::{decide_editability, cast_target, EditInfo, SourceColumn};
use crate::schema::lookup_table;
```

Add the field to `QueryResult`, after `columns`:

```rust
    /// Whether this result can be edited in the grid, and why not when
    /// it cannot. Decided in Rust so the frontend never has to.
    pub edit: EditInfo,
```

After the `columns` vector is built in `run_query`, add:

```rust
    // What Postgres said about where each column came from. `table_oid`
    // and `attnum` are empty for expressions and aggregates — that is
    // the server telling us the column has no row to update, which is
    // more reliable than parsing the SQL back.
    let sources: Vec<SourceColumn> = stmt
        .columns()
        .iter()
        .map(|c| SourceColumn {
            table_oid: c.table_oid(),
            attnum: c.column_id(),
            cast_type: cast_target(c.type_()),
        })
        .collect();

    // One catalog round-trip, and only when every sourced column agrees
    // on one table. A join or an aggregate is refused from the metadata
    // alone and pays nothing.
    let mut oids: Vec<u32> = sources.iter().filter_map(|s| s.table_oid).collect();
    oids.sort_unstable();
    oids.dedup();
    let facts = if oids.len() == 1 {
        // A failed lookup is not a failed query: the rows are fine,
        // they just cannot be edited. `decide_editability` turns `None`
        // into the right refusal.
        lookup_table(pool, oids[0]).await.unwrap_or(None)
    } else {
        None
    };

    let edit = decide_editability(&sources, facts.as_ref());
```

Then add `edit` to **both** `QueryResult` constructions in the function (the empty-columns early return and the final one). For the empty-columns case there is nothing to decide, so build it from the same function with an empty slice:

```rust
        return Ok(QueryResult {
            columns,
            edit,
            rows: Vec::new(),
            row_count: 0,
            affected_rows: Some(affected),
            duration_ms,
        });
```

**Placement note:** compute `sources`/`facts`/`edit` immediately after `columns`, *before* the `if columns.is_empty()` branch, so both returns can use it. `decide_editability(&[], None)` returns the "no columns" refusal, which is correct for an `UPDATE` or DDL statement.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --test edit_db_test`
Expected: PASS, 9 tests.

Then the whole suite, because `QueryResult` gained a field and other tests construct or assert on it:

Run: `cd src-tauri && cargo test`
Expected: PASS. If a test fails to compile because it builds a `QueryResult` literal, add `edit: quarry_lib::edit::decide_editability(&[], None)` to it.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/exec src-tauri/tests/edit_db_test.rs
git commit -m "feat(exec): report editability with every result set"
```

---

### Task 5: `edit::apply` — one transaction, rowcount assert, RETURNING

**Files:**
- Create: `src-tauri/src/edit/apply.rs`
- Modify: `src-tauri/src/edit/mod.rs`
- Test: `src-tauri/tests/edit_db_test.rs` (append)

Requires Docker.

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/tests/edit_db_test.rs`:

```rust
use quarry_lib::edit::{apply_edits, build_updates, CellEdit, RowEdit};

#[tokio::test]
async fn an_edit_lands_and_returns_the_stored_value() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(&db.pool, "insert into people values (1, 'old@x.co')", false)
        .await
        .expect("insert");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select");

    let statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("new@x.co".to_string()),
            }],
        }],
    )
    .expect("should build");

    let applied = apply_edits(&db.pool, &statements, false)
        .await
        .expect("apply should succeed");

    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].row, 0);
    assert_eq!(applied[0].cells[0].column, 1);
    assert_eq!(applied[0].cells[0].value, serde_json::json!("new@x.co"));

    let after = run_query(&db.pool, "select email from people", false)
        .await
        .expect("select");
    assert_eq!(after.rows[0][0], serde_json::json!("new@x.co"));
}

#[tokio::test]
async fn a_trigger_rewrite_comes_back_through_returning() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(&db.pool, "insert into people values (1, 'old@x.co')", false)
        .await
        .expect("insert");
    // A BEFORE UPDATE trigger that lowercases what you typed. The grid
    // must show what the database stored, not what you typed.
    run_query(
        &db.pool,
        "create function lower_email() returns trigger as $$
         begin new.email = lower(new.email); return new; end;
         $$ language plpgsql",
        false,
    )
    .await
    .expect("create function");
    run_query(
        &db.pool,
        "create trigger t before update on people for each row execute function lower_email()",
        false,
    )
    .await
    .expect("create trigger");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select");

    let statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("SHOUTY@X.CO".to_string()),
            }],
        }],
    )
    .expect("should build");

    let applied = apply_edits(&db.pool, &statements, false)
        .await
        .expect("apply should succeed");

    assert_eq!(applied[0].cells[0].value, serde_json::json!("shouty@x.co"));
}

#[tokio::test]
async fn a_vanished_row_rolls_back_the_whole_batch() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(
        &db.pool,
        "insert into people values (1, 'a@x.co'), (2, 'b@x.co')",
        false,
    )
    .await
    .expect("insert");

    let result = run_query(&db.pool, "select id, email from people order by id", false)
        .await
        .expect("select");

    // Row 2 is deleted behind our back, exactly as a concurrent session
    // would.
    run_query(&db.pool, "delete from people where id = 2", false)
        .await
        .expect("delete");

    let statements = build_updates(
        &result.edit,
        &[
            RowEdit {
                row: 0,
                pk: vec!["1".to_string()],
                cells: vec![CellEdit {
                    column: 1,
                    value: Some("changed@x.co".to_string()),
                }],
            },
            RowEdit {
                row: 1,
                pk: vec!["2".to_string()],
                cells: vec![CellEdit {
                    column: 1,
                    value: Some("gone@x.co".to_string()),
                }],
            },
        ],
    )
    .expect("should build");

    let error = apply_edits(&db.pool, &statements, false)
        .await
        .expect_err("a missing row must fail the batch");
    assert!(
        format!("{error}").contains("no longer"),
        "error was: {error}"
    );

    // The edit that *would* have worked must be rolled back too.
    // A partial apply leaves the grid claiming things the database
    // does not agree with.
    let after = run_query(&db.pool, "select email from people where id = 1", false)
        .await
        .expect("select");
    assert_eq!(after.rows[0][0], serde_json::json!("a@x.co"));
}

#[tokio::test]
async fn setting_null_differs_from_setting_an_empty_string() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(
        &db.pool,
        "insert into people values (1, 'a@x.co'), (2, 'b@x.co')",
        false,
    )
    .await
    .expect("insert");

    let result = run_query(&db.pool, "select id, email from people order by id", false)
        .await
        .expect("select");

    let statements = build_updates(
        &result.edit,
        &[
            RowEdit {
                row: 0,
                pk: vec!["1".to_string()],
                cells: vec![CellEdit {
                    column: 1,
                    value: None,
                }],
            },
            RowEdit {
                row: 1,
                pk: vec!["2".to_string()],
                cells: vec![CellEdit {
                    column: 1,
                    value: Some(String::new()),
                }],
            },
        ],
    )
    .expect("should build");

    apply_edits(&db.pool, &statements, false)
        .await
        .expect("apply should succeed");

    let after = run_query(
        &db.pool,
        "select id, email is null as is_null, email from people order by id",
        false,
    )
    .await
    .expect("select");

    assert_eq!(after.rows[0][1], serde_json::json!(true));
    assert_eq!(after.rows[1][1], serde_json::json!(false));
    assert_eq!(after.rows[1][2], serde_json::json!(""));
}

#[tokio::test]
async fn a_bad_value_fails_with_the_postgres_message() {
    let db = common::start().await;

    run_query(&db.pool, "create table nums (id int primary key, n int)", false)
        .await
        .expect("create table");
    run_query(&db.pool, "insert into nums values (1, 5)", false)
        .await
        .expect("insert");

    let result = run_query(&db.pool, "select id, n from nums", false)
        .await
        .expect("select");

    let statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("not a number".to_string()),
            }],
        }],
    )
    .expect("should build");

    let error = apply_edits(&db.pool, &statements, false)
        .await
        .expect_err("a bad value must fail");
    assert!(
        format!("{error}").contains("invalid input syntax"),
        "error was: {error}"
    );

    // And the old value survives.
    let after = run_query(&db.pool, "select n from nums", false)
        .await
        .expect("select");
    assert_eq!(after.rows[0][0], serde_json::json!(5));
}
```

```rust
#[tokio::test]
async fn postgres_refuses_an_edit_on_a_read_only_pool() {
    // Layer two, standing alone for the *editing* path specifically.
    // `guard_db_test` proves this for `run_query`; this proves it for
    // `apply_edits`, which is a different code path — and being a
    // different code path is the entire reason the write-guard spec
    // built two layers.
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(&db.pool, "insert into people values (1, 'a@x.co')", false)
        .await
        .expect("insert");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select");

    let statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("b@x.co".to_string()),
            }],
        }],
    )
    .expect("should build");

    // A second pool at the same database, read-only — and
    // `read_write: false`, which is what a future code path that
    // forgot the guard would produce.
    let cfg = common::config_for(db.port);
    let locked_pool = quarry_lib::conn::build_pool(&cfg, quarry_lib::guard::Policy::ReadOnly)
        .expect("pool should build");

    let error = apply_edits(&locked_pool, &statements, false)
        .await
        .expect_err("a read-only connection must refuse an edit");
    let message = format!("{error}");
    assert!(
        message.contains("read-only") || message.contains("read only"),
        "expected a read-only refusal from the server, got: {message}"
    );
}

#[tokio::test]
async fn an_unlocked_connection_can_apply_an_edit() {
    // The other half: `BEGIN READ WRITE` must override the session
    // default for the editing path too, or unlocking could never let
    // an edit through.
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id int primary key, email text)",
        false,
    )
    .await
    .expect("create table");
    run_query(&db.pool, "insert into people values (1, 'a@x.co')", false)
        .await
        .expect("insert");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select");

    let statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit {
                column: 1,
                value: Some("b@x.co".to_string()),
            }],
        }],
    )
    .expect("should build");

    let cfg = common::config_for(db.port);
    let locked_pool = quarry_lib::conn::build_pool(&cfg, quarry_lib::guard::Policy::ReadOnly)
        .expect("pool should build");

    apply_edits(&locked_pool, &statements, true)
        .await
        .expect("an unlocked edit should be permitted");

    let after = run_query(&db.pool, "select email from people", false)
        .await
        .expect("select");
    assert_eq!(after.rows[0][0], serde_json::json!("b@x.co"));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --test edit_db_test`
Expected: FAIL to compile — `cannot find function 'apply_edits'`.

- [ ] **Step 3: Write the implementation**

Create `src-tauri/src/edit/apply.rs`:

```rust
//! Running generated `UPDATE`s in one transaction.
//!
//! The impure half of the module. Everything it runs was built by
//! `edit::sql`, which is pure and tested separately.

use crate::edit::sql::Statement;
use crate::error::AppError;
use crate::exec::value::cell_to_json;
use deadpool_postgres::Pool;
use serde::Serialize;
use tokio_postgres::types::ToSql;

/// One cell as the database now holds it.
#[derive(Debug, Serialize)]
pub struct AppliedCell {
    pub column: usize,
    pub value: serde_json::Value,
}

/// What one statement did, so the grid can patch that row.
#[derive(Debug, Serialize)]
pub struct AppliedRow {
    pub row: usize,
    pub cells: Vec<AppliedCell>,
}

/// Apply every statement in one transaction.
///
/// Each must affect exactly one row. Anything else — zero because the
/// row was deleted, more than one because the key is not what we think
/// it is, or an error from the server — rolls the whole batch back.
/// A partial apply would leave the grid asserting values the database
/// does not hold, which is the worst outcome available here.
///
/// `read_write` mirrors `exec::run_query`: on a read-only connection
/// the session default is `default_transaction_read_only=on`, and an
/// unlocked write has to opt out of it explicitly.
pub async fn apply_edits(
    pool: &Pool,
    statements: &[Statement],
    read_write: bool,
) -> Result<Vec<AppliedRow>, AppError> {
    if statements.is_empty() {
        return Ok(Vec::new());
    }

    let client = pool.get().await?;

    let begin = if read_write {
        "begin read write"
    } else {
        "begin"
    };
    client.batch_execute(begin).await?;

    let mut applied = Vec::new();

    for statement in statements {
        match run_one(&client, statement).await {
            Ok(row) => applied.push(row),
            Err(e) => {
                // Leave no transaction open on the pooled connection:
                // `RecyclingMethod::Clean` would roll it back on
                // return, but not before another checkout could see it.
                // Same reasoning as `exec::run_query`.
                let _ = client.batch_execute("rollback").await;
                return Err(e);
            }
        }
    }

    client.batch_execute("commit").await?;
    Ok(applied)
}

async fn run_one(
    client: &deadpool_postgres::Client,
    statement: &Statement,
) -> Result<AppliedRow, AppError> {
    // `query` wants `&[&(dyn ToSql + Sync)]`, and what we hold is
    // `Vec<Option<String>>`. `Option<String>` implements `ToSql` —
    // `None` binds a real SQL NULL — so this borrows each element and
    // widens it to a trait object. The intermediate `Vec` has to exist
    // as a named binding: building it inline would drop it while the
    // slice still borrowed from it.
    let params: Vec<&(dyn ToSql + Sync)> = statement
        .params
        .iter()
        .map(|p| p as &(dyn ToSql + Sync))
        .collect();

    let rows = client.query(&statement.sql, &params).await?;

    if rows.len() != 1 {
        return Err(AppError::Query {
            message: format!(
                "row {} no longer matches one row in the table — it was changed or deleted \
                 by someone else. Nothing was applied.",
                statement.row + 1
            ),
            code: None,
            position: None,
        });
    }

    let cells = statement
        .returned
        .iter()
        .enumerate()
        .map(|(i, column)| AppliedCell {
            column: *column,
            value: cell_to_json(&rows[0], i),
        })
        .collect();

    Ok(AppliedRow {
        row: statement.row,
        cells,
    })
}
```

Add to `src-tauri/src/edit/mod.rs`:

```rust
pub mod apply;

pub use apply::{apply_edits, AppliedCell, AppliedRow};
```

If `cell_to_json` is not public, make it `pub` in `src-tauri/src/exec/value.rs` and export it from `src-tauri/src/exec/mod.rs`:

```rust
pub use value::cell_to_json;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --test edit_db_test`
Expected: PASS, 16 tests.

- [ ] **Step 5: Prove the rowcount assert is load-bearing**

This is a required mutation check, not optional. Temporarily change the assert in `run_one` to `if rows.len() > 99 {`, then:

Run: `cd src-tauri && cargo test --test edit_db_test a_vanished_row_rolls_back_the_whole_batch`
Expected: **FAIL**. If it passes, the test is not testing the assert — fix the test before restoring the code.

Restore the assert to `if rows.len() != 1 {` and re-run:
Expected: PASS.

Record both outcomes in the commit message body.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/edit src-tauri/src/exec src-tauri/tests/edit_db_test.rs
git commit -m "feat(edit): apply staged edits in one transaction

The rowcount assert was verified by mutation: relaxing it to
rows.len() > 99 makes a_vanished_row_rolls_back_the_whole_batch fail,
and restoring it makes the test pass again."
```

---

### Task 6: The guard gate, as a pure function

The command must not be trusted to remember to call the guard, and a Tauri command cannot be unit-tested without a `State`. So the decision moves into a pure helper that *is* testable, and the command only carries it out — the same shape `execute` already has.

**Files:**
- Modify: `src-tauri/src/edit/apply.rs`
- Test: `src-tauri/tests/edit_guard_test.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/edit_guard_test.rs`:

```rust
use quarry_lib::edit::plan_apply;
use quarry_lib::edit::sql::Statement;
use quarry_lib::guard::Policy;
use std::time::{Duration, Instant};

fn one_update() -> Vec<Statement> {
    vec![Statement {
        sql: "update \"public\".\"users\" set \"email\" = $1::text::\"pg_catalog\".\"text\" \
              where \"id\" = $2::text::\"pg_catalog\".\"text\" returning \"email\""
            .to_string(),
        params: vec![Some("a@b.co".to_string()), Some("1".to_string())],
        row: 0,
        returned: vec![1],
    }]
}

#[test]
fn a_free_connection_applies_without_opting_out() {
    let now = Instant::now();
    let read_write = plan_apply(Policy::Free, None, now, &one_update()).expect("free must allow");
    // No BEGIN READ WRITE needed: the session is not read-only.
    assert!(!read_write);
}

#[test]
fn a_locked_connection_refuses() {
    let now = Instant::now();
    let error = plan_apply(Policy::ReadOnly, None, now, &one_update())
        .expect_err("a locked connection must refuse an edit");
    assert!(
        format!("{error}").contains("read-only"),
        "error was: {error}"
    );
}

#[test]
fn an_unlocked_connection_applies_and_opts_out() {
    let now = Instant::now();
    let deadline = now + Duration::from_secs(600);
    let read_write =
        plan_apply(Policy::ReadOnly, Some(deadline), now, &one_update()).expect("unlocked allows");
    assert!(read_write, "an unlocked write needs BEGIN READ WRITE");
}

#[test]
fn an_expired_unlock_refuses() {
    let now = Instant::now();
    let deadline = now - Duration::from_secs(1);
    plan_apply(Policy::ReadOnly, Some(deadline), now, &one_update())
        .expect_err("an expired unlock must refuse");
}

#[test]
fn nothing_to_apply_is_still_refused_while_locked() {
    // An empty batch is harmless, but answering "fine" on a locked
    // connection would mean the gate depends on the payload.
    let now = Instant::now();
    plan_apply(Policy::ReadOnly, None, now, &[]).expect_err("locked refuses regardless");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --test edit_guard_test`
Expected: FAIL to compile — `cannot find function 'plan_apply'`.

- [ ] **Step 3: Write the implementation**

Append to `src-tauri/src/edit/apply.rs`:

```rust
use crate::guard::{decide, Decision, Policy};
use std::time::Instant;

/// Decide whether this batch may run, and whether it needs to opt out
/// of the read-only session default.
///
/// Generated `UPDATE`s cross the same chokepoint as everything the user
/// types. The write-guard spec predicted this path: "Inline editing,
/// two stages away, will issue UPDATEs through a path that does not
/// exist yet." This is that path, and it does not get its own rules.
///
/// Pure so it can be tested without a Tauri `State`. The command below
/// only carries out what this returns.
pub fn plan_apply(
    policy: Policy,
    unlocked_until: Option<Instant>,
    now: Instant,
    statements: &[Statement],
) -> Result<bool, AppError> {
    // An empty batch is still asked: the gate must not depend on the
    // payload being non-empty.
    let sql = statements
        .iter()
        .map(|s| s.sql.as_str())
        .collect::<Vec<_>>()
        .join(";\n");
    // With no statements there is nothing for the classifier to read,
    // and an empty buffer classifies as a read — which would let a
    // locked connection through. Name the intent instead.
    let sql = if sql.is_empty() {
        "update".to_string()
    } else {
        sql
    };

    match decide(policy, unlocked_until, now, &sql) {
        Decision::Allow { read_write } => Ok(read_write),
        Decision::Deny => Err(AppError::WriteBlocked(
            "this connection is locked — unlock it to edit rows".to_string(),
        )),
    }
}
```

Export from `src-tauri/src/edit/mod.rs`:

```rust
pub use apply::{apply_edits, plan_apply, AppliedCell, AppliedRow};
```

**Note on `"update"` as the fallback SQL:** it is deliberately not valid SQL. `guard::classify` treats unparseable input as a write, which is exactly the answer wanted — a locked connection refuses, a free one allows. If a future `sqlparser` parses it, it parses as an `UPDATE`, which is also a write. Both roads lead to the same place.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --test edit_guard_test`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the guard call is load-bearing**

Required mutation check. Temporarily replace the `match decide(...)` block with `Ok(false)`, then:

Run: `cd src-tauri && cargo test --test edit_guard_test`
Expected: **FAIL** — `a_locked_connection_refuses`, `an_expired_unlock_refuses`, `nothing_to_apply_is_still_refused_while_locked`, and `an_unlocked_connection_applies_and_opts_out` should all fail.

Restore and re-run. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/edit src-tauri/tests/edit_guard_test.rs
git commit -m "feat(edit): route generated updates through the write guard

Verified by mutation: replacing the guard::decide call with Ok(false)
fails four of the five tests in edit_guard_test."
```

---

### Task 7: The `apply_edits` and `preview_edits` commands

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register both in the handler list)

- [ ] **Step 1: Add the commands**

In `src-tauri/src/commands.rs`, beside `execute`:

```rust
use crate::edit::{apply_edits, build_updates, plan_apply, AppliedRow, EditInfo, RowEdit, Statement};

/// Show the statements an apply would run, without running them.
///
/// Calls the same generator `apply_row_edits` calls. A preview that
/// could drift from what executes would be worse than no preview.
#[tauri::command]
pub fn preview_edits(edit: EditInfo, rows: Vec<RowEdit>) -> Result<Vec<Statement>, AppError> {
    build_updates(&edit, &rows)
}

/// Apply staged cell edits in one transaction.
#[tauri::command]
pub async fn apply_row_edits(
    state: tauri::State<'_, AppState>,
    edit: EditInfo,
    rows: Vec<RowEdit>,
) -> Result<Vec<AppliedRow>, AppError> {
    let (pool, policy, unlocked_until) = state.pool_and_guard()?;

    let statements = build_updates(&edit, &rows)?;

    // The same chokepoint every typed statement crosses. The UI hides
    // editing on a locked connection; this does not trust it to.
    let read_write = plan_apply(policy, unlocked_until, Instant::now(), &statements)?;

    apply_edits(&pool, &statements, read_write).await
}
```

`EditInfo` and its parts are `Serialize` today and now need `Deserialize` too, since the frontend sends the decision back. In `src-tauri/src/edit/decide.rs`, change the three derives:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
```

on `PkColumn`, `ColumnEdit`, and `EditInfo`, and add `use serde::{Deserialize, Serialize};` at the top.

**Why send it back rather than recompute it:** recomputing would mean re-preparing the original SQL, which the user may have since edited in the buffer. The decision belongs to the result on screen. `build_updates` refuses anything inconsistent, and the guard refuses anything that should not run, so a tampered payload cannot widen what an edit can do beyond "an UPDATE against a table you can already write to".

In `src-tauri/src/lib.rs`, add both to `tauri::generate_handler![...]`:

```rust
            commands::preview_edits,
            commands::apply_row_edits,
```

- [ ] **Step 2: Verify it compiles and the suite still passes**

Run: `cd src-tauri && cargo test`
Expected: PASS — 163 existing tests plus the new ones (185+).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src
git commit -m "feat(edit): expose preview and apply as commands"
```

---

### Task 8: Frontend types and IPC bindings

**Files:**
- Modify: `src/types.ts`
- Modify: `src/lib/ipc.ts`

- [ ] **Step 1: Add the types**

In `src/types.ts`, beside `QueryResult`:

```ts
/** Mirrors Rust `PkColumn`. */
export interface PkColumn {
  name: string;
  result_index: number;
}

/** Mirrors Rust `ColumnEdit`: one result column's verdict. */
export interface ColumnEdit {
  editable: boolean;
  column_name: string | null;
  cast_type: string | null;
  /** Why this cell cannot be edited. */
  reason: string | null;
}

/**
 * Mirrors Rust `EditInfo`. Decided in Rust from the metadata Postgres
 * sent about the result; the frontend never works it out itself.
 */
export interface EditInfo {
  editable: boolean;
  /** Why the whole result cannot be edited. */
  reason: string | null;
  schema: string | null;
  table: string | null;
  pk: PkColumn[];
  columns: ColumnEdit[];
}

/** Mirrors Rust `CellEdit`. `value: null` is an explicit SQL NULL. */
export interface CellEdit {
  column: number;
  value: string | null;
}

/** Mirrors Rust `RowEdit`. */
export interface RowEdit {
  row: number;
  pk: string[];
  cells: CellEdit[];
}

/** Mirrors Rust `Statement`, for the View SQL panel. */
export interface EditStatement {
  sql: string;
  params: (string | null)[];
  row: number;
  returned: number[];
}

/** Mirrors Rust `AppliedRow`. */
export interface AppliedRow {
  row: number;
  cells: { column: number; value: CellValue }[];
}
```

And add the field to `QueryResult`:

```ts
export interface QueryResult {
  columns: ColumnMeta[];
  edit: EditInfo;
  rows: CellValue[][];
  row_count: number;
  affected_rows: number | null;
  duration_ms: number;
}
```

In `src/lib/ipc.ts`, add the two calls following the file's existing style:

```ts
export async function previewEdits(
  edit: EditInfo,
  rows: RowEdit[],
): Promise<EditStatement[]> {
  return invoke("preview_edits", { edit, rows });
}

export async function applyRowEdits(
  edit: EditInfo,
  rows: RowEdit[],
): Promise<AppliedRow[]> {
  return invoke("apply_row_edits", { edit, rows });
}
```

Add `EditInfo`, `RowEdit`, `EditStatement`, and `AppliedRow` to the existing `import type { ... } from "../types";` block at the top of `ipc.ts`.

- [ ] **Step 2: Verify the types compile**

Run: `npm run build`
Expected: success. Any test or component constructing a `QueryResult` literal now needs an `edit` field — add `edit: { editable: false, reason: null, schema: null, table: null, pk: [], columns: [] }` to those fixtures.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts src/lib/ipc.ts
git commit -m "feat(ui): type the editability decision and the edit commands"
```

---

### Task 9: `pendingEdits` — the pure frontend module

Every decision the grid makes about staging lives here, tested under Vitest. The component only renders.

**Files:**
- Create: `src/lib/pendingEdits.ts`
- Test: `src/lib/pendingEdits.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/pendingEdits.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  applyPatches,
  cellText,
  count,
  emptyPending,
  isPending,
  pendingValue,
  stage,
  toRowEdits,
} from "./pendingEdits";
import type { QueryResult } from "../types";

function result(): QueryResult {
  return {
    columns: [
      { name: "id", type_name: "int4" },
      { name: "email", type_name: "text" },
    ],
    edit: {
      editable: true,
      reason: null,
      schema: "public",
      table: "users",
      pk: [{ name: "id", result_index: 0 }],
      columns: [
        { editable: false, column_name: null, cast_type: null, reason: "primary key" },
        { editable: true, column_name: "email", cast_type: '"pg_catalog"."text"', reason: null },
      ],
    },
    rows: [
      [1, "a@x.co"],
      [2, null],
    ],
    row_count: 2,
    affected_rows: null,
    duration_ms: 1,
  };
}

describe("cellText", () => {
  it("renders values as the text an editor should start from", () => {
    expect(cellText("a@x.co")).toBe("a@x.co");
    expect(cellText(7)).toBe("7");
    expect(cellText(true)).toBe("true");
    expect(cellText(null)).toBe("");
    expect(cellText({ a: 1 })).toBe('{"a":1}');
  });
});

describe("stage", () => {
  it("records a changed cell", () => {
    const pending = stage(emptyPending(), result(), 0, 1, "b@x.co");
    expect(count(pending)).toBe(1);
    expect(pendingValue(pending, 0, 1)).toBe("b@x.co");
    expect(isPending(pending, 0, 1)).toBe(true);
  });

  it("drops the change when the value is edited back to the original", () => {
    let pending = stage(emptyPending(), result(), 0, 1, "b@x.co");
    pending = stage(pending, result(), 0, 1, "a@x.co");
    // Staging a no-op UPDATE would show a pending count for a change
    // that is not one.
    expect(count(pending)).toBe(0);
    expect(isPending(pending, 0, 1)).toBe(false);
  });

  it("treats empty text on a NULL cell as a real change", () => {
    // NULL and '' are different values; typing nothing into a NULL
    // cell means the empty string, and must stage.
    const pending = stage(emptyPending(), result(), 1, 1, "");
    expect(count(pending)).toBe(1);
  });

  it("drops a NULL staged onto a cell that is already NULL", () => {
    const pending = stage(emptyPending(), result(), 1, 1, null);
    expect(count(pending)).toBe(0);
  });

  it("stages NULL over a value", () => {
    const pending = stage(emptyPending(), result(), 0, 1, null);
    expect(count(pending)).toBe(1);
    expect(pendingValue(pending, 0, 1)).toBe(null);
  });

  it("counts two cells in one row as two changes", () => {
    let pending = stage(emptyPending(), result(), 0, 1, "b@x.co");
    pending = stage(pending, result(), 1, 1, "c@x.co");
    expect(count(pending)).toBe(2);
  });
});

describe("toRowEdits", () => {
  it("groups cells by row and carries the key value as text", () => {
    let pending = stage(emptyPending(), result(), 0, 1, "b@x.co");
    pending = stage(pending, result(), 1, 1, "c@x.co");

    const edits = toRowEdits(pending, result());

    expect(edits).toHaveLength(2);
    expect(edits[0]).toEqual({
      row: 0,
      pk: ["1"],
      cells: [{ column: 1, value: "b@x.co" }],
    });
    expect(edits[1].pk).toEqual(["2"]);
  });

  it("returns nothing when nothing is staged", () => {
    expect(toRowEdits(emptyPending(), result())).toEqual([]);
  });

  it("throws when a key value is NULL", () => {
    const r = result();
    r.rows[0][0] = null;
    const pending = stage(emptyPending(), r, 0, 1, "b@x.co");
    // A NULL key cannot address a row. This is unreachable through a
    // real primary key, which is NOT NULL by definition — but the
    // payload builder is the last place that can notice.
    expect(() => toRowEdits(pending, r)).toThrow(/primary key/i);
  });
});

describe("applyPatches", () => {
  it("replaces cells with what the database returned", () => {
    const patched = applyPatches(result(), [
      { row: 0, cells: [{ column: 1, value: "shouty@x.co" }] },
    ]);

    expect(patched.rows[0][1]).toBe("shouty@x.co");
    // Untouched rows keep their values.
    expect(patched.rows[1][1]).toBe(null);
  });

  it("does not mutate the result it was given", () => {
    const original = result();
    applyPatches(original, [{ row: 0, cells: [{ column: 1, value: "x@x.co" }] }]);
    expect(original.rows[0][1]).toBe("a@x.co");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- pendingEdits`
Expected: FAIL — `Failed to resolve import "./pendingEdits"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/pendingEdits.ts`:

```ts
import type { AppliedRow, CellValue, QueryResult, RowEdit } from "../types";

/**
 * Staged cell edits, keyed by row and column.
 *
 * A `Map` rather than a nested object so counting is O(1) and the key
 * shape is explicit. `value: null` means an explicit SQL NULL, which is
 * a different thing from the empty string.
 */
export type Pending = Map<string, { row: number; col: number; value: string | null }>;

export function emptyPending(): Pending {
  return new Map();
}

function key(row: number, col: number): string {
  return `${row}:${col}`;
}

/**
 * The text an editor should start from, and the text a staged value is
 * compared against to decide whether anything actually changed.
 */
export function cellText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Stage one cell.
 *
 * Editing a value back to what it was removes the pending change
 * rather than recording a no-op: a pending count that includes changes
 * that change nothing is a lie about how much is about to be written.
 */
export function stage(
  pending: Pending,
  result: QueryResult,
  row: number,
  col: number,
  value: string | null,
): Pending {
  const next = new Map(pending);
  const original = result.rows[row]?.[col] ?? null;

  const unchanged =
    value === null ? original === null : original !== null && cellText(original) === value;

  if (unchanged) next.delete(key(row, col));
  else next.set(key(row, col), { row, col, value });

  return next;
}

export function count(pending: Pending): number {
  return pending.size;
}

export function isPending(pending: Pending, row: number, col: number): boolean {
  return pending.has(key(row, col));
}

export function pendingValue(
  pending: Pending,
  row: number,
  col: number,
): string | null | undefined {
  return pending.get(key(row, col))?.value;
}

/**
 * Group the staged cells into the payload the backend expects, one
 * entry per row, with the row's primary key values as text.
 */
export function toRowEdits(pending: Pending, result: QueryResult): RowEdit[] {
  const byRow = new Map<number, RowEdit>();

  // Sorted so the generated statements — and the View SQL panel — come
  // out in a stable order rather than in Map insertion order.
  const staged = [...pending.values()].sort((a, b) => a.row - b.row || a.col - b.col);

  for (const edit of staged) {
    let entry = byRow.get(edit.row);
    if (!entry) {
      entry = { row: edit.row, pk: pkValues(result, edit.row), cells: [] };
      byRow.set(edit.row, entry);
    }
    entry.cells.push({ column: edit.col, value: edit.value });
  }

  return [...byRow.values()].sort((a, b) => a.row - b.row);
}

function pkValues(result: QueryResult, row: number): string[] {
  return result.edit.pk.map((k) => {
    const value = result.rows[row]?.[k.result_index] ?? null;
    if (value === null) {
      throw new Error(`primary key ${k.name} is NULL in row ${row + 1} — cannot edit this row`);
    }
    return cellText(value);
  });
}

/**
 * Replace edited cells with the values the database returned.
 *
 * Returns a new result rather than mutating: React re-renders on
 * identity, and the grid would otherwise keep showing the old values.
 */
export function applyPatches(result: QueryResult, applied: AppliedRow[]): QueryResult {
  const rows = result.rows.map((row) => [...row]);

  for (const patch of applied) {
    for (const cell of patch.cells) {
      if (rows[patch.row]) rows[patch.row][cell.column] = cell.value;
    }
  }

  return { ...result, rows };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- pendingEdits`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pendingEdits.ts src/lib/pendingEdits.test.ts
git commit -m "feat(ui): stage pending cell edits in a pure module"
```

---

### Task 10: Editing in the grid

**Files:**
- Modify: `src/components/ResultGrid.tsx`
- Modify: `src/App.css`

- [ ] **Step 1: Extend the grid's props**

In `src/components/ResultGrid.tsx`, add to the imports:

```ts
import { cellText, isPending, pendingValue } from "../lib/pendingEdits";
import type { Pending } from "../lib/pendingEdits";
```

Add to `Props`:

```ts
  /**
   * Staged edits, or null when editing is off entirely — a locked
   * connection, or a result that cannot be edited.
   */
  pending: Pending | null;
  onStage: (row: number, col: number, value: string | null) => void;
```

- [ ] **Step 2: Add the editing state and handlers**

Inside the component, beside the other `useState` calls:

```tsx
  // Which cell is open for editing, and the text currently in it.
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [draft, setDraft] = useState("");

  const columnEdits = result.edit.columns;

  function canEdit(col: number): boolean {
    return pending !== null && (columnEdits[col]?.editable ?? false);
  }

  function openEditor(row: number, col: number) {
    if (!canEdit(col)) return;
    const staged = pendingValue(pending!, row, col);
    setDraft(
      staged !== undefined ? (staged ?? "") : cellText(result.rows[row][col]),
    );
    setEditing({ row, col });
  }

  function commit() {
    if (editing === null) return;
    onStage(editing.row, editing.col, draft);
    setEditing(null);
  }
```

Reset `editing` alongside the existing selection reset:

```tsx
  useEffect(() => {
    setAnchor(null);
    setFocus(null);
    setSelectedAll(null);
    setEditing(null);
    // `shape` is the same trigger the widths use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);
```

- [ ] **Step 3: Render the editor and the pending highlight**

Replace the cell `<td>` body in the virtualized row map with:

```tsx
                {row.map((cell, i) => {
                  const rowIndex = order[item.index];
                  const staged = pending ? pendingValue(pending, rowIndex, i) : undefined;
                  const shown = staged !== undefined ? staged : cell;
                  const { text, kind } = formatCell(shown as typeof cell);
                  const isEditingCell =
                    editing?.row === rowIndex && editing?.col === i;
                  const columnEdit = columnEdits[i];
                  const locked = pending !== null && !canEdit(i);

                  return (
                    <td
                      key={i}
                      className={[
                        `cell-${kind}`,
                        isSelected(range, item.index, i) ? "selected" : "",
                        pending && isPending(pending, rowIndex, i) ? "pending" : "",
                        locked ? "not-editable" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{ width: `${widths[i]}px` }}
                      title={locked ? (columnEdit?.reason ?? undefined) : text}
                      onDoubleClick={() => openEditor(rowIndex, i)}
                      onClick={(e) => {
                        setSelectedAll(null);
                        const cellRef = { row: item.index, col: i };
                        if (e.shiftKey && anchor) setFocus(cellRef);
                        else {
                          setAnchor(cellRef);
                          setFocus(cellRef);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !isEditingCell) {
                          e.preventDefault();
                          openEditor(rowIndex, i);
                        }
                        // Cmd+Backspace stages an explicit SQL NULL.
                        // Typing nothing means the empty string, which
                        // is a different value — the grid has always
                        // rendered the two differently and editing must
                        // keep them apart.
                        if ((e.metaKey || e.ctrlKey) && e.key === "Backspace" && canEdit(i)) {
                          e.preventDefault();
                          onStage(rowIndex, i, null);
                        }
                      }}
                      tabIndex={canEdit(i) ? 0 : undefined}
                    >
                      {isEditingCell ? (
                        <input
                          className="cell-editor"
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commit();
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setEditing(null);
                            }
                            if (e.key === "Tab") {
                              e.preventDefault();
                              commit();
                            }
                            // The grid's document-level Cmd+C/Cmd+A
                            // handler already skips inputs, so nothing
                            // more is needed here.
                          }}
                        />
                      ) : (
                        text
                      )}
                    </td>
                  );
                })}
```

**Note on `rowIndex` versus `item.index`:** the grid sorts client-side, so `item.index` is the *display* position and `order[item.index]` is the position in `result.rows`. Staging must use the latter, or sorting the grid and then editing writes to the wrong row. The selection code deliberately keeps using `item.index` because a selection rectangle is about what is on screen.

- [ ] **Step 4: Add the styles**

Append to `src/App.css`:

```css
/* A cell with an unapplied edit. Deliberately loud: the grid is
   otherwise showing database truth, and this is the one state where it
   is not. */
.result-grid td.pending {
  background: var(--pending-bg, #3a3000);
  box-shadow: inset 2px 0 0 var(--pending-mark, #d9a400);
}

/* A cell that cannot be edited while the rest of the row can. Not an
   error state, so it stays quiet — the reason is in the tooltip. */
.result-grid td.not-editable {
  color: var(--fg-muted, #8a8a8a);
}

.result-grid .cell-editor {
  width: 100%;
  border: 1px solid var(--accent, #4a90d9);
  background: var(--bg, #1e1e1e);
  color: var(--fg, #e8e8e8);
  font: inherit;
  padding: 0 4px;
}
```

Match the variable names to whatever `App.css` already defines — the fallbacks above are only there so the file is valid if a name is missing. Check the existing `:root` block and use the real names.

- [ ] **Step 5: Verify the build**

Run: `npm run build && npm test`
Expected: build succeeds; all TypeScript tests pass. `ResultGrid` now requires `pending` and `onStage`, so `App.tsx` will not compile until Task 11 — pass `pending={null}` and `onStage={() => {}}` at both call sites for now to keep this task's commit building.

- [ ] **Step 6: Commit**

```bash
git add src/components/ResultGrid.tsx src/App.css src/App.tsx
git commit -m "feat(ui): edit cells in the result grid"
```

---

### Task 11: The bottom bar, the SQL panel, and applying

**Files:**
- Create: `src/components/EditBar.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [ ] **Step 1: Write the bar**

Create `src/components/EditBar.tsx`:

```tsx
import type { EditStatement } from "../types";

interface Props {
  count: number;
  /** Generated statements, shown only while the SQL panel is open. */
  statements: EditStatement[] | null;
  busy: boolean;
  onViewSql: () => void;
  onHideSql: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The pending-changes bar.
 *
 * Confirm applies straight away. Viewing the SQL is an affordance, not
 * a gate: a mandatory review on a routine path gets dismissed by
 * reflex, and a reflexively dismissed dialog looks like a safeguard
 * without being one. The connection lock is the safeguard.
 */
export function EditBar({
  count,
  statements,
  busy,
  onViewSql,
  onHideSql,
  onCancel,
  onConfirm,
}: Props) {
  if (count === 0) return null;

  return (
    <div className="edit-bar">
      {statements !== null && (
        <div className="edit-sql">
          {statements.map((s, i) => (
            <pre key={i}>
              {s.sql}
              {"\n"}
              {s.params.map((p, n) => `$${n + 1} = ${p === null ? "NULL" : p}`).join("\n")}
            </pre>
          ))}
        </div>
      )}
      <div className="edit-bar-row">
        <span className="edit-count">
          {count} pending change{count === 1 ? "" : "s"}
        </span>
        <button onClick={statements === null ? onViewSql : onHideSql} disabled={busy}>
          {statements === null ? "View SQL" : "Hide SQL"}
        </button>
        <button onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="primary" onClick={onConfirm} disabled={busy}>
          {busy ? "Applying…" : "Confirm"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into App**

In `src/App.tsx`, add the imports:

```ts
import { EditBar } from "./components/EditBar";
import {
  applyPatches,
  count as pendingCount,
  emptyPending,
  stage,
  toRowEdits,
} from "./lib/pendingEdits";
import type { Pending } from "./lib/pendingEdits";
import { applyRowEdits, previewEdits } from "./lib/ipc";
import type { EditStatement } from "./types";
```

Add the state, beside the existing `result` state:

```tsx
  const [pending, setPending] = useState<Pending>(emptyPending());
  const [editSql, setEditSql] = useState<EditStatement[] | null>(null);
  const [applying, setApplying] = useState(false);
```

Editing is off entirely when the connection is locked or the result is
not editable. `locked` already exists in this file for the guard banner:

```tsx
  const canEditRows = Boolean(result?.edit.editable) && !locked;
```

Clear the staging whenever a new result arrives. There are two
`setResult` call sites in this file today — `setResult(await execute(sql))`
around line 241, and `setResult(null)` around line 453 — and both need
to be followed by:

```tsx
      setPending(emptyPending());
      setEditSql(null);
```

Handlers:

```tsx
  function onStage(row: number, col: number, value: string | null) {
    if (!result) return;
    setPending((current) => stage(current, result, row, col, value));
    // The shown SQL is about a set of edits that just changed.
    setEditSql(null);
  }

  async function onViewSql() {
    if (!result) return;
    try {
      setEditSql(await previewEdits(result.edit, toRowEdits(pending, result)));
    } catch (e) {
      setError(asAppError(e));
    }
  }

  async function onConfirmEdits() {
    if (!result) return;
    setApplying(true);
    try {
      const applied = await applyRowEdits(result.edit, toRowEdits(pending, result));
      // Patch with what the database returned, not with what was
      // typed: a trigger or a type coercion may have changed it.
      setResult(applyPatches(result, applied));
      setPending(emptyPending());
      setEditSql(null);
      setError(null);
    } catch (e) {
      // The whole batch rolled back, so the staged edits stay staged —
      // the user can fix the offending cell and confirm again.
      setError(asAppError(e));
    } finally {
      setApplying(false);
    }
  }
```

Pass the props at **both** `ResultGrid` call sites (the query tab and the table Data tab):

```tsx
                  pending={canEditRows ? pending : null}
                  onStage={onStage}
```

And render the bar directly beneath each grid, above the status bar:

```tsx
            {canEditRows && (
              <EditBar
                count={pendingCount(pending)}
                statements={editSql}
                busy={applying}
                onViewSql={() => void onViewSql()}
                onHideSql={() => setEditSql(null)}
                onCancel={() => {
                  setPending(emptyPending());
                  setEditSql(null);
                }}
                onConfirm={() => void onConfirmEdits()}
              />
            )}
```

- [ ] **Step 3: Show the reason when a result cannot be edited**

In `src/components/StatusBar.tsx`, add the reason beside the existing row count and duration, so "why can't I edit this" is always answerable:

```tsx
      {result && !result.edit.editable && result.edit.reason && (
        <span className="status-readonly" title={result.edit.reason}>
          read-only · {result.edit.reason}
        </span>
      )}
```

- [ ] **Step 4: Add the styles**

Append to `src/App.css`:

```css
.edit-bar {
  border-top: 1px solid var(--border, #333);
  background: var(--panel, #252525);
}

.edit-bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
}

.edit-count {
  margin-right: auto;
  font-weight: 600;
}

.edit-sql {
  max-height: 30vh;
  overflow: auto;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, #333);
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
  white-space: pre-wrap;
}

.status-readonly {
  color: var(--fg-muted, #8a8a8a);
}
```

Again, use the variable names `App.css` already defines.

- [ ] **Step 5: Verify**

Run: `npm run build && npm test`
Expected: build succeeds, all tests pass.

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components src/App.tsx src/App.css
git commit -m "feat(ui): pending-changes bar with optional SQL review"
```

---

### Task 12: Docs and backlog

**Files:**
- Modify: `README.md`
- Modify: `docs/BACKLOG.md`

- [ ] **Step 1: Document the feature in the README**

Add to the feature list, in the style of the surrounding entries:

```markdown
- **Inline row editing.** Double-click a cell to edit it, `⌘⌫` to set NULL.
  Changes stage as highlighted pending diffs with a bottom bar showing the
  count; Confirm applies them in one transaction, and `View SQL` shows the
  generated statements first if you want them. A result is editable only
  when it comes from one ordinary table whose primary key is in the result —
  a join, a view, an aggregate, or a table without a key says why it is
  read-only. Disabled entirely on a locked production connection.
```

- [ ] **Step 2: Record what was deferred**

Append to `docs/BACKLOG.md`:

```markdown
## Row editing extras

**Deferred:** 2026-08-16, while designing inline row editing
(`specs/2026-08-16-inline-row-editing-design.md`). The machinery all
three need — identity from `table_oid`, generated SQL, the transaction
with its rowcount assert — now exists, so each is much cheaper than it
would have been before.

- **Insert and delete rows from the grid.** Insert needs an empty
  pending row, awareness of `NOT NULL` and defaults, and returning the
  generated key to display. Delete needs its own affordance and a
  strikethrough rendering for pending deletions.
- **Editing a primary key.** Mechanically fine — the `WHERE` uses the
  original value — but excluded from v1 because it is rare and it is
  the one edit that can orphan a foreign key silently.
- **Optimistic concurrency.** Today the last write wins: a concurrent
  change to the same cell is overwritten without warning. Checking
  original values in the `WHERE` was rejected because the `json` type
  has no equality operator, so it would need a per-type carve-out that
  gives some columns weaker guarantees than others. A row *version* or
  `xmin` check would avoid that and is the better shape if this ever
  becomes a real problem.
- **A bigint key past 2^53.** Key values reach the frontend as JSON
  numbers and go back as text, so an `int8` key above 9,007,199,254,740,992
  would round-trip wrong. The grid already displays such a value wrong
  today, so this is pre-existing rather than new — but editing is where
  it would do damage rather than merely mislead.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/BACKLOG.md
git commit -m "docs: describe inline row editing and what it defers"
```

---

### Task 13: Full verification

- [ ] **Step 1: Rust suite**

Run: `cd src-tauri && cargo test`
Expected: PASS. Was 163 tests before this stage; expect roughly 198 now (13 decide + 11 sql + 16 db + 5 guard). Docker must be running.

- [ ] **Step 2: TypeScript suite**

Run: `npm test`
Expected: PASS. Was 130 tests; expect roughly 143.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success.

Do **not** run `cargo clippy` or `cargo fmt`. Both fail at baseline in this repo for reasons recorded in `docs/BACKLOG.md`; running them here would bury this stage's diff.

- [ ] **Step 4: Report for smoke testing**

Report to the user with:
- the two test counts, quoted from the actual output
- the two mutation-check results from Tasks 5 and 6
- this smoke checklist:

```
1. select id, email from <a table with a PK> — double-click a cell, type,
   Enter. Cell highlights. Bar shows "1 pending change".
2. View SQL — the UPDATE names the real column and the key. Hide SQL.
3. Confirm — highlight clears, value shows what the database stored.
4. Edit a cell, then edit it back to its original value — the pending
   count returns to 0 rather than staying at 1.
5. ⌘⌫ on a cell — stages NULL; Confirm; the cell renders as NULL, not
   as an empty string.
6. Cancel with edits staged — highlights clear, nothing was written.
7. select * from <a view>, a join, and count(*) — no editing offered,
   and the status bar states the reason for each.
8. A table without a primary key — the reason names the table.
9. Connect to the prod-tagged connection while locked — cells do not
   enter edit mode and no bar appears. Unlock, edit, confirm, relock.
10. Type a word into an integer column and Confirm — a Postgres error
    with "invalid input syntax", the value unchanged, edits still staged.
```

---

## Notes for the implementer

**Rust idioms used here, briefly:**

- `Option<T>` is Rust's "maybe": `Some(x)` or `None`. `table_oid: Option<u32>` is how the driver says "this column has no source table". `.filter_map(|c| c.table_oid)` keeps the `Some` values and drops the `None`s in one pass.
- `impl Into<String>` as a parameter type accepts both `&str` and `String` so callers do not have to write `.to_string()` at every site.
- `&[&(dyn ToSql + Sync)]` in `run_one` is a slice of trait objects: "references to any types that know how to become SQL parameters". The intermediate `Vec` must be a named binding because the slice borrows from it.
- `#[derive(Serialize)]` generates the JSON conversion Tauri needs to send a struct to the frontend; `Deserialize` is the reverse, needed when the frontend sends one back.

**What must not drift:**

- `decide.rs` and `sql.rs` stay pure. If either grows a `Pool` parameter, the test suite stops being able to cover the rule table cheaply, and that coverage is the reason this feature is safe to ship.
- `preview_edits` and `apply_row_edits` both call `build_updates`. If a future change makes the preview build its statements differently, the preview stops being evidence.
