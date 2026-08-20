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
    /// `pg_class.relkind`: `r` ordinary, `p` partitioned, `v` view, `m`
    /// materialised view. The tree used to list only `r` and `p`, which
    /// meant a view you had just created was nowhere on screen — the
    /// user's conclusion being that the `create view` had failed.
    pub kind: String,
    pub columns: Vec<Column>,
    pub indexes: Vec<Index>,
    pub constraints: Vec<Constraint>,
    /// Size and row estimate, absent when the catalog row could not be
    /// read.
    pub stats: Option<TableStats>,
    /// `COMMENT ON TABLE`, if there is one.
    pub comment: Option<String>,
    pub triggers: Vec<Trigger>,
    /// Views and materialised views that read this table.
    pub dependents: Vec<Dependent>,
    /// The defining query, on views and materialised views only. A
    /// structure tab that showed a view's columns but not the statement
    /// behind them would answer the wrong half of "what is this?".
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableStats {
    /// `pg_class.reltuples`: the planner's estimate, not a count. It
    /// reads -1 on a table that has never been analyzed, which the UI
    /// shows as unknown rather than as a number.
    pub estimated_rows: i64,
    /// `pg_total_relation_size`: heap, indexes and TOAST together.
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trigger {
    pub name: String,
    /// The full `CREATE TRIGGER` text from `pg_get_triggerdef`.
    pub definition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dependent {
    pub schema: String,
    pub name: String,
    /// `v` for a view, `m` for a materialised view.
    pub kind: String,
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
