# Backlog

Deferred work that is not yet assigned to a stage plan. Anything here is a
real commitment, not a maybe — it was consciously postponed, not dropped.

## Visual design pass

**Deferred:** 2026-08-14, during the saved-connections stage. The user wants
fine-tuning done once, at the end, rather than piecemeal per stage.

The UI was built to be correct and legible, not designed. Concrete problems
observed in the connection editor, which the rest of the app shares:

- **No vertical rhythm.** Labels sit hard against their inputs while unrelated
  rows are widely spaced, so nothing reads as grouped. Needs a consistent
  label→field gap and a larger gap between field groups.
- **Inputs are oversized.** Full-bleed inputs at ~44px tall in a 460px dialog
  look like a mobile form. Height, padding, and font size should match the
  density of the rest of the app (13px base).
- **Fields are not sized to their content.** Port and SSL mode get the same
  width as Host and Database; a 5-character port field should be narrow.
- **The dialog is too wide for its content**, which stretches every field.
- **No visual hierarchy.** The pasted-URL shortcut, the identity fields
  (name/host/port/user/database), the credential, and the classification
  (environment/SSL) are four different kinds of thing rendered identically.
  They want separating — a divider or grouped sections.
- **Button weight is off.** Save and Cancel are nearly equal in visual weight,
  and disabled Save is barely distinguishable from enabled.

Worth doing as one deliberate pass across every surface — editor, picker,
sidebar, tab bar, grid, status bar — so the app ends up with a single spacing
scale and type scale rather than per-component guesses. Consider extracting
spacing/size tokens into CSS custom properties alongside the existing colour
tokens in `App.css`, since the colours are already tokenised and the geometry
is not.

## Schema tree extras

**Deferred:** 2026-08-14, while designing the schema tree. Each was consciously
cut to keep that stage tight; none is hard once the tree exists.

- **Views and materialised views in the tree.** Excluded on purpose, but it
  means a view can be queried and never seen. The fix is one character in the
  `relkind` filter in `schema/introspect.rs` plus a marker in the UI.
- **Double-click a table to preview it** — opens a tab running
  `select * from schema.table limit 500`. The original design spec promised
  this; it is the fastest way to see what is in a table.
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
