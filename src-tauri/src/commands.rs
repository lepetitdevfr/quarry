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
    /// Introspected structure of the live database.
    ///
    /// Cleared by `set_active` on every connection change: a schema
    /// outliving its connection would autocomplete tables from the
    /// wrong database.
    schema: Mutex<Option<crate::schema::Schema>>,
}

impl AppState {
    /// Fails only if the library database cannot be opened, which is
    /// unrecoverable — the app has nowhere to store anything.
    pub fn new() -> Result<Self, AppError> {
        Ok(AppState {
            active: Mutex::new(None),
            library: Store::open()?,
            schema: Mutex::new(None),
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

        *self.schema.lock().expect("state lock poisoned") = None;
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

// ---- connection commands ----------------------------------------------

use crate::library::model::{Connection, ConnectionInput};

#[tauri::command]
pub fn list_connections(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Connection>, AppError> {
    state.library.connections()
}

#[tauri::command]
pub fn create_connection(
    state: tauri::State<'_, AppState>,
    input: ConnectionInput,
) -> Result<Vec<Connection>, AppError> {
    let password = input.password.clone();
    let created = state.library.create_connection(input)?;

    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        state.library.save_connection_password(&created.id, &pw)?;
    }

    state.library.connections()
}

#[tauri::command]
pub fn update_connection(
    state: tauri::State<'_, AppState>,
    id: String,
    input: ConnectionInput,
) -> Result<Vec<Connection>, AppError> {
    let password = input.password.clone();
    state.library.update_connection(&id, input)?;

    // An empty or absent password means "leave the stored one alone",
    // so editing a host does not silently wipe the credential.
    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        state.library.save_connection_password(&id, &pw)?;
    }

    state.library.connections()
}

#[tauri::command]
pub fn delete_connection(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<Connection>, AppError> {
    // Disconnect first if this is the live one, otherwise the pool
    // would outlive the record it came from.
    let is_active = state
        .active
        .lock()
        .expect("state lock poisoned")
        .as_ref()
        .is_some_and(|a| a.id == id);
    if is_active {
        state.set_active(None);
    }

    state.library.delete_connection(&id)?;
    state.library.connections()
}

/// Connect to a saved connection, replacing any current one.
///
/// `password` is only for the case where the Keychain has no entry —
/// normally it is omitted and the stored credential is used. A supplied
/// password is saved on success, so the prompt happens at most once.
#[tauri::command]
pub async fn connect_saved(
    state: tauri::State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> Result<ConnectionInfo, AppError> {
    let record = state.library.connection(&id)?;

    let stored = crate::secrets::load_password(&id)?;
    let password = password.filter(|p| !p.is_empty()).or(stored);

    let cfg = ConnectionConfig {
        host: record.host.clone(),
        port: record.port,
        user: record.user.clone(),
        dbname: record.dbname.clone(),
        password: password.clone(),
        sslmode: record.sslmode,
    };

    let attempted_without_password = password.is_none();

    // Build and verify BEFORE touching the active slot: a failed
    // connect must leave the user disconnected, never half-switched.
    let pool = build_pool(&cfg)?;
    let server_version = match ping(&pool).await {
        Ok(v) => v,
        // A failure with no password is almost always the missing
        // password rather than anything else the driver reports —
        // tokio-postgres says "invalid configuration", which names
        // neither the cause nor the fix. Send the UI something it can
        // act on instead.
        Err(_) if attempted_without_password => return Err(AppError::PasswordRequired),
        Err(e) => return Err(e),
    };

    let info = ConnectionInfo {
        id: id.clone(),
        host: record.host,
        port: record.port,
        dbname: record.dbname,
        user: record.user,
        server_version,
    };

    state.set_active(Some(ActiveConnection {
        id: id.clone(),
        pool,
        info: info.clone(),
    }));

    if let Some(pw) = password {
        state.library.save_connection_password(&id, &pw)?;
    }
    state.library.touch_connection(&id)?;

    Ok(info)
}

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
