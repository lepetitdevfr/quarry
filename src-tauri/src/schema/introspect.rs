//! Reading the database's structure out of `pg_catalog`.
//!
//! Three queries rather than one aggregate: columns, indexes, and
//! constraints. A single `json_agg` query would save two round-trips at
//! the cost of being unreadable, and this runs once per connection.
//!
//! `pg_catalog` rather than `information_schema` — it is faster, and it
//! gives us `pg_get_indexdef` and `pg_get_constraintdef`, which return
//! the real definitions instead of a reconstruction.

use crate::edit::{Identity, TableColumn, TableFacts};
use crate::error::AppError;
use crate::schema::model::{Column, Constraint, ForeignKey, Index, Schema, SchemaNode, Table};
use deadpool_postgres::Pool;
use std::collections::BTreeMap;
use tokio_postgres::types::Oid;

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
        nodes.push(SchemaNode {
            name,
            tables: owned,
        });
    }

    Ok(Schema { schemas: nodes })
}

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
    let client = pool
        .get()
        .await
        .map_err(|e| AppError::Connection(e.to_string()))?;

    // Postgres oids are unsigned, and Rust's postgres types are signed —
    // plain `u32` has no `ToSql`. `tokio_postgres::types::Oid` is a `u32`
    // alias that does, so bind through it rather than casting to i32
    // (oids above 2^31 exist).
    let oid: Oid = oid;

    let rows = client
        .query(
            "select c.relkind::text        as relkind,
                    n.nspname               as schema,
                    c.relname               as table_name,
                    a.attnum                as attnum,
                    a.attname::text         as column_name,
                    exists (
                      select 1 from pg_constraint pc
                      where pc.conrelid = c.oid
                        and pc.contype = 'p'
                        and a.attnum = any (pc.conkey)
                    )                       as is_pk,
                    a.attnotnull            as not_null,
                    a.atthasdef             as has_default,
                    a.attidentity::text     as identity,
                    a.attgenerated::text    as generated
             from   pg_class c
             join   pg_namespace n on n.oid = c.relnamespace
             join   pg_attribute a on a.attrelid = c.oid
             where  c.oid = $1
               and  a.attnum > 0
               and  not a.attisdropped
             order by a.attnum",
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
    }))
}
