# Beta → V1 — what Quarry must become

**Date:** 2026-08-20 · **Inputs:** competitive product audit (2026-08-19), live UX
stress test (2026-08-20), repo state at v0.4.1 · **Question:** what must change for a
developer to confidently use Quarry as their primary database client?

## Product thesis

> **Quarry is the Postgres client that removes fear.**
> Production cannot be hurt by accident, work cannot be lost, and nothing on the
> screen is ever untrue.

The eventual "I prefer this over DBeaver" is not about features, speed, or looks. It
is: *"I stopped being afraid of my database client."* DBeaver gives a hundred
features and keeps the fear; Quarry's bet is that removing the fear — of the wrong
statement against prod, of the lost scratch query, of the grid that doesn't mean what
it shows — is worth more than the next hundred features combined.

Everything below is that sentence, operationalized.

## Target user

**The backend or full-stack product developer on a Postgres stack who touches
production weekly but is not a DBA.** They live in VS Code or Cursor, they think in
keystrokes, their company has one to five Postgres databases, and they are permanently
one mistyped `WHERE` away from a very bad day.

Why this persona and not the others:

- **Not the DBA** — they need user management, replication dashboards, backup
  tooling. Quarry has none and should build none; pgAdmin has that unenviable job.
- **Not the data engineer** — they need CSV/ETL import, cross-database migration,
  multi-engine support. All three are on Quarry's explicit don't-build list, because
  each would dilute or falsify the safety guarantees.
- **Not the occasional-SQL developer** — they want visual query builders and
  hand-holding. Quarry's keyboard-first, SQL-forward surface is wrong for them, and
  making it right would ruin it for the primary persona.

The chosen persona is the one whose needs are *already* what the codebase does well:
Postgres-native depth, keyboard speed, enforced safety, queries as files that go in
git. Strategy is mostly refusing to serve the other three.

## Current product assessment

**Production-ready today** (the stress test confirmed these live):

- The write-guard architecture — three enforced layers, typed-name unlock, relock.
- The editing machinery — wire-protocol row identity, one transaction, per-statement
  rowcount asserts, explained refusals.
- Structure tabs (row estimate, size, PK/FK, index DDL, used-by, constraints).
- Error anatomy: SQLSTATE, exact message, position, "Show me" caret jump.
- The schema filter box, statement-under-cursor execution, `⌘S`-to-library flow.
- Speed, and the engineering hygiene underneath (pure tested decision modules).

**Beta-quality** — and every one is a *trust* defect, which for this thesis is the
worst possible category:

- A dirty scratch tab closes silently from one click. Work lost.
- The result pane is global, not tab-scoped: editor and grid can disagree.
- "truncated" is false on every `LIMIT` query.
- Switching to an unreachable connection hangs forever with zero feedback.
- The grid gives no visible response to a click; editing is undiscoverable.
- Unsigned builds behind an `xattr` ritual.

**Missing** (the walls a first-week switcher hits): multiple simultaneous
connections; a table filter bar; run-whole-buffer on multi-statement scratchpads;
views in the tree; test-connection; SSH tunnels; query history; a command palette.

**Unnecessary:** almost nothing — the small surface is the asset. Nothing built so
far should be removed. The discipline to keep it that way *is* the strategy.

**To simplify:** the result pane concept (one pane per tab, no shared state); a
single search surface when the palette lands (absorb tree filter and library search
rather than adding boxes); keep the preferences surface near-empty.

## V1 definition

> **V1 is when a switcher's first week contains zero betrayals.**
> A developer can adopt Quarry as their only Postgres client for daily application
> work — reading, writing, guarding prod — without hitting a data loss, a lie on
> screen, or a wall that sends them back to their old client.

Not "feature parity with anyone." Betrayals and walls, eliminated.

## Must have

Without these, v1 cannot honestly be claimed.

1. **The trust-repair pack** (all four stress-test criticals):
   scratch-tab content persisted in the workspace SQLite (nothing typed is ever
   lost); results scoped to their tab; "truncated" true only when the app's cap cut
   the result; connect/switch progress with timeout and cancel.
2. **Multiple simultaneous connections** — the first demo-killer; staging vs prod is
   the daily norm.
3. **Client-side statement splitting** so `⇧⌘↵` runs a multi-statement buffer
   sequentially (stop on first error) instead of failing with driver noise.
4. **Signed, notarized macOS builds** — the install ritual filters out the audience
   before the product gets a chance.
5. **Views and materialized views in the tree** — the one-character `relkind` fix; an
   invisible view is a lie of omission.
6. **Test connection** in the form, and save-&-connect.
7. **Table filter bar** compiling to always-visible SQL — the bread-and-butter
   inspection gesture Quarry currently lacks entirely.
8. **A grid that answers the hand**: visible cell focus/selection, a positive
   "editable — double-click to change a cell" affordance, and the editing flow
   verified end-to-end (the stress test could not reach it).

## Should have

Important, not blocking:

- **Query history** — cheap (workspace SQLite exists), used daily, completes the
  "never lose work" half of the thesis.
- **Command palette (⌘K)** absorbing table jump, library search, and actions.
- **SSH tunnels** — arguably must-have for the persona's bastion-guarded prod; ships
  in v1 if capacity allows, first thing after otherwise.
- Teaching error for multi-statement runs; error rendering deduplicated and surfaced
  near the editor.
- Autocomplete ranking cleanup (no `password` for `ord`); prefix-match keywords only.
- Keyboard cheat-sheet overlay (`⌘/`); the shortcuts are the product — show them.
- Prod state made ambient: connection color and relock countdown always visible.
- The §10 paper cuts from the stress test (spaces in names, "add id" advice on
  aggregates, dropdown order frozen).

## Differentiators

The moat — none blocks v1, each deepens the thesis:

- **Guarded execution for hand-written SQL.** Every typed `UPDATE`/`DELETE` runs in a
  transaction, reports its rowcount, and asks before committing past a threshold or a
  stated `-- expect: 1`. Extends the machinery already built for grid edits to
  everything. Nobody ships this as a default. This is the single highest-leverage
  feature the product can build.
- **Write audit log** — every applied batch and unlocked-prod statement recorded with
  SQL, rowcount, and generated undo where derivable. "What did I change during the
  incident?" answered locally.
- **Parameterized saved queries** (`:variable`, Insomnia-style) — turns the library
  from filing cabinet into toolbelt.
- **Git-native library** — status badges, one-key commit; the file mirror makes it
  nearly free, and it opens the team story without accounts or sync services.

## Don't build yet

- **Multi-engine support** — would falsify the guarantees, not dilute them. Never.
- **ER diagrams** — demo-ware usage curve; owned by DBeaver/DataGrip.
- **Import/export wizards** — bottomless edge-case pit; `\copy` exists. Keep
  copy/export lightweight.
- **Plugin system** — how DBeaver became DBeaver; the tested-pure-module architecture
  is worth more than an extension API.
- **Admin/monitoring suite** — different buyer, different product.
- **An AI assistant panel** — sounds impressive, adds a second opinion the product's
  whole voice contradicts; revisit only when it can be held to the same honesty bar.
- **Cloud sync / accounts** — files plus git already solve it with zero
  infrastructure. Sync services are a support burden and a trust surface.
- **EXPLAIN visualizer** — genuinely valuable, deliberately v2: it deepens retention
  but does not remove a first-week betrayal or wall.
- **Modal insert form for wide tables** — a second editing surface with its own
  staging and validation; already rejected once in the specs, still right.

## Beta → V1 roadmap

**Beta stabilization (now — one short stage each, no new surface):**
trust-repair pack (must-have 1) · views in tree · test connection · error
dedupe + multi-statement hint · rename input fix · dropdown order frozen.
Everything here is small, and everything here is the product's story leaking. Ship
before seeking any new users.

**V1 (the switcher release):**
multiple connections (the one architectural lift — pool per connection, guard state
per connection, color everywhere) · statement splitting · table filter bar · signed
builds + updater · grid focus/affordance + editing verified · SSH tunnels if capacity
allows · README limitations list rewritten to match reality.

**V1.1 (the moat begins):**
query history · command palette · guarded execution for hand-written SQL ·
parameterized saved queries · SSH tunnels if not in v1 · keyboard cheat-sheet.

**V2 (the widening):**
write audit log · git-native library UI · session diff (same query, two connections)
· EXPLAIN visualizer · real Linux/Windows support (tested on hardware, packaged
properly) · optimistic concurrency via `xmin` · primary-key editing.

## Priorities scored

Value/Diff = user value, differentiation (1–5). Cx = complexity (5 = cheapest).
Risk = product/engineering risk of building it now.

| Initiative | Value | Diff | Cx | Risk | Priority | Depends on |
|---|---|---|---|---|---|---|
| Trust-repair pack (4 fixes) | 5 | 3 | 4 | low | **P0** | — |
| Views in tree, test connection, paper cuts | 4 | 1 | 5 | low | **P0** | — |
| Multiple connections | 5 | 1 | 3 | medium (touches pool + guard state) | **P1** | — |
| Statement splitting | 5 | 1 | 4 | low (pure module exists: `statements.ts`) | **P1** | — |
| Table filter bar | 5 | 2 | 4 | low | **P1** | — |
| Signed builds + updater | 5 | 1 | 3 | low, mostly money | **P1** | — |
| Grid focus + editing affordance | 4 | 2 | 4 | low | **P1** | — |
| SSH tunnels | 4 | 1 | 3 | medium (new dependency surface) | **P1.5** | multi-connection |
| Query history | 5 | 3 | 5 | low | **P2** | workspace SQLite (exists) |
| Command palette | 5 | 4 | 4 | low | **P2** | — |
| Guarded typed writes | 5 | 5 | 4 | medium (must never false-refuse) | **P2** | guard + edit machinery (exist) |
| Parameterized queries | 4 | 4 | 4 | low | **P2** | library (exists) |
| Write audit log | 4 | 5 | 4 | low | **P3** | guarded typed writes |
| Git-native library | 4 | 5 | 3 | medium | **P3** | parameterized queries (sequencing) |
| Session diff | 4 | 5 | 2 | medium | **P3** | multi-connection |
| EXPLAIN visualizer | 4 | 3 | 2 | medium | **P3** | — |

## Product principles

Derived from what the codebase already believes, stated so future decisions can be
tested against them:

1. **Three layers or it isn't safe.** A safety claim enforced only in the UI is a
   decoration. Every guarantee gets defense in depth, ending at Postgres itself.
2. **Never lose a keystroke of SQL.** Scratch or saved, typed work is sacred. Any
   surface that can discard text must persist, confirm, or undo.
3. **The screen never lies.** Every signal is true or absent: no false "truncated",
   no grid that outlives its query, no green dot that doesn't mean what it implies.
4. **Refuse loudly, explain exactly.** Every refusal names its rule and its remedy.
   An error the app predicted (multi-statement) must teach the workaround.
5. **Postgres-only, on purpose.** Depth over breadth; wire-protocol truth over SQL
   parsing; features that only Postgres makes correct.
6. **Keyboard-first, visibly.** Every action reachable from the keyboard, and every
   shortcut printed where its action lives.
7. **One statement, one transaction, one truth.** Writes are atomic, asserted, and
   reported with their real blast radius.
8. **Decisions live in pure modules with tests that have been shown to fail.** The
   product's reliability is a property of its code shape.
9. **Defaults are the product.** Every preference toggle is a fork in tested
   behavior; near-zero settings is a feature to defend.
10. **Files over services.** The library is a folder; git is the sync engine; there
    are no accounts. Infrastructure Quarry doesn't run can't betray anyone.

## Top 10 priorities

1. Fix the four trust leaks (scratch persistence, tab-scoped results, honest
   truncated, connect feedback).
2. Views in the tree + test connection + the paper cuts — drain the stabilization
   list to zero.
3. Multiple simultaneous connections.
4. Statement splitting for run-whole-buffer.
5. Signed builds.
6. Table filter bar with visible SQL.
7. Grid focus, editing affordance, and an end-to-end verification of the editing
   flow.
8. Query history.
9. Command palette.
10. Guarded execution for hand-written SQL — the differentiator, and the feature the
    thesis has been pointing at all along.

## The final answer

What must change for a developer to confidently make Quarry their primary client?
Two things, in order. First, the product must stop contradicting its own story — the
beta's failures are almost all trust failures, and this product cannot afford a
single one. Second, the walls must come down: two connections at once, a filter bar,
a buffer that runs, a build that installs. After that, everything else is moat — and
the moat is already designed: extend the safety machinery from grid edits to every
statement a human types, and the thesis stops being a positioning line and becomes a
demo.
