# UI/UX Audit

Audited 2026-08-18 against the full frontend source (`src/App.tsx`, all of
`src/components/`, `src/App.css`, `src/components/editorTheme.ts`) plus
`README.md` and `docs/BACKLOG.md`. This is a code-level audit of every screen,
state and interaction the code can produce; no code was modified.

Benchmarks used: DataGrip, TablePlus, Beekeeper Studio, DBeaver, VS Code.

---

## Executive Summary

Quarry is unusually coherent for a beta. It has a real design position — dark,
dense, keyboard-first, no decoration — and most of the code shows deliberate
decisions with written rationale (the CSS comments read like a design doc).
The write-guard UX (lock banner → typed unlock → red window ring → countdown →
relock) is genuinely better than anything in DBeaver or TablePlus and is the
product's identity. The pending-edit model (amber cells, strikethrough
deletes, View SQL, single-transaction confirm) is also excellent.

What holds it back from feeling professional is not visual style — it is
**missing desktop-tool table stakes** and **a handful of consistency leaks**:

1. The editor/results split is a fixed 200px editor — not resizable. Every
   benchmarked tool makes this the primary adjustable surface.
2. A running query cannot be cancelled, and the only execution feedback is a
   button label change to "Running…".
3. No right-click context menus anywhere — on a desktop database client this
   is the strongest "web page, not app" signal there is.
4. Keyboard-first claim vs. reality: no tab switching (`⌘1…9`/`⌃Tab`), no
   focus-visible styling on most controls, hover-only row actions that
   keyboard users can never see, no command palette, no shortcut reference.
5. Small consistency leaks: three background darks instead of two, four
   border radii used where two are tokenized, two modal systems with
   different widths/paddings/z-indexes, blue Confirm on a destructive
   dialog while the unlock dialog correctly uses red, orphan CSS
   classes (`.guard-banner`) and unstyled classes (`.grid-empty`,
   `.sql-editor`, `.caret`).

None of this requires a redesign. The design system exists; it needs to be
enforced and completed, and four or five interaction gaps need filling.

---

## Implementation Status

Implemented on branch `ui-audit-pass` (2026-08-18): steps 1–5 of the
recommended order, plus the frontend half of step 7.

**Done:** P0-1 editor/results splitter · P0-3 context menus (schema tree,
query tree, grid cells, tabs) · P0-4 global `:focus-visible`,
focus-revealed row actions, roving tab stops in grid and tree · P0-5
ConfirmDialog focus/Enter/danger · P1-1 tree click semantics · P1-2 tab
shortcuts (⌘T, ⇧⌘[ / ⇧⌘], ⌘1–9, middle-click, Close others) · P1-4
zero-row state · P1-5 draggable sidebar section split · P1-6 one modal
system · P1-7 Save demoted · P2-1/2/4/5/6/7/13 token and consistency
sweep · P2-9 grid arrow-key selection · P2-11 menu keyboard model ·
P2-14 dialog roles and Escape · P3-3 grid max-width · P3-7 saved-badge
motion · the "N changes applied" and "Running… Ns" feedback from the
Database Client UX section, and the `truncated` / `stale` status flags.

**Not done, and why:**

- **P0-2 cancel** — the elapsed-time running state shipped, but actual
  cancellation needs a `pg_cancel_backend` token plumbed through a new
  Tauri command. Backend work, deliberately not bundled into a frontend
  branch.
- **P1-3 error detail/hint** — the wrapping error panel and
  jump-to-position shipped. `DETAIL` and `HINT` are not in
  `ErrorPayload` at all; adding them means two new fields on
  `AppError::Query` and updating its ten construction sites in
  `guard/` and `edit/`.
- **P1-8 views in the tree** — needs the `relkind` filter change in
  `schema/introspect.rs`; it is a Rust change and stays with the
  backlog entry that already owns it.
- **P2-8 guard tick isolation, P2-10 Data-tab SQL persistence, P2-12
  disabled-reason surfacing, query history, cell value inspector** —
  still open.

## Product Strengths

Things that are already better than the competition, or exactly right.
**Do not change these.**

- **The write-guard experience.** Lock banner with a reachable Unlock,
  typed-name confirmation ("a name cannot be typed by reflex"), a 2px red
  inset ring around the *whole window* while unlocked, a live countdown, a
  one-click Relock, and a `guard-denial` strip that appears exactly when a
  write is refused, with the unlock right there. This is the pitch, and the
  UX delivers it.
- **The pending-edit model.** Amber tint + left rule for edited cells,
  strikethrough + red rule for staged deletes, amber row for staged inserts,
  italic `default`/`NULL`/`generated` placeholders that state what the
  database will do, a count in the edit bar, optional View SQL with real
  parameters, and Confirm-without-a-dialog justified in a comment worth
  framing ("a reflexively dismissed dialog looks like a safeguard without
  being one"). No benchmark tool explains *why* a result is read-only as
  well as the status bar's `read-only · <reason>` does.
- **NULL vs empty string** rendered distinctly everywhere, including in the
  editing chords (`⌘⌫` = NULL). DataGrip-level correctness.
- **The sort-partial `!` marker** — flagging that a client-side sort covered
  only the fetched page is honesty no competitor surfaces.
- **Virtualized grid and tree** — 100k rows and thousand-table schemas stay
  responsive; row identity from Postgres metadata, not SQL parsing.
- **Motion discipline.** Per-property 130ms transitions, one 150ms `rise`
  animation, `prefers-reduced-motion` respected. Nothing "AI-generated" here.
- **Window sizing per app state** (small launch panel → large workspace),
  preview tabs in italic (VS Code convention), `⌘↵` runs statement under
  cursor, Tab owned by completion in the editor.
- **The connection editor's SSL labels** ("require — encrypt, no certificate
  check") and URL-paste autofill. Small, deeply professional touches.
- **Honest empty/qualifier text**: "estimated" on row counts, "No views read
  this table", "blank keeps the saved one".

---

## Critical Problems

The compressed list of what most damages daily-driver credibility. Detail and
IDs in the priority sections below.

1. Fixed 200px editor / no editor↔results splitter (P0-1).
2. No query cancellation and near-invisible execution state (P0-2).
3. No context menus; browsing actions hidden behind hover-only glyph buttons
   (P0-3).
4. Keyboard navigation holes in a keyboard-first product: no tab cycling, no
   visible focus on most controls, hover-revealed actions unreachable by
   keyboard, tree not arrow-key navigable (P0-4, P1-2).
5. Single-click on a schema-tree table fires a query — browsing has side
   effects, and double-click fires the preview query *and then* replaces it
   with a structure tab (P1-1).
6. Destructive-dialog conventions inverted: focus lands on Confirm, Enter
   deletes, and the Delete button is accent blue (P0-5).

---

## P0 Issues

### P0-1 — Editor/results split is fixed
- **Screen/component:** `SqlEditor.tsx:120` (`height="200px"`), main pane layout.
- **Problem:** The SQL editor is hard-coded to 200px. Results take the rest.
  No way to grow the editor for a long query or collapse it to scan results.
- **Why it matters:** This is the single most-used layout adjustment in every
  benchmarked tool. A fixed split reads as prototype immediately, and 200px
  is ~9 lines of SQL — real queries are longer.
- **Recommended solution:** A horizontal drag handle between editor and
  results, same pattern as `SidebarResizer` (pointer capture, clamped, not
  persisted — one integer of state, matching the sidebar decision). Apply to
  both the query-tab layout and the Data-tab layout in `App.tsx`.
- **Expected UX impact:** High — removes the most obvious "beta" tell.
- **Complexity:** Medium (the resizer pattern already exists; wire height as
  state and pass to CodeMirror).

### P0-2 — No cancel, and execution feedback is one button label
- **Screen/component:** `SqlEditor.tsx` toolbar, `App.tsx` `busy` state,
  `StatusBar.tsx`.
- **Problem:** While a query runs, the only signals are the Run button
  becoming "Running…" and disabled. The status bar still shows the previous
  result. There is no way to cancel; a slow query locks the workflow until
  Postgres returns.
- **Why it matters:** Accidentally running an unindexed scan on a big table
  is a weekly event for the target user. Every benchmark tool has cancel
  (Postgres supports it via `pg_cancel_backend`/`CancelToken`). Without it,
  users fear the Run button on production-sized data.
- **Recommended solution:** (a) status bar shows `Running… <elapsed>s` while
  busy, replacing the stale row count; (b) Run button becomes Cancel while
  busy (or add `⌘.` — the macOS cancel convention), backed by a tokio-postgres
  cancel token in the Rust layer.
- **Expected UX impact:** High — this is trust, not polish.
- **Complexity:** Medium-High (needs a backend command; the UI half is Low).

### P0-3 — No context menus anywhere
- **Screen/component:** Schema tree, query tree, tabs, result grid,
  connection rows.
- **Problem:** Right-click does nothing in any surface. All row operations
  are hover-revealed glyph buttons (`⋯`, `×`, `+`, `✎`) at 10–14px targets.
- **Why it matters:** Right-click is *the* desktop affordance. In a database
  client users right-click a table expecting Open / Structure / Copy name /
  Filter; they right-click a cell expecting Copy / Set NULL / Delete row.
  Its absence, more than any visual choice, makes Quarry feel like a web
  dashboard. It would also give the grid's hidden chords (`⌘⌫`, `⇧⌘⌫`,
  `⇧⌘N`) a discoverable, labeled home.
- **Recommended solution:** One reusable context-menu component (positioned
  panel using the existing `.move-menu` styling, which already looks right).
  Wire to: table rows (Open data / Open structure / Copy qualified name),
  query rows (Open / Rename / Move to… / Delete — replacing the `⋯` and `×`
  buttons), grid cells (Copy / Copy row / Set NULL / Delete row / Insert
  row, with the shortcut labels shown), tabs (Close / Close others), and
  connection rows (Connect / Edit / Delete).
- **Expected UX impact:** High — discoverability for everything currently
  hidden, plus instant "real app" feel.
- **Complexity:** Medium.

### P0-4 — No visible focus on most controls; hover-only actions invisible to keyboard
- **Screen/component:** Global `button` rule (`App.css:95` — `border: none`,
  no `:focus-visible` style anywhere for buttons), `.row-action`/`.tab-close`
  at `opacity: 0` revealed only by `:hover` (App.css:327–348; the picker list
  alone handles `:focus-within`), tab bar, segmented control, tree rows
  (divs, not focusable at all).
- **Problem:** Tabbing through the app gives no visual indication of where
  focus is for buttons, tabs, or toolbar controls; the row actions never
  appear at all without a mouse. Grid cells and the column-resize handles do
  have focus behavior — inconsistently, they're the only ones.
- **Why it matters:** The product's stated identity is "keyboard-first". A
  keyboard-first app where you cannot see focus is a contradiction users
  will notice in the first minute, and it is the highest-impact
  accessibility defect present.
- **Recommended solution:** One global rule:
  `:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }`
  (matching the grid cell's existing focus treatment), plus extend the
  picker's `li:focus-within .row-action { opacity: 1 }` pattern to
  `.tree-row:focus-within` and `.tab:focus-within`.
- **Expected UX impact:** High for keyboard users; zero visual cost for
  mouse users.
- **Complexity:** Low.

### P0-5 — Destructive confirmation dialog defaults inverted
- **Screen/component:** `ConfirmDialog.tsx` (used for delete query, delete
  collection, delete connection).
- **Problem:** Focus mounts on the **Confirm** button and Enter anywhere in
  the dialog triggers `onConfirm`. The confirm button uses the default
  accent-blue style. So: `×` on a collection → Enter (or a stray keypress
  ending in Enter) → the collection and everything in it is gone, with "This
  cannot be undone" in the message. Meanwhile `UnlockDialog` correctly
  styles its dangerous action with `.danger` red.
- **Why it matters:** macOS convention (and every benchmark) is
  default-focus on the safe action for destructive dialogs. The current
  arrangement makes the irreversible path the path of least resistance,
  in an app whose brand is protecting you from exactly that.
- **Recommended solution:** Focus Cancel on mount; keep Enter =
  focused-button only (drop the dialog-level Enter→confirm handler); give
  ConfirmDialog a `danger` variant using the existing `.modal button.danger`
  red for Delete labels.
- **Expected UX impact:** High relative to cost; aligns the safety story.
- **Complexity:** Low.

---

## P1 Issues

### P1-1 — Schema-tree click semantics: browsing has side effects
- **Screen/component:** `SchemaTree.tsx` row handlers, `App.tsx`
  `openTableData`/`openTableStructure`.
- **Problem:** Single-click on a table opens a Data preview **and executes
  the preview query**. Double-click opens Structure — but the first click of
  the double-click has already fired the data query and opened a data tab,
  which the structure tab then replaces. Casually arrowing/clicking down a
  schema runs a query per click. There is also no `.active` state on table
  rows (only query rows get one), so the tree does not show which table the
  current tab came from.
- **Why it matters:** Browsing should be free. Against production (even
  read-only) every click is load; against big tables `SELECT … LIMIT` with
  no ORDER BY is cheap but not free. And the double-click race means the
  common gesture does double work. Benchmarks: TablePlus single-click
  selects, double-click opens; DataGrip selects, Enter/double-click opens.
- **Recommended solution:** Single-click selects the row (visual `.active`,
  no query). Double-click opens Data preview (runs the query). Structure
  moves to the context menu (P0-3) and/or a modifier-click; alternatively
  keep double-click = structure and make single-click select-only with
  Enter = open data. Either way: one gesture, one query.
- **Expected UX impact:** Medium-High.
- **Complexity:** Low-Medium (state exists; it's re-mapping handlers).

### P1-2 — Tab management below desktop baseline
- **Screen/component:** `TabBar.tsx`, `App.tsx` keyboard handling,
  `menu.rs`-driven `⌘W`.
- **Problem:** No `⌘1…⌘9` / `⌃Tab` / `⇧⌘[ ]` to switch tabs, no `⌘T` for a
  new tab, no middle-click close, no "Close others". Tab overflow is a bare
  `overflow-x: auto` strip with no scroll affordance. `⌘W` exists (native
  menu) — the rest of the family is missing.
- **Why it matters:** Tab shortcuts are muscle memory from every editor and
  browser; their absence is felt within minutes in a "keyboard-first" tool.
- **Recommended solution:** Add `⌘T` (new tab), `⇧⌘[`/`⇧⌘]` or `⌥⌘←/→`
  (previous/next), `⌘1…9` (activate by position) — all via `menu.rs`
  accelerators forwarding events, same pattern as `menu://close-tab`.
  Middle-click close in `TabBar`.
- **Expected UX impact:** High for daily use.
- **Complexity:** Medium (menu plumbing is established).

### P1-3 — Error presentation can't handle real Postgres errors
- **Screen/component:** `StatusBar.tsx` error branch, `.status-bar` CSS.
- **Problem:** Errors render as one status-bar line: SQLSTATE + message +
  "at character N". Long messages (function bodies, constraint violations
  with DETAIL/HINT) don't wrap by design of the bar; DETAIL and HINT are not
  shown at all if the payload carries only `message`; "at character 3141" is
  not actionable — the editor does not highlight the position.
- **Why it matters:** Reading errors is half of SQL development. DataGrip
  and even psql show detail/hint and jump to position.
- **Recommended solution:** Keep the one-line bar as summary; on error, allow
  the bar to expand (click, or auto for multiline) into a small scrollable
  error panel above it showing full message/detail/hint in monospace. Use
  `error.position` to set a CodeMirror diagnostic/selection so the offending
  token is visible.
- **Expected UX impact:** High for daily SQL work.
- **Complexity:** Medium.

### P1-4 — Zero-row results show a header floating over nothing
- **Screen/component:** `ResultGrid.tsx` (only the zero-*column* case has a
  message, and its `grid-empty` class has **no CSS rule** — it renders as an
  unstyled bare div).
- **Problem:** A query returning 0 rows renders the sticky header and an
  empty scroll area; the only signal is "0 rows" in the status bar. The
  zero-column message is unstyled text jammed at the top-left.
- **Why it matters:** "Did it run? Is it still loading?" is the question an
  empty region asks. Every benchmark shows an explicit "No rows returned".
- **Recommended solution:** Centered muted "No rows" line under the header
  when `rows.length === 0`; add a `.grid-empty` rule (padding `--s-4`, color
  `--muted`, `--t-base`) and reuse it for both cases.
- **Expected UX impact:** Medium.
- **Complexity:** Low.

### P1-5 — Sidebar SCHEMA/QUERIES split is fixed 50/50
- **Screen/component:** `Sidebar.tsx`, `.sidebar-section { flex: 1 }`.
- **Problem:** Both sections always take half the sidebar. Ten saved queries
  and a 400-table schema get the same share; the 1px `.sidebar-splitter` is
  decorative, not draggable, though it looks like it should be.
- **Why it matters:** Vertical space in the tree is the scarce resource in a
  DB client. Users with big schemas will feel this daily.
- **Recommended solution:** Make the splitter draggable (third use of the
  resizer pattern), or cheaper: collapsible section headers (click SCHEMA /
  QUERIES to fold, remaining section takes the space).
- **Expected UX impact:** Medium-High for large schemas.
- **Complexity:** Low (collapse) / Medium (drag).

### P1-6 — Modal system is two systems
- **Screen/component:** `.confirm-overlay` (z-index 100) vs `.modal-backdrop`
  (z-index 30); `.confirm-dialog` (320px, `--s-4` padding) vs `.modal`
  (380px, `--s-5`) vs `.connection-editor` (380px, `--s-5`, but no shadow);
  ConfirmDialog closes on backdrop click and traps Tab, ConnectionEditor and
  UnlockDialog do neither; UnlockDialog handles Escape only while its input
  has focus; ConnectionEditor has no Escape handling at all.
- **Problem:** Three modal-ish surfaces with different widths, paddings,
  shadows, stacking, and dismissal behavior.
- **Why it matters:** Dismissal inconsistency is felt (Escape works in one
  dialog and not the next); the z-index split is a latent stacking bug
  (a confirm opened over the connection editor works, the reverse would not).
- **Recommended solution:** One backdrop class, one z-index, one card base
  (380px, `--s-5`, `--radius-lg`, the 0 12px 32px shadow), one behavior
  contract: Escape cancels, backdrop click cancels non-form dialogs, Tab
  stays inside, focus returns to the invoker on close.
- **Expected UX impact:** Medium; removes a class of surprises.
- **Complexity:** Low-Medium.

### P1-7 — Header "Save ⌘S" button: wrong prominence, wrong home
- **Screen/component:** `App.tsx:1038`, top bar.
- **Problem:** A permanently filled accent-blue button labeled "Save ⌘S"
  sits in the window header at all times — including on Data tabs, where
  "Save" actually triggers the tab-naming flow for a *query* concept that
  doesn't apply. It is the most visually prominent control in the app,
  for an action that is (a) on `⌘S`, (b) already autosaved (`autosave` runs
  on every change; Save mostly names untitled tabs and flashes "Saved").
- **Why it matters:** Prominence should follow frequency × importance. The
  blue button distorts the hierarchy — the eye goes to Save, not to the
  connection identity or the running state. Embedding the shortcut in the
  label instead of a tooltip is also nonstandard.
- **Recommended solution:** Demote to `button.secondary` with `title="⌘S"`,
  or remove it from the header entirely (keep `⌘S` + a File menu item) and
  let the tab's dirty dot / status-bar "Saved" carry the state. Hide or
  disable it on table tabs.
- **Expected UX impact:** Medium — visual hierarchy of the whole workspace.
- **Complexity:** Low.

### P1-8 — Views absent from the schema tree (known, but P1 from a UX seat)
- **Screen/component:** Schema tree; `docs/BACKLOG.md` "Schema tree extras".
- **Problem:** Views and materialized views can be queried and edited around
  but never appear in the tree; autocomplete likewise doesn't know them.
  The backlog itself calls the fix one character plus a UI marker.
- **Why it matters:** "Is it easy to find things?" fails for a whole object
  class. First-session credibility issue for anyone whose schema uses views.
- **Recommended solution:** Do the backlog item; distinguish views with the
  existing `.marker` styling (e.g. a faint `V` badge), which also introduces
  the object-type differentiation the tree currently lacks entirely.
- **Expected UX impact:** High for view-heavy schemas.
- **Complexity:** Low (per the backlog's own assessment).

---

## P2 Issues

### P2-1 — Three background darks where the system defines two
- **Where:** `--bg: #16181d`, `--panel: #1d2027` (App.css) vs the editor's
  `BG = "#1a1d23"` (editorTheme.ts:990) whose comment claims it matches
  App.css; also literal hovers `#22262e` (`.tree-row:hover`), `#2a3446`
  (`.tree-row.active`), `#20242b` (`.cm-activeLineGutter`), `#2d4a7c` /
  `#23344f` / `#2f3a4d` (selection colors).
- **Standard:** Editor background = `--bg` (it is a content surface like the
  grid). Hover/active/selection get named tokens (`--hover`, `--selected`,
  `--selection`), defined once, used in both CSS and editorTheme.
- **Why:** The between-color is subliminally visible where editor meets grid;
  literals are how palettes drift.

### P2-2 — Border-radius drift
- **Where:** Tokens are 6/10px, but 3px (`.rename-input`, `.cell-editor`),
  4px (`.grid-toolbar button`, `.move-option`, `.tag-inline`,
  `.unlock-banner button`, `.lock-banner button`, `.update-banner button`)
  and 8px (`.connection-picker`) all appear as literals.
- **Standard:** 4px for small inline controls (add `--radius-sm: 4px`), 6px
  (`--radius`) for controls/menus, 10px (`--radius-lg`) for dialogs. Migrate
  the 3px and 8px cases into those three.
- **Why:** Radius is one of the strongest "designed vs. generated" signals;
  three values used consistently read as a system.

### P2-3 — Two twisty implementations
- **Where:** `.chevron` (10px wide, `--muted`, QueryTree) vs `.twisty`
  (12px wide, `--faint`, SchemaTree) — same glyphs `▸▾`, different width,
  different color, so the two trees' indentation and hierarchy read
  slightly differently in the same sidebar.
- **Standard:** One class (keep `.twisty`, 12px, `--faint`); delete
  `.chevron`.
- **Why:** They are the same concept 20px apart on screen.

### P2-4 — Uppercase-label styles re-implemented four ways
- **Where:** `.sidebar-header` (10px, 0.06em, no explicit uppercase — relies
  on the literal "SCHEMA" string), `.group-title` (10px, 0.08em, literal
  "CONNECTION"), `.grid-toolbar-label` (10px, 0.06em, `text-transform`),
  `.fact-label` / `.picker-tag` (10px, 0.06em/0.04em, `text-transform`).
- **Standard:** One `.overline` utility: `--t-xs`, 0.06em,
  `text-transform: uppercase`, `--faint`. Content stays sentence-case in
  markup.
- **Why:** Same semantic role, four slightly different renderings; also the
  literal-uppercase strings defeat any future restyle.

### P2-5 — Small-button style re-implemented four times
- **Where:** 22px-high bordered quiet buttons defined separately in
  `.grid-toolbar button`, `.unlock-banner button`, `.lock-banner button`,
  `.update-banner button` — with different border colors and radii.
- **Standard:** One `.btn-small` (22px, `--radius-sm`, `1px solid
  var(--border)`, `--t-sm`), with contextual border-color modifiers.
- **Why:** These appear adjacent (banners stack above the same toolbar) and
  the differences are visible.

### P2-6 — Terminology: "collection" vs "Folder"
- **Where:** Sidebar button says "+ Folder"; confirms, code, docs and the
  move-menu all say "collection"; the README says "collection tree".
- **Standard:** Pick one user-facing word (recommend "folder" — users know
  it; keep "collection" internal) and use it in the button, confirm text
  ("Delete this folder…"), and RenameInput placeholder.
- **Why:** Two names for one concept in a 200px sidebar.

### P2-7 — Connection identity truncation unhandled
- **Where:** `.connection-menu` / `.connection-target` in the top bar; also
  `.picker-target`.
- **Problem:** `user@host:port/db` for a real cloud host (e.g.
  `abc.eu-west-1.rds.amazonaws.com`) plus a long connection name will
  overflow the top bar against the Save button; no `min-width: 0` /
  ellipsis chain exists on that flex path.
- **Standard:** Ellipsize `.connection-target` with full value in `title`;
  cap `.connection-trigger` name similarly (the tab-label pattern, 160px
  max, already exists).

### P2-8 — Guard countdown ticks the whole app
- **Where:** `App.tsx` guard poll (1s `setInterval` → `setGuard`) re-renders
  the entire component tree every second while connected — the code even
  documents downstream workarounds (SqlEditor's ref dance exists because
  "App re-renders once a second").
- **Problem:** Not visual, but it is UI-architecture debt that already
  caused one shipped bug (the vanishing completion list) and will cause
  more; every future child must remember to memoize.
- **Standard:** Isolate guard state + countdown in a small component or
  context so the tick re-renders only the banner and status bar.

### P2-9 — Grid keyboard model is incomplete
- **Where:** `ResultGrid.tsx`.
- **Problem:** Cells are clickable and `⌘C`/`⌘A` work, but arrow keys do not
  move the selection, Shift+arrows do not extend it, and Escape does not
  clear it. Selection is mouse-only in a keyboard-first app; `tabIndex` is
  only granted to *editable* cells, so read-only results are untabbable.
- **Standard:** Arrow-key navigation of the anchor cell, Shift+arrow
  extension, Escape to clear, Enter to edit (already present). This also
  unlocks the P0-4 focus-visible work inside the grid.
- **Complexity:** Medium.

### P2-10 — Data-tab editor state is silently volatile
- **Where:** `App.tsx` `tableSql` ("Held here rather than in the tab
  record… a scratch edit").
- **Problem:** Editing the SQL on a Data tab, switching tabs, and returning
  reseeds the generated preview — the edit is gone without warning. The
  design decision is defensible; the silence is not: the same surface *is*
  persistent on query tabs, so users will assume persistence, type a
  careful WHERE, and lose it.
- **Standard:** Either keep the edited SQL for the tab's lifetime (state
  keyed by tab id, not persisted), or mark the edited state visibly (e.g.
  "scratch — not saved" hint in the Data-tab editor) so the volatility is
  stated. Recommend the former.

### P2-11 — Dropdown keyboard behavior (connection picker)
- **Where:** `ConnectionPicker` in dropdown mode; `.move-menu`.
- **Problem:** No arrow-key navigation, no Escape-to-close on the picker
  (outside-click only, wired in App), no focus management on open; the
  move menu closes on Escape but doesn't arrow-navigate.
- **Standard:** Menus open with first item focused; ↑↓ move, Enter picks,
  Escape closes and restores focus to the trigger. One shared menu
  primitive would cover picker, move menu, and the future context menu
  (P0-3).

### P2-12 — `title`-attribute tooltips carry load-bearing information
- **Where:** insert/delete reasons (`GridToolbar`), not-editable cell
  reasons, `read-only · reason` (status bar has inline text — good),
  sort-partial explanation, every icon button.
- **Problem:** Native tooltips appear after ~1s hover, never on keyboard
  focus, and are invisible on disabled buttons on some platforms
  (disabled elements don't fire hover in WebKit consistently). The
  explanations are excellent content trapped in a weak channel.
- **Standard:** Keep `title` for icon labels; for *reasons on disabled
  controls*, surface the text inline nearby (the status bar already does
  this correctly for edit-blocked reasons — extend that pattern) rather
  than relying on hovering a dead button.

### P2-13 — Orphan and missing CSS
- **Where:** `.guard-banner` is animated in App.css:1314 but no component
  renders it (the real classes are `.lock-banner`/`.unlock-banner`, which
  therefore *don't* get the rise animation intended for them); `.caret`
  (App.tsx:1005), `.sql-editor` (SqlEditor.tsx:115) and `.grid-empty`
  (ResultGrid.tsx:378) have no rules at all.
- **Standard:** Point the animation at `.lock-banner, .unlock-banner,
  .guard-denial`; style or remove the dead classes.
- **Why:** Two of these are silent regressions (missing animation, unstyled
  empty state), not just hygiene.

### P2-14 — Focus not returned after dialogs; no `aria` on most overlays
- **Where:** All modals except ConfirmDialog (which has
  `role="alertdialog"`); UnlockDialog, ConnectionEditor modal, pickers.
- **Standard:** `role="dialog"` + `aria-modal` + `aria-labelledby` on the
  card; restore focus to the invoking control on close (part of the P1-6
  modal contract).

---

## P3 Issues

### P3-1 — Glyph-icon inconsistency
`⟳ ✎ × ⋯ + ▾ ▸ ▲ ▼ ↗ •` are all text glyphs at inherited font sizes —
mostly fine and pleasantly unfussy, but they render at different optical
sizes (the `•` dirty dot is forced to 16px, `×` inherits 13px, twisties
10–12px wide boxes). If keeping text glyphs (reasonable — zero icon-font
weight), normalize: one size per role, `line-height: 1`, centered in a
fixed-width box like `.twisty` already does.

### P3-2 — Sort arrows both-visible states
`▲/▼` plus the red `!` plus the type name can make a sorted header noisy on
narrow columns. Consider hiding `.col-type` under ~90px column width.

### P3-3 — `.result-grid td { max-width: 340px }` fights explicit widths
Widths are set inline per cell; the stray max-width caps a user who drags a
column wider than 340px for long JSON values. Remove it (truncation is
already handled by `overflow: hidden` + the dragged width).

### P3-4 — Launch screen tagline explains prod-lock before it explains the app
Minor copy: the tagline's second sentence is the guard; first-time users
haven't made a connection yet. Fine to keep — just noting it is a pitch, not
onboarding, and the empty-state copy on the picker ("password goes to the
macOS Keychain, never to disk") is doing the trust work already.

### P3-5 — Non-macOS fallbacks (known, backlog item)
`-apple-system`/`SF Mono` stacks and `⌘` labels on Windows/Linux builds.
Already tracked in BACKLOG; listed here only for completeness. The
`ui-monospace` stacks degrade acceptably.

### P3-6 — Status bar "Ready" is dead weight
"Ready" says nothing; the slot could show the active connection's
`user@host/db` (redundant with header, but the status bar is where eyes are
after a run) or nothing. Cosmetic either way.

### P3-7 — `.saved-indicator` appears with no transition
Everything else eases in; the "Saved" badge pops. Add it to the 130ms
opacity transition group for consistency with the motion rules.

---

## Top 10 Improvements

If only ten changes ship before the next beta, in order:

1. **Editor↔results drag splitter** (P0-1) — the loudest prototype tell.
2. **Cancel + running state** (P0-2) — trust on real databases.
3. **Context menus everywhere** (P0-3) — desktop-app feel + discoverability
   of the already-built hidden features in one stroke.
4. **Global `:focus-visible` + focus-revealed row actions** (P0-4) — makes
   "keyboard-first" true, one afternoon of CSS.
5. **Fix ConfirmDialog focus/Enter/danger color** (P0-5) — safety story
   consistency, trivial cost.
6. **Tab shortcuts ⌘T / ⌘1–9 / next-prev** (P1-2) — daily-driver muscle
   memory.
7. **Tree click semantics: select on click, open on double-click/Enter**
   (P1-1) — browsing stops having side effects.
8. **Error panel + editor position highlight** (P1-3) — half of SQL work is
   reading errors.
9. **Views in the schema tree** (P1-8) — cheap, closes a whole-object-class
   hole.
10. **Token sweep: one editor background, radius scale, small-button class,
    overline class, orphan CSS** (P2-1/2/4/5/13) — one mechanical pass that
    buys the "every pixel deliberate" impression everywhere at once.

---

## Screen-by-Screen Audit

### Launch screen
Icon + name + tagline, connection list, primary "Add a connection", inline
error and inline password retry. **Good:** window sized to content; focus on
most-recent connection so Enter connects; error capped at 60ch and centered;
password retry inline instead of a modal. **Issues:** connect-in-progress
state is only `disabled` rows — no spinner/text ("Connecting…") anywhere, so
a slow network looks frozen (small P1-adjacent; add a status line); the
connection editor replaces the picker rather than layering, which is fine,
but Escape does not cancel it (P1-6 contract).

### Application shell (connected)
Drag strip / sidebar / main pane / status bar. **Good:** drag strip and
traffic-light clearance handled carefully; sidebar resize excellent
(pointer capture, clamped). **Issues:** header hierarchy dominated by the
Save button (P1-7); connection identity can overflow (P2-7); no window-level
"which schema am I in" — acceptable since Postgres search_path defaults are
not surfaced anywhere, but the top bar has room for `db` emphasis.

### Connection picker (dropdown + standalone)
**Good:** colour dot + name + tag + mono target is exactly the right row;
active connection outlined; hover-revealed edit/delete keyboard-reachable
via `:focus-within` (the one place this was done right). **Issues:** no
arrow-key navigation (P2-11); delete confirm is the blue-Enter dialog
(P0-5).

### Connection editor
**Good:** URL paste autofill, grouped fields with overline titles, port
width matched to content, SSL modes explained, "blank keeps the saved one".
Best form in the app; make it the standard. **Issues:** no Escape-to-cancel;
tag select doesn't preview its colour (the dot exists everywhere else —
minor); validation is only "name non-empty" (a junk port silently becomes
5432 via `Number(port) || 5432`).

### Sidebar — schema tree
**Good:** virtualized; filter covers tables and columns; refresh with
loading glyph; error row with retry. **Issues:** click semantics (P1-1); no
active-table indication (P1-1); no views (P1-8); no object-type distinction
at all — schemas and tables differ only by indentation and twisty; columns
expanded under a table show plain labels with no type/PK marker (the
`.marker` CSS notes the tree "stops at tables" but flattenSchema emits
column rows — whichever is current, column rows showing types faintly would
be cheap density win); filter matches don't highlight or auto-expand
context.

### Sidebar — query tree
**Good:** dirty dot; inline rename; move-menu anchored to the row with full
paths; empty states ("No saved queries yet", "No other collection").
**Issues:** hover-only `⋯`/`×` (P0-3/P0-4); double-click-to-rename
undiscoverable and conflicts with users expecting double-click = open;
"Folder" vs "collection" (P2-6); no drag-and-drop or reorder (known,
backlogged).

### Tab bar
**Good:** preview italics; dirty dots; inline naming on first save is a
genuinely nice flow. **Issues:** shortcuts (P1-2); overflow affordance;
close target is 13px text `×` (small for a frequent action — give it a
fixed 16×16 hit box); no tooltip difference between preview and pinned for
users who don't know the italic convention.

### SQL editor
**Good:** statement-under-cursor run; Tab-for-completion with written
rationale; theme matches app; Run button runs *the same thing* as the chord.
**Issues:** fixed height (P0-1); the toolbar is a lone right-aligned Run
button — a whole 28px band for one control (fold Run into the status bar or
tab row when the splitter arrives); no line numbers?… gutters are styled so
lineNumbers is on via basicSetup — fine; no current-statement indication
(DataGrip subtly highlights the statement that ⌘↵ would run — worth
considering with `statementAt` already written).

### Result grid
**Good:** virtualization; sticky header with type names; NULL/empty
distinction; right-aligned numbers; selection-tint-not-fill; ordinal gutter
recessive; column fit on double-click; keyboard resize on the handle (!);
sort honesty marker. **Issues:** keyboard selection model (P2-9); zero-row
state (P1-4); max-width fight (P3-3); no cell inspector for long values
(340px + ellipsis + title tooltip is the only path to a long JSON blob —
a popover or bottom value panel is the benchmark norm; P2-level, pairs with
P1-3's error panel); header click-to-sort has no hover affordance (cursor
pointer only).

### Grid toolbar
**Good:** export group left, destructive right with `margin-left: auto` gap
— deliberate and correct; disabled-with-reason philosophy. **Issues:**
"EXPORT" label + three text buttons is fine, but reasons live in `title` on
disabled buttons (P2-12); Insert/Delete row here duplicate grid chords with
different discoverability — context menu (P0-3) resolves.

### Table view (structure/data)
**Good:** facts first with "estimated" qualifier; segmented control is
clean; "not in this database → Refresh" recovery path; constraint grouping.
**Issues:** segmented control is the only one of its kind (fine — keep as
the standard for binary mode switches); structure tables use 13px while the
grid uses 13px mono for data — consistent enough; Data-tab volatile SQL
(P2-10); double-render of GridToolbar/ResultGrid/EditBar JSX in App.tsx for
table vs query layout is code smell that will drift the two experiences
apart (refactor when the splitter lands).

### Edit bar / write guard surfaces
**Good:** see Strengths — this whole area is the product's best work.
**Issues:** only the missing rise animation (P2-13) and pluralization is
handled — genuinely little to fix.

### Status bar
**Good:** rows · ms; read-only reason inline; SQLSTATE code in mono.
**Issues:** error capacity (P1-3); "Ready" (P3-6); saved badge pop (P3-7).

---

## Interaction & UX Audit

- **Hover:** consistent 130ms feedback on rows/tabs/buttons. Good.
- **Focus:** the app's biggest gap (P0-4, P2-9, P2-11). Grid cells and
  resize handles are the only well-focused citizens.
- **Keyboard shortcuts:** ⌘↵ / ⇧⌘↵ / ⌘S / ⌘W / ⌘C / ⌘A / ⌘⌫ / ⇧⌘⌫ / ⇧⌘N —
  a solid set, entirely undiscoverable (no menu items except ⌘W, no cheat
  sheet, some only in `title`s of related buttons). A Help→Shortcuts panel
  or `⌘/` overlay is cheap and pays immediately. Missing: tab cycling
  (P1-2), cancel (P0-2), focus-editor/focus-grid hops (consider `⌘L`-style
  jump to editor).
- **Context menus:** absent (P0-3).
- **Double-click:** overloaded — rename (query rows) vs open-structure
  (tables) vs edit-cell (grid) vs fit-width (resize handle). Grid and
  resize are conventional; rename-on-double-click and
  structure-on-double-click are both nonstandard in the same click radius
  (P1-1; move rename to context menu/F2... actually `Enter` on a focused row
  is the mac-native rename once trees are focusable).
- **Drag:** sidebar resize excellent; column resize excellent (drift-free
  math, pointer capture, sort-click suppression — textbook). No
  drag-and-drop of queries (backlogged, agreed deferrable).
- **Undo:** editor has CodeMirror undo; staged edits have Cancel-all but no
  per-cell revert (re-typing the old value is the workaround; a context-menu
  "Revert cell" would complete the story).
- **Copy/paste:** ⌘C TSV with header-when-whole-columns logic is
  thoughtful. No paste-into-cells (fine for now; editing model is
  cell-at-a-time).

---

## Visual Design Audit

**Typography.** Four-step scale (10/11/13/15) with tokens — right-sized for
a dense tool; body 13px matches benchmarks. Mono consistently applied to
data, identifiers, targets and SQL. Weights restrained (400/500/600, one
700 on the `!`). Issues: literal sizes bypassing tokens in the table-detail
CSS block (`font-size: 12px`/`13px` where `--t-sm`/`--t-base` exist —
App.css:872–971, note 12px vs the 11px `--t-sm` used for equivalent
secondary text elsewhere: standardize on the token); overline styles
re-implemented (P2-4). 10px overlines are at the floor of comfortable
legibility but used only for labels — acceptable.

**Spacing.** A real 4px scale with tokens, mostly obeyed. Leaks: literal
`6px`/`8px`/`10px`/`12px`/`16px`/`20px` sprinkled in later blocks
(`.sidebar-header-actions gap: 6px`, `.saved-indicator margin-left: 8px`,
`.connection-menu gap: 10px`, the whole table-detail section, `.marker
margin-left: 6px`). One mechanical pass to tokens.

**Color.** Small semantic palette, each with a purpose: accent = selection/
action, error = danger/prod, pending = amber staged, muted/faint two-tier
grays (the comment explaining *why* faint exists is design maturity).
Issues: literals bypassing it (P2-1); green/amber/red tag colours are
communicated by colour alone in the dot (the picker also prints the tag
name — good; keep that pairing rule).

**Borders & surfaces.** 1px `--border` separators, panels vs bg two-level
hierarchy, shadows only on floating surfaces (menus, dialogs) at two
consistent values. This is exactly the "hierarchy without boxes"
professional-tool look — no cards, no gradient, nothing decorative.
Preserve. The radius drift (P2-2) is the only blemish.

**Icons.** All text glyphs — a defensible, weight-free choice that mostly
works (P3-1). The ambiguous ones: `⋯` (move? more?) and `✎` vs
double-click-rename inconsistency (queries rename by double-click, connections
by pencil — pick one affordance). If the tool ever adopts an icon set,
Lucide at 14px/1.5px-stroke matches this aesthetic; not needed for quality.

---

## Information Architecture Audit

- **Where am I / what am I connected to?** Strong: named connection + colour
  dot + mono target in the header, colour stripe on the top edge, red ring
  when unlocked. Best-in-class among the benchmarks. Weakness: truncation
  (P2-7) and nothing distinguishing two connections to the same host but
  different databases at a glance beyond the target string.
- **What query produced this result?** Adequate: the result sits under the
  editor that ran it, and `ranSql` drives truncation detection — but after
  editing the buffer, the grid may show stale results with no "result is
  from a previous run" indicator. A subtle staleness hint (e.g. dimmed
  toolbar or "run to refresh" note when buffer ≠ ranSql) would close the
  loop. P2.
- **What can I safely modify?** Excellent — the layered read-only reasons.
- **Hierarchy depth:** shallow and right: two sidebar sections, tabs, one
  level of modal. No unnecessary nesting; the move-menu correctly avoids a
  submenu tree by using full paths.
- **Labels:** mostly precise ("Locked · writes and row editing are
  refused"). The Folder/collection split (P2-6) is the one terminology bug.
- **Click economy:** connect → browse → query is tight. The one economy
  failure is inverted: too *few* clicks — browsing fires queries (P1-1).

---

## Database Client UX Audit

- **Connections:** state clear when connected; switching is two clicks; no
  spinner during connect (noted above); error + inline password retry flow
  is better than TablePlus's modal loop. Disconnected state = launch screen;
  there is no "connection dropped mid-session" UX (what happens on network
  loss? — the error will surface per-query as a failed execute; a status-bar
  connection-health indicator is a P2 for later).
- **Explorer:** scales technically (virtualized) but not informationally
  (no views/functions/sequences, no type badges, P1-8). Search filter is
  good and covers columns.
- **SQL editor:** statement-at-cursor is the right execution model and
  well-explained; autocomplete schema-fed; no query history — worth naming
  as the largest missing DB-tool feature after cancel: every benchmark has
  it, and the library's "saved queries" answers a different need (curated
  vs. archaeological). Backlog-worthy P1 feature, not a UI fix.
- **Results:** strong grid; missing cell-value inspector for long values;
  no pagination controls — the PREVIEW_LIMIT model with honest truncation
  markers is a fair alternative, but the limit itself is not visible in the
  UI on a Data tab ("first N rows" appears only in the sort tooltip; put
  the truncation fact in the status bar: "500 rows (truncated) · 12 ms").
- **Mutation UX:** the best part of the app. One gap: after Confirm, the
  only feedback is the edit bar vanishing and the grid patching — a brief
  status-bar "3 changes applied · 8 ms" would confirm the transaction the
  same way query runs are confirmed. P2, small.

---

## Consistency Audit

| # | Inconsistency | Where | Standard to adopt | Why |
|---|---|---|---|---|
| 1 | Editor bg ≠ app bg tokens | editorTheme BG #1a1d23 vs --bg/--panel | `--bg` everywhere content lives | visible seam at editor/grid boundary |
| 2 | Radii 3/4/6/8/10 | rename-input, toolbar btns, picker, dialogs | 4/6/10 tokenized | strongest "designed" signal |
| 3 | Two overlay systems | confirm-overlay z100 vs modal-backdrop z30 | one backdrop, one z, one card | stacking bugs, felt dismissal differences |
| 4 | Danger styling | UnlockDialog red vs ConfirmDialog blue Delete | `.danger` on all destructive primaries | safety semantics must be uniform |
| 5 | Escape behavior | Confirm yes, Unlock partial, ConnEditor no | Escape always cancels topmost surface | muscle memory |
| 6 | Twisty | .chevron 10px muted vs .twisty 12px faint | .twisty | same glyph, same sidebar |
| 7 | Overline labels | 4 impls, some literal-uppercase strings | one .overline class | one semantic role |
| 8 | Small buttons | 4 impls, mixed borders/radii | one .btn-small | adjacent surfaces |
| 9 | Rename affordance | dbl-click (queries) vs ✎ (connections) | context menu + one direct affordance | two ways to do one thing |
| 10 | Folder vs collection | sidebar button vs everything else | one word | one concept |
| 11 | Type-scale literals | table-detail block 12/13px | tokens | drift-proofing |
| 12 | Spacing literals | 6/8/10px gaps in later CSS | --s-* | drift-proofing |
| 13 | Row actions on focus | picker handles :focus-within, trees don't | :focus-within everywhere opacity:0 is used | keyboard parity |
| 14 | Banner animation | .guard-banner (unused) has it, real banners don't | animate .lock/.unlock/.guard-denial | intended behavior lost |

---

## Accessibility Audit

Material issues only:

1. **Focus visibility** — P0-4. The one that matters most.
2. **Hover-only controls** — row actions at opacity 0 (P0-4/13 above).
3. **Contrast:** `--muted` #8b93a1 on #1d2027 ≈ 5.9:1 — fine. `--faint`
   #6b7280 on #1d2027 ≈ 3.6:1 — below 4.5:1, used for 10px overlines and
   placeholders; at that size it should be ≥4.5. Nudge `--faint` to
   ~#78808f or reserve it for non-text decoration (twisties). Amber
   `--pending` text on panel is only used as background tint — fine.
4. **Color-only indicators:** tag colour dots are paired with text in the
   picker (good) but the header dot + stripe rely on colour alone until the
   name is read — acceptable since the name sits adjacent; keep the
   pairing rule for anything new.
5. **Dialog semantics:** P2-14 (roles, labels, focus return).
6. **Target sizes:** `×` close buttons and 6–7px drag handles are small;
   handles are fine (edge targets), the 13px `×` on tabs deserves a padded
   hit box.
7. **Grid:** no arrow-key model (P2-9); screen-reader table semantics are
   actually decent (real `<table>`, `aria-label` on the gutter, roles on
   separators — better than most custom grids).

Not worth pursuing now: full WCAG audit, light theme, zoom levels.

---

## AI-Generated UI Audit

Checked for the generic-generated tells: excessive cards, gradients, shadow
stacks, arbitrary accent colors, icon noise, hero sections, dashboard
patterns. **Quarry has essentially none of them.** No gradients, two shadow
values both earned, no cards inside cards, one accent used semantically,
no decorative icons, and CSS comments that argue for each decision. The
few places that could read as generated are the *inconsistencies*, not the
style: mixed radii (P2-2), the four small-button variants (P2-5), literal
colors drifting from tokens (P2-1) — the fixes are already listed. The
glyph-icon approach, if normalized (P3-1), reads as a deliberate aesthetic
(à la early Linear/terminal tools), not a shortcut.

---

## Design System Recommendations

Codify what exists; add the missing pieces. Rules, not tweaks:

**Typography**
- Scale: 10 (`--t-xs`, overlines/badges only) · 11 (`--t-sm`, secondary/
  meta/mono-small) · 13 (`--t-base`, everything) · 15 (`--t-lg`, dialog
  titles). No literals; migrate table-detail block.
- Mono (`ui-monospace, "SF Mono", Menlo, monospace` — one stack, currently
  three variants of it; unify) for: data cells, SQL, identifiers,
  connection targets, SQLSTATE. Never for UI labels.
- Weights: 400 default, 500 emphasized labels/buttons, 600 titles and the
  edit count. Nothing else.

**Spacing:** keep the 4px scale; add `--s-0: 2px` if needed for glyph
padding; forbid literals in review.

**Radius:** `--radius-sm: 4px` (inline controls, badges, small buttons),
`--radius: 6px` (inputs, buttons, menus), `--radius-lg: 10px` (dialogs
only). Nothing else.

**Surfaces (3 levels, already true — write it down):**
`--bg` = content (editor, grid, inputs); `--panel` = chrome (sidebar, bars,
headers, menus, dialogs); floating = `--panel` + border + shadow
(`0 8px 24px` menus, `0 12px 32px` dialogs). Borders always 1px `--border`;
never use border for emphasis — use the accent.

**Color semantics:** accent = selection/primary action/focus; error =
destructive/prod/danger; pending = staged-not-applied (never for warning
generally); success = (new) reuse accent or add `--ok` only if a real need
appears — resist adding colors. New tokens to add: `--hover`, `--selected`,
`--selection` (from the current literals).

**Buttons (4 variants, all existing, name them):** primary (accent fill —
at most one visible per surface); secondary (border, transparent); small
(`.btn-small`, 22px, for bars/banners/toolbars); ghost/row-action (no
border, faint→text on hover). `.danger` modifier on primary and small.
Every button gets `:focus-visible` outline.

**Inputs:** 28px, `--bg` fill, `--border` 1px, `--radius`; focus =
`--accent` border (rename-input already does this — generalize). Labels
11px `--muted` above, 4px gap; field-to-field 12px.

**Menus/popovers:** `--panel`, `--radius`, `0 8px 24px`, `--s-1` padding,
row height `--h-row`, first item focused on open, ↑↓/Enter/Escape. One
component serves connection picker, move menu, context menus, future
export dropdown.

**Dialogs:** one backdrop (z updated to a single scale: content 0–10,
banners 20, menus 30, dialogs 40), 380px card, `--s-5` padding,
`--radius-lg`, title 15/600, body 1.4 line-height, actions right with
`--s-2` gap, Escape cancels, Tab trapped, focus returns.

**Tables (detail + grid):** header 500 `--muted` with 1px bottom border;
cells 4px 8px; mono for values. Grid rows 28px, tree rows 26px (keep the
distinction — data rows carry mono descenders).

**Tabs:** 26px, active = `--bg` fill + 2px accent inset bottom, preview
italic, dirty dot accent. Add: hover close-target padding, middle-click.

**Status/banners:** banners are full-width strips above the tab bar in
severity order (error/unlock > update > lock); all use `.btn-small`; all
get the rise animation.

**Empty states:** one pattern — `--muted`, `--t-base`, `--s-4` padding,
sentence with a recovery action as a link-button where one exists
("Nothing matches.", "No rows.", "Not connected."). Already mostly true;
codify.

**Loading:** text-first ("…", "Running… 3s", "Connecting…") — no spinners
needed at this density, but the text must always appear within 100ms of the
action somewhere fixed (status bar).

**Errors:** SQLSTATE in mono + message; detail/hint in the expandable
panel (P1-3); never colour-only — always the word.

**Icons:** stay with glyphs deliberately: fixed-width boxes, `line-height:
1`, one size per role, every icon-only control has `title` *and*
`aria-label`.

---

## Patterns To Preserve

Explicitly not to be "improved":

- The entire write-guard surface set (banners, typed unlock, window ring,
  countdown, guard-denial strip) and its copy.
- The pending-edit visual language (amber/strikethrough/placeholder
  italics) and Confirm-without-modal with optional View SQL.
- The read-only-reason plumbing into the status bar and cell tooltips.
- Statement-under-cursor execution and the Tab-for-completion decision,
  including its rationale comments.
- NULL vs empty-string rendering; right-aligned numerics; tinted (not
  filled) selection; recessive ordinal gutter.
- The sort-partial honesty marker.
- Virtualization approach in grid and tree; row-height token discipline.
- Sidebar resizer implementation (pointer capture, clamp, not persisted) —
  and reuse it for P0-1/P1-5 rather than inventing another.
- Window-size-per-state on the launch flow.
- Preview-tab italics + promote-on-edit; inline tab naming on first save.
- The connection editor's URL autofill and SSL-mode explanatory labels;
  keychain-not-disk copy.
- Motion rules (per-property, 130ms, reduced-motion respect) — extend, don't
  replace.
- No light theme, no settings screen yet — neither is blocking quality;
  don't build them before the P0/P1 list.

---

## Recommended Implementation Order

Sequenced for dependency and leverage, sized for stage-per-branch:

1. **CSS-only consistency pass** (P2-1, P2-2, P2-4, P2-5, P2-13, P3-3,
   P3-7, `--faint` contrast) + **P0-4 focus-visible** + **P0-5 dialog
   fixes**. One branch, no behavior risk, immediate quality jump.
2. **Modal/menu unification** (P1-6, P2-11, P2-14): one backdrop, one card,
   one menu primitive with keyboard model. Produces the component P0-3
   needs.
3. **Context menus** (P0-3) on tree rows, grid, tabs, connections — built
   on step 2's menu primitive; retire hover-glyph crowding where covered.
4. **Editor/results splitter** (P0-1) + sidebar section sizing (P1-5),
   both reusing the resizer pattern; fold the Run toolbar row away.
5. **Tab shortcuts + tree click semantics** (P1-2, P1-1) — menu.rs
   accelerators plus handler remapping.
6. **Cancel + execution state** (P0-2) — the one item needing new Rust.
7. **Error panel + position highlight, zero-row state, truncation in
   status bar, applied-changes feedback** (P1-3, P1-4, and the two small
   DB-UX notes).
8. **Views in the tree + type badges** (P1-8) — schema introspection
   one-liner plus marker UI.
9. Later/backlog: query history, cell value inspector, connection-health
   indicator, grid arrow-key selection (P2-9), Data-tab SQL persistence
   (P2-10), guard-tick isolation (P2-8).

Steps 1–5 contain no backend work and would, together, move Quarry from
"impressive beta" to "credible daily driver" on look and feel alone; step 6
is the remaining trust item.
