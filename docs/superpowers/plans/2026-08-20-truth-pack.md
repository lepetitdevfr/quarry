# Truth pack — wave 1 of the unified roadmap

**Branch:** `truth-pack` · **Process:** lean (short plan, no spec, no
brainstorm — read path only, no write path, no open design question).

Source: `docs/audits/2026-08-20-unified-roadmap.md`, wave 1 item 1. Every
defect below is a place the screen states something that is not true.

## Order of work

Small pure-module fixes first, the App.tsx refactor last, so a failure in the
big one does not sit on top of unshipped small ones.

### 1 · "truncated" only when the app's cap cut the result

`isTruncated(rowCount, sql)` in `src/lib/gridSort.ts` fires whenever the row
count equals any `LIMIT` in the SQL, so `limit 5` returning 5 rows is labelled
truncated. The app's own cap is `PREVIEW_LIMIT` (500) in generated preview SQL;
a user-typed `limit 5` returning 5 rows is a complete answer to the question
asked.

Change the signature to take whether the statement was app-generated, and fire
only then. Tests in `gridSort.test.ts` updated to match, plus a case pinning
"user-typed limit reached exactly → not truncated".

### 2 · "add id to the query" is wrong on aggregates

`decide_editability` in `src-tauri/src/edit/decide.rs` rule 6 tells the user to
add the primary key when it is missing from the result. On a `GROUP BY`, adding
the key changes the grouping — the advice cannot be followed. The metadata
already distinguishes the cases: an aggregate result carries columns with no
`table_oid` alongside the grouped ones.

When every column is a plain table column → keep the advice. When computed
columns are also present → refuse without advice that cannot be taken. New unit
tests for both branches.

### 3 · The multi-statement error teaches ⌘↵

`42601 cannot insert multiple commands into a prepared statement` is raw driver
text. Add a pure `hintFor(error)` in `src/lib/errors.ts` (tests in
`errors.test.ts`), rendered by `ErrorPanel` under the message. One sentence:
run the statement under the cursor with ⌘↵.

### 4 · One error on screen, not two

`StatusBar` and `ErrorPanel` both render `error.message` in full. The panel
wraps and carries the position link, so it keeps the message; the status bar
drops to the SQLSTATE and a short "query failed", which is what a one-line
non-wrapping bar can honestly hold.

### 5 · Frozen dropdown order, tag chips as identity

`connections()` in `src-tauri/src/library/connections.rs` orders by
`last_used_at desc`, so the same physical row is a different database on
different opens — and one of them is production. Order by name instead.

The launch screen focuses row 0 to make Enter connect to the most recently
used one; with a frozen order that would focus whatever sorts first, so focus
moves to the most-recently-used row by `last_used_at`, wherever it now sits.

Drop the colour dot from the picker row — it is the tag colour and reads as
health — and colour the existing LOCAL/PROD chip instead.

### 6 · Results belong to their tab

`result`, `error`, `ranSql`, `sort`, the staged edits and the grid selection
are single App-level states, so a fresh tab shows the previous tab's grid and a
closed tab leaves its rows behind.

New pure module `src/lib/tabResults.ts` with tests: a keyed record of per-tab
result state, with `get`/`set`/`clear`/`prune(liveTabIds)`. `App.tsx` reads the
active tab's entry and writes through the same module; closing a tab prunes it.
`busy` becomes `busyTabId`, so only the tab that is running says "Running…".

### 7 · Connect and switch report progress, time out, and can be cancelled

`connect_saved` awaits `ping` with no ceiling, so an unreachable host hangs
with no feedback and self-heals silently minutes later. Wrap the ping in a
`tokio::time::timeout` and return `AppError::Connection` naming the host and
the elapsed ceiling.

Frontend: the picker shows "Connecting…" on the row being connected, with a
Cancel that abandons the attempt (the request is ignored on return, and the
backend timeout ends it).

## Out of scope, deliberately

The other never-lose-work and tree-honesty items of wave 1 are their own
branches. The save-rename input swallowing spaces (audit item 10) is a real
defect but not a truth defect; it rides along here only if it costs one line.

## Verification

`npm test && npm run build`, and `cargo test && cargo clippy --all-targets -D
warnings && cargo fmt --check`. Every new pure-module test gets a mutation
check: delete the code under it, show the failure, restore, show the pass.
