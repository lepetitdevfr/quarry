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

## Recover from a poisoned mutex instead of panicking — RESOLVED

**Deferred:** 2026-08-14. **Closed:** 2026-08-16.

The seven `.expect("state lock poisoned")` calls are gone. `AppState` gained
`active()` and `schema()` accessors and `Store::lock` recovers, all three via
`unwrap_or_else(|e| e.into_inner())`: the data behind these locks is a
`HashMap` insert, an `Option` swap or a SQLite connection, structurally valid
either way, so recovering beats bricking every later call.

Proven rather than assumed — `a_poisoned_library_lock_still_serves_the_next_caller`
poisons the lock from a panicking thread and then reads the library. Restoring
the `expect` makes it fail with `library lock poisoned: PoisonError { .. }`.

The three remaining `expect` calls are the startup fail-fast in `lib.rs`, which
this entry always said were correct as they are.


## CI cannot run the integration tests — RESOLVED

**Found:** 2026-08-16, when the first CI run failed. **Closed:** the same
day, by the cross-platform port below.

`secrets.rs` moved from `security-framework` to the `keyring` crate and
`menu.rs` gained the codebase's only `cfg(target_os)`, so the crate compiles
on Linux. CI now runs two Rust jobs: Ubuntu runs the whole suite, database
tests included, because Docker is there; macOS runs clippy, fmt, the unit
tests and a build, because it is the platform users run and the only one that
compiles the Keychain branch.


## Windows and Linux builds

**Assessed:** 2026-08-15. **Code port done:** 2026-08-16 — see
`plans/2026-08-16-cross-platform.md`. What is left is distribution, not
compilation.

The crate now builds off macOS: `keyring` covers macOS Keychain, Windows
Credential Manager and Linux keyutils behind the same three functions, and
the only `cfg(target_os)` in the codebase is the macOS menu in `menu.rs`.
**Keep it that way** — this entry exists to keep the constraint visible.

Remaining, in order of cost:

1. **Real-machine testing.** The Windows and Linux credential backends have
   never been run, only compiled. `keyring`'s Linux feature here is
   `linux-native` (kernel keyutils) rather than Secret Service, chosen
   because a headless CI runner has no D-Bus session — a desktop Linux user
   may want the opposite, and that is a one-line change in `Cargo.toml`.
2. **Fonts.** Six `-apple-system` / `SF Pro` / `SF Mono` references in
   `App.css` need fallbacks.
3. **Shortcut labels.** Both `metaKey` uses are already `metaKey || ctrlKey`;
   this is showing "Ctrl+S" rather than "⌘S".
4. **CI, signing and installers.** The largest item and mostly money: a
   runner per platform, an Authenticode certificate for Windows, AppImage or
   `.deb` for Linux.


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

## Row editing extras

**Deferred:** 2026-08-16, while designing inline row editing
(`specs/2026-08-16-inline-row-editing-design.md`). The machinery all three need
— identity from `table_oid`, generated SQL, the transaction with its rowcount
assert — now exists, so each is much cheaper than it would have been before.


- **Inserting an empty string into a text column.** Committing an empty
  input returns an insert cell to *untouched*, which is what makes "give me
  the default back" possible without another chord — so `''` and untouched
  are the same gesture and an empty string cannot be inserted from the grid.
  Accepted deliberately in §5 of the insert spec. Rare, and the workaround
  is one hand-written `INSERT`. A fix would need a second gesture, and the
  chord space around `⌘⌫` is already crowded.
- **A stored generated column is still offered as editable.**
  `decide_editability` marks any resolved non-key column `editable: true`, so
  a `GENERATED ALWAYS AS (…) STORED` column opens an editor and then fails at
  the server with `column "shout" can only be updated to DEFAULT`.
  Pre-existing — the catalog metadata to know better did not exist until the
  insert stage added it — and now a one-line fix: reuse the `is_generated`
  helper in the per-column *edit* verdict the way the insert verdict already
  does. Left out of the insert stage to keep that diff to inserting.
- **A modal insert form for wide tables.** A form with one labelled field per
  column is honestly easier to fill than a horizontally scrolled grid row.
  Rejected for v1 in §12 of the insert spec because it is a second editing
  surface with its own staging and validation. Revisit if filling rows in the
  grid turns out to hurt in practice.
- **Foreign-key value suggestions, and choices from a `CHECK` constraint.**
  The enum and boolean selectors come free from the driver's type metadata. A
  foreign key would need a lookup against another table, and a
  `check (x in (…))` would need constraint-expression parsing — the thing the
  editing design refuses to do. Both are real features, not fields.
- **Editing a primary key.** Mechanically fine — the `WHERE` uses the original
  value — but excluded from v1 because it is rare and it is the one edit that
  can orphan a foreign key silently.
- **Optimistic concurrency.** Today the last write wins: a concurrent change to
  the same cell is overwritten without warning. Checking original values in the
  `WHERE` was rejected because the `json` type has no equality operator, so it
  would need a per-type carve-out that gives some columns weaker guarantees than
  others. A row version or `xmin` check would avoid that and is the better shape
  if this ever becomes a real problem.
- **A bigint key past 2^53.** Key values reach the frontend as JSON numbers and
  go back as text, so an `int8` key above 9,007,199,254,740,992 would round-trip
  wrong. The grid already displays such a value wrong today, so this is
  pre-existing rather than new — but editing is where it would do damage rather
  than merely mislead.


## An unidentified flake in the Rust suite

**Seen once:** 2026-08-16, during the migration-test fix. One full
`cargo test` reported `203 passed, 1 failed` where every run either side
reported `209 passed, 0 failed`. Four consecutive runs since have been
clean.

The failing test's name was lost — the run was filtered through `awk` for
counts only, so the failure line was never captured. That is the real
mistake worth not repeating: **capture full output to a file when running
the suite, and grep the file**, rather than piping the run itself through
a filter.

Note the arithmetic: 203 + 1 = 204, five short of 209. So five tests did
not report at all, which points at a test binary dying rather than an
assertion failing — consistent with a testcontainers container failing to
start under parallel load, since several binaries each boot their own
Postgres simultaneously. That is a hypothesis, not a diagnosis.

Not chased further because it has not recurred. If it comes back, the
first move is `cargo test 2>&1 | tee /tmp/run.txt` and reading the file.
