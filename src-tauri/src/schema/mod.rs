pub mod introspect;
pub mod model;

pub use introspect::{introspect, lookup_table};
pub use model::{
    Column, Constraint, Dependent, ForeignKey, Index, Schema, SchemaNode, Table, TableStats,
    Trigger,
};
