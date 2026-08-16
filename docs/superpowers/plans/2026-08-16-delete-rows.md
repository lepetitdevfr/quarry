# Delete Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Stage row deletions alongside cell edits and apply them in the same transaction.

**Architecture:** Reuses the inline-editing machinery whole — the primary-key `WHERE`, the exactly-one-row assert, the single transaction, and the guard gate. The only new backend concept is that a `Statement` now knows whether it updates or deletes. On the frontend, staged deletions live in a `Set` of row indexes beside the existing pending-cell `Map`.

**Tech Stack:** Rust (`tokio-postgres`, `deadpool-postgres`), Tauri 2, React 19 + TypeScript, Vitest, `testcontainers`.

**Note on process:** this is one combined design-and-plan document rather than the usual separate spec and plan. The design questions are small and already settled by `specs/2026-08-16-inline-row-editing-design.md`; the session budget is better spent executing. Deliberate, and worth reverting to the normal flow for insert-rows, which has real design questions.

---

## Design decisions

**Editability.** Deleting a row needs exactly what updating one needs: a single ordinary table with its primary key in the result. So `EditInfo.editable` gates deletion unchanged, and no new decision code is written. Per-column verdicts are irrelevant to a delete — a row with a computed column beside real ones is still deletable.

**Trigger.** A `Delete row` button in `GridToolbar`, enabled when the result is editable and a row is selected, plus `⇧⌘⌫`. Not plain `⌫`, which would make an accidental keypress destructive, and not `⌘⌫`, which already stages `NULL` in a cell. The shifted chord is symmetric with it and deliberate to type.

**A delete beats an edit.** Staging a deletion for a row drops any cell edits staged against that row — applying both would generate an `UPDATE` for a row that is about to disappear. Handled in the pure module, tested.

**Statement shape.** `delete from t where pk = $1 returning pk`. The `RETURNING` is not for display; it makes a delete report exactly one row through the same code path the updates use, so the rowcount assert stays one implementation.

**After applying.** Deleted rows are removed from the grid in place, like edited cells are patched in place. Row indexes shift as a result — which is safe only because Confirm clears all staged edits, so no key survives that could point at the wrong row. Do not weaken that.

**Ordering.** Updates run before deletes within the transaction. With delete-beats-edit there is no row in both sets, so the order is arbitrary; fixing it makes the generated SQL stable for the View SQL panel.

---

### Task 1: Deletes end to end in Rust

**Files:**
- Modify: `src-tauri/src/edit/sql.rs`, `src-tauri/src/edit/apply.rs`, `src-tauri/src/edit/mod.rs`, `src-tauri/src/commands.rs`
- Test: `src-tauri/tests/edit_sql_test.rs`, `src-tauri/tests/edit_db_test.rs`

**Interfaces to implement exactly** — the frontend task is written against these:

```rust
/// What a generated statement does. `Update` carries the result column
/// indexes its RETURNING list names; `Delete` carries none, because the
/// row is going away rather than changing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementKind {
    Update,
    Delete,
}

// `Statement` gains:
pub kind: StatementKind,

/// One row to delete, identified the same way an edit identifies its row.
#[derive(Debug, Clone, Deserialize)]
pub struct RowDelete {
    pub row: usize,
    pub pk: Vec<String>,
}

/// Build one DELETE per row. Same refusals as `build_updates`: a result
/// that is not editable, or a key of the wrong arity.
pub fn build_deletes(info: &EditInfo, deletes: &[RowDelete]) -> Result<Vec<Statement>, AppError>;

// `AppliedRow` gains, so the frontend knows to drop the row rather than patch it:
pub deleted: bool,
```

Both commands take the deletes beside the edits:

```rust
pub fn preview_edits(edit: EditInfo, rows: Vec<RowEdit>, deletes: Vec<RowDelete>) -> Result<Vec<Statement>, AppError>;
pub async fn apply_row_edits(state, edit: EditInfo, rows: Vec<RowEdit>, deletes: Vec<RowDelete>) -> Result<Vec<AppliedRow>, AppError>;
```

Both build updates first, then deletes, and concatenate. `plan_apply` and `apply_edits` are unchanged — they take a slice of statements and neither cares what kind they are, which is the point of putting the kind on the statement.

- [ ] **Step 1: Write the failing tests**

In `edit_sql_test.rs`, covering `build_deletes`: one row produces `delete from "public"."users" where "id" = $1::text::… returning "id"`; two rows produce two statements; the composite-key case puts both columns in the `WHERE` with both params in order; a wrong key arity is refused; a non-editable result is refused; an empty slice produces nothing. Reuse the existing `users()` and composite fixtures in that file.

In `edit_db_test.rs`, against a real Postgres: a delete removes the row and the row count drops; a row already gone makes the batch fail with the "no longer" message and **rolls back an accompanying update in the same batch**; a mixed batch of one update and one delete applies both.

- [ ] **Step 2: Run them and confirm they fail**

`cd src-tauri && cargo test --test edit_sql_test --test edit_db_test`

- [ ] **Step 3: Implement**

Follow the interfaces above. `run_one` in `apply.rs` sets `deleted: matches!(statement.kind, StatementKind::Delete)` and skips cell collection for a delete — its `RETURNING` values are the key, not display data.

- [ ] **Step 4: Confirm they pass, then run the whole suite**

`cd src-tauri && cargo test` — expect 209 plus the new tests, 0 failed.

- [ ] **Step 5: Mutation check**

The rowcount assert must still be load-bearing for deletes specifically. Relax `rows.len() != 1` to `rows.len() > 99`, confirm the vanished-row delete test FAILS, restore, confirm it passes. Report both outputs verbatim.

- [ ] **Step 6: Commit** — `feat(edit): generate and apply row deletions`

---

### Task 2: Deletes on the frontend

**Files:**
- Modify: `src/types.ts`, `src/lib/ipc.ts`, `src/lib/pendingEdits.ts`, `src/components/ResultGrid.tsx`, `src/components/GridToolbar.tsx`, `src/components/EditBar.tsx`, `src/App.tsx`, `src/App.css`
- Test: `src/lib/pendingEdits.test.ts`

**Pure module additions** — all decisions live here, the components only render:

```ts
export type PendingDeletes = Set<number>;

/** Stage or unstage a row deletion. Staging one drops any cell edits
 *  staged against that row: applying both would UPDATE a row that is
 *  about to disappear. Returns both, since one changes the other. */
export function toggleDelete(
  pending: Pending,
  deletes: PendingDeletes,
  row: number,
): { pending: Pending; deletes: PendingDeletes };

/** Total staged changes: edited cells plus deleted rows. */
export function totalPending(pending: Pending, deletes: PendingDeletes): number;

export function toRowDeletes(deletes: PendingDeletes, result: QueryResult): RowDelete[];
```

`applyPatches` extends to drop rows whose `AppliedRow.deleted` is true, after patching the rest. Deleting rows shifts indexes, so it must drop by the original index in one pass rather than deleting one at a time.

- [ ] **Step 1: Write the failing tests** for `toggleDelete` (stages, unstages, drops that row's cell edits, leaves other rows' edits alone), `totalPending`, `toRowDeletes` (order stable, key values as text, throws on a NULL key), and `applyPatches` dropping deleted rows while patching survivors correctly.

- [ ] **Step 2: Run and confirm they fail** — `npm test -- pendingEdits`

- [ ] **Step 3: Implement the module, then the UI**

- `GridToolbar` gains a `Delete row` button: props `canDelete: boolean` and `onDeleteRow: () => void`. Disabled rather than absent when nothing is selected, so the affordance is discoverable.
- `ResultGrid` renders a staged-deletion row with a `deleted` class and handles `⇧⌘⌫` on a focused cell. It needs `deletes: PendingDeletes | null` and `onToggleDelete: (row: number) => void`. Use `order[item.index]`, never `item.index` — same trap as staging.
- `EditBar` count comes from `totalPending`. Its label stays "N pending changes".
- `App.tsx` holds `deletes` beside `pending`, clears both wherever it clears `pending` today, and passes both to `previewEdits`/`applyRowEdits`.
- `App.css`: `.result-grid tr.deleted td` gets a strikethrough and reduced opacity, using the real tokens in `:root` (`--muted`, `--error`, the `--s-*` scale). Check them; do not invent variable names.

- [ ] **Step 4: Verify** — `npm test` (146 plus new), `npm run build` clean.

- [ ] **Step 5: Commit** — `feat(ui): stage and apply row deletions`

---

### Task 3: Docs and full verification

- [ ] README: extend the inline-editing paragraph with deletion and `⇧⌘⌫`; add both to the Keyboard table.
- [ ] `docs/BACKLOG.md`: the "Row editing extras" entry loses its delete bullet; insert, primary-key editing, and optimistic concurrency remain, with a note that the delete work landed 2026-08-16 and that insert deserves the normal spec-then-plan flow.
- [ ] Full run: `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`, `npm test`, `npm run build`. All must pass — this repo has no baseline failures any more.
- [ ] Commit — `docs: describe row deletion`
