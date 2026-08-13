use serde::{Deserialize, Serialize};

/// A folder in the sidebar. `parent_id` is None for a top-level folder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Collection {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub position: i64,
    pub created_at: String,
}

/// A saved query.
///
/// `sql` is the last explicitly saved text. `draft_sql` is the
/// continuously autosaved text, and is None when the draft matches
/// `sql`. The editor shows `draft_sql` when present — that is what
/// makes closing the app without saving safe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Query {
    pub id: String,
    pub collection_id: Option<String>,
    pub name: String,
    pub sql: String,
    pub draft_sql: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl Query {
    /// The text the editor should display.
    pub fn effective_sql(&self) -> &str {
        self.draft_sql.as_deref().unwrap_or(&self.sql)
    }

    /// True when the draft differs from the saved text.
    pub fn is_dirty(&self) -> bool {
        match &self.draft_sql {
            Some(d) => d != &self.sql,
            None => false,
        }
    }
}

/// An open editor tab. A tab with `query_id: None` is untitled and
/// keeps its text in `scratch_sql`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Tab {
    pub id: String,
    pub query_id: Option<String>,
    pub scratch_sql: Option<String>,
    pub position: i64,
    pub is_active: bool,
    pub cursor_pos: i64,
}

/// The whole sidebar in one payload — cheaper than the UI walking the
/// tree with one IPC call per level.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryTree {
    pub collections: Vec<Collection>,
    pub queries: Vec<Query>,
}

/// Gap between sibling positions, so inserting between two neighbours
/// usually needs no renumbering.
pub const POSITION_GAP: i64 = 100;
