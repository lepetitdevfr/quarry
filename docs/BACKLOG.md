# Backlog

Deferred work that is not yet assigned to a stage plan. Anything here is a
real commitment, not a maybe — it was consciously postponed, not dropped.

## Schema tree extras

**Deferred:** 2026-08-14, while designing the schema tree. Each was consciously
cut to keep that stage tight; none is hard once the tree exists.

- **Views and materialised views in the tree.** Excluded on purpose, but it
  means a view can be queried and never seen. The fix is one character in the
  `relkind` filter in `schema/introspect.rs` plus a marker in the UI.
- **Insert a qualified name at the cursor** from a tree row.
- **Copy `CREATE TABLE` DDL.** Postgres has no built-in DDL function, so this
  means assembling columns, defaults, keys, and indexes from the catalog —
  the introspection stage already gathers everything needed.

## Move a query between collections (UI only)

**Deferred:** 2026-08-14, end of Stage 2. Not urgent, but not forgotten.

The backend is already done and tested:

- `Store::move_query` (`src-tauri/src/library/store.rs`) reparents the row and
  relocates its `.sql` mirror file
- the `move_query` IPC command is registered in `src-tauri/src/commands.rs`
- `ipc.moveQuery` and `actions.moveQuery` exist on the frontend
- `moves_a_query_to_another_collection` covers it in `tests/library_test.rs`

Missing: any way to trigger it. There are no drag handlers anywhere in `src/`,
and no move affordance in `QueryTree.tsx`.

Why it slipped: the design spec calls for "drag to reorder/move", but the
Stage 2 plan only gave the tree tasks for rename, create, and delete. The store
work covered moving because it belonged there; the UI task was never written.

**Two options, in the order recommended:**

1. **"Move to…" in a row menu** — right-click or a `⋯` button listing
   collections. Small, keyboard-accessible, uses `actions.moveQuery` exactly as
   it stands today. No backend change needed.
2. **Drag and drop** — closer to the spec and to Insomnia. Drag a query onto a
   collection to move it, drag between rows to reorder. Needs drop targets and
   drag-over affordances, and **reordering needs new backend work**: today only
   the parent can change, so sibling `position` recalculation does not exist
   yet.

Do (1) first; do (2) together with the `position` work rather than rushing
both.

## Recover from a poisoned mutex instead of panicking

**Deferred:** 2026-08-14, raised while reading the Rust code.

Production code has ten `expect` calls. Three are startup fail-fast in
`lib.rs` and are correct as they are. The other seven are
`.expect("state lock poisoned")` on `Mutex` guards in `commands.rs` and
`store.rs`.

A mutex poisons only if a thread panics while holding it. These critical
sections are a `HashMap` insert or an `Option` swap, so it is unreachable in
practice — but if it ever happened, every later `connect`, `execute`, and
`disconnect` would panic too, leaving the app permanently dead with no error
shown.

The fix is one helper and seven call sites:

```rust
fn lock(&self) -> MutexGuard<'_, T> {
    self.inner.lock().unwrap_or_else(|e| e.into_inner())
}
```

The data behind the lock is structurally valid either way, so recovering beats
bricking. Not urgent; "unreachable in practice" is just the assumption that
ages badly as the code grows.

## Confirm no query data was lost — RESOLVED

**Raised:** 2026-08-14. **Closed:** 2026-08-15, no data loss.

During the Keychain debugging the workspace database showed `queries: 0` where
a saved query named "Widgets" had existed earlier in the session, and the
connection count dropped from two to one. The user has since confirmed they
made those deletions themselves while recreating connections. Nothing in the
v2→v3 migration touches `queries`, which matches. No investigation needed.

The WAL-safe backup at
`~/Library/Application Support/com.quarry.app/workspace-backup-20260814-182733.db`
can be deleted whenever convenient.

**Process note, still standing:** back up with `sqlite3 db ".backup out.db"`,
never `cp`. A plain copy of a WAL database captures a file with no tables in
it — which is exactly what happened on the first attempt that night.

## A migration test that passes without the migration

**Found:** 2026-08-15, in code review of the table-detail stage.

`adds_preview_columns_to_an_existing_tabs_table` in `src-tauri/src/library/db.rs`
builds its "old" database by calling `open()` — which creates `tabs` with
`is_preview` and `title` already in it, because they are in the
`create table if not exists` block. So `add_column_if_missing` never runs, and
the test passes with those calls deleted. It covers the fresh-database path
while claiming to cover the upgrade path.

The v4 test written this stage had the identical defect and was fixed by
building the old table with raw SQL instead. Apply the same fix here. The real
failure it should guard is a user's existing database lacking a column, which
makes every launch fail with `no such column`.

**Worth doing generally:** any future migration test must be checked by
deleting the migration and watching the test fail. A migration test that
passes without the migration is worse than no test.

## Tab storage cleanups

**Found:** 2026-08-15, in code review of the table-detail stage. All three
touch pre-existing code or are preference calls, so they were kept out of that
stage deliberately.

- **Read rows by column name, not index.** `tab_from_row` in
  `src-tauri/src/library/store.rs` reads eleven columns by position, and two
  `params!` lists bind `table` twice with `schema` between them — a swap
  compiles, runs, and silently mislabels a tab. `rusqlite`'s `Row::get` accepts
  a column name, and `named_params!` does the same for writes. `TAB_COLUMNS`
  names every column, so the names are guaranteed present. That removes the
  whole class of bug instead of testing for it.
- **A `TabPin` enum instead of `pin: bool`.** Call sites currently end in a
  bare `..., TableMode::Structure, false)` whose trailing bool means nothing
  without opening the signature. `Tag`, `SslMode`, and `TableMode` are all
  two-variant enums; `TabPin::{Preview, Pinned}` would match.
- **`activate` should be one statement.** It clears `is_active` on every tab
  and then sets it on one, so between the two autocommitted statements there is
  a durable state with no tab active — a crash there leaves it. The mutex
  prevents interleaving but not a crash, which is exactly the case `close_tab`
  wraps in a transaction and says so. One statement closes it for the whole
  family: `update tabs set is_active = (id = ?1)`. Blast radius is UI state,
  not saved queries, and clicking a tab recovers it.

## Split `store.rs` along the tabs seam

**Deferred:** 2026-08-15, raised in code review.

`store.rs` is ~700 lines holding four concerns: collections, queries, tabs, and
mirror-file side effects. Tabs is now the largest at roughly 200 lines, and it
is the part that keeps growing — recent stages add tab behaviour, not
collection behaviour.

The split is unusually cheap because half of it is already done: `lock()`,
`new_id()`, `sql_err()`, and `validate_name()` are `pub(crate)`, so moving the
tab methods into a second `impl Store` block in `library/store/tabs.rs` (making
`store.rs` into `store/mod.rs`) is a pure move — no signature changes, no
visibility churn.

Do it as the first task of whichever stage next grows the tab code, not inside
one: a 400-line move would bury that stage's actual diff.

## `cargo clippy` and `cargo fmt` do not pass at baseline

**Found:** 2026-08-15, confirmed at commit `6af8a67` by two independent
reviewers.

- **Clippy:** `cargo clippy --all-targets -- -D warnings` fails with two
  `dead_code` errors — `pub pool` and `pub port` in
  `src-tauri/tests/common/mod.rs` — which fail four test targets. Different
  test binaries use different fields of the shared harness struct, so the fix
  is probably `#[allow(dead_code)]` on it with a comment saying why.
- **Format:** the repo has never been rustfmt-formatted; 19 files differ at
  baseline. Running `cargo fmt` now would rewrite the tree and bury whatever
  stage is in flight.

Neither is urgent, but both mean "the checks pass" currently has an asterisk,
and every stage plan has to explain the asterisk. Best done alone, on its own
branch, between stages.

## Table detail extras

**Deferred:** 2026-08-15, while designing table detail tabs
(`specs/2026-08-15-table-detail-tabs-design.md`). Each needs a new catalog
query and a round-trip per table open, which the three shipped sections do
not.

- **Live table stats.** Estimated row count (`pg_class.reltuples`, which reads
  `-1` on a never-analyzed table), on-disk size (`pg_total_relation_size`), and
  table/column comments (`obj_description`/`col_description`).
- **Triggers and dependent views.** `pg_trigger` rows, plus the views that
  depend on this table via a `pg_depend` walk.
- **Copy `CREATE TABLE` DDL** (see above) belongs in this view once the
  assembly work is done.
