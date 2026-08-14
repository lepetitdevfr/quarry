# Schema Tree and Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browse schemas, tables, columns, indexes, and constraints in the sidebar, and complete table and column names in the editor from that same data.

**Architecture:** A new Rust `schema/` module reads `pg_catalog` with three focused queries and assembles a `Schema` tree, cached in `AppState` beside the active connection and cleared whenever the connection changes. The frontend renders it as one flat virtualized list and converts it into the object `@codemirror/lang-sql` already understands, which supplies clause context and alias resolution for free.

**Tech Stack:** Rust (`tokio-postgres`, `deadpool-postgres`), React 19 + TypeScript 7, `@codemirror/lang-sql`, `@tanstack/react-virtual`, testcontainers, vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-schema-tree-design.md`

---

## Prerequisites

- On `main`, clean tree, 131 tests passing (102 Rust + 29 TS)
- If `cargo` is missing: `export PATH="/opt/homebrew/opt/rustup/bin:$PATH"`
- Docker running — integration tests start real Postgres containers
- **Commit messages must NOT include a `Co-Authored-By: Claude` trailer**

Create a branch:

```bash
cd /Users/lepetitdev/dev/quarry && git checkout -b stage-4-schema
```

---

## File Structure

### Rust (`src-tauri/`)

| File | Responsibility |
|---|---|
| `src/schema/mod.rs` | Module re-exports |
| `src/schema/model.rs` | `Schema`, `SchemaNode`, `Table`, `Column`, `ForeignKey`, `Index`, `Constraint` — plain data |
| `src/schema/introspect.rs` | The three catalog queries and their assembly |
| `src/exec/value.rs` | *(modify)* array and enum rendering |
| `src/commands.rs` | *(modify)* schema cache and the `refresh_schema` command |
| `src/lib.rs` | *(modify)* declare `schema`, register commands |
| `tests/schema_test.rs` | Introspection against a fixture database |

### TypeScript (`src/`)

| File | Responsibility |
|---|---|
| `src/types.ts` | *(modify)* schema types mirroring the Rust structs |
| `src/lib/ipc.ts` | *(modify)* `refreshSchema` wrapper |
| `src/lib/schema.ts` | Flatten + filter the tree; build the CodeMirror schema object |
| `src/lib/schema.test.ts` | Vitest for both pure functions |
| `src/hooks/useSchema.ts` | Fetch on connect, refresh, loading and error state |
| `src/components/SchemaTree.tsx` | The virtualized tree |
| `src/components/Sidebar.tsx` | *(modify)* replace the placeholder |
| `src/components/SqlEditor.tsx` | *(modify)* accept a schema and feed `sql()` |
| `src/App.tsx` | *(modify)* wire the hook through |
| `src/App.css` | *(modify)* tree styles |

---

## Task 1: Schema data model

**Files:**
- Create: `src-tauri/src/schema/model.rs`, `src-tauri/src/schema/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the model**

Create `src-tauri/src/schema/model.rs`:

```rust
use serde::{Deserialize, Serialize};

/// Everything the UI knows about a database's structure.
///
/// Built once per connection by `introspect`, held in memory, and
/// thrown away when the connection changes. Never persisted: a stale
/// schema on disk would autocomplete columns that no longer exist.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Schema {
    pub schemas: Vec<SchemaNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaNode {
    pub name: String,
    pub tables: Vec<Table>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Table {
    pub schema: String,
    pub name: String,
    pub columns: Vec<Column>,
    pub indexes: Vec<Index>,
    pub constraints: Vec<Constraint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub is_primary_key: bool,
    /// Only set for single-column foreign keys. Composite keys appear
    /// in `Table::constraints` instead — showing one arbitrary column
    /// of a composite key would be misleading.
    pub references: Option<ForeignKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKey {
    pub schema: String,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Index {
    pub name: String,
    /// Straight from `pg_get_indexdef` — the real definition rather
    /// than something reassembled from catalog columns.
    pub definition: String,
    pub is_unique: bool,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Constraint {
    pub name: String,
    /// `pg_constraint.contype`: p=primary, f=foreign, u=unique,
    /// c=check, x=exclusion.
    pub kind: String,
    /// Straight from `pg_get_constraintdef`.
    pub definition: String,
}
```

Create `src-tauri/src/schema/mod.rs`:

```rust
pub mod model;

pub use model::{Column, Constraint, ForeignKey, Index, Schema, SchemaNode, Table};
```

Add `pub mod schema;` to `src-tauri/src/lib.rs`.

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo check 2>&1 | tail -5
```

Expected: `Finished`, no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/schema src-tauri/src/lib.rs
git commit -m "feat(schema): add the schema data model"
```

---

## Task 2: Introspection (TDD)

**Files:**
- Create: `src-tauri/tests/schema_test.rs`
- Create: `src-tauri/src/schema/introspect.rs`
- Modify: `src-tauri/src/schema/mod.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/schema_test.rs`:

```rust
mod common;

use quarry_lib::schema::introspect;

/// A fixture exercising every shape the tree must render: a composite
/// primary key, a cross-schema foreign key, unique and partial indexes,
/// a check constraint, nullable and defaulted columns, an array column,
/// and an enum.
const FIXTURE: &str = "
    create schema analytics;

    create type mood as enum ('sad', 'ok', 'happy');

    create table public.users (
        id          serial primary key,
        email       text not null,
        nickname    text,
        plan        text not null default 'free',
        tags        text[],
        temperament mood
    );

    create unique index users_email_key on public.users (email);
    create index users_active_plan on public.users (plan) where nickname is not null;
    alter table public.users add constraint email_has_at check (email like '%@%');

    create table analytics.events (
        user_id    integer not null references public.users(id),
        seq        integer not null,
        payload    jsonb,
        primary key (user_id, seq)
    );
";

async fn fixture_schema() -> (quarry_lib::schema::Schema, common::TestDb) {
    let db = common::start().await;
    let client = db.pool.get().await.expect(\"checkout\");
    client.batch_execute(FIXTURE).await.expect(\"fixture should apply\");
    let schema = introspect(&db.pool).await.expect(\"introspection should succeed\");
    (schema, db)
}

fn table<'a>(
    schema: &'a quarry_lib::schema::Schema,
    schema_name: &str,
    table_name: &str,
) -> &'a quarry_lib::schema::Table {
    schema
        .schemas
        .iter()
        .find(|s| s.name == schema_name)
        .unwrap_or_else(|| panic!(\"no schema {schema_name}\"))
        .tables
        .iter()
        .find(|t| t.name == table_name)
        .unwrap_or_else(|| panic!(\"no table {table_name}\"))
}

#[tokio::test]
async fn finds_user_schemas_and_hides_system_ones() {
    let (schema, _db) = fixture_schema().await;

    let names: Vec<&str> = schema.schemas.iter().map(|s| s.name.as_str()).collect();

    assert!(names.contains(&\"public\"));
    assert!(names.contains(&\"analytics\"));
    assert!(
        !names.iter().any(|n| n.starts_with(\"pg_\") || *n == \"information_schema\"),
        \"system schemas must be filtered out, got {names:?}\",
    );
}

#[tokio::test]
async fn reports_columns_in_ordinal_order_with_types() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, \"public\", \"users\");

    let names: Vec<&str> = users.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        vec![\"id\", \"email\", \"nickname\", \"plan\", \"tags\", \"temperament\"],
        \"columns must keep their declared order, not alphabetical\",
    );

    let email = users.columns.iter().find(|c| c.name == \"email\").unwrap();
    assert_eq!(email.type_name, \"text\");
}

#[tokio::test]
async fn distinguishes_nullable_from_not_null() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, \"public\", \"users\");

    let email = users.columns.iter().find(|c| c.name == \"email\").unwrap();
    let nickname = users.columns.iter().find(|c| c.name == \"nickname\").unwrap();

    assert!(!email.nullable);
    assert!(nickname.nullable);
}

#[tokio::test]
async fn reports_defaults() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, \"public\", \"users\");

    let plan = users.columns.iter().find(|c| c.name == \"plan\").unwrap();
    assert!(
        plan.default.as_deref().unwrap_or_default().contains(\"free\"),
        \"expected the default expression, got {:?}\",
        plan.default,
    );

    let nickname = users.columns.iter().find(|c| c.name == \"nickname\").unwrap();
    assert_eq!(nickname.default, None);
}

#[tokio::test]
async fn marks_primary_keys_including_composite_ones() {
    let (schema, _db) = fixture_schema().await;

    let users = table(&schema, \"public\", \"users\");
    let id = users.columns.iter().find(|c| c.name == \"id\").unwrap();
    assert!(id.is_primary_key);

    let events = table(&schema, \"analytics\", \"events\");
    let pk_columns: Vec<&str> = events
        .columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(pk_columns, vec![\"user_id\", \"seq\"], \"both halves of a composite key\");
}

#[tokio::test]
async fn resolves_a_cross_schema_foreign_key() {
    let (schema, _db) = fixture_schema().await;
    let events = table(&schema, \"analytics\", \"events\");

    let user_id = events.columns.iter().find(|c| c.name == \"user_id\").unwrap();
    let fk = user_id.references.as_ref().expect(\"user_id references users\");

    assert_eq!(fk.schema, \"public\");
    assert_eq!(fk.table, \"users\");
    assert_eq!(fk.column, \"id\");
}

#[tokio::test]
async fn reports_indexes_with_their_definitions() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, \"public\", \"users\");

    let unique = users
        .indexes
        .iter()
        .find(|i| i.name == \"users_email_key\")
        .expect(\"unique index\");
    assert!(unique.is_unique);
    assert!(!unique.is_primary);
    assert!(unique.definition.to_lowercase().contains(\"unique\"));

    let partial = users
        .indexes
        .iter()
        .find(|i| i.name == \"users_active_plan\")
        .expect(\"partial index\");
    assert!(
        partial.definition.to_lowercase().contains(\"where\"),
        \"a partial index must keep its predicate: {}\",
        partial.definition,
    );

    assert!(
        users.indexes.iter().any(|i| i.is_primary),
        \"the primary key's index should be listed too\",
    );
}

#[tokio::test]
async fn reports_constraints_with_their_definitions() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, \"public\", \"users\");

    let check = users
        .constraints
        .iter()
        .find(|c| c.name == \"email_has_at\")
        .expect(\"check constraint\");

    assert_eq!(check.kind, \"c\");

    // Postgres deparses the definition rather than echoing the source:
    // `LIKE` comes back as the `~~` operator, so asserting on the word
    // \"like\" would fail forever. What matters is that a real, complete
    // definition arrives — it starts with CHECK and names the column.
    let definition = check.definition.to_lowercase();
    assert!(
        definition.starts_with(\"check\"),
        \"expected a CHECK definition, got: {}\",
        check.definition,
    );
    assert!(
        definition.contains(\"email\"),
        \"the definition should name the column it constrains, got: {}\",
        check.definition,
    );

    assert!(
        users.constraints.iter().any(|c| c.kind == \"p\"),
        \"primary key should appear as a constraint\",
    );
}

#[tokio::test]
async fn reports_a_foreign_key_constraint_on_the_referencing_table() {
    let (schema, _db) = fixture_schema().await;
    let events = table(&schema, \"analytics\", \"events\");

    let fk = events
        .constraints
        .iter()
        .find(|c| c.kind == \"f\")
        .expect(\"events references users\");

    assert!(
        fk.definition.to_lowercase().contains(\"references\"),
        \"got: {}\",
        fk.definition,
    );
}

#[tokio::test]
async fn renders_array_and_enum_column_types_readably() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, \"public\", \"users\");

    let tags = users.columns.iter().find(|c| c.name == \"tags\").unwrap();
    assert_eq!(tags.type_name, \"text[]\", \"not the internal _text spelling\");

    let temperament = users.columns.iter().find(|c| c.name == \"temperament\").unwrap();
    assert_eq!(temperament.type_name, \"mood\");
}

#[tokio::test]
async fn an_empty_database_yields_empty_schemas_not_an_error() {
    let db = common::start().await;

    let schema = introspect(&db.pool).await.expect(\"should succeed\");

    // `public` exists in a fresh database but holds no tables.
    let public = schema.schemas.iter().find(|s| s.name == \"public\");
    assert!(public.map(|s| s.tables.is_empty()).unwrap_or(true));
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test schema_test 2>&1 | tail -15
```

Expected: compilation failure — `unresolved import quarry_lib::schema::introspect`.

- [ ] **Step 3: Write the introspection module**

Create `src-tauri/src/schema/introspect.rs`:

```rust
//! Reading the database's structure out of `pg_catalog`.
//!
//! Three queries rather than one aggregate: columns, indexes, and
//! constraints. A single `json_agg` query would save two round-trips at
//! the cost of being unreadable, and this runs once per connection.
//!
//! `pg_catalog` rather than `information_schema` — it is faster, and it
//! gives us `pg_get_indexdef` and `pg_get_constraintdef`, which return
//! the real definitions instead of a reconstruction.

use crate::error::AppError;
use crate::schema::model::{Column, Constraint, ForeignKey, Index, Schema, SchemaNode, Table};
use deadpool_postgres::Pool;
use std::collections::BTreeMap;

/// Schemas that are never interesting to browse.
const SYSTEM_SCHEMA_FILTER: &str = "
    n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg_toast%'
    and n.nspname not like 'pg_temp%'
";

/// Read the whole structure. Ordinary and partitioned tables only.
pub async fn introspect(pool: &Pool) -> Result<Schema, AppError> {
    let client = pool
        .get()
        .await
        .map_err(|e| AppError::Connection(e.to_string()))?;

    // Keyed by (schema, table) so the three result sets can be merged
    // without repeated linear scans. BTreeMap keeps schemas and tables
    // in name order for free.
    let mut tables: BTreeMap<(String, String), Table> = BTreeMap::new();

    // ---- columns ----------------------------------------------------
    //
    // `format_type` renders the type the way a user writes it:
    // `text[]` rather than the internal `_text`, and `mood` for an enum.
    let column_sql = format!(
        "select n.nspname                        as schema,
                c.relname                        as table,
                a.attname                        as column,
                format_type(a.atttypid, a.atttypmod) as type_name,
                not a.attnotnull                 as nullable,
                pg_get_expr(d.adbin, d.adrelid)  as default_expr,
                coalesce(pk.is_pk, false)        as is_primary_key,
                fk.ref_schema,
                fk.ref_table,
                fk.ref_column
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
         left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
         left join lateral (
             select true as is_pk
             from pg_constraint pc
             where pc.conrelid = c.oid
               and pc.contype = 'p'
               and a.attnum = any (pc.conkey)
         ) pk on true
         left join lateral (
             select fn.nspname as ref_schema,
                    fc.relname as ref_table,
                    fa.attname as ref_column
             from pg_constraint pc
             join pg_class fc on fc.oid = pc.confrelid
             join pg_namespace fn on fn.oid = fc.relnamespace
             join pg_attribute fa
                  on fa.attrelid = pc.confrelid and fa.attnum = pc.confkey[1]
             where pc.conrelid = c.oid
               and pc.contype = 'f'
               and array_length(pc.conkey, 1) = 1
               and pc.conkey[1] = a.attnum
             limit 1
         ) fk on true
         where c.relkind in ('r', 'p')
           and a.attnum > 0
           and not a.attisdropped
           and {SYSTEM_SCHEMA_FILTER}
         order by n.nspname, c.relname, a.attnum"
    );

    for row in client.query(&column_sql, &[]).await? {
        let schema: String = row.get("schema");
        let table_name: String = row.get("table");

        let references = match (
            row.get::<_, Option<String>>("ref_schema"),
            row.get::<_, Option<String>>("ref_table"),
            row.get::<_, Option<String>>("ref_column"),
        ) {
            (Some(s), Some(t), Some(c)) => Some(ForeignKey {
                schema: s,
                table: t,
                column: c,
            }),
            _ => None,
        };

        tables
            .entry((schema.clone(), table_name.clone()))
            .or_insert_with(|| Table {
                schema,
                name: table_name,
                columns: Vec::new(),
                indexes: Vec::new(),
                constraints: Vec::new(),
            })
            .columns
            .push(Column {
                name: row.get("column"),
                type_name: row.get("type_name"),
                nullable: row.get("nullable"),
                default: row.get("default_expr"),
                is_primary_key: row.get("is_primary_key"),
                references,
            });
    }

    // ---- indexes ----------------------------------------------------
    let index_sql = format!(
        "select n.nspname                as schema,
                c.relname                as table,
                ic.relname               as index_name,
                pg_get_indexdef(i.indexrelid) as definition,
                i.indisunique            as is_unique,
                i.indisprimary           as is_primary
         from pg_index i
         join pg_class c  on c.oid = i.indrelid
         join pg_class ic on ic.oid = i.indexrelid
         join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p')
           and {SYSTEM_SCHEMA_FILTER}
         order by n.nspname, c.relname, ic.relname"
    );

    for row in client.query(&index_sql, &[]).await? {
        let key: (String, String) = (row.get("schema"), row.get("table"));
        if let Some(table) = tables.get_mut(&key) {
            table.indexes.push(Index {
                name: row.get("index_name"),
                definition: row.get("definition"),
                is_unique: row.get("is_unique"),
                is_primary: row.get("is_primary"),
            });
        }
    }

    // ---- constraints ------------------------------------------------
    let constraint_sql = format!(
        "select n.nspname   as schema,
                c.relname   as table,
                pc.conname  as name,
                pc.contype::text as kind,
                pg_get_constraintdef(pc.oid) as definition
         from pg_constraint pc
         join pg_class c on c.oid = pc.conrelid
         join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p')
           and {SYSTEM_SCHEMA_FILTER}
         order by n.nspname, c.relname, pc.conname"
    );

    for row in client.query(&constraint_sql, &[]).await? {
        let key: (String, String) = (row.get("schema"), row.get("table"));
        if let Some(table) = tables.get_mut(&key) {
            table.constraints.push(Constraint {
                name: row.get("name"),
                kind: row.get("kind"),
                definition: row.get("definition"),
            });
        }
    }

    // ---- schemas ----------------------------------------------------
    //
    // Listed separately so an empty schema still appears in the tree.
    let schema_sql = format!(
        "select n.nspname as name
         from pg_namespace n
         where {SYSTEM_SCHEMA_FILTER}
         order by n.nspname"
    );

    let mut nodes: Vec<SchemaNode> = Vec::new();
    for row in client.query(&schema_sql, &[]).await? {
        let name: String = row.get("name");
        let owned: Vec<Table> = tables
            .iter()
            .filter(|((s, _), _)| s == &name)
            .map(|(_, t)| t.clone())
            .collect();
        nodes.push(SchemaNode { name, tables: owned });
    }

    Ok(Schema { schemas: nodes })
}
```

Add to `src-tauri/src/schema/mod.rs`:

```rust
pub mod introspect;

pub use introspect::introspect;
```

- [ ] **Step 4: Run tests to verify they pass**

Docker must be running.

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test schema_test 2>&1 | tail -20
```

Expected: `test result: ok. 11 passed; 0 failed`.

If a test fails on the exact spelling of a type or definition, check what
Postgres actually returned before changing anything — the test asserts real
behavior, and the implementation is the more likely culprit.

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/schema src-tauri/tests/schema_test.rs
git commit -m "feat(schema): introspect tables, columns, indexes, and constraints"
```

---

## Task 3: Array and enum rendering (TDD)

Closes a Stage 1 review finding: both currently render as
`<unsupported type: …>`.

**Files:**
- Modify: `src-tauri/tests/exec_test.rs`
- Modify: `src-tauri/src/exec/value.rs`

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/tests/exec_test.rs`:

```rust
#[tokio::test]
async fn renders_arrays_as_json_arrays() {
    let db = common::start().await;

    let result = run_query(
        &db.pool,
        "select array[1,2,3]::int4[]           as ints,
                array['a','b']::text[]         as texts,
                array[]::int4[]                as empty,
                array[1,null,3]::int4[]        as with_null,
                array[true,false]::bool[]      as bools",
    )
    .await
    .expect("query should succeed");

    let col = |name: &str| {
        let i = result.columns.iter().position(|c| c.name == name).unwrap();
        result.rows[0][i].clone()
    };

    assert_eq!(col("ints"), json!([1, 2, 3]));
    assert_eq!(col("texts"), json!(["a", "b"]));
    assert_eq!(col("empty"), json!([]));
    assert_eq!(col("with_null"), json!([1, null, 3]));
    assert_eq!(col("bools"), json!([true, false]));
}

#[tokio::test]
async fn renders_enum_values_as_their_labels() {
    let db = common::start().await;
    let client = db.pool.get().await.expect("checkout");
    client
        .batch_execute("create type mood as enum ('sad', 'ok', 'happy')")
        .await
        .expect("type should be created");

    let result = run_query(&db.pool, "select 'happy'::mood as m")
        .await
        .expect("query should succeed");

    assert_eq!(result.rows[0][0], json!("happy"));
}

#[tokio::test]
async fn an_unrenderable_type_still_shows_a_visible_placeholder() {
    let db = common::start().await;

    // A multi-dimensional array is deliberately NOT flattened into a
    // lying one-dimensional list: better a visible placeholder than
    // silently wrong data.
    let result = run_query(&db.pool, "select '{{1,2},{3,4}}'::int4[][] as grid")
        .await
        .expect("query should succeed");

    let cell = &result.rows[0][0];
    let text = cell.as_str().unwrap_or_default();
    assert!(
        text.contains("unsupported") || cell.is_array(),
        "expected a placeholder or a faithful array, got {cell}",
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test exec_test renders_ 2>&1 | tail -15
```

Expected: `renders_arrays_as_json_arrays` and `renders_enum_values_as_their_labels`
both fail, showing `<unsupported type: _int4>` and `<unsupported type: mood>`.

- [ ] **Step 3: Add array and enum handling**

In `src-tauri/src/exec/value.rs`, add these two helpers above `cell_to_json`:

```rust
/// Decode a one-dimensional array of `T` into a JSON array.
///
/// `Vec<Option<T>>` because array elements can individually be NULL —
/// `{1,NULL,3}` is a perfectly ordinary Postgres value.
fn convert_array<'a, T>(row: &'a Row, idx: usize) -> Option<Value>
where
    T: FromSql<'a> + Serialize,
{
    match row.try_get::<_, Option<Vec<Option<T>>>>(idx) {
        Ok(Some(items)) => {
            let json: Vec<Value> = items
                .into_iter()
                .map(|item| match item {
                    Some(v) => serde_json::to_value(v).unwrap_or(Value::Null),
                    None => Value::Null,
                })
                .collect();
            Some(Value::Array(json))
        }
        Ok(None) => Some(Value::Null),
        // A multi-dimensional array fails to decode as a flat Vec. Fall
        // through to the placeholder rather than inventing a shape.
        Err(_) => None,
    }
}

/// Reads any type's bytes as UTF-8, whatever its OID.
///
/// This exists for enums: their wire representation is simply the label
/// text, but `String`'s `FromSql` refuses unknown OIDs, so the normal
/// path cannot read them. Used only as a last resort, after every known
/// type has been tried.
#[derive(Debug)]
struct AnyText(String);

impl<'a> FromSql<'a> for AnyText {
    fn from_sql(
        _ty: &Type,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(AnyText(std::str::from_utf8(raw)?.to_string()))
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }
}
```

Then replace the final `else` branch of `cell_to_json` — currently
`Value::String(format!("<unsupported type: {}>", t.name()))` — with:

```rust
    } else if let Some(array) = array_to_json(row, idx, t) {
        array
    } else if t.name() != "record" {
        // Last resort: enums and other text-shaped types whose OID we do
        // not know. Anything that is not valid UTF-8 falls through to the
        // placeholder below rather than becoming a silent null.
        match row.try_get::<_, Option<AnyText>>(idx) {
            Ok(Some(AnyText(s))) => Value::String(s),
            Ok(None) => Value::Null,
            Err(_) => Value::String(format!("<unsupported type: {}>", t.name())),
        }
    } else {
        Value::String(format!("<unsupported type: {}>", t.name()))
    }
```

And add the array dispatcher below `cell_to_json`:

```rust
/// Dispatch on element type for the array types we render.
///
/// Returns `None` for arrays we cannot decode — including
/// multi-dimensional ones — so the caller falls back to a placeholder.
fn array_to_json(row: &Row, idx: usize, t: &Type) -> Option<Value> {
    if t == &Type::INT2_ARRAY {
        convert_array::<i16>(row, idx)
    } else if t == &Type::INT4_ARRAY {
        convert_array::<i32>(row, idx)
    } else if t == &Type::INT8_ARRAY {
        convert_array::<i64>(row, idx)
    } else if t == &Type::FLOAT4_ARRAY {
        convert_array::<f32>(row, idx)
    } else if t == &Type::FLOAT8_ARRAY {
        convert_array::<f64>(row, idx)
    } else if t == &Type::BOOL_ARRAY {
        convert_array::<bool>(row, idx)
    } else if t == &Type::TEXT_ARRAY
        || t == &Type::VARCHAR_ARRAY
        || t == &Type::NAME_ARRAY
        || t == &Type::BPCHAR_ARRAY
    {
        convert_array::<String>(row, idx)
    } else if t == &Type::UUID_ARRAY {
        match row.try_get::<_, Option<Vec<Option<uuid::Uuid>>>>(idx) {
            Ok(Some(items)) => Some(Value::Array(
                items
                    .into_iter()
                    .map(|i| match i {
                        Some(u) => Value::String(u.to_string()),
                        None => Value::Null,
                    })
                    .collect(),
            )),
            Ok(None) => Some(Value::Null),
            Err(_) => None,
        }
    } else if t == &Type::JSON_ARRAY || t == &Type::JSONB_ARRAY {
        convert_array::<Value>(row, idx)
    } else {
        None
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test exec_test 2>&1 | tail -12
```

Expected: all exec tests pass, including the three new ones. The existing
`unsupported_types_do_not_crash_the_query` test uses `point`, which has no
array or text decoding, so it must still produce a placeholder — if it now
returns text instead, that is fine only if the text is meaningful; check the
assertion still holds and report if you changed it.

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/exec/value.rs src-tauri/tests/exec_test.rs
git commit -m "feat(exec): render arrays and enums instead of a placeholder"
```

---

## Task 4: Cache the schema and expose it

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the cache to AppState**

In `src-tauri/src/commands.rs`, add to the `AppState` struct:

```rust
    /// Introspected structure of the live database.
    ///
    /// Cleared by `set_active` on every connection change: a schema
    /// outliving its connection would autocomplete tables from the
    /// wrong database.
    schema: Mutex<Option<crate::schema::Schema>>,
```

Initialise it in `AppState::new` with `schema: Mutex::new(None),`.

At the end of `set_active`, after closing the previous pool, add:

```rust
        *self.schema.lock().expect("state lock poisoned") = None;
```

- [ ] **Step 2: Add the commands**

Append to `src-tauri/src/commands.rs`:

Only one command, not two. The spec listed a `schema` command returning the
cache, but the frontend always calls `refresh_schema` — on connect and on
refresh alike — so a cache-reading command would be dead code. The cache still
earns its place: it is what `set_active` clears, and a later stage that needs to
read the schema from Rust (the write-guard, for instance) will want it.

```rust
/// Re-read the database structure and replace the cache.
///
/// Also the initial load: the frontend calls this after connecting.
#[tauri::command]
pub async fn refresh_schema(
    state: tauri::State<'_, AppState>,
) -> Result<crate::schema::Schema, AppError> {
    let pool = state.pool()?;
    let fresh = crate::schema::introspect(&pool).await?;

    *state.schema.lock().expect("state lock poisoned") = Some(fresh.clone());

    Ok(fresh)
}
```

- [ ] **Step 3: Register them**

Add to `generate_handler!` in `src-tauri/src/lib.rs`:

```rust
            commands::refresh_schema,
```

- [ ] **Step 4: Verify the whole suite**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test 2>&1 | grep -E "^test result|^error"
```

Expected: every suite `ok`, no regressions.

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): cache the schema per connection and expose it"
```

---

## Task 5: TypeScript types and helpers (TDD)

**Files:**
- Modify: `src/types.ts`, `src/lib/ipc.ts`
- Create: `src/lib/schema.ts`, `src/lib/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/schema.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildCompletionSchema, flattenSchema, matchesFilter } from "./schema";
import type { Schema } from "../types";

const SCHEMA: Schema = {
  schemas: [
    {
      name: "public",
      tables: [
        {
          schema: "public",
          name: "users",
          columns: [
            {
              name: "id",
              type_name: "int4",
              nullable: false,
              default: null,
              is_primary_key: true,
              references: null,
            },
            {
              name: "email",
              type_name: "text",
              nullable: false,
              default: null,
              is_primary_key: false,
              references: null,
            },
          ],
          indexes: [
            {
              name: "users_pkey",
              definition: "CREATE UNIQUE INDEX users_pkey ON public.users (id)",
              is_unique: true,
              is_primary: true,
            },
          ],
          constraints: [],
        },
        {
          schema: "public",
          name: "invoices",
          columns: [
            {
              name: "total",
              type_name: "numeric",
              nullable: true,
              default: null,
              is_primary_key: false,
              references: null,
            },
          ],
          indexes: [],
          constraints: [],
        },
      ],
    },
    {
      name: "analytics",
      tables: [
        {
          schema: "analytics",
          name: "events",
          columns: [
            {
              name: "user_id",
              type_name: "int4",
              nullable: false,
              default: null,
              is_primary_key: true,
              references: { schema: "public", table: "users", column: "id" },
            },
          ],
          indexes: [],
          constraints: [],
        },
      ],
    },
  ],
};

describe("buildCompletionSchema", () => {
  it("maps qualified table names to their columns", () => {
    const built = buildCompletionSchema(SCHEMA);
    expect(built["public.users"]).toEqual(["id", "email"]);
    expect(built["analytics.events"]).toEqual(["user_id"]);
  });

  it("also exposes public tables unqualified", () => {
    // `public` is on the default search path, so `users` must complete
    // without typing `public.`.
    const built = buildCompletionSchema(SCHEMA);
    expect(built["users"]).toEqual(["id", "email"]);
  });

  it("does not expose non-public tables unqualified", () => {
    const built = buildCompletionSchema(SCHEMA);
    expect(built["events"]).toBeUndefined();
  });

  it("returns an empty object for a null schema", () => {
    expect(buildCompletionSchema(null)).toEqual({});
  });
});

describe("flattenSchema", () => {
  it("returns only schema rows when nothing is expanded", () => {
    const rows = flattenSchema(SCHEMA, new Set(), "");
    expect(rows.map((r) => r.label)).toEqual(["analytics", "public"]);
    expect(rows.every((r) => r.kind === "schema")).toBe(true);
  });

  it("reveals tables when a schema is expanded", () => {
    const rows = flattenSchema(SCHEMA, new Set(["schema:public"]), "");
    expect(rows.map((r) => r.label)).toEqual([
      "analytics",
      "public",
      "invoices",
      "users",
    ]);
  });

  it("reveals columns and group rows when a table is expanded", () => {
    const rows = flattenSchema(
      SCHEMA,
      new Set(["schema:public", "table:public.users"]),
      "",
    );
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("id");
    expect(labels).toContain("email");
    expect(labels).toContain("indexes (1)");
  });

  it("indents deeper rows", () => {
    const rows = flattenSchema(SCHEMA, new Set(["schema:public"]), "");
    const schemaRow = rows.find((r) => r.label === "public")!;
    const tableRow = rows.find((r) => r.label === "users")!;
    expect(tableRow.depth).toBeGreaterThan(schemaRow.depth);
  });
});

describe("matchesFilter", () => {
  it("keeps tables whose name matches", () => {
    const rows = flattenSchema(SCHEMA, new Set(), "invo");
    expect(rows.map((r) => r.label)).toContain("invoices");
  });

  it("auto-expands to reveal a matching column", () => {
    // Typing a column name should surface the table containing it,
    // without the user expanding anything by hand.
    const rows = flattenSchema(SCHEMA, new Set(), "email");
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("users");
    expect(labels).toContain("email");
    expect(labels).not.toContain("invoices");
  });

  it("is case-insensitive", () => {
    expect(matchesFilter("Users", "user")).toBe(true);
    expect(matchesFilter("users", "USER")).toBe(true);
  });

  it("treats an empty filter as matching everything", () => {
    expect(matchesFilter("anything", "")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry && npm test 2>&1 | tail -8
```

Expected: cannot resolve `./schema`.

- [ ] **Step 3: Add the types**

Append to `src/types.ts`:

```typescript
/** Mirrors Rust `ForeignKey`. */
export interface ForeignKey {
  schema: string;
  table: string;
  column: string;
}

/** Mirrors Rust `Column`. */
export interface SchemaColumn {
  name: string;
  type_name: string;
  nullable: boolean;
  default: string | null;
  is_primary_key: boolean;
  references: ForeignKey | null;
}

/** Mirrors Rust `Index`. */
export interface SchemaIndex {
  name: string;
  definition: string;
  is_unique: boolean;
  is_primary: boolean;
}

/** Mirrors Rust `Constraint`. */
export interface SchemaConstraint {
  name: string;
  kind: string;
  definition: string;
}

/** Mirrors Rust `Table`. */
export interface SchemaTable {
  schema: string;
  name: string;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
  constraints: SchemaConstraint[];
}

/** Mirrors Rust `SchemaNode`. */
export interface SchemaNode {
  name: string;
  tables: SchemaTable[];
}

/** Mirrors Rust `Schema`. */
export interface Schema {
  schemas: SchemaNode[];
}
```

- [ ] **Step 4: Add the IPC wrappers**

Append to `src/lib/ipc.ts`:

```typescript
import type { Schema } from "../types";

/// Re-reads the database structure. Used for both the initial load
/// after connecting and the manual refresh button.
export async function refreshSchema(): Promise<Schema> {
  return invoke<Schema>("refresh_schema");
}
```

- [ ] **Step 5: Write the helpers**

Create `src/lib/schema.ts`:

```typescript
import type { Schema, SchemaTable } from "../types";

/** One rendered line of the tree. */
export interface SchemaRow {
  /** Stable identity, also the expansion key: `table:public.users`. */
  id: string;
  kind: "schema" | "table" | "column" | "group" | "index" | "constraint";
  label: string;
  depth: number;
  /** Column type, or an index/constraint definition. */
  detail?: string;
  /** Set on rows that can be expanded. */
  expandable?: boolean;
  /** Column markers. */
  isPrimaryKey?: boolean;
  nullable?: boolean;
  /** Tooltip text for a foreign key marker. */
  referencesLabel?: string;
}

/** Case-insensitive substring match; an empty filter matches everything. */
export function matchesFilter(text: string, filter: string): boolean {
  if (filter === "") return true;
  return text.toLowerCase().includes(filter.toLowerCase());
}

function tableMatches(table: SchemaTable, filter: string): boolean {
  if (filter === "") return true;
  if (matchesFilter(table.name, filter)) return true;
  return table.columns.some((c) => matchesFilter(c.name, filter));
}

/**
 * Turn the tree into the flat list the virtualizer renders.
 *
 * A filter auto-expands whatever it matches: typing a column name
 * surfaces the tables containing it without the user expanding
 * anything, which is what makes a wide schema navigable.
 */
export function flattenSchema(
  schema: Schema | null,
  expanded: Set<string>,
  filter: string,
): SchemaRow[] {
  if (!schema) return [];

  const rows: SchemaRow[] = [];
  const filtering = filter !== "";

  const sortedSchemas = [...schema.schemas].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const node of sortedSchemas) {
    const tables = [...node.tables]
      .filter((t) => tableMatches(t, filter))
      .sort((a, b) => a.name.localeCompare(b.name));

    // While filtering, a schema with no surviving tables disappears.
    if (filtering && tables.length === 0) continue;

    const schemaId = `schema:${node.name}`;
    const schemaOpen = filtering || expanded.has(schemaId);

    rows.push({
      id: schemaId,
      kind: "schema",
      label: node.name,
      depth: 0,
      expandable: true,
    });

    if (!schemaOpen) continue;

    for (const table of tables) {
      const tableId = `table:${table.schema}.${table.name}`;
      // A filter that matched a column expands that table so the match
      // is visible; a filter matching only the table name does not.
      const columnHit =
        filtering && table.columns.some((c) => matchesFilter(c.name, filter));
      const tableOpen = expanded.has(tableId) || columnHit;

      rows.push({
        id: tableId,
        kind: "table",
        label: table.name,
        depth: 1,
        expandable: true,
      });

      if (!tableOpen) continue;

      for (const column of table.columns) {
        rows.push({
          id: `column:${table.schema}.${table.name}.${column.name}`,
          kind: "column",
          label: column.name,
          depth: 2,
          detail: column.type_name,
          isPrimaryKey: column.is_primary_key,
          nullable: column.nullable,
          referencesLabel: column.references
            ? `references ${column.references.schema}.${column.references.table}.${column.references.column}`
            : undefined,
        });
      }

      if (table.indexes.length > 0) {
        const groupId = `indexes:${table.schema}.${table.name}`;
        rows.push({
          id: groupId,
          kind: "group",
          label: `indexes (${table.indexes.length})`,
          depth: 2,
          expandable: true,
        });
        if (expanded.has(groupId)) {
          for (const index of table.indexes) {
            rows.push({
              id: `index:${table.schema}.${table.name}.${index.name}`,
              kind: "index",
              label: index.name,
              depth: 3,
              detail: index.definition,
            });
          }
        }
      }

      if (table.constraints.length > 0) {
        const groupId = `constraints:${table.schema}.${table.name}`;
        rows.push({
          id: groupId,
          kind: "group",
          label: `constraints (${table.constraints.length})`,
          depth: 2,
          expandable: true,
        });
        if (expanded.has(groupId)) {
          for (const constraint of table.constraints) {
            rows.push({
              id: `constraint:${table.schema}.${table.name}.${constraint.name}`,
              kind: "constraint",
              label: constraint.name,
              depth: 3,
              detail: constraint.definition,
            });
          }
        }
      }
    }
  }

  return rows;
}

/**
 * Build the object `@codemirror/lang-sql` expects: table name → column
 * names. Tables in `public` are exposed twice, qualified and bare,
 * because `public` is on the default search path and nobody types it.
 */
export function buildCompletionSchema(
  schema: Schema | null,
): Record<string, string[]> {
  if (!schema) return {};

  const built: Record<string, string[]> = {};

  for (const node of schema.schemas) {
    for (const table of node.tables) {
      const columns = table.columns.map((c) => c.name);
      built[`${node.name}.${table.name}`] = columns;
      if (node.name === "public") built[table.name] = columns;
    }
  }

  return built;
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry && npm test 2>&1 | tail -8
```

Expected: `Test Files 5 passed`, `Tests 41 passed` (29 existing + 12 new).

- [ ] **Step 7: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/types.ts src/lib/ipc.ts src/lib/schema.ts src/lib/schema.test.ts
git commit -m "feat(ui): add schema types and tree helpers"
```

---

## Task 6: The schema hook

**Files:**
- Create: `src/hooks/useSchema.ts`

- [ ] **Step 1: Write the hook**

Create `src/hooks/useSchema.ts`:

```typescript
import { useCallback, useEffect, useState } from "react";
import { asAppError, refreshSchema } from "../lib/ipc";
import type { Schema } from "../types";

/**
 * Loads the database structure for the live connection.
 *
 * Keyed on `connectionId`: passing null (disconnected) clears the
 * schema, so autocomplete can never offer tables from a database the
 * user has left.
 */
export function useSchema(connectionId: string | null) {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSchema(await refreshSchema());
    } catch (e) {
      // Introspection failing is not fatal: a user without catalog
      // permissions can still run queries. Keep whatever we had.
      setError(asAppError(e).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connectionId === null) {
      setSchema(null);
      setError(null);
      return;
    }
    void load();
  }, [connectionId, load]);

  return { schema, loading, error, refresh: load };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/lepetitdev/dev/quarry && npx tsc --noEmit 2>&1 | head -5
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/hooks/useSchema.ts
git commit -m "feat(ui): add the schema hook"
```

---

## Task 7: The tree component

**Files:**
- Create: `src/components/SchemaTree.tsx`
- Modify: `src/App.css`

- [ ] **Step 1: Write the component**

Create `src/components/SchemaTree.tsx`:

```tsx
import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { flattenSchema } from "../lib/schema";
import type { Schema } from "../types";

interface Props {
  schema: Schema | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  onRefresh: () => void;
}

const ROW_HEIGHT = 22;

export function SchemaTree({
  schema,
  loading,
  error,
  connected,
  onRefresh,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () => flattenSchema(schema, expanded, filter),
    [schema, expanded, filter],
  );

  // A schema with every table expanded runs to thousands of rows, so
  // the tree is windowed exactly like the result grid.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!connected) {
    return <p className="tree-empty">Not connected.</p>;
  }

  return (
    <>
      <div className="schema-toolbar">
        <input
          className="schema-filter"
          placeholder="Filter tables and columns…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
        <button
          className="row-action"
          title="Refresh schema"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? "…" : "⟳"}
        </button>
      </div>

      {error && (
        <p className="tree-error">
          {error} <button className="link" onClick={onRefresh}>Retry</button>
        </p>
      )}

      {rows.length === 0 && !loading && !error && (
        <p className="tree-empty">
          {filter === "" ? "No tables." : "Nothing matches."}
        </p>
      )}

      <div className="schema-rows" ref={scrollRef}>
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            const open = expanded.has(row.id);

            return (
              <div
                key={row.id}
                className={`tree-row schema-${row.kind}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: `${ROW_HEIGHT}px`,
                  transform: `translateY(${item.start}px)`,
                  paddingLeft: 8 + row.depth * 12,
                }}
                onClick={() => row.expandable && toggle(row.id)}
                title={row.referencesLabel ?? row.detail}
              >
                {row.expandable && (
                  <span className="twisty">{open ? "▾" : "▸"}</span>
                )}
                <span className="schema-label">{row.label}</span>
                {row.kind === "column" && (
                  <>
                    <span
                      className={`schema-type${row.nullable ? " nullable" : ""}`}
                    >
                      {row.detail}
                    </span>
                    {row.isPrimaryKey && <span className="marker pk">PK</span>}
                    {row.referencesLabel && <span className="marker fk">↗</span>}
                  </>
                )}
                {(row.kind === "index" || row.kind === "constraint") && (
                  <span className="schema-def">{row.detail}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Add the styles**

Append to `src/App.css`:

```css
.schema-toolbar {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 4px 6px;
}

.schema-filter {
  flex: 1;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
}

.schema-toolbar .row-action {
  opacity: 1;
}

.schema-rows {
  flex: 1;
  overflow: auto;
  position: relative;
}

.tree-row.schema-column,
.tree-row.schema-index,
.tree-row.schema-constraint {
  cursor: default;
}

.twisty {
  display: inline-block;
  width: 12px;
  color: var(--muted);
  flex: none;
}

.schema-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.schema-type {
  margin-left: 8px;
  color: var(--muted);
  font-family: ui-monospace, monospace;
  font-size: 11px;
}

/* NOT NULL columns read stronger than nullable ones. */
.schema-type.nullable {
  opacity: 0.6;
}

.marker {
  margin-left: 6px;
  font-size: 9px;
  letter-spacing: 0.04em;
}

.marker.pk {
  color: var(--accent);
}

.marker.fk {
  color: var(--muted);
}

.schema-def {
  margin-left: 8px;
  color: var(--muted);
  font-family: ui-monospace, monospace;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-error {
  margin: 6px 8px;
  color: var(--error);
  font-size: 12px;
}

button.link {
  background: none;
  border: none;
  padding: 0 4px;
  color: var(--accent);
  text-decoration: underline;
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd /Users/lepetitdev/dev/quarry && npx tsc --noEmit 2>&1 | head -5
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/components/SchemaTree.tsx src/App.css
git commit -m "feat(ui): add the virtualized schema tree"
```

---

## Task 8: Wire the tree and autocomplete in

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/SqlEditor.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Replace the sidebar placeholder**

In `src/components/Sidebar.tsx`, add to the imports:

```tsx
import { SchemaTree } from "./SchemaTree";
import type { LibraryTree, Schema } from "../types";
```

Add to the `Props` interface:

```tsx
  schema: Schema | null;
  schemaLoading: boolean;
  schemaError: string | null;
  connected: boolean;
  onRefreshSchema: () => void;
```

Replace the placeholder — currently
`<p className="tree-empty">Schema browsing arrives in Stage 4.</p>` — with:

```tsx
        <SchemaTree
          schema={props.schema}
          loading={props.schemaLoading}
          error={props.schemaError}
          connected={props.connected}
          onRefresh={props.onRefreshSchema}
        />
```

- [ ] **Step 2: Teach the editor about the schema**

In `src/components/SqlEditor.tsx`, add `completionSchema` to `Props`:

```tsx
interface Props {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  busy: boolean;
  /** Table name → column names, from `buildCompletionSchema`. */
  completionSchema: Record<string, string[]>;
}
```

Destructure it in the component signature, then change the `sql()` call inside
`useMemo` from `sql({ dialect: PostgreSQL })` to:

```tsx
      sql({
        dialect: PostgreSQL,
        schema: completionSchema,
        // `public` is on the default search path, so unqualified names
        // should resolve there.
        defaultSchema: "public",
        upperCaseKeywords: false,
      }),
```

and add `completionSchema` to the `useMemo` dependency array, so it becomes
`[onRun, completionSchema]`.

- [ ] **Step 3: Wire it through App.tsx**

In `src/App.tsx`, add the imports:

```tsx
import { useSchema } from "./hooks/useSchema";
import { buildCompletionSchema } from "./lib/schema";
```

After the `useConnections()` call, add:

```tsx
  const {
    schema: dbSchema,
    loading: schemaLoading,
    error: schemaError,
    refresh: refreshDbSchema,
  } = useSchema(connection?.id ?? null);

  // Rebuilt only when the schema changes, not on every keystroke —
  // an unstable object here would tear down CodeMirror's state.
  const completionSchema = useMemo(
    () => buildCompletionSchema(dbSchema),
    [dbSchema],
  );
```

Make sure `useMemo` is in the React import.

Pass the new props to `<Sidebar>`:

```tsx
        schema={dbSchema}
        schemaLoading={schemaLoading}
        schemaError={schemaError}
        connected={connection !== null}
        onRefreshSchema={() => void refreshDbSchema()}
```

And to `<SqlEditor>`:

```tsx
        completionSchema={completionSchema}
```

- [ ] **Step 4: Verify everything**

```bash
cd /Users/lepetitdev/dev/quarry
npx tsc --noEmit
npm test 2>&1 | tail -6
npm run build 2>&1 | tail -4
```

Expected: `tsc` silent, 41 tests passing, build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/components/Sidebar.tsx src/components/SqlEditor.tsx src/App.tsx
git commit -m "feat(ui): show the schema tree and complete from it"
```

---

## Task 9: End-to-end smoke test

**Files:** none

- [ ] **Step 1: Start a database with a real schema**

```bash
docker rm -f quarry-schema >/dev/null 2>&1
docker run --rm -d --name quarry-schema -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17
sleep 6
docker exec quarry-schema psql -U postgres -c "
  create schema analytics;
  create type mood as enum ('sad','ok','happy');
  create table users (
    id serial primary key,
    email text not null,
    nickname text,
    plan text not null default 'free',
    tags text[],
    temperament mood
  );
  create unique index users_email_key on users (email);
  alter table users add constraint email_has_at check (email like '%@%');
  create table analytics.events (
    user_id integer not null references users(id),
    seq integer not null,
    primary key (user_id, seq)
  );
  insert into users (email, tags, temperament)
    values ('a@b.co', array['vip','beta'], 'happy');
"
```

- [ ] **Step 2: Run the app**

```bash
cd /Users/lepetitdev/dev/quarry && npm run tauri dev
```

- [ ] **Step 3: Verify each behavior**

Connect to `postgres://postgres:postgres@localhost:55432/postgres?sslmode=disable`.

- [ ] The Schema section lists `analytics` and `public`, and no `pg_*` schemas
- [ ] Expanding `public` → `users` shows columns in declared order, not alphabetical
- [ ] `id` is marked `PK`; `nickname` renders dimmer than `email` (nullable vs NOT NULL)
- [ ] `tags` shows type `text[]` and `temperament` shows `mood`
- [ ] `indexes (2)` expands to show `users_pkey` and `users_email_key` with real definitions
- [ ] `constraints` expands to show `email_has_at` with its `CHECK` definition
- [ ] Under `analytics` → `events`, `user_id` carries `↗` and its tooltip names `public.users.id`
- [ ] Typing `email` in the filter reveals `users` with the column visible, and hides `events`
- [ ] Clearing the filter restores the tree
- [ ] `select * from users` renders `tags` as `["vip","beta"]` and `temperament` as `happy`
- [ ] In the editor, typing `select * from ` offers table names
- [ ] Typing `select  from users u` then `u.` in the gap offers only that table's columns
- [ ] Add a table (`docker exec quarry-schema psql -U postgres -c "create table late (id int);"`), press ⟳, and `late` appears
- [ ] Switch to another connection: the tree changes and autocomplete no longer offers `users`
- [ ] Disconnect: the tree reads "Not connected"

- [ ] **Step 4: Tear down**

```bash
docker stop quarry-schema
```

- [ ] **Step 5: Final verification and tag**

```bash
cd /Users/lepetitdev/dev/quarry
npm test && npx tsc --noEmit && cd src-tauri && cargo test 2>&1 | grep -E "^test result"
cd /Users/lepetitdev/dev/quarry && git tag stage-4-schema-tree
```

---

## Definition of done

- Schemas, tables, columns, indexes, and constraints browsable in the sidebar
- Columns show type, PK and FK markers, and nullability
- The filter matches columns as well as tables, auto-expanding hits
- Refresh picks up DDL changes; the schema clears on disconnect
- Autocomplete offers tables after `FROM` and alias-resolved columns after `.`
- Arrays and enums render as values, not placeholders
- All tests pass: 116 Rust (102 existing + 11 introspection + 3 value), 41 TS

## Deliberately not in this stage

Views in the tree, double-click to preview a table, insert-name-at-cursor, copy
DDL — all recorded in `docs/BACKLOG.md`. Also still open: moving queries between
collections, the visual design pass, and the production write-guard.
