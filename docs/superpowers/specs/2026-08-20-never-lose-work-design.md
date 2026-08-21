# Never lose work — design

**Date:** 2026-08-20 · **Roadmap:** wave 1, item 2 of
`docs/audits/2026-08-20-unified-roadmap.md` · **Status:** approved, ready to plan.

## The problem, stated accurately

The UX stress test called this "a dirty tab dies from one click, silently" and
the roadmap asks for scratch persistence plus query history. Reading the code
first narrows it: **scratch content is already persisted.** `tabs.scratch_sql`
is a real column, autosaved per tab on a debounce, and restored on launch — a
typed-but-unsaved query already survives quitting the app.

Two holes remain:

1. **`close_tab` deletes the row**, so closing a tab destroys its text with no
   recovery of any kind.
2. **Nothing records what was executed.** A query typed, run, read, and then
   overwritten in the same buffer is gone — the exact loss the product exists
   to prevent.

And a hole in the union of the two: text typed, never run, then closed, which
neither persistence-while-open nor an execution log would catch.

## Decisions

Each was settled deliberately; none is a default.

**Closing keeps the text, and there is no confirm dialog.** Closing a tab stays
one click. Safety comes from the text being recoverable, not from asking. This
is what the roadmap means by "safe by construction".

**History records user-run statements, failures included.** Anything run from
an editor, whether it succeeded or errored — a statement you spent ten minutes
failing to get right is work. The app's own generated preview SQL is excluded:
browsing the schema tree would otherwise write an entry per click and the
signal would drown.

**Repeated runs collapse.** Identical SQL against the same connection updates
one row: `last_at` moves, `run_count` increments. A debugging loop that runs
one statement forty times leaves one entry, so the list shows forty different
queries rather than one repeated. The cost — per-run timings — is accepted.

**Nothing is pruned.** No age cap, no count cap. With repeats collapsed, growth
is slow, and a retention rule is a silent deletion of work, which is the thing
this feature exists to prevent.

**Identical text closes onto one row.** *(Revised 2026-08-20, after smoke
testing.)* The original decision kept every closed draft as its own row, on the
grounds that merging two would lose one. That reasoning does not survive
contact: two byte-identical drafts are indistinguishable, so keeping both
preserves nothing — and it broke the feature's own loop, because recovering a
draft from History and closing it again left another copy every time. Closing
text that matches an existing closed row for the same connection now moves that
row's `last_at` instead of inserting. Runs are unaffected; they already
collapsed.

**Scoped to the connection you are on, by default.** *(Revised
2026-08-21.)* The original decision showed every database's work, current
connection first, on the grounds that nothing should be hidden and that
people reconnect precisely in order to find an old query. The first half
does not survive use: both lists are read to answer a question about the
database in front of you, and rows from three other databases are noise
in the way of it. The second half does survive, so the other work is one
click away rather than gone — the view carries a scope toggle, and it is
only offered while there is a connection to scope to.

**One list, not two.** The user's question is "where is that thing I had", not
"was it typed or executed". Closed tabs and executed statements share one
surface.

**Activating a row opens a new tab already holding the SQL, and runs nothing.**
Already holding it, not filled afterwards: the editor seeds itself from whatever
the backend reports for the active tab, so a tab created empty and typed into a
moment later gets reset to empty by that seeding — the text only appeared after
switching tabs and back. `open_tab_with_sql` creates it with the text in one
call. It
matches the schema tree's rule that opening is not running, and it leaves the
current buffer alone — the alternative loses work inside the feature built to
stop losing work.

**Deletion is one row at a time, from a context menu.** SQL sometimes carries a
literal secret. There is no bulk clear: a one-click wipe of the never-lose-work
feature is a foot-gun.

## Storage

Schema version 5. One new table, discriminated by kind, because a run and a
closed buffer want different rules and two tables would need merging on every
read anyway:

```sql
create table if not exists recent (
    id            text primary key,
    kind          text not null,              -- 'run' | 'closed'
    sql           text not null,
    connection_id text references connections(id) on delete set null,
    title         text,                       -- the closed tab's name, if it had one
    first_at      text not null,
    last_at       text not null,
    run_count     integer not null default 0,
    duration_ms   integer,                    -- of the last run
    row_count     integer,                    -- of the last run
    error         text                        -- last run's message; null when it succeeded
);

create unique index if not exists idx_recent_run
    on recent(sql, connection_id) where kind = 'run';

create index if not exists idx_recent_last_at on recent(last_at);
```

`on delete set null` on the connection: deleting a connection must not delete
the queries written against it. The row keeps its SQL and loses its origin
chip.

The partial unique index is what makes the run collapse a single `insert … on
conflict do update` rather than a read-then-write race. It covers `kind='run'`
only.

Closed rows collapse too (see the revised decision above) but not through this
index, because SQLite treats NULLs as distinct in a unique index and two closed
rows with no connection are two rows with the same absence. Their match is
written by hand as update-then-insert, using `is` — SQLite's null-safe
comparison — so an absent connection matches an absent connection. Runs always
have a connection, since `execute` refuses without one, so the index is exact
for them.

Ids come from the existing `new_id()`, timestamps from `now()` (RFC 3339), both
in `library/store/mod.rs`.

## Write paths

**Runs are recorded in the `execute` command**, the single choke point every
statement passes through. It gains a `generated: bool` parameter, which the
frontend already carries — `runSql(sql, generated, target)` threads it today
for the truncation flag. Recording happens when `generated` is false, on both
the success and the error path, before the result or the error is returned.

A recording failure never fails the query. The workspace SQLite is not the
user's database, and a history write that fails must not turn a successful
`SELECT` into an error on screen; it goes to stderr. Nothing in the UI claims
"recorded", so a silent miss overstates nothing.

**Closes are recorded in `close_tab`**, inside the transaction that deletes the
tab, and only when the tab has non-empty `scratch_sql` and no `query_id` — a
saved query's text lives in `queries`, so closing its tab loses nothing and a
`recent` row would duplicate something that was never at risk. `connection_id`
is whatever was active at the time, which is context rather than provenance: a
tab is not bound to a connection.

## Read model

One store method returns every row; the ordering and filtering decision lives
in a pure frontend module, `src/lib/recent.ts`, with unit tests:

```ts
groupRecent(items, activeConnectionId, filter): RecentRow[]
```

Current connection's items first, then everything else, each group newest-first
by `last_at`. The filter matches SQL text and title, case-insensitively, on the
same terms as the schema tree's filter. Nothing is hidden by connection: a
query written against staging stays findable while connected to production.

## Surface

The sidebar is two stacked sections — Schema, sized; Queries, taking the rest —
with one resizer between them. A third stacked section would need two resizers
and three-way height maths in a sidebar that is already tight.

Instead **the bottom section becomes tabbed**: `Queries | History`, one header
row, two lists sharing the same space, the existing resizer untouched. They are
alternatives rather than competitors for height — you are either browsing work
you saved or recovering work you did not.

Each row shows its connection's tag chip, the first line of its SQL, and either
`NN× · <relative time>` with a `failed` marker when the last run errored, or the
tab's title when it is a closed buffer.

`Enter` or double-click opens a new tab holding the SQL. Right-click offers
Delete, which removes that row.

### On wave 4

The command palette is meant to become the single search surface, absorbing the
tree filter and library search. This adds a third box for it to absorb, which
is what absorption means — not a violation of the principle. The filter here
deliberately reuses the existing idiom so that absorbing it is mechanical.

## Testing

Following the house rule that every decision lives in a pure module with unit
tests:

- `src/lib/recent.ts` — grouping, ordering, filtering. Tested directly.
- Rust integration tests against the workspace SQLite: a run is recorded; a
  generated statement is not; a failed run is recorded with its error; an
  identical re-run collapses and increments rather than inserting; closing the
  same text twice keeps one row, including when there is no connection at all;
  recovering a draft and closing it again does not breed rows; closing an empty
  or whitespace-only tab records nothing; closing a saved query's tab records
  nothing; deleting a connection leaves its rows with a null `connection_id`; a
  v4 database upgrades to v5 with its existing rows intact.

Every new test gets a mutation check: delete the code under it, show the
failure, restore, show the pass.

## Out of scope

- **The write audit log** (wave 2) — applied edit batches go through
  `apply_row_edits`, not `execute`, and are deliberately untouched here.
- **Per-run timings.** Collapsing repeats trades them away knowingly.
- **Bulk clear**, and any settings surface.
- **Restoring a closed tab's cursor position, mode, or preview state.** The
  text is the work; the rest is furniture.
