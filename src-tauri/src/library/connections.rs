//! Connection records.
//!
//! These are `impl Store` blocks living in their own file to keep
//! `store.rs` focused on collections, queries, and tabs.
//!
//! Passwords are never stored here. They live in the macOS Keychain
//! under the connection's id, and `delete_connection` removes the
//! Keychain entry alongside the row — a deleted connection must not
//! leave a credential behind.

use crate::conn::config::SslMode;
use crate::error::AppError;
use crate::library::model::{Connection, ConnectionInput, Tag};
use crate::library::store::{new_id, now, sql_err, validate_name, Store};
use rusqlite::{params, Row};

impl Store {
    pub fn connections(&self) -> Result<Vec<Connection>, AppError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "select id, name, host, port, \"user\", dbname, sslmode, tag,
                        colour, last_used_at, created_at
                 from connections
                 -- Frozen order, deliberately. Sorting by last use meant
                 -- the same physical row in the dropdown was a different
                 -- database on different opens, and one of the rows is
                 -- production. `last_used_at` is still read: the launch
                 -- screen focuses the most recently used row wherever it
                 -- now sits.
                 order by name collate nocase, id",
            )
            .map_err(sql_err)?;

        let rows = stmt
            .query_map([], read_connection)
            .map_err(sql_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_err)?;

        Ok(rows)
    }

    pub fn connection(&self, id: &str) -> Result<Connection, AppError> {
        self.lock()
            .query_row(
                "select id, name, host, port, \"user\", dbname, sslmode, tag,
                        colour, last_used_at, created_at
                 from connections where id = ?1",
                params![id],
                read_connection,
            )
            .map_err(|_| AppError::Library(format!("no such connection: {id}")))
    }

    pub fn create_connection(&self, input: ConnectionInput) -> Result<Connection, AppError> {
        let name = validate_name(&input.name)?;
        let colour = input
            .colour
            .clone()
            .unwrap_or_else(|| input.tag.default_colour().to_string());

        let c = Connection {
            id: new_id(),
            name,
            host: input.host,
            port: input.port,
            user: input.user,
            dbname: input.dbname,
            sslmode: input.sslmode,
            tag: input.tag,
            colour,
            last_used_at: None,
            created_at: now(),
        };

        self.lock()
            .execute(
                "insert into connections
                   (id, name, host, port, \"user\", dbname, sslmode, tag,
                    colour, last_used_at, created_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, null, ?10)",
                params![
                    c.id,
                    c.name,
                    c.host,
                    c.port,
                    c.user,
                    c.dbname,
                    c.sslmode.as_str(),
                    c.tag.as_str(),
                    c.colour,
                    c.created_at,
                ],
            )
            .map_err(sql_err)?;

        Ok(c)
    }

    pub fn update_connection(&self, id: &str, input: ConnectionInput) -> Result<(), AppError> {
        let name = validate_name(&input.name)?;
        let colour = input
            .colour
            .clone()
            .unwrap_or_else(|| input.tag.default_colour().to_string());

        let changed = self
            .lock()
            .execute(
                "update connections
                 set name = ?2, host = ?3, port = ?4, \"user\" = ?5, dbname = ?6,
                     sslmode = ?7, tag = ?8, colour = ?9
                 where id = ?1",
                params![
                    id,
                    name,
                    input.host,
                    input.port,
                    input.user,
                    input.dbname,
                    input.sslmode.as_str(),
                    input.tag.as_str(),
                    colour,
                ],
            )
            .map_err(sql_err)?;

        if changed == 0 {
            return Err(AppError::Library(format!("no such connection: {id}")));
        }
        Ok(())
    }

    /// Delete the record and its Keychain entry.
    ///
    /// The credential is removed first: if that fails we stop, because
    /// deleting the row would orphan a password with no way to reach it
    /// from the UI again.
    pub fn delete_connection(&self, id: &str) -> Result<(), AppError> {
        crate::secrets::delete_password(id)?;

        self.lock()
            .execute("delete from connections where id = ?1", params![id])
            .map_err(sql_err)?;

        Ok(())
    }

    /// Stamp this connection as the most recently used one.
    pub fn touch_connection(&self, id: &str) -> Result<(), AppError> {
        self.lock()
            .execute(
                "update connections set last_used_at = ?2 where id = ?1",
                params![id, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Store a connection's password in the Keychain.
    ///
    /// Lives on `Store` so every credential write goes through the same
    /// place as the record itself, rather than being scattered across
    /// command handlers.
    pub fn save_connection_password(&self, id: &str, password: &str) -> Result<(), AppError> {
        crate::secrets::save_password(id, password)
    }
}

fn read_connection(row: &Row) -> rusqlite::Result<Connection> {
    let sslmode: String = row.get(6)?;
    let tag: String = row.get(7)?;

    Ok(Connection {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get(3)?,
        user: row.get(4)?,
        dbname: row.get(5)?,
        sslmode: SslMode::from_stored(&sslmode),
        tag: Tag::from_stored(&tag),
        colour: row.get(8)?,
        last_used_at: row.get(9)?,
        created_at: row.get(10)?,
    })
}
