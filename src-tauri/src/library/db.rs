use crate::error::AppError;
use rusqlite::Connection;
use std::path::Path;

/// Bump this when the schema changes and add a migration step below.
pub const SCHEMA_VERSION: i64 = 2;

/// Open the database, creating and migrating it if needed.
///
/// Foreign keys are OFF by default in SQLite and must be enabled per
/// connection — without this, deleting a collection would silently
/// orphan its queries instead of removing them.
pub fn open(path: &Path) -> Result<Connection, AppError> {
    let conn = Connection::open(path).map_err(|e| AppError::Library(e.to_string()))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| AppError::Library(e.to_string()))?;
    // WAL lets a read proceed while a write is in flight, which keeps
    // the UI responsive during autosave.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| AppError::Library(e.to_string()))?;

    migrate(&conn)?;
    Ok(conn)
}

/// Apply the schema. Every statement is `if not exists`, so running
/// this on an already-migrated database is a no-op.
fn migrate(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "
        create table if not exists meta (
            key   text primary key,
            value text not null
        );

        create table if not exists collections (
            id         text primary key,
            parent_id  text references collections(id) on delete cascade,
            name       text not null,
            position   integer not null,
            created_at text not null
        );

        create table if not exists queries (
            id            text primary key,
            collection_id text references collections(id) on delete cascade,
            name          text not null,
            sql           text not null,
            draft_sql     text,
            position      integer not null,
            created_at    text not null,
            updated_at    text not null
        );

        create table if not exists tabs (
            id          text primary key,
            query_id    text references queries(id) on delete cascade,
            scratch_sql text,
            position    integer not null,
            is_active   integer not null default 0,
            cursor_pos  integer not null default 0
        );

        create table if not exists connections (
            id           text primary key,
            name         text not null,
            host         text not null,
            port         integer not null,
            \"user\"       text not null,
            dbname       text not null,
            sslmode      text not null,
            tag          text not null,
            colour       text not null,
            last_used_at text,
            created_at   text not null
        );

        create index if not exists idx_collections_parent on collections(parent_id);
        create index if not exists idx_queries_collection on queries(collection_id);
        create index if not exists idx_tabs_position      on tabs(position);
        create index if not exists idx_connections_last_used on connections(last_used_at);
        ",
    )
    .map_err(|e| AppError::Library(e.to_string()))?;

    conn.execute(
        "insert into meta (key, value) values ('schema_version', ?1)
         on conflict(key) do update set value = excluded.value",
        [SCHEMA_VERSION.to_string()],
    )
    .map_err(|e| AppError::Library(e.to_string()))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_the_schema_on_a_fresh_database() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("test.db")).unwrap();

        let tables: Vec<String> = conn
            .prepare("select name from sqlite_master where type='table' order by name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert!(tables.contains(&"collections".to_string()));
        assert!(tables.contains(&"queries".to_string()));
        assert!(tables.contains(&"tabs".to_string()));
        assert!(tables.contains(&"meta".to_string()));
    }

    #[test]
    fn migrating_twice_is_harmless() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");

        let first = open(&path).unwrap();
        drop(first);
        // Reopening runs migration again; it must not error or wipe data.
        let second = open(&path).unwrap();

        let version: i64 = second
            .query_row("select value from meta where key='schema_version'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn enforces_foreign_keys() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("test.db")).unwrap();

        // Inserting a query under a collection that does not exist must
        // fail; otherwise deletes leave orphans behind.
        let result = conn.execute(
            "insert into queries (id, collection_id, name, sql, position, created_at, updated_at)
             values ('q1', 'nope', 'n', 's', 100, 'now', 'now')",
            [],
        );
        assert!(result.is_err(), "foreign keys should be enforced");
    }

    #[test]
    fn deleting_a_collection_cascades_to_its_queries() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("test.db")).unwrap();

        conn.execute(
            "insert into collections (id, parent_id, name, position, created_at)
             values ('c1', null, 'Billing', 100, 'now')",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into queries (id, collection_id, name, sql, position, created_at, updated_at)
             values ('q1', 'c1', 'mrr', 'select 1', 100, 'now', 'now')",
            [],
        )
        .unwrap();

        conn.execute("delete from collections where id='c1'", []).unwrap();

        let remaining: i64 = conn
            .query_row("select count(*) from queries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "queries should cascade with their collection");
    }

    #[test]
    fn creates_the_connections_table() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("w.db")).unwrap();

        let count: i64 = conn
            .query_row(
                "select count(*) from sqlite_master
                 where type = 'table' and name = 'connections'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(count, 1);
    }

    #[test]
    fn upgrading_a_v1_database_keeps_existing_rows() {
        // The developer has a real library on disk. Adding a table must
        // never cost them their saved queries.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("w.db");

        {
            let conn = open(&path).unwrap();
            conn.execute(
                "insert into queries (id, collection_id, name, sql, draft_sql,
                                      position, created_at, updated_at)
                 values ('q1', null, 'keeper', 'select 1', null, 100, 'now', 'now')",
                [],
            )
            .unwrap();
            conn.execute("update meta set value = '1' where key = 'schema_version'", [])
                .unwrap();
        }

        // Reopening runs migrate() again, as a version upgrade would.
        let conn = open(&path).unwrap();

        let name: String = conn
            .query_row("select name from queries where id = 'q1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "keeper");

        let version: String = conn
            .query_row("select value from meta where key = 'schema_version'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(version, "2");
    }
}
