use crate::error::AppError;
use rusqlite::Connection;
use std::path::Path;

/// The schema every database is brought up to before any versioned step
/// runs. It is the schema as it stood at version 7, written so that
/// applying it to a database at any earlier version — or to one that
/// already has it — converges on the same result.
///
/// Nothing new goes in here. New schema changes are steps in
/// [`MIGRATIONS`]; the baseline exists only to give the databases that
/// shipped before versioning a floor to start from.
const BASELINE_VERSION: i64 = 7;

/// The schema changes made since the baseline, in order. Index 0 is the
/// step that takes a database from [`BASELINE_VERSION`] to the next
/// version, so index `i` produces version `BASELINE_VERSION + i + 1`.
///
/// To change the schema, append one entry. Never edit or remove an
/// entry that has shipped: someone's database has already run it, and
/// the only record of what it did is the text itself.
///
/// Unlike the baseline, a step is applied exactly once and so does not
/// need to be idempotent. That is the point of versioning them — it is
/// what lets a step drop a column, backfill a value, or tighten a
/// constraint, none of which can be expressed as `if not exists`.
const MIGRATIONS: &[&str] = &[];

/// The version a database is at once every step has run.
pub const SCHEMA_VERSION: i64 = BASELINE_VERSION + MIGRATIONS.len() as i64;

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
    tidy_up_tabs(&conn)?;
    Ok(conn)
}

/// What opening a database at `current` has to do to bring it up to
/// date, given how many steps exist past the baseline.
#[derive(Debug, PartialEq, Eq)]
struct Plan {
    /// Whether the baseline has to be applied first.
    baseline: bool,
    /// The indices into the step list still to run, in order.
    steps: std::ops::Range<usize>,
}

/// Decide which work an open has left to do.
///
/// Split out from the statements themselves because this is the part
/// that can be wrong in a way no schema will catch: run a step twice and
/// it fails or double-applies, skip one and the column never arrives.
fn plan(current: i64, steps: usize) -> Result<Plan, AppError> {
    let target = BASELINE_VERSION + steps as i64;

    // A database written by a newer build. Its extra columns are
    // invisible to this one and its constraints are not ours to guess
    // at, so opening it read-write would corrupt work we cannot see.
    if current > target {
        return Err(AppError::Library(format!(
            "this library was created by a newer version of Quarry \
             (database schema {current}, this build understands {target}). \
             Update Quarry to open it."
        )));
    }

    // Everything that shipped before versioning reports version 0,
    // whatever its schema actually is: `user_version` was never set.
    // The baseline is idempotent precisely so that this one branch can
    // serve all of them — a database from v1 and a database from v7
    // both come out of it at v7, and neither loses a row.
    let baseline = current < BASELINE_VERSION;
    let applied = current.max(BASELINE_VERSION);

    Ok(Plan {
        baseline,
        steps: (applied - BASELINE_VERSION) as usize..steps,
    })
}

/// Bring the database up to [`SCHEMA_VERSION`].
///
/// The version lives in SQLite's own `user_version` header field rather
/// than in a table of ours, so that the stamp commits in the same
/// transaction as the statements it describes. A crash mid-migration
/// therefore leaves the database at the last version that fully
/// applied, never at a version whose changes only half-arrived.
fn migrate(conn: &Connection) -> Result<(), AppError> {
    migrate_with(conn, MIGRATIONS)
}

/// The body of [`migrate`], with the step list as a parameter so that a
/// test can supply its own. With `MIGRATIONS` empty there is otherwise
/// no way to prove a step runs once and only once, which is the whole
/// reason the versions exist.
fn migrate_with(conn: &Connection, migrations: &[&str]) -> Result<(), AppError> {
    let current: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| AppError::Library(e.to_string()))?;

    let plan = plan(current, migrations.len())?;
    let target = BASELINE_VERSION + migrations.len() as i64;

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::Library(e.to_string()))?;

    if plan.baseline {
        apply_baseline(&tx)?;
        tx.pragma_update(None, "user_version", BASELINE_VERSION)
            .map_err(|e| AppError::Library(e.to_string()))?;
    }

    for i in plan.steps {
        tx.execute_batch(migrations[i])
            .map_err(|e| AppError::Library(e.to_string()))?;
        tx.pragma_update(None, "user_version", BASELINE_VERSION + i as i64 + 1)
            .map_err(|e| AppError::Library(e.to_string()))?;
    }

    // `meta.schema_version` is no longer what decides anything — it is
    // written so that a build from before this change can still read a
    // version out of a database this one has touched.
    tx.execute(
        "insert into meta (key, value) values ('schema_version', ?1)
         on conflict(key) do update set value = excluded.value",
        [target.to_string()],
    )
    .map_err(|e| AppError::Library(e.to_string()))?;

    tx.commit().map_err(|e| AppError::Library(e.to_string()))?;
    Ok(())
}

/// Apply the version 7 schema to a database at any earlier version.
///
/// Every statement is `if not exists` and every column is added only
/// after checking, so running this on a database that already has some
/// or all of it is a no-op.
fn apply_baseline(conn: &Connection) -> Result<(), AppError> {
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
            mode          text,
            record        text
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

        -- v6: what this app wrote, and how it ended. Deliberately not a
        -- kind of row in `recent`, which exists to find a query again and
        -- so collapses repeats and allows deletion. Both are wrong here,
        -- where every occurrence is a separate fact and forgetting one
        -- defeats the point of keeping it.
        create table if not exists writes (
            id              text primary key,
            at              text not null,
            connection_id   text references connections(id) on delete set null,
            -- Copied rather than joined: the row must still say which
            -- database it hit after that connection is renamed or
            -- deleted. An audit line that loses its subject is not one.
            connection_name text not null,
            tag             text not null,
            sql             text not null,
            kind            text not null,
            row_count       integer,
            outcome         text not null,
            reason          text,
            undo_sql        text
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
        create index if not exists idx_writes_at on writes(at);
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

    // v7: a tab may show one of the app's own records — `history` or
    // `writes` — instead of a query or a table. They outgrew the
    // sidebar: a statement is a line of SQL and the sidebar is 250px,
    // so the list that exists to be read was the one that could not be.
    add_column_if_missing(conn, "tabs", "record", "text")?;

    Ok(())
}

/// Housekeeping at open time. Not a migration: it runs on every launch
/// and depends on what the last session left behind, not on which
/// schema version the database is at.
fn tidy_up_tabs(conn: &Connection) -> Result<(), AppError> {
    // Preview tabs are transient. Purging them here rather than filtering
    // them on restore means a crash cannot leave one behind.
    conn.execute("delete from tabs where is_preview = 1", [])
        .map_err(|e| AppError::Library(e.to_string()))?;

    // The purge can take the active tab with it — you were last looking
    // at a table preview — and a session that restores with tabs but
    // none of them active opens onto an empty editor belonging to
    // nothing. Adopt the leftmost tab instead.
    conn.execute(
        "update tabs set is_active = 1
         where id = (select id from tabs order by position limit 1)
           and not exists (select 1 from tabs where is_active = 1)",
        [],
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
    fn opening_adopts_the_first_tab_when_the_purge_took_the_active_one() {
        // You quit while looking at a table preview. The preview is
        // transient and goes; without this, the session restores with
        // tabs and no active one, which opens onto an empty editor that
        // belongs to nothing.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("w.db");

        {
            let conn = open(&path).unwrap();
            conn.execute_batch(
                "insert into tabs (id, query_id, scratch_sql, position, is_active, is_preview)
                 values ('keeper', null, 'select 1', 100, 0, 0),
                        ('gone',   null, 'select 2', 200, 1, 1);",
            )
            .unwrap();
        }

        let conn = open(&path).unwrap();

        let active: Vec<String> = conn
            .prepare("select id from tabs where is_active = 1")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(active, vec!["keeper".to_string()]);
    }

    #[test]
    fn opening_does_not_move_an_active_tab_that_survived() {
        // Restoring where you left off is the point. Only an absent
        // active tab is adopted, never a present one.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("w.db");

        {
            let conn = open(&path).unwrap();
            conn.execute_batch(
                "insert into tabs (id, query_id, scratch_sql, position, is_active, is_preview)
                 values ('first',  null, 'select 1', 100, 0, 0),
                        ('second', null, 'select 2', 200, 1, 0);",
            )
            .unwrap();
        }

        let conn = open(&path).unwrap();

        let active: Vec<String> = conn
            .prepare("select id from tabs where is_active = 1")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(active, vec!["second".to_string()]);
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
    fn upgrading_a_v5_database_adds_writes_and_keeps_existing_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v5.db");

        // A v5 database with history in it: the audit log must arrive
        // without costing anybody their recorded work.
        {
            let conn = open(&path).unwrap();
            conn.execute(
                "insert into recent (id, kind, sql, first_at, last_at, run_count)
                 values ('r1', 'run', 'select 1', '2026-08-20T00:00:00Z',
                         '2026-08-20T00:00:00Z', 1)",
                [],
            )
            .unwrap();
            // Whatever this build created, take the audit table away
            // again: what is being tested is the upgrade of a database
            // that never had one.
            conn.execute("drop table if exists writes", []).unwrap();
            // And put it back to what a v5 database on disk actually
            // looks like. Every database that shipped before versioning
            // reports `user_version` 0 — leaving the stamp this build
            // just wrote would make the next open skip the baseline and
            // test nothing.
            conn.pragma_update(None, "user_version", 0).unwrap();
            conn.execute(
                "update meta set value = '5' where key = 'schema_version'",
                [],
            )
            .unwrap();
        }

        let conn = open(&path).unwrap();

        let kept: i64 = conn
            .query_row("select count(*) from recent", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "history must survive the migration");

        conn.execute(
            "insert into writes
                (id, at, connection_name, tag, sql, kind, outcome)
             values ('w1', '2026-08-21T00:00:00Z', 'smoke', 'local',
                     'delete from t', 'delete', 'committed')",
            [],
        )
        .unwrap();

        let version: String = conn
            .query_row(
                "select value from meta where key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // The current version, whatever it is. A migration test is
        // about the new table arriving and the old rows surviving; it
        // has no business knowing which version happens to be latest,
        // and pinning the number here has broken this suite on every
        // bump since.
        assert_eq!(version, SCHEMA_VERSION.to_string());
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
        // The current version, whatever it is: this test is about the
        // recent table arriving and the tab surviving, not about which
        // version happens to be latest.
        assert_eq!(version, SCHEMA_VERSION);
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

    #[test]
    fn plans_the_baseline_for_a_database_from_before_versioning() {
        // Everything that shipped before this change reports 0, whatever
        // schema it actually has.
        assert_eq!(
            plan(0, 0).unwrap(),
            Plan {
                baseline: true,
                steps: 0..0
            }
        );
        // A v5 database still has to run every step past the baseline.
        assert_eq!(
            plan(5, 2).unwrap(),
            Plan {
                baseline: true,
                steps: 0..2
            }
        );
    }

    #[test]
    fn plans_no_baseline_once_it_has_been_stamped() {
        // The baseline is the expensive part — a full DDL batch and a
        // pragma per column. Once stamped it must never run again.
        assert_eq!(
            plan(BASELINE_VERSION, 2).unwrap(),
            Plan {
                baseline: false,
                steps: 0..2
            }
        );
    }

    #[test]
    fn plans_only_the_steps_not_yet_applied() {
        // Half-migrated: one step in, two to go.
        assert_eq!(
            plan(BASELINE_VERSION + 1, 3).unwrap(),
            Plan {
                baseline: false,
                steps: 1..3
            }
        );
    }

    #[test]
    fn plans_nothing_for_an_up_to_date_database() {
        let up_to_date = plan(BASELINE_VERSION + 2, 2).unwrap();
        assert!(!up_to_date.baseline);
        assert!(up_to_date.steps.is_empty(), "nothing left to run");
    }

    #[test]
    fn plans_refuse_a_database_from_a_newer_build() {
        // Its extra columns are invisible to this build and its
        // constraints are not ours to guess at. Opening it read-write
        // would corrupt work we cannot see.
        let err = plan(BASELINE_VERSION + 3, 1).unwrap_err();
        let AppError::Library(message) = err else {
            panic!("expected a library error");
        };
        assert!(
            message.contains("newer version"),
            "the message must say why: {message}"
        );
    }

    #[test]
    fn opening_refuses_a_database_from_a_newer_build() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("future.db");

        {
            let conn = open(&path).unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
                .unwrap();
        }

        assert!(
            open(&path).is_err(),
            "a database from a newer build must not be opened"
        );
    }

    #[test]
    fn a_fresh_database_is_stamped_with_the_current_version() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("fresh.db")).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        // The current version, whatever it is: pinning the number here
        // would break the suite on the next bump.
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn a_database_from_before_versioning_is_stamped_after_the_baseline() {
        // The bridge every existing installation crosses exactly once:
        // a real schema on disk with no stamp on it.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("unstamped.db");

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
            let version: i64 = conn
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .unwrap();
            assert_eq!(version, 0, "the fixture must be unstamped");
        }

        let conn = open(&path).unwrap();

        let sql: String = conn
            .query_row("select scratch_sql from tabs where id = 't1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(sql, "select 1", "the existing tab must survive");

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn a_step_runs_once_however_often_the_database_is_opened() {
        // The property the whole change exists for. `MIGRATIONS` is
        // empty, so the step list is supplied here: a step that is not
        // idempotent, which is exactly the kind the old converged
        // schema could not express.
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("stepped.db")).unwrap();

        let steps: &[&str] = &[
            "create table sample (id integer primary key, n integer not null);
             insert into sample (id, n) values (1, 1);",
        ];

        migrate_with(&conn, steps).unwrap();
        migrate_with(&conn, steps).unwrap();
        migrate_with(&conn, steps).unwrap();

        let rows: i64 = conn
            .query_row("select count(*) from sample", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "the step must have been applied exactly once");

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, BASELINE_VERSION + 1);
    }

    #[test]
    fn a_failing_step_leaves_the_database_where_it_was() {
        // A crash or a bad statement partway through must not leave a
        // database at a version whose changes only half-arrived. One
        // transaction covers the statements and the stamp together.
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("failing.db")).unwrap();

        let steps: &[&str] = &[
            "create table good (id integer primary key);",
            "this is not sql;",
        ];

        assert!(migrate_with(&conn, steps).is_err());

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(
            version, BASELINE_VERSION,
            "the version must not advance past what applied"
        );

        let tables: i64 = conn
            .query_row(
                "select count(*) from sqlite_master where type='table' and name='good'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0, "the successful step must have rolled back too");
    }
}
