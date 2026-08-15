use crate::conn::{build_pool, ping, ConnectionConfig};
use crate::error::AppError;
use crate::exec::{run_query, QueryResult};
use crate::guard::{decide, Decision, Policy};
use crate::library::model::{LibraryTree, Query, Tab, TableMode};
use crate::library::store::Store;
use deadpool_postgres::Pool;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
    pub policy: Policy,
    /// When the current unlock expires. `None` means locked.
    ///
    /// Deliberately not persisted: restarting relocks, which is the
    /// point. An `Instant` rather than a wall clock, so changing the
    /// system time cannot extend an unlock.
    pub unlocked_until: Option<Instant>,
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

    /// The pool plus the guard state, read under one lock so the policy
    /// cannot change between the check and the execution.
    fn pool_and_guard(&self) -> Result<(Pool, Policy, Option<Instant>), AppError> {
        let active = self.active.lock().expect("state lock poisoned");
        active
            .as_ref()
            .map(|a| (a.pool.clone(), a.policy, a.unlocked_until))
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
    let (pool, policy, unlocked_until) = state.pool_and_guard()?;

    // The one chokepoint. Every statement the user runs passes here.
    let read_write = match decide(policy, unlocked_until, Instant::now(), &sql) {
        Decision::Allow { read_write } => read_write,
        Decision::Deny => return Err(AppError::WriteBlocked(sql.trim().to_string())),
    };

    run_query(&pool, &sql, read_write).await
}

/// How long an unlock lasts. Fixed from the moment of unlocking rather
/// than sliding: a sliding window can be kept alive indefinitely, which
/// is the state this feature exists to prevent.
const UNLOCK_MINUTES: u64 = 30;

/// What the UI needs to render the guard's state.
#[derive(Clone, Serialize)]
pub struct GuardStatus {
    /// "free" or "read_only".
    pub policy: String,
    /// Seconds left on the unlock, or None when locked.
    pub unlocked_seconds_remaining: Option<u64>,
}

#[tauri::command]
pub fn guard_status(state: tauri::State<'_, AppState>) -> Result<Option<GuardStatus>, AppError> {
    let active = state.active.lock().expect("state lock poisoned");
    Ok(active.as_ref().map(|a| GuardStatus {
        policy: match a.policy {
            Policy::Free => "free".to_string(),
            Policy::ReadOnly => "read_only".to_string(),
        },
        unlocked_seconds_remaining: a.unlocked_until.and_then(|deadline| {
            deadline
                .checked_duration_since(Instant::now())
                .map(|left| left.as_secs())
        }),
    }))
}

/// Unlock the active connection for a fixed window.
///
/// `typed_name` must match the connection's name exactly. The point is
/// not authentication — anyone at the keyboard can read the name — but
/// deliberateness: typing it is impossible to do by reflex, which a
/// confirmation button is not.
#[tauri::command]
pub fn unlock(state: tauri::State<'_, AppState>, typed_name: String) -> Result<(), AppError> {
    // Read the id and release the lock before touching the library:
    // holding the `active` mutex across a SQLite call would nest two
    // locks for no reason, and nested locks are how ordering bugs start.
    let id = {
        let active = state.active.lock().expect("state lock poisoned");
        active
            .as_ref()
            .map(|a| a.id.clone())
            .ok_or_else(|| AppError::Connection("not connected to a database".into()))?
    };

    let record = state.library.connection(&id)?;
    if typed_name.trim() != record.name {
        return Err(AppError::WriteBlocked(format!(
            "type the connection name exactly to unlock: {}",
            record.name
        )));
    }

    let mut active = state.active.lock().expect("state lock poisoned");
    // Re-check identity: the user could have switched connections while
    // the dialog was open, and unlocking a different database than the
    // one they named is exactly the accident this feature prevents.
    match active.as_mut() {
        Some(connection) if connection.id == id => {
            connection.unlocked_until =
                Some(Instant::now() + Duration::from_secs(UNLOCK_MINUTES * 60));
            Ok(())
        }
        _ => Err(AppError::Connection(
            "the connection changed while unlocking".into(),
        )),
    }
}

#[tauri::command]
pub fn relock(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let mut active = state.active.lock().expect("state lock poisoned");
    if let Some(connection) = active.as_mut() {
        connection.unlocked_until = None;
    }
    Ok(())
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

#[tauri::command]
pub fn open_preview_tab(
    state: tauri::State<'_, AppState>,
    title: String,
    sql: String,
) -> Result<Vec<Tab>, AppError> {
    state.library.open_preview_tab(&title, &sql)
}

#[tauri::command]
pub fn promote_tab(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<Tab>, AppError> {
    state.library.promote_tab(&id)?;
    state.library.tabs()
}

#[tauri::command]
pub fn open_table_tab(
    state: tauri::State<'_, AppState>,
    schema: String,
    table: String,
    mode: TableMode,
    pin: bool,
) -> Result<Vec<Tab>, AppError> {
    state.library.open_table_tab(&schema, &table, mode, pin)
}

#[tauri::command]
pub fn set_tab_mode(
    state: tauri::State<'_, AppState>,
    id: String,
    mode: TableMode,
) -> Result<Vec<Tab>, AppError> {
    state.library.set_tab_mode(&id, mode)
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

/// Decide which password to connect with: the one the user just typed,
/// or failing that whatever the Keychain holds.
///
/// The Keychain is consulted **only** when nothing was typed, and that
/// ordering is the whole point rather than an optimisation. Reading the
/// Keychain is precisely what fails after a rebuild — macOS ties entries
/// to the signing identity that created them — and the error tells the
/// user to enter the password again. Reading it anyway made that
/// instruction impossible to follow: the read failed, the failure was
/// returned, and the password the user had just typed was never looked
/// at. Every retry hit the same wall.
///
/// `load` is a closure rather than a value so the read genuinely does
/// not happen in the supplied-password case, which is what the test
/// asserts.
pub fn resolve_password(
    supplied: Option<String>,
    load: impl FnOnce() -> Result<Option<String>, AppError>,
) -> Result<Option<String>, AppError> {
    // An empty field is the absence of a password, not a password.
    match supplied.filter(|p| !p.is_empty()) {
        Some(typed) => Ok(Some(typed)),
        None => load(),
    }
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

    let password = resolve_password(password, || crate::secrets::load_password(&id))?;

    let cfg = ConnectionConfig {
        host: record.host.clone(),
        port: record.port,
        user: record.user.clone(),
        dbname: record.dbname.clone(),
        password: password.clone(),
        sslmode: record.sslmode,
    };

    let attempted_without_password = password.is_none();

    let policy = Policy::for_tag(record.tag);

    // Build and verify BEFORE touching the active slot: a failed
    // connect must leave the user disconnected, never half-switched.
    let pool = build_pool(&cfg, policy)?;
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
        policy,
        // A fresh connection is always locked, whatever the previous
        // one was.
        unlocked_until: None,
    }));

    // Saving the password is a convenience, and by this point the
    // connection is already live and installed. Propagating a save
    // failure here would report a working connection as a failed one —
    // and it is reachable: after a rebuild macOS can deny the delete
    // inside `save_password`, leaving the old entry in place so the
    // write that follows collides with it. The user stays connected;
    // they are simply asked for the password again next time.
    if let Some(pw) = password {
        let _ = state.library.save_connection_password(&id, &pw);
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

// ---- export -----------------------------------------------------------

/// Write a string to a path the user chose in the Save panel.
///
/// This exists instead of `tauri-plugin-fs` on purpose. That plugin
/// grants the webview a general filesystem write capability; this
/// feature needs to write exactly one file that the user just named in
/// a native dialog. One narrow command is a much smaller door.
///
/// Split from the `#[tauri::command]` wrapper so it can be tested
/// without a Tauri app handle.
pub fn write_text(path: &str, contents: &str) -> Result<(), AppError> {
    std::fs::write(path, contents)
        .map_err(|e| AppError::Export(format!("{path}: {e}")))
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), AppError> {
    write_text(&path, &contents)
}
