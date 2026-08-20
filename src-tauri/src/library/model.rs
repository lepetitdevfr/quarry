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
    /// A transient tab opened by previewing a table. Reused by the next
    /// preview, and cleared by the first edit.
    pub is_preview: bool,
    /// Label for a tab with no saved query behind it — the table name
    /// for a preview. `None` for ordinary tabs, which take their label
    /// from their query.
    pub title: Option<String>,
    /// Schema and table this tab targets. Both are `None` on an
    /// ordinary query tab; both are `Some` on a table tab. They move
    /// together — one set without the other is a bug, not a state.
    pub target_schema: Option<String>,
    pub target_table: Option<String>,
    /// Which face of the target is showing. `None` when there is no
    /// target.
    pub mode: Option<TableMode>,
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

use crate::conn::config::SslMode;

/// What kind of environment a connection points at.
///
/// Nothing enforces this yet — the write-guard is a later stage. It
/// exists now so the guard needs no schema migration, and so the UI can
/// make production visually obvious today.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tag {
    Local,
    Staging,
    Prod,
}

impl Tag {
    pub fn as_str(&self) -> &'static str {
        match self {
            Tag::Local => "local",
            Tag::Staging => "staging",
            Tag::Prod => "prod",
        }
    }

    /// Unrecognised values become `Prod`. Erring toward the most
    /// cautious tag means a corrupted row shows as dangerous rather
    /// than looking safe.
    pub fn from_stored(s: &str) -> Self {
        match s {
            "local" => Tag::Local,
            "staging" => Tag::Staging,
            _ => Tag::Prod,
        }
    }

    /// Default colour when the user does not pick one.
    pub fn default_colour(&self) -> &'static str {
        match self {
            Tag::Local => "#4ade80",
            Tag::Staging => "#fbbf24",
            Tag::Prod => "#f26d6d",
        }
    }
}

/// Which face of a table a table tab is showing.
///
/// `Structure` renders from the cached schema and runs no SQL; `Data`
/// runs the preview `SELECT`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableMode {
    Structure,
    Data,
}

impl TableMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            TableMode::Structure => "structure",
            TableMode::Data => "data",
        }
    }

    /// Unrecognised values become `Structure`, following `Tag::from_stored`:
    /// a corrupted row resolves to the mode that touches no database.
    pub fn from_stored(s: &str) -> Self {
        match s {
            "data" => TableMode::Data,
            _ => TableMode::Structure,
        }
    }
}

/// Whether opening a table tab claims the preview slot or keeps the tab.
///
/// `Preview` is a single-click: the tab is disposable and the next
/// preview reuses it. `Pinned` is a double-click — an explicit "keep
/// this one", so the next preview opens elsewhere.
///
/// This is not stored as a string: it decides the `is_preview` integer
/// column, which is why there is no `as_str`/`from_stored` pair here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TabPin {
    Preview,
    Pinned,
}

impl TabPin {
    /// The `is_preview` column value this pin means.
    pub fn is_preview(&self) -> i64 {
        match self {
            TabPin::Preview => 1,
            TabPin::Pinned => 0,
        }
    }
}

/// A saved connection. The password is NOT here — it lives in the
/// Keychain under this record's id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub dbname: String,
    pub sslmode: SslMode,
    pub tag: Tag,
    pub colour: String,
    pub last_used_at: Option<String>,
    pub created_at: String,
}

/// The fields the UI submits when creating or editing a connection.
/// `password` is optional: absent means "leave the Keychain entry
/// alone" on edit, and "no password" on create.
#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub dbname: String,
    pub sslmode: SslMode,
    pub tag: Tag,
    pub colour: Option<String>,
    pub password: Option<String>,
}

/// One row of the History list: a statement that was run, or the text
/// of a tab that was closed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentItem {
    pub id: String,
    /// `run` or `closed`.
    pub kind: String,
    pub sql: String,
    /// The connection it ran against, or was open beside. `None` once
    /// that connection has been deleted — the work outlives its origin.
    pub connection_id: Option<String>,
    /// The closed tab's name, when it had one.
    pub title: Option<String>,
    pub first_at: String,
    pub last_at: String,
    pub run_count: i64,
    /// The last run's duration and row count. Both `None` on a closed
    /// tab, which never ran, and on a run that failed.
    pub duration_ms: Option<i64>,
    pub row_count: Option<i64>,
    /// The last run's error message; `None` when it succeeded.
    pub error: Option<String>,
}

/// One write this app performed, and how it ended.
///
/// `connection_name` and `tag` are copied in rather than joined: the row
/// must still say which database it hit after that connection is renamed
/// or deleted, and an audit line that loses its subject is not an audit
/// line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteRecord {
    pub id: String,
    pub at: String,
    pub connection_id: Option<String>,
    pub connection_name: String,
    pub tag: String,
    pub sql: String,
    /// `update`, `delete`, `insert`, `ddl`, `other`, or `batch` for the
    /// grid's own edits.
    pub kind: String,
    pub row_count: Option<i64>,
    /// `committed`, `rolled_back`, `refused` or `failed`.
    pub outcome: String,
    /// Why it was refused, or how it failed. `None` when it committed.
    pub reason: Option<String>,
    /// SQL that would put it back, where that is derivable. `None` for
    /// typed statements, which are recorded but not reversible.
    pub undo_sql: Option<String>,
}

/// What is known about a write at the moment it is recorded.
///
/// A struct rather than nine positional arguments: a call site reading
/// `record_write(id, name, tag, sql, kind, count, outcome, reason, undo)`
/// cannot be checked by eye, and a swapped pair of strings compiles
/// silently.
#[derive(Debug, Clone)]
pub struct WriteEntry {
    pub connection_id: Option<String>,
    pub connection_name: String,
    pub tag: String,
    pub sql: String,
    pub kind: String,
    pub row_count: Option<i64>,
    pub outcome: String,
    pub reason: Option<String>,
    pub undo_sql: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_mode_round_trips_through_storage() {
        assert_eq!(TableMode::from_stored("structure"), TableMode::Structure);
        assert_eq!(TableMode::from_stored("data"), TableMode::Data);
        assert_eq!(TableMode::Structure.as_str(), "structure");
        assert_eq!(TableMode::Data.as_str(), "data");
    }

    #[test]
    fn an_unknown_mode_is_structure() {
        // Structure runs no SQL. A corrupted row must not be able to
        // make the app execute a query on open.
        assert_eq!(TableMode::from_stored("nonsense"), TableMode::Structure);
        assert_eq!(TableMode::from_stored(""), TableMode::Structure);
    }
}
