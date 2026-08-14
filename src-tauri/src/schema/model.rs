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
