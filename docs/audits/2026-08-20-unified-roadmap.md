# Unified roadmap — one plan from five audits

**Date:** 2026-08-20 · **Inputs:** competitive product audit (08-19), live UX stress
test (08-20), beta→v1 product strategy (08-20), the repo backlog, and the design
specs' recorded rejections. · **Rule set by the owner:** prioritize by **user impact
and product differentiation only** — implementation ease is explicitly not a factor.

That rule changes the order. The strategy doc quietly let cheapness pull items
forward (the "trust-repair pack" led partly because it is small) and let cost push
the flagship differentiator back (guarded typed writes sat at P2 partly because
multi-connection was "the architectural lift"). Re-ranked on impact and
differentiation alone, trust still leads — but for the right reason — and the
flagship moves up past the adoption walls.

## Contradictions found, and how each is resolved

**1 · SSH tunnels: "priority 8" vs "v1 if capacity allows" vs the persona.**
The competitive audit ranked tunnels eighth; the strategy waffled ("v1 if capacity
allows"). Both contradict their own persona: the target user touches production
weekly, and production Postgres overwhelmingly lives behind a bastion. By the
strategy's own v1 test — *zero walls in the first week* — no tunnel is a wall for
most of the audience, not a nice-to-have. **Resolved: SSH tunnels are a V1 must.**

**2 · Query history: deferred to v1.1 while the thesis claims "work cannot be lost."**
The strategy put history at P2/v1.1 but declared the "never lose work" half of the
thesis satisfied at v1 by scratch-tab persistence. Those two statements conflict:
executed-but-unsaved queries are work, and losing yesterday's ad-hoc query is the
exact loss the product exists to prevent. **Resolved: history joins the
never-lose-work pack, in V1.** Scratch persistence covers what you typed; history
covers what you ran.

**3 · Guarded typed writes: flagship in every audit, yet scheduled behind plumbing.**
The competitive audit scored it highest of all opportunities (value 5, differentiation
5); the strategy called it "the single highest-leverage feature the product can
build" — then scheduled it at P2 behind multi-connection, splitting, filters, and
signing. That ordering was acquisition-and-ease logic. Under impact + differentiation
it is indefensible: the walls make Quarry *usable*; guarded writes make it
*chooseable*. **Resolved: guarded execution moves ahead of the adoption walls** — it
is the demo, and every week it doesn't exist the product competes on politeness.

**4 · Command palette vs "one search surface."**
The competitive audit added a palette as killer feature #2; the UX test praised the
existing filter box; the strategy's simplification principle demands one search
surface. Building the palette *alongside* the filter box and library search would
violate the principle all three documents endorse. **Resolved: the palette ships only
as an absorption** — it replaces tree filtering and library search as the single
search surface, or it doesn't ship.

**5 · Signed builds: "biggest funnel leak" vs zero in-app impact.**
Two audits rank signing top-five; but by user impact it does nothing for anyone who
has already installed — its entire value is acquisition. It is not a feature and
should not compete with features for rank. **Resolved: reclassified as a release
gate** — a parallel task that must complete before v1 is announced, sequenced
against no feature.

**6 · Positive editability affordance vs the quiet-refusal design voice.**
The UX test wants the grid to announce "editable"; the original design language only
ever speaks negatively (refusals with reasons). A banner would be off-voice.
**Resolved: extend the existing footer vocabulary symmetrically** — the same quiet
line that today says "read-only · [reason]" says "editable · double-click a cell";
no new surface.

**7 · Statement splitting vs the one-statement principle.**
"One statement at a time" is a load-bearing design decision (the guard classifies per
statement), and splitting a buffer client-side could read as eroding it. It doesn't —
each split statement passes the classifier individually, preserving the invariant —
but no audit said so. **Resolved: splitting ships with the explicit constraint that
every fragment goes through the guard separately and execution stops at the first
error.** The principle survives intact.

## Removed as low-value

Cut from all prior lists; none returns without new evidence:

- **Cell peek** (pretty-print JSON on space) — pleasant, differentiates nothing.
- **Editor line-wrap option** — a preference toggle, and defaults are the product.
- **Insert qualified name at cursor / copy-name on tree rows** — micro-conveniences
  the palette obsoletes.
- **Live table stats extras** beyond what Structure already ships — marginal.
- **Error-position squiggle in the editor** — superseded: "Show me" already exists
  and works; a second presentation of the same fact adds surface, not information.
- **"Reopen closed tab"** — superseded by scratch persistence, which is strictly
  stronger (nothing to reopen if nothing is lost).
- **Modal insert form** — stays rejected, as the specs already decided.
- **Save-&-connect as its own item** — folded into the test-connection work.

## The unified roadmap

Four waves, ordered by impact × differentiation. Within a wave, order is free.

### Wave 1 — The screen never lies *(impact: existential · differentiation: is the brand)*

The audits agree on one thing above all: every beta defect is a trust defect, and
trust is the product. This wave is one coherent workstream, not a bug list:

1. **Truth pack:** results scoped to their tab · "truncated" true only when the app's
   cap cut the result · connect/switch progress with timeout and cancel · duplicate
   error rendering removed · the multi-statement error teaches `⌘↵` · "add id" advice
   corrected for aggregates · connection dropdown order frozen, tag chips as identity.
2. **Never-lose-work pack:** scratch-tab content persisted in the workspace SQLite
   (close becomes safe by construction, no confirm dialog needed) · **query history**
   — every executed statement recorded, searchable, restorable.
3. **Tree honesty:** views and materialized views appear (an invisible view is a lie
   of omission) · test connection in the form.

### Wave 2 — The flagship *(impact: high · differentiation: maximal — this is the moat)*

4. **Guarded execution for hand-written SQL.** Every typed `UPDATE`/`DELETE` runs in
   a transaction, reports its rowcount, and asks before committing past a threshold
   or a stated `-- expect: n`. Extends the shipped edit machinery to everything a
   human types. No competitor ships this as a default; after this exists, the
   product's pitch is a demo instead of a paragraph.
5. **Write audit log**, same machinery, same wave: every applied batch and every
   unlocked-prod statement recorded with SQL, rowcount, and generated undo where
   derivable.

### Wave 3 — The walls come down *(impact: high · differentiation: low — the price of admission)*

6. **Multiple simultaneous connections** — pool and guard state per connection,
   connection color everywhere.
7. **SSH tunnels** (promoted per contradiction 1).
8. **Table filter bar** compiling to always-visible SQL.
9. **Statement splitting** under the per-fragment guard constraint (contradiction 7).
10. **Grid presence:** visible cell focus and selection, the symmetric editability
    footer (contradiction 6), and the editing flow verified end-to-end on a real
    mouse — the stress test could not reach it.

**Release gate, in parallel:** signed and notarized builds with an update story.
Must be done before v1 is announced; blocks no wave.

### Wave 4 — The identity compounds *(impact: medium-high · differentiation: high)*

11. **Command palette as the single search surface** — absorbs tree filter, library
    search, table jump, and actions; the keyboard cheat-sheet (`⌘/`) rides along.
12. **Parameterized saved queries** (`:variable`, prompt on run).
13. **Git-native library** — status badges, one-key commit; the team story with zero
    infrastructure.

### V2 horizon (unchanged by this synthesis)

Session diff · EXPLAIN visualizer · real Linux/Windows support · optimistic
concurrency via `xmin` · primary-key editing.

## Why this order and not the strategy doc's

The strategy sequenced *stabilize → walls → moat*, which is how you schedule work by
risk and cost. This document sequences *trust → moat → walls*, which is how you rank
by impact and differentiation:

- **Trust first** is unchanged, but the reason is corrected: not because the fixes
  are small, but because every hour the screen lies, the product's only real asset
  depreciates — for its one current user and for every screenshot and demo made of it.
- **The moat before the walls** is the reversal. The walls (multi-connection,
  tunnels, filters) determine whether a switcher *can stay*; the flagship determines
  whether anyone *comes*. Under an impact-and-differentiation rule, the feature that
  makes the product chooseable outranks the features that make it merely usable —
  and shipping guarded writes early means every subsequent wall removed exposes more
  people to the differentiator, not to a polite-but-ordinary client.

One consequence to accept with eyes open: between waves 2 and 3, the product is
differentiated but still single-connection and tunnel-less — impressive to try,
hard to adopt. That is the correct trade under the stated rule: it front-loads the
reason to care, and adoption capacity arrives one wave later.
