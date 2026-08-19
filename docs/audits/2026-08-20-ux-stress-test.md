# UX Stress Test — first-contact usability audit

**Date:** 2026-08-20 · **Build:** `main` (v0.4.1 + dev), `npm run tauri dev` on macOS ·
**Method:** live driving of the real app as a first-time user — synthetic mouse/keyboard
events (CGEvent + accessibility API), screenshot verification of every step, against a
seeded throwaway Postgres 17 (`customers` 500 rows, `orders` 5000 rows with enum + FK,
`analytics` schema, one view). The reviewer had not used the app before this session.

**Tooling caveats, stated once:** two interactions could not be verified end-to-end with
synthetic events and are marked as such — grid **cell editing** never triggered (real
double-click from a human may behave differently), and early tab mis-clicks were partly
caused by window-coordinate drift in the harness. Every other finding was reproduced at
verified coordinates with real event injection and is a genuine app behavior.

## Executive summary

The core loop — connect, explore, query, read results — is fast, legible, and in places
genuinely better-explained than any competitor (SQLSTATE + error position + a "Show me"
link that moves the caret; structure tabs with FK references and used-by views; a filter
box that auto-expands matches). The app's failures are not in the happy path. They
cluster in exactly the territory the product claims as its identity — **not losing work
and never being misled**:

1. A modified, unsaved scratch tab **closes silently** from one click on its close
   button. No confirmation, no undo, no reopen. The query is gone. This directly
   contradicts the product's core promise.
2. The **result pane is global, not tab-scoped**. A fresh empty tab displays the
   previous tab's rows; results survive even the death of the tab that produced them.
   The screen routinely shows an editor and a grid that have nothing to do with each
   other.
3. Every `LIMIT n` result is labeled **"truncated"** — false signal on the product's own
   status bar, the one place that must never lie.
4. Switching to an unreachable connection **hangs forever with zero feedback** — no
   spinner, no timeout, no cancel; the click appears ignored, then completes silently
   minutes later when the server returns.

None of these are hard fixes. All four would embarrass the product in a switcher's
first hour.

## The 15 tasks, as experienced

| # | Task | Outcome |
|---|------|---------|
| 1 | Launch | Instant. Welcome screen states the product thesis in two lines. Keyboard focus works (Tab reaches connection rows). |
| 2 | Create connection | URL-paste autofills every field including SSL mode — best-in-class. But autofocus lands on *Name* while the promoted path is the URL field; the name defaults to the database name (`postgres`, collision-prone); **there is no "Test connection"** — Save is blind. |
| 3 | Connect | One click on the row. But Save returns to the list instead of offering to connect — an extra step every time. macOS Keychain prompt appears (expected once per install; every rebuild in dev). |
| 4 | Find a schema | Tree lists schemas collapsed. The **filter box is excellent**: typing `rev` auto-expands `analytics` and shows `daily_revenue` instantly. |
| 5 | Find a table | Fine — except **views do not exist in the tree**. The seeded `paid_orders` view is invisible; a user who creates a view will believe it failed. (Known backlog entry, confirmed live as genuinely disorienting.) |
| 6 | Inspect structure | **Excellent.** Row estimate, on-disk size, columns with PK badge/nullable/default, FK references (`public.customers.id`), index DDL, triggers, *used by* (the invisible view finally appears here), constraints. Better organized than DBeaver's tabs. |
| 7 | View data | Enter (or double-click) on a tree row opens a preview tab with the generated `select * … limit 500` visible — honest and editable. Types shown in column headers; `NULL` italic and distinct. |
| 8 | SQL editor | Fine. Long lines scroll horizontally with no wrap option (minor). |
| 9 | Write & execute | `⌘↵` works; the Run button carries its shortcut label (good teaching). Autocomplete ranks the matching table first, but pollutes the list with mid-word keyword matches — typing `ord` offers `password`, `according`, `parameter_ordinal_position`. |
| 10 | Inspect results | Row count + duration in the status bar. Editability refusals are explained — but see findings: the explanation can be wrong, and the "truncated" flag lies on LIMIT queries. |
| 11 | Save a query | `⌘S` turns the tab into an inline rename — nice flow. But typed spaces were swallowed: "paid orders sample" saved as `paidorderssample`. |
| 12 | Multiple tabs | Preview/pin semantics exist; tooltip on hover. But the close × killed a dirty tab silently — see finding #1. |
| 13 | Switch connections | Dropdown is fast; tabs and their SQL persist across the switch (results correctly cleared). But the list **reorders active-first**, the colored dots are tag colors that read as health, and an unreachable target hangs silently — findings #4 and #9. |
| 14 | Modify data | **Could not be triggered with synthetic events**: single click on a cell produces no visible focus or selection, Enter does nothing, double-click does nothing. Even granting an event-injection artifact, the grid gives *zero visible response to a click*, and nothing anywhere teaches that double-click edits. Insert row / Delete row buttons do enable and disable correctly with editability. |
| 15 | Error & recovery | The good: SQLSTATE, exact Postgres message, position, **"Show me" moves the caret to the offending token**, Dismiss. The bad: the error is anchored to the window bottom ~900px from the editor with a stale grid in between; the multi-statement error is raw driver text with no hint; the same error renders twice. |

## Top 10 UX problems

Each scored: what I expected / what happened / severity.

**1 · A dirty tab dies from one click, silently.** *(Severity: critical — brand-level)*
Expected: closing a tab with unsaved content asks, or is undoable, or the content is
recoverable (VS Code, DataGrip local history, even TextEdit). Happened: the scratch tab
holding a typed query vanished with its content on a single click of the hover-revealed
×. The product's own README leads with "losing your queries" as the enemy. A
confirm-on-dirty-close, an undo-close-tab, or auto-preserving scratch content (Insomnia
keeps everything) is table stakes.

**2 · The result pane belongs to no tab.** *(Critical — trust)*
Expected: each tab owns its results, like every competitor and every browser devtool.
Happened: a brand-new empty tab displayed the previous tab's 15 aggregate rows;
closing the tab that produced a grid left the grid on screen. Editor says one thing,
grid says another — the exact "grid disagreeing with reality" the product promises to
prevent, only on the read path.

**3 · "truncated" is false on LIMIT queries.** *(High — the status bar must not lie)*
Expected: "truncated" means the app cut my result at its 500-row cap. Happened: `limit
5` → "5 rows · 1 ms · truncated"; `limit 15` → same. Every limited query gets the
flag, so the one signal that should mean "you are not seeing everything" means nothing.

**4 · Unreachable connection = silent infinite hang.** *(High)*
Expected: "Connecting…", a timeout, a cancel. Happened: with the server paused,
clicking the connection did nothing visible — hover state, dropdown stayed open, no
spinner, no error after 25+ seconds. When the server came back, the queued switch
completed silently. To a user this reads as "the app is frozen" — and there is no way
out but waiting.

**5 · No "Test connection".** *(High — first-contact moment)*
Expected by every developer from every DB client ever used. Happened: Save is the only
action; wrong credentials are discovered only after saving and clicking the row. The
form validates nothing it could cheaply verify.

**6 · Views are invisible.** *(High, already in backlog — confirmed painful live)*
`create view` succeeds; the tree never shows it; the only place it appears is the
"used by" section of a table it reads from. First-hour user: "my view didn't work."

**7 · The grid gives no feedback on click, and editing is undiscoverable.** *(High;
editing flow itself untested — see caveats)*
Expected: clicking a cell shows a selection/focus rectangle (Excel, TablePlus,
DataGrip); some affordance hints that editing exists. Happened: no visible response of
any kind to a click on a cell. Even where a result is editable, nothing on screen says
so — editability is only ever announced negatively (the read-only footer note on
non-editable results).

**8 · The multi-statement refusal teaches nothing.** *(Medium-high)*
Expected: the app knows its own one-statement rule (it's in the README with the
workaround). Happened: raw `42601: cannot insert multiple commands into a prepared
statement`, rendered twice, no "run the statement under the cursor with ⌘↵ instead".
One sentence turns the product's most-hit limitation into a teaching moment.

**9 · The connection dropdown shifts under your pointer.** *(Medium — safety-adjacent)*
The list reorders active-first, so the same physical row is a different database on
different opens — and one of the rows is production. The colored dots are tag colors
(green=local, red=prod) but a paused-dead local connection still shows a green dot, so
they read as (wrong) health indicators. Fixed order + explicit tag chips (the row
already shows LOCAL/PROD text) + dots only if they mean liveness.

**10 · Small honesty leaks.** *(Medium, cheap)*
The read-only footer says "add id to the query to edit these rows" on a GROUP BY
aggregate where no id can help; the save-rename input swallows spaces
("paidorderssample"); errors render duplicated; after Save the form returns to the
list instead of offering to connect; the same error bar sits ~900px from the editor on
a tall window with a stale grid in between.

## Discoverability

- Nothing teaches the tree's interaction model: single click selects and does nothing
  else; the affordance that opens a table (Enter / double-click) is invisible. A
  first-time user clicks, sees a highlight, and stalls. (Observed directly.)
- Editing existence is never announced. Insert/Delete row buttons appear, but no cell
  ever looks editable.
- No keyboard cheat-sheet in-app; the README is the only map to a keyboard-first
  product. `Run ⌘↵` on the button is the one (good) exception.
- The Structure/Data toggle is quiet and placed away from the tab; it was missed on
  first read of the screen.

## Navigation

- Tab switching, preview/pin, and connection switching are fast and coherent once
  understood. Tabs surviving connection switches is defensible but unmarked: a tab
  written against `smoke-test` runs against `lifegame` with no origin indicator.
- The queries library, schema tree, and tabs are three unconnected namespaces with no
  global search across them (no command palette — consistent with the competitive
  audit's finding).

## Feedback

- Strong: run duration, row counts, explained read-only refusals, "Show me" caret
  jump, filter box responsiveness.
- Weak: no connecting/progress state anywhere (connect, switch, long queries untested);
  no cell selection; false "truncated"; duplicated error bars; the dirty-dot on tabs is
  the only unsaved-state signal and it's easy to miss.

## Error recovery

- SQL errors: excellent bones (SQLSTATE, position, caret link) — worth keeping exactly.
- Connection loss: silent hang, no timeout, no cancel, silent self-heal. The recovery
  exists (queued action completes) but the user is never told anything at any point.
- Lost work: no recovery path of any kind for a closed dirty tab.

## Cognitive load

Low overall — the small surface is the product's strength. The load that exists is
manufactured by the trust leaks: a grid that may not match the editor, a "truncated"
flag that may not mean truncated, dots that may not mean health. The user has to
maintain a mental model of *which signals to ignore*, which is precisely the cost this
product exists to remove.

## Recommended improvements (ordered)

1. **Confirm or make undoable the close of a dirty tab**; better, keep scratch tabs'
   content in the workspace SQLite so nothing typed is ever lost.
2. **Scope results to tabs.** Empty tab = empty pane; closed tab takes its grid.
3. **Fix "truncated"** to fire only when the app's own cap did the cutting.
4. **Connection progress + timeout + cancel**, and an error when connect fails.
5. **Test connection button** in the form (the pool code already knows how).
6. **Views in the tree** (the one-character `relkind` fix, already in backlog).
7. **Visible cell focus/selection** in the grid, and a subtle "editable — double-click
   a cell" affordance where editing is available (positive announcement, not only
   negative).
8. **Teach the ⌘↵ workaround** in the multi-statement error; dedupe error rendering;
   show errors adjacent to the editor (or scroll them into view).
9. **Freeze dropdown order; make tag chips the identity signal**, not the dots.
10. Fix spaces in the save-rename input; correct the "add id" advice on aggregates;
    offer "Save & connect" from the connection form.

## Most important changes before v1

Items 1–4 above. They are all small, all in territory the tests-around-pure-modules
architecture handles well, and all sit exactly on the product's stated promise: never
lose a query, never let the screen disagree with the database. The polish items
(5–10) matter for the switcher's first hour; these four matter for whether the
product's own story survives contact with its UI.

## What was not tested

- End-to-end row editing, insertion, deletion, and the confirm/rollback flow (cell
  editing would not trigger under synthetic events).
- The production write-guard and unlock ritual (the only PROD-tagged connection is the
  maintainer's real production database; testing it live was out of bounds).
- Column sort and resize, copy/export contents, big-result virtualization performance.
- Multi-hour behavior: relock timing, pool recovery after laptop sleep.
