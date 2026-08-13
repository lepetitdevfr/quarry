# Backlog

Deferred work that is not yet assigned to a stage plan. Anything here is a
real commitment, not a maybe — it was consciously postponed, not dropped.

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
