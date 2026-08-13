use crate::conn::{build_pool, ping, ConnectionConfig};
use crate::error::AppError;
use crate::exec::{run_query, QueryResult};
use crate::secrets;
use deadpool_postgres::Pool;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

/// Live connections, keyed by id. `Mutex` because Tauri calls commands
/// from multiple threads; the lock is held only long enough to clone a
/// pool handle (cloning a Pool is cheap and shares the same sockets).
#[derive(Default)]
pub struct AppState {
    pools: Mutex<HashMap<String, Pool>>,
}

impl AppState {
    fn get(&self, id: &str) -> Result<Pool, AppError> {
        let pools = self.pools.lock().expect("state lock poisoned");
        pools
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::UnknownConnection(id.to_string()))
    }
}

/// What the UI gets back after a successful connect.
#[derive(Serialize)]
pub struct ConnectionInfo {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub dbname: String,
    pub user: String,
    pub server_version: String,
}

#[tauri::command]
pub async fn connect(
    state: tauri::State<'_, AppState>,
    id: String,
    url: String,
    remember_password: bool,
) -> Result<ConnectionInfo, AppError> {
    let cfg = ConnectionConfig::from_url(&url)?;
    let pool = build_pool(&cfg)?;
    let server_version = ping(&pool).await?;

    if remember_password {
        if let Some(pw) = &cfg.password {
            secrets::save_password(&id, pw)?;
        }
    }

    state
        .pools
        .lock()
        .expect("state lock poisoned")
        .insert(id.clone(), pool);

    Ok(ConnectionInfo {
        id,
        host: cfg.host,
        port: cfg.port,
        dbname: cfg.dbname,
        user: cfg.user,
        server_version,
    })
}

#[tauri::command]
pub async fn execute(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> Result<QueryResult, AppError> {
    let pool = state.get(&connection_id)?;
    run_query(&pool, &sql).await
}

#[tauri::command]
pub async fn disconnect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), AppError> {
    let removed = state
        .pools
        .lock()
        .expect("state lock poisoned")
        .remove(&connection_id);

    if let Some(pool) = removed {
        pool.close();
    }
    Ok(())
}
