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

## A migration test that passes without the migration — RESOLVED

**Found:** 2026-08-15, in code review of the table-detail stage.
**Closed:** 2026-08-16.

The defect was reproduced before being fixed — with both
`add_column_if_missing` calls for `is_preview` and `title` deleted, the
test still passed. It now builds the v2 `tabs` table with raw SQL, the
way the v4 test does, and fails when those calls are removed
(`panicked at src/library/db.rs:292` — `no such column: is_preview`).

The original entry follows.

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

## `cargo clippy` and `cargo fmt` do not pass at baseline — RESOLVED

**Found:** 2026-08-15, confirmed at commit `6af8a67` by two independent
reviewers. **Closed:** 2026-08-16, on its own branch between stages, as
this entry recommended.

Both commands now exit 0, so "the checks pass" no longer carries a
footnote and stage plans no longer have to tell implementers to skip
them. Add them to the check list for future stages:

```bash
cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

- **Clippy** needed `#[allow(dead_code)]` on `TestDb` and on `config_for`
  in `src-tauri/tests/common/mod.rs`, each with a comment. It was three
  items rather than the two guessed below, and six test targets rather
  than four.
- **Format** was 111 diffs across 26 files, not 19 files. Done as a
  single formatting-only commit (`e60dab1`); 209 tests pass either side
  of it.

The original entry follows.

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

## Windows and Linux support

**Assessed:** 2026-08-15, by measuring the codebase rather than estimating.
Out of scope for v1 by the original design spec, but cheaper than expected —
**and it stays cheap only while nothing else reaches for a platform API
directly.** That is the reason this entry exists: to keep the constraint
visible, not because the work is scheduled.

**One file is genuinely macOS-only.** `security-framework` is the single
platform crate, used in `src-tauri/src/secrets.rs` and nowhere else, behind a
three-function interface — `save_password`, `load_password`,
`delete_password`. There are **zero `cfg(target_os)` guards in the codebase**;
nothing else ever needed one.

Already portable: `dirs::data_dir()` for paths, `rusqlite` with `bundled`,
`rustls` + `webpki-roots` (no system TLS), the `.ico` and Windows `Square*`
icons that `tauri icon` already emits, `"targets": "all"` in
`tauri.conf.json`, and a window config carrying nothing but title and size.

**The work, in order of cost:**

1. **Keychain → the `keyring` crate**, which wraps macOS Keychain, Windows
   Credential Manager and Linux Secret Service behind one API. The three
   signatures stay identical, so `commands.rs` and every test are untouched.
   The subtlety is error semantics: `secrets.rs` distinguishes
   `errSecItemNotFound` (→ `Ok(None)`) from `errSecAuthFailed` (→ "enter the
   password again to re-save it"). Those codes are macOS-specific and each
   platform needs its equivalents mapped. The existing tests pin the
   behaviour that matters.
2. **Keyboard shortcuts.** Only two `metaKey` uses, both already
   `metaKey || ctrlKey`, and CodeMirror's `Mod-` handles the rest. Mostly a
   labelling question — showing "Ctrl+S" rather than "⌘S".
3. **Fonts.** Six references to `-apple-system` / `SF Pro` / `SF Mono` in
   `App.css`. Cosmetic; needs fallbacks.
4. **CI, signing and installers.** Not code, and the largest item: build
   runners per platform, an Authenticode certificate for Windows (without it
   SmartScreen warns on every download), AppImage or `.deb` for Linux.
   Money and bureaucracy rather than engineering time.
5. **Testing on real machines.** The Keychain replacement in particular
   cannot be proven from a Mac.

**Rough size:** the code port is about one stage. Distribution is a separate
stage and the one that actually consumes the time.

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

- **Insert and delete rows from the grid.** Insert needs an empty pending row,
  awareness of `NOT NULL` and defaults, and returning the generated key to
  display. Delete needs its own affordance and a strikethrough rendering for
  pending deletions.
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

## The README's Status section was stale

**Fixed:** 2026-08-16. It had claimed "Stage 1 of 6 is done ... no safety guard
yet" since the first stage, through nine further stages. Rewritten this stage
because inline editing was the last planned feature and the claim had become
actively misleading — it told a reader the write-guard did not exist.

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
