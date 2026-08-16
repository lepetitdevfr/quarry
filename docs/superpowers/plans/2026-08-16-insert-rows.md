# Insert Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage new rows in the result grid and apply them in the same transaction as cell edits and row deletions, with enum and boolean cells offering a selector on new and existing rows alike.

**Architecture:** The catalog lookup widens to report NOT NULL, defaults, identity and generated columns; `edit/decide.rs` turns those into an insert verdict per result and per column; `edit/sql.rs` gains `build_inserts`, which shares the refusals and the `RETURNING` machinery with the update and delete builders; `edit/apply.rs` runs them last in the existing transaction with the existing exactly-one-row assert. The frontend stages new rows in `src/lib/pendingEdits.ts` beside the existing pending map and delete set, and appends the returned rows to the grid.

**Spec:** `docs/superpowers/specs/2026-08-16-insert-rows-design.md`. Read it before Task 1 — every decision below is justified there.

**Tech Stack:** Rust (`tokio-postgres`, `deadpool-postgres`), Tauri 2, React 19 + TypeScript, Vitest, `testcontainers` (Docker must be running for the `*_db_test` files).

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src-tauri/src/schema/introspect.rs` | modify | catalog query gains four attributes; builds `TableColumn` |
| `src-tauri/src/edit/decide.rs` | modify | `Identity`, `TableColumn`, insert verdicts, `choices` |
| `src-tauri/src/edit/sql.rs` | modify | `value_choices`, `RowInsert`, `build_inserts`, `StatementKind::Insert` |
| `src-tauri/src/edit/apply.rs` | modify | `AppliedRow.kind` replaces `AppliedRow.deleted` |
| `src-tauri/src/exec/run.rs` | modify | fills `SourceColumn.choices` from the prepare metadata |
| `src-tauri/src/commands.rs` | modify | both edit commands take `inserts` |
| `src/types.ts` | modify | mirrors the Rust changes; adds the `UNKNOWN` sentinel |
| `src/lib/format.ts`, `gridSort.ts`, `exportRows.ts` | modify | handle `UNKNOWN` deliberately |
| `src/lib/pendingEdits.ts` | modify | staged inserts, `totalPending`, `applyPatches` append |
| `src/components/ResultGrid.tsx` | modify | staged rows, selector inputs, `⇧⌘N` |
| `src/components/GridToolbar.tsx` | modify | `Insert row` button |
| `src/App.tsx`, `src/App.css` | modify | wiring and styling |

---

### Task 1: Widen the catalog facts

A mechanical change with no behaviour change, done alone so the next task's diff is only decisions. It touches every construction site of `TableFacts`, which is why it is not folded into Task 2.

**Files:**
- Modify: `src-tauri/src/edit/decide.rs`, `src-tauri/src/schema/introspect.rs:214-270`
- Test: `src-tauri/tests/edit_db_test.rs`, `src-tauri/tests/edit_decide_test.rs`

- [ ] **Step 1: Write the failing test**

In `src-tauri/tests/edit_db_test.rs`, replace the tuple assertions in `lookup_table_reports_columns_and_the_primary_key` (lines 44-45) and add a new test after it:

```rust
    assert_eq!(facts.columns[0].attnum, 1);
    assert_eq!(facts.columns[0].name, "id");
    assert!(facts.columns[0].is_pk);
    assert_eq!(facts.columns[1].name, "email");
    assert!(!facts.columns[1].is_pk);
}

#[tokio::test]
async fn lookup_table_reports_nullability_defaults_and_identity() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table widgets (
           id     int generated always as identity primary key,
           code   text not null,
           label  text,
           made   timestamptz not null default now(),
           shout  text generated always as (upper(code)) stored
         )",
        false,
    )
    .await
    .expect("create table");

    let oid = oid_of(&db.pool, "widgets").await;
    let facts = lookup_table(&db.pool, oid)
        .await
        .expect("lookup should run")
        .expect("the table exists");

    let by_name = |name: &str| {
        facts
            .columns
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("{name} should be in the catalog"))
            .clone()
    };

    // An identity column: the database supplies the value.
    assert_eq!(by_name("id").identity, Identity::Always);
    assert!(by_name("id").not_null);

    // The one column a user must supply: NOT NULL, no default, not
    // generated. This is what rule 2 of the spec keys off.
    assert!(by_name("code").not_null);
    assert!(!by_name("code").has_default);
    assert_eq!(by_name("code").identity, Identity::None);
    assert!(!by_name("code").generated);

    // Nullable, so it may be left out.
    assert!(!by_name("label").not_null);

    // NOT NULL but defaulted, so it may also be left out.
    assert!(by_name("made").not_null);
    assert!(by_name("made").has_default);

    // A stored generated column cannot be written at all.
    assert!(by_name("shout").generated);
}
```

Add `Identity` to the import at the top of the file:

```rust
use quarry_lib::edit::{apply_edits, build_deletes, build_updates, CellEdit, Identity, RowDelete, RowEdit};
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd src-tauri && cargo test --test edit_db_test lookup_table
```

Expected: compile error — `Identity` and the `TableColumn` fields do not exist yet.

- [ ] **Step 3: Implement the types**

In `src-tauri/src/edit/decide.rs`, replace the `columns` field of `TableFacts` and add two items above it:

```rust
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
```

Then fix the two readers inside `decide_editability`:

```rust
    let pk_names: Vec<(i16, String)> = facts
        .columns
        .iter()
        .filter(|c| c.is_pk)
        .map(|c| (c.attnum, c.name.clone()))
        .collect();
```

and

```rust
            match facts.columns.iter().find(|c| c.attnum == attnum) {
                Some(column) => ColumnEdit {
                    editable: true,
                    column_name: Some(column.name.clone()),
                    cast_type: Some(c.cast_type.clone()),
                    reason: None,
                },
```

Export the new names from `src-tauri/src/edit/mod.rs` alongside `TableFacts`.

- [ ] **Step 4: Implement the query**

In `src-tauri/src/schema/introspect.rs`, add four columns to the `select` in `lookup_table` (after `is_pk`):

```sql
                    a.attnotnull            as not_null,
                    a.atthasdef             as has_default,
                    a.attidentity::text     as identity,
                    a.attgenerated::text    as generated,
```

and replace the `columns` builder:

```rust
        columns: rows
            .iter()
            .map(|row| TableColumn {
                attnum: row.get::<_, i16>("attnum"),
                name: row.get::<_, String>("column_name"),
                is_pk: row.get::<_, bool>("is_pk"),
                not_null: row.get::<_, bool>("not_null"),
                has_default: row.get::<_, bool>("has_default"),
                identity: Identity::from_catalog(&row.get::<_, String>("identity")),
                // 's' is STORED; Postgres has no other generated kind
                // today, and an empty string means "not generated".
                generated: row.get::<_, String>("generated") == "s",
            })
            .collect(),
```

Import `TableColumn` and `Identity` from `crate::edit` at the top of the file.

- [ ] **Step 5: Update the pure-test fixture**

In `src-tauri/tests/edit_decide_test.rs`, replace the `columns` in `users_table()` and add a helper above it:

```rust
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

fn users_table() -> TableFacts {
    TableFacts {
        relkind: "r".to_string(),
        schema: "public".to_string(),
        table: "users".to_string(),
        columns: vec![tc(1, "id", true), tc(2, "email", false), tc(3, "plan", false)],
    }
}
```

Update the import on line 1 to include `Identity` and `TableColumn`. Fix every other `TableFacts` literal in the file the same way — build them with `tc(...)` and adjust the fields the individual test cares about.

- [ ] **Step 6: Run the whole suite**

```bash
cd src-tauri && cargo test 2>&1 | tee /tmp/task1.txt
```

Expected: 0 failed. If a run reports fewer tests than it should, read `/tmp/task1.txt` for the failure line rather than re-running — see the flake entry in `docs/BACKLOG.md`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor(edit): report nullability, defaults and identity per column"
```

---

### Task 2: Insert verdicts and value choices

**Files:**
- Modify: `src-tauri/src/edit/decide.rs`, `src-tauri/src/edit/sql.rs`, `src-tauri/src/exec/run.rs`
- Test: `src-tauri/tests/edit_decide_test.rs`, `src-tauri/tests/edit_sql_test.rs`

**Interfaces to implement exactly** — Tasks 3 and 5 are written against these:

```rust
// SourceColumn gains, filled from the prepare metadata in exec/run.rs:
pub choices: Option<Vec<String>>,

// EditInfo gains:
pub insertable: bool,
pub insert_reason: Option<String>,

// ColumnEdit gains:
pub insertable: bool,
pub insert_reason: Option<String>,
pub choices: Option<Vec<String>>,
/// Whether the database fills this column in when a new row leaves it
/// out. The grid needs it to say whether an untouched cell means
/// "default" or "NULL", which are different promises.
pub has_default: bool,
```

**One existing behaviour changes deliberately:** `ColumnEdit.column_name` is now filled for *every* column whose attnum resolves to a real table column, including primary keys and generated columns, rather than only for editable ones. `RETURNING` needs the name of the generated key, which is exactly the column that used to carry `None`. This does not loosen updates: `build_updates` matches on `(Some(name), Some(cast)) if column.editable`, and `editable` is unchanged. Step 1 pins that with a regression test.

- [ ] **Step 1: Write the failing tests**

In `src-tauri/tests/edit_decide_test.rs`:

```rust
/// A table that exercises every insert verdict at once.
fn widgets_table() -> TableFacts {
    TableFacts {
        relkind: "r".to_string(),
        schema: "public".to_string(),
        table: "widgets".to_string(),
        columns: vec![
            TableColumn { attnum: 1, name: "id".to_string(), is_pk: true, not_null: true, has_default: false, identity: Identity::Always, generated: false },
            TableColumn { attnum: 2, name: "code".to_string(), is_pk: false, not_null: true, has_default: false, identity: Identity::None, generated: false },
            TableColumn { attnum: 3, name: "label".to_string(), is_pk: false, not_null: false, has_default: false, identity: Identity::None, generated: false },
            TableColumn { attnum: 4, name: "shout".to_string(), is_pk: false, not_null: false, has_default: false, identity: Identity::None, generated: true },
        ],
    }
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
    let info = decide_editability(&[col(1, "\"int4\""), col(3, "\"text\"")], Some(&widgets_table()));

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
    assert_eq!(info.columns[2].insert_reason.as_deref(), Some("computed value"));
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
    let info = decide_editability(&[col(1, "\"int4\""), col(2, "\"text\"")], Some(&users_table()));

    assert_eq!(info.columns[0].column_name.as_deref(), Some("id"));
    assert!(!info.columns[0].editable, "it is still read-only");
}
```

Extend `col()` and `computed()` in that file with the new field:

```rust
fn col(attnum: i16, cast_type: &str) -> SourceColumn {
    SourceColumn {
        table_oid: Some(16385),
        attnum: Some(attnum),
        cast_type: cast_type.to_string(),
        choices: None,
    }
}
```

(same addition in `computed()`), and add a choices test:

```rust
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
```

In `src-tauri/tests/edit_sql_test.rs`, covering the pure type helper:

```rust
#[test]
fn a_boolean_offers_true_and_false() {
    assert_eq!(
        value_choices(&Type::BOOL),
        Some(vec!["true".to_string(), "false".to_string()])
    );
}

#[test]
fn an_ordinary_type_offers_nothing() {
    assert_eq!(value_choices(&Type::TEXT), None);
    assert_eq!(value_choices(&Type::INT4), None);
}

#[test]
fn an_enum_offers_its_labels_in_declaration_order() {
    // Postgres reports enum labels in the order they were declared,
    // which is the type's own sort order — not alphabetical.
    let mood = Type::new(
        "mood".to_string(),
        16400,
        Kind::Enum(vec!["sad".to_string(), "ok".to_string(), "happy".to_string()]),
        "public".to_string(),
    );

    assert_eq!(
        value_choices(&mood),
        Some(vec!["sad".to_string(), "ok".to_string(), "happy".to_string()])
    );
}

#[test]
fn a_domain_over_an_enum_offers_the_enums_labels() {
    let mood = Type::new(
        "mood".to_string(),
        16400,
        Kind::Enum(vec!["sad".to_string(), "ok".to_string()]),
        "public".to_string(),
    );
    let strict_mood = Type::new(
        "strict_mood".to_string(),
        16401,
        Kind::Domain(mood),
        "public".to_string(),
    );

    assert_eq!(
        value_choices(&strict_mood),
        Some(vec!["sad".to_string(), "ok".to_string()])
    );
}
```

Add `value_choices` to the `edit::sql` import and `use tokio_postgres::types::Kind;` at the top of that file. Every `ColumnEdit` literal in `edit_sql_test.rs` (`editable()` and `read_only()`) needs the three new fields — give `editable()` `insertable: true, insert_reason: None, choices: None` and `read_only()` `insertable: false, insert_reason: Some("generated by the database".to_string()), choices: None`.

- [ ] **Step 2: Run them and confirm they fail**

```bash
cd src-tauri && cargo test --test edit_decide_test --test edit_sql_test
```

Expected: compile errors naming `insertable`, `insert_reason`, `choices` and `value_choices`.

- [ ] **Step 3: Implement `value_choices`**

In `src-tauri/src/edit/sql.rs`, beside `cast_target`:

```rust
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
```

- [ ] **Step 4: Implement the verdicts**

In `src-tauri/src/edit/decide.rs`, add the field to `SourceColumn`:

```rust
    /// The values this column accepts, if it is an enum or a boolean.
    /// Built by `edit::sql::value_choices` from the same metadata.
    pub choices: Option<Vec<String>>,
```

the two fields to `EditInfo` and the three to `ColumnEdit` (documented as in the spec), then add above `decide_editability`:

```rust
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
```

`EditInfo::blocked` sets `insertable: false`, `insert_reason: Some(<the same reason>)`, and gives each `ColumnEdit` `insertable: false, insert_reason: None, choices: None` — rule 1 of the spec's insert table is "the existing reason, verbatim", so the two fields carry the same sentence.

In the editable path, after the primary key is resolved and before the per-column verdicts, decide the grid-level insert verdict:

```rust
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
```

Per column, alongside the existing verdicts:

- a column with no attnum: `insertable: false`, `insert_reason: Some("computed value")`
- a duplicated attnum: `insertable: false`, `insert_reason: Some("this column appears twice in the result")`
- otherwise look the attnum up in `facts.columns`, and set `insertable` to `!is_generated(column) && !(column.is_pk && (column.has_default || column.identity != Identity::None))`, with `insert_reason: Some("generated by the database")` when that is false
- every resolved column sets `column_name: Some(column.name.clone())`, `choices: c.choices.clone()` and `has_default: column.has_default || column.identity != Identity::None || column.generated`, whatever its editability — "the database fills this in if I leave it out" is what the grid needs, and identity and generated columns fill themselves in
- an unresolved column (no attnum, duplicated, or absent from the catalog) sets `has_default: false`

Finally, `EditInfo` is built with `insertable: insert_reason.is_none()` and that `insert_reason`.

- [ ] **Step 5: Fill `choices` at the source**

In `src-tauri/src/exec/run.rs:90`, add the field:

```rust
        .map(|c| SourceColumn {
            table_oid: c.table_oid(),
            attnum: c.column_id(),
            cast_type: cast_target(c.type_()),
            choices: value_choices(c.type_()),
        })
```

and add `value_choices` to the `crate::edit` import on line 1.

- [ ] **Step 6: Confirm they pass, then run the suite**

```bash
cd src-tauri && cargo test 2>&1 | tee /tmp/task2.txt
```

Expected: 0 failed.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(edit): decide which columns a new row may supply"
```

---

### Task 3: Generate and apply inserts

**Files:**
- Modify: `src-tauri/src/edit/sql.rs`, `src-tauri/src/edit/apply.rs`, `src-tauri/src/edit/mod.rs`, `src-tauri/src/commands.rs`
- Test: `src-tauri/tests/edit_sql_test.rs`, `src-tauri/tests/edit_db_test.rs`

**Interfaces to implement exactly:**

```rust
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

pub fn build_inserts(info: &EditInfo, inserts: &[RowInsert]) -> Result<Vec<Statement>, AppError>;

// StatementKind gains `Insert`.
// AppliedRow.deleted: bool is REPLACED by:
pub kind: StatementKind,

pub fn preview_edits(edit: EditInfo, rows: Vec<RowEdit>, deletes: Vec<RowDelete>, inserts: Vec<RowInsert>) -> Result<Vec<Statement>, AppError>;
pub async fn apply_row_edits(state, edit: EditInfo, rows: Vec<RowEdit>, deletes: Vec<RowDelete>, inserts: Vec<RowInsert>) -> Result<Vec<AppliedRow>, AppError>;
```

Both commands build updates, then deletes, then inserts, and concatenate — inserts last so that deleting a key and re-adding it in one batch does not collide.

- [ ] **Step 1: Write the failing pure tests**

In `src-tauri/tests/edit_sql_test.rs`. Two fixture changes come first, and the second is load-bearing:

```rust
fn read_only() -> ColumnEdit {
    ColumnEdit {
        editable: false,
        // Filled even though the column is read-only: RETURNING has to
        // name the generated key, and this is the fixture that proves
        // `build_inserts` returns it. With `None` here the expected SQL
        // below silently loses `"id"`.
        column_name: Some("id".to_string()),
        cast_type: Some("\"pg_catalog\".\"int4\"".to_string()),
        reason: Some("primary key".to_string()),
        // A serial key: the database generates it.
        insertable: false,
        insert_reason: Some("generated by the database".to_string()),
        choices: None,
        has_default: true,
    }
}
```

and `users()` gains `insertable: true, insert_reason: None` on the `EditInfo`. Then the tests:

```rust
#[test]
fn one_staged_row_becomes_one_insert() {
    let inserts = vec![RowInsert {
        row: 0,
        cells: vec![
            CellEdit { column: 1, value: Some("a@b.c".to_string()) },
            CellEdit { column: 2, value: Some("pro".to_string()) },
        ],
    }];

    let statements = build_inserts(&users(), &inserts).expect("should build");

    assert_eq!(statements.len(), 1);
    assert_eq!(
        statements[0].sql,
        "insert into \"public\".\"users\" (\"email\", \"plan\") \
         values ($1::text::\"pg_catalog\".\"text\", $2::text::\"pg_catalog\".\"text\") \
         returning \"id\", \"email\", \"plan\""
    );
    assert_eq!(statements[0].params, vec![Some("a@b.c".to_string()), Some("pro".to_string())]);
    assert_eq!(statements[0].kind, StatementKind::Insert);
    // Every result column that maps to a real table column is returned,
    // in result order, so the generated key lands in the right cell.
    assert_eq!(statements[0].returned, vec![0, 1, 2]);
    assert_eq!(statements[0].row, 0);
}

#[test]
fn an_untouched_column_is_left_out_of_the_statement() {
    // Absent from `cells` means absent from the column list, which is
    // what makes the database apply its default.
    let inserts = vec![RowInsert {
        row: 0,
        cells: vec![CellEdit { column: 1, value: Some("a@b.c".to_string()) }],
    }];

    let statements = build_inserts(&users(), &inserts).expect("should build");

    assert!(statements[0].sql.contains("(\"email\")"));
    assert!(!statements[0].sql.contains("\"plan\""), "plan is untouched, so it takes its default");
    assert_eq!(statements[0].params.len(), 1);
}

#[test]
fn an_explicit_null_is_bound_as_null() {
    // Distinct from untouched: this overrides a default with NULL.
    let inserts = vec![RowInsert {
        row: 0,
        cells: vec![CellEdit { column: 2, value: None }],
    }];

    let statements = build_inserts(&users(), &inserts).expect("should build");

    assert!(statements[0].sql.contains("(\"plan\")"));
    assert_eq!(statements[0].params, vec![None]);
}

#[test]
fn a_row_with_nothing_staged_uses_default_values() {
    let inserts = vec![RowInsert { row: 0, cells: vec![] }];

    let statements = build_inserts(&users(), &inserts).expect("should build");

    assert_eq!(
        statements[0].sql,
        "insert into \"public\".\"users\" default values returning \"id\", \"email\", \"plan\""
    );
    assert!(statements[0].params.is_empty());
}

#[test]
fn a_generated_column_is_refused_a_value() {
    // The frontend never offers this; refusing here means a frontend
    // bug cannot become a failed transaction or a wrong write.
    let inserts = vec![RowInsert {
        row: 0,
        cells: vec![CellEdit { column: 0, value: Some("7".to_string()) }],
    }];

    let error = build_inserts(&users(), &inserts).expect_err("should refuse");

    assert!(format!("{error:?}").contains("cannot take a value"), "was: {error:?}");
}

#[test]
fn a_result_that_is_not_insertable_is_refused() {
    let mut info = users();
    info.insertable = false;
    info.insert_reason = Some("add code to the query to insert rows — it is NOT NULL with no default".to_string());

    let error = build_inserts(&info, &[RowInsert { row: 0, cells: vec![] }])
        .expect_err("should refuse");

    assert!(format!("{error:?}").contains("NOT NULL"), "was: {error:?}");
}

#[test]
fn no_staged_rows_produce_no_statements() {
    assert!(build_inserts(&users(), &[]).expect("should build").is_empty());
}

#[test]
fn two_staged_rows_produce_two_statements_in_order() {
    let inserts = vec![
        RowInsert { row: 0, cells: vec![CellEdit { column: 1, value: Some("a".to_string()) }] },
        RowInsert { row: 1, cells: vec![CellEdit { column: 1, value: Some("b".to_string()) }] },
    ];

    let statements = build_inserts(&users(), &inserts).expect("should build");

    assert_eq!(statements.len(), 2);
    assert_eq!(statements[0].row, 0);
    assert_eq!(statements[1].row, 1);
}
```

- [ ] **Step 2: Write the failing database tests**

In `src-tauri/tests/edit_db_test.rs`. Follow the existing tests in that file for the `run_query` → `EditInfo` → `apply_edits` shape:

```rust
#[tokio::test]
async fn an_insert_returns_the_generated_key_and_the_applied_defaults() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (
           id    serial primary key,
           email text not null,
           plan  text default 'free'
         )",
        false,
    )
    .await
    .expect("create table");

    let result = run_query(&db.pool, "select id, email, plan from people", false)
        .await
        .expect("select should run");

    let inserts = vec![RowInsert {
        row: 0,
        cells: vec![CellEdit { column: 1, value: Some("a@b.c".to_string()) }],
    }];
    let statements = build_inserts(&result.edit, &inserts).expect("should build");
    let applied = apply_edits(&db.pool, &statements, true)
        .await
        .expect("insert should apply");

    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].kind, StatementKind::Insert);
    // The generated key and the applied default both come back, so the
    // grid shows what the database stored rather than what was typed.
    assert_eq!(applied[0].cells[0].value, serde_json::json!(1));
    assert_eq!(applied[0].cells[2].value, serde_json::json!("free"));
}

#[tokio::test]
async fn an_explicit_null_overrides_a_default() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id serial primary key, plan text default 'free')",
        false,
    )
    .await
    .expect("create table");

    let result = run_query(&db.pool, "select id, plan from people", false)
        .await
        .expect("select should run");

    let inserts = vec![
        // Untouched: takes the default.
        RowInsert { row: 0, cells: vec![] },
        // Explicitly NULL: overrides it.
        RowInsert { row: 1, cells: vec![CellEdit { column: 1, value: None }] },
    ];
    let statements = build_inserts(&result.edit, &inserts).expect("should build");
    let applied = apply_edits(&db.pool, &statements, true)
        .await
        .expect("inserts should apply");

    assert_eq!(applied[0].cells[1].value, serde_json::json!("free"));
    assert_eq!(applied[1].cells[1].value, serde_json::Value::Null);
}

#[tokio::test]
async fn a_before_insert_trigger_rewrite_comes_back() {
    let db = common::start().await;

    run_query(&db.pool, "create table people (id serial primary key, email text)", false)
        .await
        .expect("create table");
    run_query(
        &db.pool,
        "create function lower_email() returns trigger as $$
           begin new.email := lower(new.email); return new; end;
         $$ language plpgsql",
        false,
    )
    .await
    .expect("create function");
    run_query(
        &db.pool,
        "create trigger lower_it before insert on people
         for each row execute function lower_email()",
        false,
    )
    .await
    .expect("create trigger");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select should run");

    let inserts = vec![RowInsert {
        row: 0,
        cells: vec![CellEdit { column: 1, value: Some("LOUD@B.C".to_string()) }],
    }];
    let statements = build_inserts(&result.edit, &inserts).expect("should build");
    let applied = apply_edits(&db.pool, &statements, true)
        .await
        .expect("insert should apply");

    assert_eq!(applied[0].cells[1].value, serde_json::json!("loud@b.c"));
}

#[tokio::test]
async fn a_failing_insert_rolls_back_an_update_in_the_same_batch() {
    let db = common::start().await;

    run_query(
        &db.pool,
        "create table people (id serial primary key, email text not null)",
        false,
    )
    .await
    .expect("create table");
    run_query(&db.pool, "insert into people (email) values ('first@b.c')", false)
        .await
        .expect("seed");

    let result = run_query(&db.pool, "select id, email from people", false)
        .await
        .expect("select should run");

    let mut statements = build_updates(
        &result.edit,
        &[RowEdit {
            row: 0,
            pk: vec!["1".to_string()],
            cells: vec![CellEdit { column: 1, value: Some("changed@b.c".to_string()) }],
        }],
    )
    .expect("should build");
    // NOT NULL with no default, staged as NULL: the server refuses it.
    statements.extend(
        build_inserts(
            &result.edit,
            &[RowInsert { row: 0, cells: vec![CellEdit { column: 1, value: None }] }],
        )
        .expect("should build"),
    );

    apply_edits(&db.pool, &statements, true)
        .await
        .expect_err("the batch must fail");

    let after = run_query(&db.pool, "select email from people order by id", false)
        .await
        .expect("select should run");
    assert_eq!(after.rows.len(), 1, "the insert must not have landed");
    assert_eq!(
        after.rows[0][0],
        serde_json::json!("first@b.c"),
        "the update must have rolled back with it"
    );
}

#[tokio::test]
async fn a_deleted_natural_key_can_be_reinserted_in_one_batch() {
    // This is the ordering decision: inserts run after deletes. Reverse
    // them and this fails on the unique key.
    let db = common::start().await;

    run_query(&db.pool, "create table codes (code text primary key, label text)", false)
        .await
        .expect("create table");
    run_query(&db.pool, "insert into codes values ('FR', 'France')", false)
        .await
        .expect("seed");

    let result = run_query(&db.pool, "select code, label from codes", false)
        .await
        .expect("select should run");

    let mut statements = build_deletes(
        &result.edit,
        &[RowDelete { row: 0, pk: vec!["FR".to_string()] }],
    )
    .expect("should build");
    statements.extend(
        build_inserts(
            &result.edit,
            &[RowInsert {
                row: 0,
                cells: vec![
                    CellEdit { column: 0, value: Some("FR".to_string()) },
                    CellEdit { column: 1, value: Some("France (new)".to_string()) },
                ],
            }],
        )
        .expect("should build"),
    );

    apply_edits(&db.pool, &statements, true)
        .await
        .expect("delete then insert should apply");

    let after = run_query(&db.pool, "select label from codes", false)
        .await
        .expect("select should run");
    assert_eq!(after.rows.len(), 1);
    assert_eq!(after.rows[0][0], serde_json::json!("France (new)"));
}
```

Add `build_inserts`, `RowInsert` and `StatementKind` to the imports at the top of the file. Also update the existing delete tests in this file that assert `applied[0].deleted` to assert `applied[0].kind == StatementKind::Delete`.

- [ ] **Step 3: Run them and confirm they fail**

```bash
cd src-tauri && cargo test --test edit_sql_test --test edit_db_test
```

Expected: compile errors naming `build_inserts` and `RowInsert`.

- [ ] **Step 4: Implement**

In `src-tauri/src/edit/sql.rs`, add `Insert` to `StatementKind`, add the `RowInsert` struct from the interface block above, and:

```rust
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

        // A row with nothing staged is a table of defaults, and
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
```

Document on `Statement.row` that it is a grid index for updates and deletes and an index into the staged insert list for inserts.

In `src-tauri/src/edit/apply.rs`, replace `AppliedRow.deleted: bool` with `pub kind: StatementKind` (`deleted && inserted` should not be representable), and in `run_one`:

```rust
    let cells = match statement.kind {
        // A delete's RETURNING carries its key, not display data, and
        // the row is leaving the grid.
        StatementKind::Delete => Vec::new(),
        _ => statement
            .returned
            .iter()
            .enumerate()
            .map(|(i, column)| AppliedCell {
                column: *column,
                value: cell_to_json(&rows[0], i),
            })
            .collect(),
    };

    Ok(AppliedRow {
        row: statement.row,
        cells,
        kind: statement.kind,
    })
```

In `src-tauri/src/edit/mod.rs`, add the shared batch builder — both commands call it, so the preview cannot drift from what executes, and Step 6 has one place to mutate:

```rust
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
```

In `src-tauri/src/commands.rs`, add the `inserts: Vec<RowInsert>` parameter to both commands and replace the two-line list building in each with:

```rust
    let statements = build_batch(&edit, &rows, &deletes, &inserts)?;
```

Export `build_inserts` and `RowInsert` from `src-tauri/src/edit/mod.rs`.

- [ ] **Step 5: Confirm they pass, then run the suite**

```bash
cd src-tauri && cargo test 2>&1 | tee /tmp/task3.txt
```

Expected: 0 failed.

- [ ] **Step 6: Mutation check — the batch ordering**

The database test written in Step 2 builds its own statement list, so it pins the *behaviour* but not the order the commands use. Pin that too, in `src-tauri/tests/edit_sql_test.rs` (pure, no Docker), through `build_batch`:

```rust
#[test]
fn a_batch_runs_updates_then_deletes_then_inserts() {
    let edits = vec![RowEdit {
        row: 0,
        pk: vec!["1".to_string()],
        cells: vec![CellEdit { column: 1, value: Some("a@b.c".to_string()) }],
    }];
    let deletes = vec![RowDelete { row: 1, pk: vec!["2".to_string()] }];
    let inserts = vec![RowInsert {
        row: 0,
        cells: vec![CellEdit { column: 1, value: Some("c@d.e".to_string()) }],
    }];

    let statements = build_batch(&users(), &edits, &deletes, &inserts).expect("should build");

    let kinds: Vec<StatementKind> = statements.iter().map(|s| s.kind).collect();
    assert_eq!(
        kinds,
        vec![StatementKind::Update, StatementKind::Delete, StatementKind::Insert]
    );
}
```

Now reverse the two lines inside `build_batch`, run that test, confirm it **FAILS**, restore, confirm it passes. Report both outputs verbatim.

- [ ] **Step 7: Mutation check — the rowcount assert for inserts**

In `apply.rs`, relax `if rows.len() != 1` to `if rows.len() > 99`. Run:

```bash
cd src-tauri && cargo test --test edit_db_test a_failing_insert_rolls_back_an_update_in_the_same_batch
```

Confirm it **FAILS**, restore the assert, confirm it passes. Report both outputs verbatim. If it passes with the assert relaxed, the test is proving nothing and must be strengthened before moving on.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(edit): generate and apply row inserts"
```

---

### Task 4: The unknown cell

An appended row has no value for a computed column. This lands before the staging module because `applyPatches` builds those rows.

**Files:**
- Modify: `src/types.ts`, `src/lib/format.ts`, `src/lib/gridSort.ts`, `src/lib/exportRows.ts`, `src/App.css`
- Test: `src/lib/format.test.ts`, `src/lib/gridSort.test.ts`, `src/lib/exportRows.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/format.test.ts
it("renders an unknown cell distinctly from NULL", () => {
  expect(formatCell(UNKNOWN)).toEqual({ text: "—", kind: "unknown" });
  expect(formatCell(null)).toEqual({ text: "NULL", kind: "null" });
});

// src/lib/exportRows.test.ts
it("exports an unknown cell as an empty field, like a null", () => {
  // It must never reach String(), which would ship "Symbol(unknown)"
  // into a user's CSV.
  expect(toCsv([{ name: "a", type_name: "text" }], [[UNKNOWN]])).toBe("a\n");
  expect(toTsv([{ name: "a", type_name: "text" }], [[UNKNOWN]], false)).toBe("");
  expect(toJson([{ name: "a", type_name: "text" }], [[UNKNOWN]])).toContain('"a": null');
});

// src/lib/gridSort.test.ts
it("sorts unknown cells last in both directions", () => {
  // Not a value, so flipping the direction should not move it.
  const rows = [[UNKNOWN], [2], [1]];
  expect(sortedIndices(rows, { column: 0, direction: "asc" })).toEqual([2, 1, 0]);
  expect(sortedIndices(rows, { column: 0, direction: "desc" })).toEqual([1, 2, 0]);
});
```

Import `UNKNOWN` from `../types` in each.

- [ ] **Step 2: Run and confirm they fail**

```bash
npm test -- format exportRows gridSort
```

Expected: `UNKNOWN` is not exported.

- [ ] **Step 3: Implement**

`src/types.ts`:

```ts
/**
 * No value exists for this cell yet — a computed column on a row that
 * was just inserted. `RETURNING` can only name real table columns, and
 * nothing here parses the user's SQL to rediscover what an expression
 * meant, so the honest answer is "unknown", which is a different thing
 * from a real SQL NULL.
 */
export const UNKNOWN = Symbol("unknown");

export type CellValue =
  | string
  | number
  | boolean
  | null
  | typeof UNKNOWN
  | Record<string, unknown>
  | unknown[];
```

`src/lib/format.ts` — add `"unknown"` to `CellKind` and, as the first check in `formatCell`:

```ts
  if (value === UNKNOWN) return { text: "—", kind: "unknown" };
```

`src/lib/exportRows.ts` — first line of its private `cellText`:

```ts
  if (value === UNKNOWN || value === null) return "";
```

and in `toJson`, map `UNKNOWN` to `null` before writing the object.

`src/lib/gridSort.ts` — in `sortedIndices`, before the null handling:

```ts
    // An unknown cell is not a value, so the direction does not move
    // it: it stays at the end either way.
    if (a === UNKNOWN && b === UNKNOWN) return 0;
    if (a === UNKNOWN) return 1;
    if (b === UNKNOWN) return -1;
```

and the same first-position guard in `compareCells`, returning `1`/`-1`.

`src/App.css` — `.cell-unknown` reuses `--muted` and italics, next to the existing `.cell-null` rule. Check the real token names in `:root`; do not invent any.

- [ ] **Step 4: Verify**

```bash
npm test && npm run build
```

Expected: all pass, build clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(grid): render a cell with no known value"
```

---

### Task 5: Staged inserts in the pure module

**Files:**
- Modify: `src/types.ts`, `src/lib/ipc.ts`, `src/lib/pendingEdits.ts`
- Test: `src/lib/pendingEdits.test.ts`

**Interfaces to implement exactly:**

```ts
export type PendingInsert = { id: number; cells: Map<number, string | null> };
export type PendingInserts = PendingInsert[];

export function emptyInserts(): PendingInserts;
export function addInsert(inserts: PendingInserts): PendingInserts;
export function removeInsert(inserts: PendingInserts, id: number): PendingInserts;
export function setInsertCell(
  inserts: PendingInserts, id: number, column: number, value: string | null,
): PendingInserts;
export function insertValue(
  inserts: PendingInserts, id: number, column: number,
): string | null | undefined;
export function toRowInserts(inserts: PendingInserts): RowInsert[];
export function totalPending(
  pending: Pending, deletes: PendingDeletes, inserts: PendingInserts,
): number;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/pendingEdits.test.ts
describe("staged inserts", () => {
  it("stages a blank row and counts it", () => {
    const inserts = addInsert(emptyInserts());
    expect(inserts).toHaveLength(1);
    expect(inserts[0].cells.size).toBe(0);
    expect(totalPending(emptyPending(), emptyDeletes(), inserts)).toBe(1);
  });

  it("removes by id, not by position", () => {
    // Ids must survive an earlier row being discarded, or the grid
    // starts editing the wrong staged row.
    let inserts = addInsert(addInsert(emptyInserts()));
    const secondId = inserts[1].id;
    inserts = removeInsert(inserts, inserts[0].id);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].id).toBe(secondId);
  });

  it("keeps a value, an explicit NULL, and untouched apart", () => {
    let inserts = addInsert(emptyInserts());
    const { id } = inserts[0];

    inserts = setInsertCell(inserts, id, 1, "a@b.c");
    expect(insertValue(inserts, id, 1)).toBe("a@b.c");

    inserts = setInsertCell(inserts, id, 2, null);
    expect(insertValue(inserts, id, 2)).toBeNull();

    // Untouched: absent from the map entirely, which is what leaves the
    // column out of the INSERT so the database applies its default.
    expect(insertValue(inserts, id, 3)).toBeUndefined();
  });

  it("returns a cell to untouched when an empty value is committed", () => {
    let inserts = addInsert(emptyInserts());
    const { id } = inserts[0];

    inserts = setInsertCell(inserts, id, 1, "2026-01-01");
    inserts = setInsertCell(inserts, id, 1, "");

    expect(insertValue(inserts, id, 1)).toBeUndefined();
  });

  it("builds the payload with cells in column order", () => {
    let inserts = addInsert(emptyInserts());
    const { id } = inserts[0];
    inserts = setInsertCell(inserts, id, 2, "pro");
    inserts = setInsertCell(inserts, id, 1, "a@b.c");

    expect(toRowInserts(inserts)).toEqual([
      {
        row: 0,
        cells: [
          { column: 1, value: "a@b.c" },
          { column: 2, value: "pro" },
        ],
      },
    ]);
  });

  it("numbers rows by position in the payload, not by id", () => {
    // `row` is how the reply is matched back, and the backend sees the
    // array it was sent — not the counter behind it.
    let inserts = addInsert(addInsert(emptyInserts()));
    inserts = removeInsert(inserts, inserts[0].id);
    expect(toRowInserts(inserts)[0].row).toBe(0);
  });
});

describe("applyPatches with inserts", () => {
  it("appends returned rows, patches survivors, and drops deletions", () => {
    const result = {
      ...baseResult, // the fixture already in this file
      rows: [
        ["1", "a@b.c"],
        ["2", "c@d.e"],
      ],
      row_count: 2,
    };

    const patched = applyPatches(result, [
      { row: 0, kind: "update", cells: [{ column: 1, value: "new@b.c" }] },
      { row: 1, kind: "delete", cells: [] },
      {
        row: 0,
        kind: "insert",
        cells: [
          { column: 0, value: "3" },
          { column: 1, value: "fresh@b.c" },
        ],
      },
    ]);

    expect(patched.rows).toEqual([
      ["1", "new@b.c"],
      ["3", "fresh@b.c"],
    ]);
    expect(patched.row_count).toBe(2);
  });

  it("fills a column the insert did not return with UNKNOWN", () => {
    // A computed column: no value came back, and it must not read as
    // NULL, which would claim the database stored nothing there.
    const result = { ...baseResult, rows: [], row_count: 0 };

    const patched = applyPatches(result, [
      { row: 0, kind: "insert", cells: [{ column: 0, value: "3" }] },
    ]);

    expect(patched.rows[0][0]).toBe("3");
    expect(patched.rows[0][1]).toBe(UNKNOWN);
  });
});
```

Update every existing `AppliedRow` literal in this test file from `deleted: true/false` to `kind: "delete"` / `kind: "update"`.

- [ ] **Step 2: Run and confirm they fail**

```bash
npm test -- pendingEdits
```

- [ ] **Step 3: Implement the types**

`src/types.ts`:

```ts
/** Mirrors Rust `StatementKind`. */
export type StatementKind = "update" | "delete" | "insert";

/** Mirrors Rust `RowInsert`: one staged new row. */
export interface RowInsert {
  /** Index into the staged list, not into the grid. */
  row: number;
  cells: CellEdit[];
}

/** Mirrors Rust `AppliedRow`. */
export interface AppliedRow {
  row: number;
  cells: AppliedCell[];
  /** What the statement did: patch this row, drop it, or append it. */
  kind: StatementKind;
}
```

Add `insertable`, `insert_reason` to `EditInfo` and `insertable`, `insert_reason`, `choices: string[] | null` to `ColumnEdit`.

`src/lib/ipc.ts`: add the fourth argument to `previewEdits` and `applyRowEdits`, named `inserts` to match the Rust parameter (Tauri matches arguments by name).

- [ ] **Step 4: Implement the module**

`src/lib/pendingEdits.ts`:

```ts
/**
 * One staged new row.
 *
 * `cells` holds only the columns the user touched: a column absent from
 * the map is left out of the generated INSERT, so the database applies
 * its default. `null` is an explicit SQL NULL, which overrides one.
 *
 * `id` is a counter, never an array index — a staged row must keep its
 * identity when an earlier staged row is discarded, or the editor
 * reopens on the wrong row.
 */
export type PendingInsert = { id: number; cells: Map<number, string | null> };
export type PendingInserts = PendingInsert[];

let nextInsertId = 1;

export function emptyInserts(): PendingInserts {
  return [];
}

export function addInsert(inserts: PendingInserts): PendingInserts {
  return [...inserts, { id: nextInsertId++, cells: new Map() }];
}

export function removeInsert(inserts: PendingInserts, id: number): PendingInserts {
  return inserts.filter((row) => row.id !== id);
}

/**
 * Stage one cell of a new row.
 *
 * Committing an empty string returns the cell to untouched. That is
 * what makes "give me the default back" possible without another
 * chord; the cost is that an empty string cannot be inserted into a
 * text column from the grid, which the spec accepts.
 */
export function setInsertCell(
  inserts: PendingInserts,
  id: number,
  column: number,
  value: string | null,
): PendingInserts {
  return inserts.map((row) => {
    if (row.id !== id) return row;
    const cells = new Map(row.cells);
    if (value === "") cells.delete(column);
    else cells.set(column, value);
    return { ...row, cells };
  });
}

export function insertValue(
  inserts: PendingInserts,
  id: number,
  column: number,
): string | null | undefined {
  return inserts.find((row) => row.id === id)?.cells.get(column);
}

/**
 * The payload the backend expects. `row` is the position in this list,
 * which is the handle the reply comes back with; the id stays on the
 * frontend.
 */
export function toRowInserts(inserts: PendingInserts): RowInsert[] {
  return inserts.map((row, index) => ({
    row: index,
    cells: [...row.cells.entries()]
      .sort(([a], [b]) => a - b)
      .map(([column, value]) => ({ column, value })),
  }));
}
```

Extend `totalPending` with the third argument, and `applyPatches`:

```ts
  const removed = new Set(
    applied.filter((a) => a.kind === "delete").map((a) => a.row),
  );
  const kept = removed.size === 0 ? patched : patched.filter((_, i) => !removed.has(i));

  // Appended rows are built column by column: anything the INSERT did
  // not return has no known value, which is not the same as NULL.
  const added = applied
    .filter((a) => a.kind === "insert")
    .map((a) => {
      const row: CellValue[] = result.columns.map(() => UNKNOWN);
      for (const cell of a.cells) row[cell.column] = cell.value;
      return row;
    });

  const rows = [...kept, ...added];
  return { ...result, rows, row_count: rows.length };
```

- [ ] **Step 5: Verify**

```bash
npm test && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(ui): stage new rows in the pending module"
```

---

### Task 6: The grid, the toolbar and the selector

**Files:**
- Modify: `src/components/GridToolbar.tsx`, `src/components/ResultGrid.tsx`, `src/App.tsx`, `src/App.css`

No component-test harness exists and none is being added — every decision this task renders was tested in Tasks 2, 4 and 5.

- [ ] **Step 1: The toolbar button**

`GridToolbar` gains two props beside the delete ones:

```tsx
  /**
   * Whether this result can take new rows. Disabled rather than absent
   * when it cannot, with the reason as its tooltip, so the affordance
   * stays discoverable and explains itself.
   */
  canInsert: boolean;
  insertReason: string | null;
  onInsertRow: () => void;
```

rendered before the delete button:

```tsx
      <button
        disabled={busy || !canInsert}
        title={canInsert ? "Shift+Cmd+N" : (insertReason ?? "this result cannot take new rows")}
        onClick={onInsertRow}
      >
        Insert row
      </button>
```

- [ ] **Step 2: The selector, on existing rows first**

In `ResultGrid.tsx`, replace the `<input className="cell-editor">` (line 422) with a branch on the column's `choices`:

```tsx
                      {isEditingCell ? (
                        columnEdit?.choices ? (
                          <select
                            className="cell-editor"
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={commit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); commit(); }
                              if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                            }}
                          >
                            {columnEdit.choices.map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                        ) : (
                          /* the existing input, unchanged */
                        )
                      ) : (
                        text
                      )}
```

A native `<select>` brings type-ahead, Enter-commits and Esc-cancels for free, which is why this is a `<select>` and not a custom listbox. `⌘⌫` on the cell keeps staging NULL as it does today.

- [ ] **Step 3: Staged rows in the grid**

`ResultGrid` gains:

```tsx
  /** Staged new rows, or null when editing is off entirely. */
  inserts: PendingInserts | null;
  onInsertCell: (id: number, column: number, value: string | null) => void;
  onRemoveInsert: (id: number) => void;
```

Staged rows render after the virtualizer's rows and outside the virtual list: they are few, always at the bottom, and outside the sort order, because they are not in the database and there is nothing to sort them by.

The placeholder text for an untouched cell, extracted so it is one decision in one place:

```tsx
/**
 * What an untouched cell on a new row will become.
 *
 * `default` and `NULL` are different promises, and the column's own
 * metadata is the only thing that knows which one applies.
 */
function placeholderFor(columnEdit: ColumnEdit | undefined): string {
  if (!columnEdit || columnEdit.insertable === false) return "generated";
  return columnEdit.has_default ? "default" : "NULL";
}
```

The rows themselves:

```tsx
{(inserts ?? []).map((staged) => (
  <tr className="inserting" key={`insert-${staged.id}`}>
    <td className="row-num">+</td>
    {result.columns.map((_, i) => {
      const columnEdit = result.edit.columns[i];
      const value = insertValue(inserts!, staged.id, i);
      const canFill = columnEdit?.insertable ?? false;
      const isEditingCell =
        editingInsert?.id === staged.id && editingInsert?.col === i;

      return (
        <td
          key={i}
          className={[
            value === undefined ? "cell-placeholder" : formatCell(value ?? null).kind,
            canFill ? "" : "not-editable",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{ width: `${widths[i]}px` }}
          title={canFill ? undefined : (columnEdit?.insert_reason ?? undefined)}
          tabIndex={canFill ? 0 : undefined}
          onDoubleClick={() => canFill && openInsertEditor(staged.id, i, value ?? "")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isEditingCell && canFill) {
              e.preventDefault();
              openInsertEditor(staged.id, i, value ?? "");
            }
            // Discards the staged row outright: it never existed, so
            // there is nothing to ask the server about.
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Backspace") {
              e.preventDefault();
              onRemoveInsert(staged.id);
              return;
            }
            // An explicit NULL, which overrides a default rather than
            // accepting it.
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "Backspace" && canFill) {
              e.preventDefault();
              onInsertCell(staged.id, i, null);
            }
          }}
        >
          {isEditingCell
            ? renderEditor(columnEdit, insertDraft, setInsertDraft, commitInsert, cancelInsert)
            : value === undefined
              ? placeholderFor(columnEdit)
              : formatCell(value).text}
        </td>
      );
    })}
  </tr>
))}
```

`renderEditor` is the input-or-`<select>` branch from Step 2, extracted into one local function so the existing rows and the staged rows use the same editor rather than two that can drift. `editingInsert`, `insertDraft`, `openInsertEditor`, `commitInsert` (which calls `onInsertCell(id, col, draft)`) and `cancelInsert` mirror the existing `editing` / `draft` / `openEditor` / `commit` state for real rows.

- [ ] **Step 4: The keyboard shortcut**

In the grid's existing document-level key handler (`ResultGrid.tsx:164`), add `⇧⌘N`:

```tsx
      // Shift+Cmd+N stages a blank row. Cmd+N is untouched by menu.rs,
      // which claims only CmdOrCtrl+W and Shift+CmdOrCtrl+W.
      if (e.shiftKey && e.key.toLowerCase() === "n" && inserts !== null) {
        e.preventDefault();
        onInsertRow();
      }
```

- [ ] **Step 5: Wire `App.tsx`**

- `const [inserts, setInserts] = useState<PendingInserts>(emptyInserts());`
- clear it everywhere `setDeletes(emptyDeletes())` appears today — lines 287, 371, 586, 872, 923 at the time of writing
- pass `toRowInserts(inserts)` as the fourth argument to `previewEdits` (line 261) and `applyRowEdits` (line 276)
- `count={totalPending(pending, deletes, inserts)}` at both `EditBar` sites
- `canInsert={canEditRows && result.edit.insertable}` and `insertReason={result.edit.insert_reason}` at both `GridToolbar` sites
- pass `inserts={canEditRows ? inserts : null}` and the two handlers to both `ResultGrid` sites

There are two render sites (the query tab and the table-detail tab); both need every prop, or insert silently works in one tab and not the other.

- [ ] **Step 6: Style**

`src/App.css`: `.result-grid tr.inserting td` gets a left accent and a tinted background; `.cell-placeholder` is dimmed and italic. Use the existing `:root` tokens (`--muted`, the `--s-*` scale, the accent already used by `.pending`). Read the file's `:root` block first; do not invent variable names.

- [ ] **Step 7: Verify**

```bash
npm test && npm run build
```

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(ui): insert rows from the grid"
```

---

### Task 7: Docs and full verification

- [ ] **Step 1: README**

Extend the inline-editing paragraph (line 15) with inserting, and add to the Keyboard table:

```
| `⇧⌘N` | Stage a new row in the result grid |
```

Note in the same paragraph that enum and boolean cells offer a list of values, and that a staged cell left empty takes the column's default.

- [ ] **Step 2: `docs/BACKLOG.md`**

- "Row editing extras": drop the insert bullet; keep primary-key editing, optimistic concurrency and the bigint-key note. Record that insert shipped 2026-08-16 with its own spec, as that entry asked for.
- Add a new bullet under it: **inserting an empty string into a text column**, with the reason (empty commit means untouched, §5 of the insert spec) and the workaround (a hand-written `INSERT`).
- Add: **a modal insert form for wide tables**, deferred from §12 of the insert spec.
- Add: **foreign-key value suggestions and `CHECK`-constraint choices**, deferred from §6.

- [ ] **Step 3: Full verification**

```bash
cd src-tauri && cargo test 2>&1 | tee /tmp/final.txt
cd src-tauri && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo fmt --check
npm test
npm run build
```

All must pass. There is no baseline asterisk in this repo — clippy and fmt were fixed on their own branch on 2026-08-16, so any failure here is new. If `cargo test` reports fewer tests than expected, read `/tmp/final.txt` for the failure line rather than re-running through a filter.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: describe inserting rows"
```
