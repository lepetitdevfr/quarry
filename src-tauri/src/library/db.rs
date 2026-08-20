use crate::error::AppError;
use rusqlite::Connection;
use std::path::Path;

/// Bump this when the schema changes and add a migration step below.
pub const SCHEMA_VERSION: i64 = 5;

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
            id            text primary key,
            query_id      text references queries(id) on delete cascade,
            scratch_sql   text,
            position      integer not null,
            is_active     integer not null default 0,
            cursor_pos    integer not null default 0,
            is_preview    integer not null default 0,
            title         text,
            target_schema text,
            target_table  text,
            mode          text
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

        -- v5: work you ran or closed, so neither is lost. Two kinds of
        -- row in one table: a `run` is a statement the user executed, a
        -- `closed` is the unsaved text of a tab that was closed.
        create table if not exists recent (
            id            text primary key,
            kind          text not null,
            sql           text not null,
            connection_id text references connections(id) on delete set null,
            title         text,
            first_at      text not null,
            last_at       text not null,
            run_count     integer not null default 0,
            duration_ms   integer,
            row_count     integer,
            error         text
        );

        create index if not exists idx_collections_parent on collections(parent_id);
        create index if not exists idx_queries_collection on queries(collection_id);
        create index if not exists idx_tabs_position      on tabs(position);
        create index if not exists idx_connections_last_used on connections(last_used_at);
        -- Runs collapse on identical SQL against the same connection;
        -- this index is what makes that one statement rather than a
        -- read-then-write race. Closed rows are outside it deliberately:
        -- two drafts that read alike are two pieces of work.
        create unique index if not exists idx_recent_run
            on recent(sql, connection_id) where kind = 'run';
        create index if not exists idx_recent_last_at on recent(last_at);
        ",
    )
    .map_err(|e| AppError::Library(e.to_string()))?;

    // `create table if not exists` leaves an existing table alone, so a
    // database created before version 3 still lacks these columns. SQLite
    // has no `add column if not exists`, and re-adding one is an error
    // rather than a no-op — so ask first.
    add_column_if_missing(conn, "tabs", "is_preview", "integer not null default 0")?;
    add_column_if_missing(conn, "tabs", "title", "text")?;

    // v4: a tab may target a table instead of a query. Two columns
    // rather than one qualified string, because a Postgres identifier
    // may contain a dot and could not be split back apart reliably.
    add_column_if_missing(conn, "tabs", "target_schema", "text")?;
    add_column_if_missing(conn, "tabs", "target_table", "text")?;
    add_column_if_missing(conn, "tabs", "mode", "text")?;

    // Preview tabs are transient. Purging them here rather than filtering
    // them on restore means a crash cannot leave one behind.
    conn.execute("delete from tabs where is_preview = 1", [])
        .map_err(|e| AppError::Library(e.to_string()))?;

    conn.execute(
        "insert into meta (key, value) values ('schema_version', ?1)
         on conflict(key) do update set value = excluded.value",
        [SCHEMA_VERSION.to_string()],
    )
    .map_err(|e| AppError::Library(e.to_string()))?;

    Ok(())
}

/// Add a column unless the table already has it.
///
/// SQLite has no `add column if not exists`, and adding a duplicate is a
/// hard error, so the column list has to be read first.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), AppError> {
    let mut stmt = conn
        .prepare(&format!("pragma table_info({table})"))
        .map_err(|e| AppError::Library(e.to_string()))?;

    let existing: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| AppError::Library(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Library(e.to_string()))?;

    if existing.iter().any(|c| c == column) {
        return Ok(());
    }

    conn.execute(
        &format!("alter table {table} add column {column} {definition}"),
        [],
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
            .query_row(
                "select value from meta where key='schema_version'",
                [],
                |r| r.get::<_, String>(0),
            )
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

        conn.execute("delete from collections where id='c1'", [])
            .unwrap();

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
    fn adds_preview_columns_to_an_existing_tabs_table() {
        // The user has a real database on disk with tabs in it. Adding a
        // column to an existing table is exactly where a migration can
        // cost someone their work, so this proves both halves: the new
        // columns exist, and the old rows are still there.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("w.db");

        {
            // The v2 tabs table exactly as it shipped, built with raw
            // SQL. Going through open() would create `is_preview` and
            // `title` from the `create table if not exists` block, so
            // `add_column_if_missing` would find them already present
            // and never run — the test would then cover the
            // fresh-database path while claiming to cover the upgrade.
            // It did exactly that until 2026-08-16, and passed with both
            // migration calls deleted.
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "create table tabs (
                    id          text primary key,
                    query_id    text,
                    scratch_sql text,
                    position    integer not null,
                    is_active   integer not null default 0,
                    cursor_pos  integer not null default 0
                 );
                 insert into tabs (id, query_id, scratch_sql, position, is_active, cursor_pos)
                 values ('t1', null, 'select 1', 100, 1, 0);",
            )
            .unwrap();
        }

        // The real upgrade.
        let conn = open(&path).unwrap();

        let sql: String = conn
            .query_row("select scratch_sql from tabs where id = 't1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            sql, "select 1",
            "an existing tab must survive the migration"
        );

        let is_preview: i64 = conn
            .query_row("select is_preview from tabs where id = 't1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(is_preview, 0, "existing tabs default to not-preview");

        let title: Option<String> = conn
            .query_row("select title from tabs where id = 't1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, None);
    }

    #[test]
    fn adds_table_target_columns_to_an_existing_tabs_table() {
        // A real database on disk, with a real tab in it. This is exactly
        // where a migration can cost someone their work: prove both that
        // the columns arrive and that the old row is untouched.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("w.db");

        {
            // The v3 tabs table exactly as it shipped, built with raw SQL:
            // going through open() would create the new columns for us and
            // the migration under test would never run.
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "create table tabs (
                    id          text primary key,
                    query_id    text,
                    scratch_sql text,
                    position    integer not null,
                    is_active   integer not null default 0,
                    cursor_pos  integer not null default 0,
                    is_preview  integer not null default 0,
                    title       text
                 );
                 insert into tabs (id, query_id, scratch_sql, position, is_active, cursor_pos)
                 values ('t1', null, 'select 1', 100, 1, 0);",
            )
            .unwrap();
        }

        // The real upgrade.
        let conn = open(&path).unwrap();

        let sql: String = conn
            .query_row("select scratch_sql from tabs where id = 't1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            sql, "select 1",
            "an existing tab must survive the migration"
        );

        let target_schema: Option<String> = conn
            .query_row("select target_schema from tabs where id = 't1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let target_table: Option<String> = conn
            .query_row("select target_table from tabs where id = 't1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let mode: Option<String> = conn
            .query_row("select mode from tabs where id = 't1'", [], |r| r.get(0))
            .unwrap();

        assert_eq!(target_schema, None, "an existing tab targets no table");
        assert_eq!(target_table, None);
        assert_eq!(mode, None);
    }

    #[test]
    fn purges_preview_tabs_when_the_database_is_opened() {
        // Previews are transient. Deleting them at open time is simpler
        // and more robust than filtering them on restore: a crash cannot
        // leave one behind.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("w.db");

        {
            let conn = open(&path).unwrap();
            conn.execute(
                "insert into tabs (id, query_id, scratch_sql, position, is_active, cursor_pos, is_preview, title)
                 values ('keep', null, 'select 1', 100, 0, 0, 0, null),
                        ('gone', null, 'select 2', 200, 1, 0, 1, 'users')",
                [],
            )
            .unwrap();
        }

        let conn = open(&path).unwrap();

        let remaining: Vec<String> = conn
            .prepare("select id from tabs order by id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(remaining, vec!["keep"], "the preview tab must be gone");
    }

    #[test]
    fn upgrading_a_v4_database_adds_recent_and_keeps_existing_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v4.db");

        // A v4 database: everything the app had before history existed.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "create table tabs (
                    id          text primary key,
                    query_id    text,
                    scratch_sql text,
                    position    integer not null,
                    is_active   integer not null default 0,
                    cursor_pos  integer not null default 0
                 );
                 insert into tabs (id, query_id, scratch_sql, position, is_active, cursor_pos)
                 values ('t1', null, 'select 1', 100, 1, 0);",
            )
            .unwrap();
        }

        let conn = open(&path).unwrap();

        let sql: String = conn
            .query_row("select scratch_sql from tabs where id = 't1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            sql, "select 1",
            "an existing tab must survive the migration"
        );

        // The new table exists and takes a row.
        conn.execute(
            "insert into recent (id, kind, sql, first_at, last_at, run_count)
             values ('r1', 'run', 'select 2', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', 1)",
            [],
        )
        .unwrap();

        let version: i64 = conn
            .query_row(
                "select value from meta where key = 'schema_version'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(version, 5);
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
            conn.execute(
                "update meta set value = '1' where key = 'schema_version'",
                [],
            )
            .unwrap();
        }

        // Reopening runs migrate() again, as a version upgrade would.
        let conn = open(&path).unwrap();

        let name: String = conn
            .query_row("select name from queries where id = 'q1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "keeper");

        let version: String = conn
            .query_row(
                "select value from meta where key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // The current version, whatever it is: this test is about the
        // saved query surviving, not about which version is latest.
        assert_eq!(version, SCHEMA_VERSION.to_string());
    }
}
