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
