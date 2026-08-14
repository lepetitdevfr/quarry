use crate::conn::{build_pool, ping, ConnectionConfig};
use crate::error::AppError;
use crate::exec::{run_query, QueryResult};
use crate::library::model::{LibraryTree, Query, Tab};
use crate::library::store::Store;
use deadpool_postgres::Pool;
use serde::Serialize;
use std::sync::Mutex;

/// The one live database connection, if any.
///
/// Quarry connects to a single database at a time: switching closes the
/// previous pool. That is why this is an `Option<ActiveConnection>` and
/// not a map — a map would imply several live connections and invite
/// callers to pass the wrong id.
pub struct ActiveConnection {
    pub id: String,
    pub pool: Pool,
    pub info: ConnectionInfo,
}

pub struct AppState {
    active: Mutex<Option<ActiveConnection>>,
    pub library: Store,
}

impl AppState {
    /// Fails only if the library database cannot be opened, which is
    /// unrecoverable — the app has nowhere to store anything.
    pub fn new() -> Result<Self, AppError> {
        Ok(AppState {
            active: Mutex::new(None),
            library: Store::open()?,
        })
    }

    /// Clone the live pool, or report that nothing is connected.
    ///
    /// The guard is dropped before returning, so no lock is ever held
    /// across an `.await` in the async command handlers.
    fn pool(&self) -> Result<Pool, AppError> {
        let active = self.active.lock().expect("state lock poisoned");
        active
            .as_ref()
            .map(|a| a.pool.clone())
            .ok_or_else(|| AppError::Connection("not connected to a database".into()))
    }

    /// Install a new active connection, closing whatever it replaces.
    fn set_active(&self, next: Option<ActiveConnection>) {
        let previous = std::mem::replace(
            &mut *self.active.lock().expect("state lock poisoned"),
            next,
        );

        // `Pool` does not close its sockets when dropped, so an
        // un-closed pool leaves idle connections open on the server
        // until its last internal clone goes away.
        if let Some(old) = previous {
            old.pool.close();
        }
    }
}

/// What the UI gets back after a successful connect.
#[derive(Clone, Serialize)]
pub struct ConnectionInfo {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub dbname: String,
    pub user: String,
    pub server_version: String,
}

#[tauri::command]
pub async fn execute(
    state: tauri::State<'_, AppState>,
    sql: String,
) -> Result<QueryResult, AppError> {
    let pool = state.pool()?;
    run_query(&pool, &sql).await
}

#[tauri::command]
pub fn disconnect(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    state.set_active(None);
    Ok(())
}

#[tauri::command]
pub fn active_connection(
    state: tauri::State<'_, AppState>,
) -> Result<Option<ConnectionInfo>, AppError> {
    let active = state.active.lock().expect("state lock poisoned");
    Ok(active.as_ref().map(|a| a.info.clone()))
}

// ---- library commands ------------------------------------------------
//
// These are thin: validation and storage logic live in `library::store`,
// which is tested directly.

#[tauri::command]
pub fn library_tree(state: tauri::State<'_, AppState>) -> Result<LibraryTree, AppError> {
    state.library.tree()
}

#[tauri::command]
pub fn create_collection(
    state: tauri::State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> Result<LibraryTree, AppError> {
    state.library.create_collection(&name, parent_id.as_deref())?;
    state.library.tree()
}

#[tauri::command]
pub fn rename_collection(
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
) -> Result<LibraryTree, AppError> {
    state.library.rename_collection(&id, &name)?;
    state.library.tree()
}

#[tauri::command]
pub fn delete_collection(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<LibraryTree, AppError> {
    state.library.delete_collection(&id)?;
    state.library.tree()
}

#[tauri::command]
pub fn create_query(
    state: tauri::State<'_, AppState>,
    name: String,
    sql: String,
    collection_id: Option<String>,
) -> Result<Query, AppError> {
    state.library.create_query(&name, &sql, collection_id.as_deref())
}

#[tauri::command]
pub fn rename_query(
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
) -> Result<LibraryTree, AppError> {
    state.library.rename_query(&id, &name)?;
    state.library.tree()
}

#[tauri::command]
pub fn save_query(
    state: tauri::State<'_, AppState>,
    id: String,
    sql: String,
) -> Result<(), AppError> {
    state.library.save_query(&id, &sql)
}

#[tauri::command]
pub fn save_draft(
    state: tauri::State<'_, AppState>,
    id: String,
    sql: String,
) -> Result<(), AppError> {
    state.library.save_draft(&id, &sql)
}

#[tauri::command]
pub fn move_query(
    state: tauri::State<'_, AppState>,
    id: String,
    collection_id: Option<String>,
) -> Result<LibraryTree, AppError> {
    state.library.move_query(&id, collection_id.as_deref())?;
    state.library.tree()
}

#[tauri::command]
pub fn delete_query(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<LibraryTree, AppError> {
    state.library.delete_query(&id)?;
    state.library.tree()
}

#[tauri::command]
pub fn list_tabs(state: tauri::State<'_, AppState>) -> Result<Vec<Tab>, AppError> {
    state.library.tabs()
}

#[tauri::command]
pub fn open_tab(
    state: tauri::State<'_, AppState>,
    query_id: Option<String>,
) -> Result<Vec<Tab>, AppError> {
    state.library.open_tab(query_id.as_deref())?;
    state.library.tabs()
}

#[tauri::command]
pub fn activate_tab(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<Tab>, AppError> {
    state.library.activate_tab(&id)?;
    state.library.tabs()
}

#[tauri::command]
pub fn close_tab(state: tauri::State<'_, AppState>, id: String) -> Result<Vec<Tab>, AppError> {
    state.library.close_tab(&id)?;
    state.library.tabs()
}

#[tauri::command]
pub fn save_scratch(
    state: tauri::State<'_, AppState>,
    id: String,
    sql: String,
) -> Result<(), AppError> {
    state.library.save_scratch(&id, &sql)
}

#[tauri::command]
pub fn set_cursor(
    state: tauri::State<'_, AppState>,
    id: String,
    pos: i64,
) -> Result<(), AppError> {
    state.library.set_cursor(&id, pos)
}
