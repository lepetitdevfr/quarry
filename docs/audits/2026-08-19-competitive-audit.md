# Competitive Product Audit — does Quarry have a reason to exist?

**Date:** 2026-08-19 · **Repo state:** v0.4.1 · **Benchmarks:** DBeaver,
DataGrip, TablePlus, Beekeeper Studio, and the editor-native workflows of
VS Code / Cursor.

Published artifact version:
<https://claude.ai/code/artifact/d37236fc-349d-4382-8d29-e213eb6f1c33>

## Executive summary

**Yes — but only if it stops being described as a DBeaver alternative.**
Quarry cannot win, and should never fight, the breadth war: DBeaver supports
a hundred engines, DataGrip has a decade of SQL intelligence, TablePlus has
years of polish across eight databases. A one-person Postgres-only client
that competes on feature count is dead on arrival.

What Quarry already has — and none of the incumbents have as a *product
identity* — is a coherent answer to the two ways a database GUI ruins your
week: losing your queries, and writing to production by accident. The
three-layer write-guard (UI, Rust classifier,
`default_transaction_read_only`) and the transactional edit-apply with
per-statement rowcount asserts are not features; they are a thesis. DBeaver
colors a connection red and hopes. Quarry makes the database itself refuse.

Recommended strategy: **position as "the Postgres client that can't hurt
production," go deeper on safety and the file-backed query library, and
close exactly four adoption blockers** (multiple connections, table
filtering, signed builds, run-whole-buffer) — while explicitly refusing to
build multi-engine support, ER diagrams, import wizards, and admin tooling.

## Why users would switch

**The switching argument, strongest form:**

> "Quarry is the only Postgres client where a production incident caused by
> the GUI is structurally impossible. A Prod connection is read-only three
> layers deep — the session itself runs `read_only=on`, so even a bug in the
> app can't write. Every grid edit applies in one transaction where each
> statement must touch exactly one row or the whole batch rolls back. And
> your queries are named `.sql` files on disk — greppable, diffable,
> committable — not scratch tabs you'll close by accident. It opens in under
> a second, it lives on the keyboard, and it tells you *why* a result isn't
> editable instead of silently going read-only. DBeaver gives you a hundred
> features and one bad afternoon. Quarry gives you the twenty features you
> use daily and removes the bad afternoon."

Secondary switching pressure, real but weaker:

- **Speed and weight.** Native Tauri window vs. DBeaver's Eclipse/JVM
  startup and memory footprint. This is TablePlus's whole pitch — Quarry
  matches it.
- **Honesty as UX.** "This result isn't editable because it's a join" beats
  a silently disabled cell. `NULL` rendered distinct from empty string
  everywhere. These read as small; they compound into trust.
- **Focus.** Postgres-only means the UI never shows a MySQL-shaped
  abstraction. Every affordance can assume `table_oid`, enums, `pg_catalog`.

## Why users would NOT switch

The weakest parts of the argument, in the order a skeptical developer will
find them:

1. **One live connection at a time.** Comparing staging against prod — the
   single most common multi-connection task — requires switching and losing
   the pool. Every competitor handles this. First hard stop in a demo.
2. **No table filtering UI.** Narrowing a table without hand-writing `WHERE`
   is the bread-and-butter gesture of TablePlus and DataGrip. Its absence
   makes table inspection feel half-built.
3. **⇧⌘↵ fails on multi-statement buffers.** The honest limitation reads as
   a bug to a new user: "run the whole buffer" that refuses a buffer with
   two statements is a broken promise, even though the reason (prepared
   statements) is sound.
4. **Unsigned beta, one user, no SSH tunnels.** The quarantine/`xattr`
   install ritual filters out most of the audience before the product gets a
   chance. No SSH tunnel excludes everyone whose prod DB sits behind a
   bastion — precisely the safety-conscious audience the write-guard courts.
5. **Price isn't a wedge.** DBeaver Community and Beekeeper's community
   edition are free; TablePlus's nag-ware mode is tolerable. Quarry must win
   on the thing it does that they don't.
6. **Switching cost is memory.** Muscle memory and saved connections live
   elsewhere. The library-on-disk story helps (bring your `.sql` files), but
   there's no importer for anything.

## Competitor comparison

**1 · What does Quarry already do better than DBeaver?**
Startup and interaction speed (native vs. JVM). The write-guard — DBeaver's
connection-type coloring and confirm dialogs are advisory; Quarry's is
enforced by the session itself. Editability honesty: DBeaver guesses row
identity from SQL parsing and gets joins wrong; Quarry uses `table_oid` from
the wire protocol and refuses cleanly with a stated reason. The query
library as first-class disk files vs. DBeaver's project-buried scripts.
Cognitive load: DBeaver's UI is an Eclipse perspective with ~40 menu roots;
Quarry's whole surface is learnable in ten minutes.

**2 · What does DBeaver do significantly better?**
Everything broad: a hundred engines, ER diagrams, data transfer/import/
export wizards, mock data generation, SSH/SSL/jump-host tunneling, driver
management, a plugin ecosystem, fifteen years of edge cases. Also filtering
and paging in the data grid, cross-database migration, and a community big
enough to have answered every question already.

**3 · What does DataGrip do significantly better?**
SQL intelligence — the gap that matters most. Resolve-aware autocomplete
(it knows `t.` refers to a specific table's columns *through* aliases, CTEs,
subqueries), rename-refactoring that rewrites dependent queries, local
history on every editor, VCS integration, multi-cursor editing, inline
EXPLAIN, and introspection deep enough to navigate to a function
definition. DataGrip treats SQL as a language with a compiler; everyone
else treats it as text.

**4 · What does TablePlus do significantly better?**
Multi-connection, multi-window workflows with color-coded connection
badges. The filter bar on every table (stacked column/operator/value rows
compiling to visible SQL). SSH tunneling that just works. Years of native
polish, signed builds, an updater. TablePlus is the proof that "small,
fast, native, opinionated" is a viable position — Quarry's closest analog
and the bar for finish quality.

**5 · Where is Quarry currently behind?**
Multiple simultaneous connections; table data filtering; running
multi-statement buffers; query history; SSH tunnels; EXPLAIN support of any
kind; import/export beyond copy; command palette and in-app search; signed
and updatable distribution; everything DataGrip does with language
intelligence. Views aren't even in the schema tree yet.

**6 · Where could Quarry realistically beat these products?**
Safety as architecture, not decoration — extendable from grid edits to
hand-written SQL (killer feature №1). The library-as-files story taken to
its conclusion: a query library that's a git repo a team shares.
Keyboard-first depth: none of the four has a real command palette; VS
Code/Cursor users feel that absence daily. And trust as brand: the README's
honesty is a marketing voice none of the incumbents can use.

**7 · What should Quarry NOT attempt to reproduce?**
Multi-engine support, ER diagramming, import/export wizards, mock data,
admin/monitoring dashboards, plugin systems. See "Features to avoid".

**8 · What should become the major differentiator?**
The guarded write path, generalized: the only client where *every* write —
grid edit or hand-written statement — states its blast radius before it
lands and rolls back if reality disagrees. Plus the git-native query
library. One protects the database; the other protects the work. Together
they're the brand.

## Current advantages

- **Three-layer write-guard** with typed-name unlock and 30-minute relock —
  enforced, not advisory.
- **Wire-protocol row identity** (`table_oid`/`column_id`), never SQL
  parsing — edits correct by construction, refusals explained.
- **Single-transaction edit apply**, each statement asserting exactly one
  affected row — the grid can never disagree with the database.
- **Query library mirrored to `.sql` files** — greppable, diffable,
  survives the app.
- **Statement-under-cursor execution** (`⌘↵`) — the scratchpad workflow
  done right.
- **Native speed and small surface** — Tauri window, virtualized grid,
  preview/pin tabs, learnable in one sitting.
- **Engineering hygiene as product asset** — every decision in a pure
  tested module; the honesty carries into UX copy.

## Current weaknesses

- **Adoption blockers:** one connection at a time; no table filter UI;
  whole-buffer run fails on multiple statements; unsigned builds behind an
  `xattr` ritual.
- **Reach blockers:** no SSH tunnels (excludes bastion-guarded prod — the
  target audience); Linux/Windows builds never run on real hardware.
- **Depth gaps:** no query history; no EXPLAIN; no command palette;
  autocomplete schema-fed but not resolve-aware; views absent from the
  tree.
- **Editing edges** the README already owns: no PK edits, last-write-wins
  concurrency, empty-string insert impossible from the grid, bigint keys
  past 2^53.

## Differentiation opportunities

Scores 1–5. Value = user value · Diff = differentiation · Cx = development
complexity (5 = cheapest) · Freq = frequency of use · Adv = durable
competitive advantage.

### Ten potential killer features

| # | Feature | Value | Diff | Cx | Freq | Adv |
|---|---------|-------|------|----|------|-----|
| 1 | **Guarded execution for hand-written SQL** — every `UPDATE`/`DELETE` runs in a transaction, reports affected rows, asks before commit when the count exceeds a threshold or a stated expectation (`-- expect: 1`). Extends the existing edit-apply machinery to typed SQL. Nobody has this as a default. | 5 | 5 | 4 | 4 | 5 |
| 2 | **Command palette (⌘K)** — fuzzy jump to any table, saved query, connection, action. The VS Code/Cursor generation expects it; none of the four DB clients has a real one. | 5 | 4 | 4 | 5 | 3 |
| 3 | **Query history** — every executed statement recorded (SQLite workspace exists), searchable, restorable, with duration and row count. | 5 | 3 | 5 | 5 | 3 |
| 4 | **Git-native query library** — status badges on changed queries, one-key commit, pull a team's library. The file mirror makes it nearly free. | 4 | 5 | 3 | 3 | 5 |
| 5 | **Table filter bar** — column/operator/value rows compiling to visible, editable SQL. Table stakes elsewhere; the always-visible SQL fits the house honesty. | 5 | 2 | 4 | 5 | 2 |
| 6 | **Write audit log** — every applied edit batch and unlocked-prod statement recorded with timestamp, connection, SQL, rowcount; generated undo SQL where derivable. | 4 | 5 | 4 | 2 | 5 |
| 7 | **EXPLAIN visualizer** — plan tree with per-node cost/rows/time, hot path highlighted. Postgres-only focus makes a good one feasible. | 4 | 3 | 2 | 3 | 3 |
| 8 | **Parameterized saved queries** — `:variable` placeholders prompting on run, Insomnia-style. Makes the library a toolbelt rather than a filing cabinet. | 4 | 4 | 4 | 4 | 4 |
| 9 | **Multiple simultaneous connections** — pooled per connection, color-coded, guard state per connection. Not differentiating; the price of admission. | 5 | 1 | 3 | 5 | 1 |
| 10 | **Session diff** — run the same saved query against two connections (staging vs. prod, pre/post-migration) and diff the result grids. | 4 | 5 | 2 | 2 | 4 |

### Ten UX improvements

| # | Improvement | Value | Diff | Cx | Freq | Adv |
|---|-------------|-------|------|----|------|-----|
| 1 | Split multi-statement buffers client-side so `⇧⌘↵` runs them sequentially (stop on first error) | 5 | 1 | 4 | 4 | 1 |
| 2 | Signed, notarized macOS builds + a real updater — the biggest single funnel leak | 5 | 1 | 3 | 5 | 1 |
| 3 | Fuzzy find-table in the schema tree (type-to-filter), pending the full palette | 4 | 2 | 5 | 5 | 1 |
| 4 | Postgres error position mapped to a caret/squiggle in the editor (the wire error carries the byte offset) | 4 | 4 | 4 | 4 | 3 |
| 5 | Keyboard cheat-sheet overlay on `⌘/` — the shortcuts are the product; make them discoverable in-app | 4 | 3 | 5 | 3 | 2 |
| 6 | Cell peek: `space` on a focused cell opens pretty-printed JSON/long-text readonly view | 4 | 3 | 4 | 4 | 2 |
| 7 | Prod state always visible: connection color + relock countdown in the title area while unlocked | 4 | 4 | 5 | 3 | 3 |
| 8 | Views and materialized views in the schema tree (backlog: one character + a marker) | 4 | 1 | 5 | 4 | 1 |
| 9 | Insert qualified name at cursor from a tree row; copy-name on every tree node | 3 | 2 | 5 | 4 | 1 |
| 10 | Live table stats in detail tabs (row estimate, on-disk size, comments) — already scoped in the backlog | 3 | 2 | 4 | 3 | 1 |

### Five ways to simplify

1. **Stay Postgres-only, and say it louder.** The constraint is the
   product. Put "PostgreSQL, nothing else, on purpose" on the download page.
2. **One search surface.** When the command palette lands, let it absorb
   tree filtering, query search, and history search — three search boxes
   would be three products.
3. **No settings screen sprawl.** Quarry has almost no preferences; treat
   that as a feature and hold the line. Every toggle is a fork in the
   tested behavior.
4. **Keep one window.** Multi-connection should be tabs/sidebar sections,
   not TablePlus-style window proliferation — fewer states for the guard to
   be ambiguous in.
5. **Let the file system be the sync engine.** No accounts, no cloud
   library, no sync service — the `.sql` mirror plus git covers it with
   zero infrastructure.

### Five things to avoid building

1. **Multi-engine support.** Every Quarry guarantee (row identity via
   `table_oid`, session read-only, enum selectors) is Postgres-specific.
   MySQL support wouldn't dilute the brand — it would falsify it.
2. **ER diagrams.** High effort, demo-ware usage curve, and
   DBeaver/DataGrip already own it.
3. **Import/export wizards.** CSV import is a bottomless edge-case pit;
   `\copy` and dedicated ETL tools exist. Keep copy/export lightweight.
4. **Admin/monitoring suite** (user management, backups, replication
   dashboards). Different buyer, different product; pgAdmin has that
   unenviable job.
5. **A plugin system.** It's how DBeaver became DBeaver. The tested
   pure-module architecture is worth more than an extension API.

### Five areas of genuine differentiation

1. **Enforced safety** — the write path as the identity, extended to
   hand-written SQL and audited after the fact.
2. **Queries as files** — the only client whose library is a git-shareable
   folder by construction.
3. **Keyboard-first with a real palette** — the client for people whose
   other window is VS Code or Cursor.
4. **Honesty as UX voice** — stated refusal reasons, distinct `NULL`, a
   README that admits what's untested. Trust compounds.
5. **Postgres-native depth** — enum selectors, oid identity, eventually
   EXPLAIN and catalog features generic clients can't assume.

## Recommended product positioning

> **"The Postgres client that can't hurt production — and never loses your
> queries."**

Position against the *fear*, not against DBeaver. The audience is
developers who touch production Postgres and are one mistyped `WHERE` away
from a very bad day — nearly all of them. "DBeaver alternative" invites a
feature-count comparison Quarry loses; "the safe one" is a category with
one occupant.

Concretely: lead every page with the guard and the transaction guarantee;
demo the refusal ("watch it explain why this join isn't editable"); make
the unlock ritual — typing the connection's name — the signature visual.
Secondary message: your queries are files, bring git. The speed story
rides along for free; don't lead with it, TablePlus already owns "fast and
native."

## Top 10 strategic priorities

1. **Multiple simultaneous connections.** The first demo-killer.
   Everything else waits behind it.
2. **Client-side statement splitting** so run-whole-buffer works. Small,
   removes the "broken promise" moment.
3. **Signed builds.** $99/yr buys back most of the install funnel. Do it
   before seeking any audience.
4. **Table filter bar** (with the compiled SQL always visible). Closes the
   most-felt daily-use gap.
5. **Guarded execution for hand-written SQL.** The differentiator.
   Rowcount confirmation on typed writes turns the safety story from "grid
   edits" into "everything."
6. **Command palette**, absorbing table jump, query search, and actions.
   The keyboard-first claim becomes visible.
7. **Query history.** Cheap (workspace SQLite exists), used daily,
   completes the "never lose work" half of the brand.
8. **SSH tunnels.** Unlocks the bastion-guarded prod databases the guard
   was built for.
9. **Views in the tree + parameterized saved queries.** One is a
   one-character fix; the other makes the library the team toolbelt.
10. **Git awareness in the library.** Status badges and a commit action —
    the cheapest version of the team story, deferred until the library has
    parameters.

Sequencing logic: items 1–4 are the price of admission (a switcher's first
hour must not hit a wall); 5–7 are the moat; 8–10 widen the audience and
open the team story. EXPLAIN visualization and session diff are worthy but
sit behind all ten — they deepen retention, not acquisition.
