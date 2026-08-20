# Guarded writes and the write audit log — design

**Date:** 2026-08-21 · **Roadmap:** wave 2 of
`docs/audits/2026-08-20-unified-roadmap.md` — the flagship · **Status:**
approved, ready to plan.

## What this is for

The competitive audit scored guarded typed writes highest of every
opportunity it found, and the strategy doc called it "the single
highest-leverage feature the product can build". The shipped edit
machinery already does this for the grid: an edit batch runs in one
transaction, each statement asserting exactly one affected row, and
anything else rolls the whole batch back. Everything a person types by
hand runs with none of that.

After this exists, the product's pitch is a demo rather than a paragraph.

## Decisions

**A held transaction, bounded by hard timeouts.** `BEGIN`, execute, read
the rowcount, and wait for the human. This is the only shape where the
number on screen is the number that will be committed — the alternatives
(count first, or dry-run then re-execute) each show a figure from a
different moment than the write, which is the exact class of lie this
product exists to remove. What makes holding it safe is that Postgres,
not the app, enforces the limits: `idle_in_transaction_session_timeout`
rolls it back if the user walks away, and `lock_timeout` stops it queueing
behind somebody else's lock.

**Every write goes through it, but DDL is judged differently.** `DROP`,
`TRUNCATE` and `ALTER` report no rows, and they are the statements that
end careers — leaving them uncovered would put the guard's silence
exactly where the danger is. They take the same transaction and are
described by what they name: `this drops public.orders, ~5M rows`, from
the schema cache already in memory.

**Production always asks; elsewhere a threshold does.** A `prod`-tagged
connection asks on every write — the unlock ritual already established
that this database is worth a ceremony. Local and staging commit straight
through up to `ASK_ABOVE_ROWS` and ask above it. The tag already encodes
what the database is worth; a single number for both would end up tuned
for the wrong one.

**`-- expect: n` is an assertion, not a hint.** A mismatch rolls back and
reports both numbers. You stated a fact about your data and the database
disagreed: that is a failed assertion, not a decision to make under time
pressure with a dialog in your face. A match commits straight through
even on production — declaring the count in the statement is a stronger,
more deliberate promise than clicking a button.

**Undo is derived only where it is free.** A grid edit already has the
old values on screen and the key in hand, so its undo costs nothing to
generate and stores no new data. Deriving undo for typed SQL would mean
reading the affected rows and writing production data — possibly personal
data — into an unencrypted SQLite file in the user's home directory. The
log records typed statements without undo instead, and says so.

**The audit log is its own table.** `recent` collapses repeats and can be
deleted a row at a time, and both are wrong here: every occurrence is a
separate fact, and forgetting one defeats the point.

## Stage A — guarded execution

### The decision, as a pure function

New module `src-tauri/src/guard/plan.rs`:

```rust
pub enum Verdict {
    Commit,
    Ask { summary: String },
    Refuse { reason: String },
}

pub fn verdict(
    tag: Tag,
    kind: WriteKind,          // Update | Delete | Insert | Ddl | Other
    affected: Option<u64>,    // None for DDL
    expect: Option<u64>,      // from `-- expect: n`
    object: Option<&str>,     // "public.orders, ~5M rows", for DDL
) -> Verdict
```

No pool, no clock, no IO — the same shape as `guard::decide` and
`edit::decide`, and for the same reason: the rule table gets tested
exhaustively rather than representatively.

The rules, in order:

1. `expect` present and `affected` disagrees → `Refuse`, naming both
   numbers.
2. `expect` present and matches → `Commit`, whatever the tag.
3. DDL → `Ask`, described by `object`.
4. Tag is `prod` → `Ask`.
5. `affected` above `ASK_ABOVE_ROWS` → `Ask`.
6. Otherwise → `Commit`.

`ASK_ABOVE_ROWS` is 100, a constant rather than a setting. Defaults are
the product.

Reading `-- expect: n` out of the statement is its own pure function in
the same module, tested against the cases that matter: absent, present,
several (the last wins, matching how a person edits), and malformed
(ignored — a typo in a comment must not silently disarm the guard, so an
unparseable annotation is treated as absent and the ordinary rules
apply).

`WriteKind` comes from the parse `guard::classify` already performs, so
the two cannot disagree about what a statement is. A statement the
parser cannot read is already classified `Write`; its kind is `Other`
and it is judged on its rowcount like any DML, which is the safe
direction — it can only ask more often than it must.

This runs **after** the existing guard, never instead of it.
`guard::decide` still decides whether a statement may run at all: a
write on a locked production connection is denied before any of this is
reached, and the unlock ritual is unchanged. `verdict` only decides what
to do about a statement that is already allowed.

### The protocol

`execute` becomes two phases, over two commands.

`execute(sql, generated)` — checks a connection out of the pool and
**holds it**, opens a transaction, runs the statement, and asks
`verdict`:

| Verdict | What happens |
|---|---|
| `Commit` | commits, returns the result — indistinguishable from today |
| `Refuse` | rolls back, returns the reason as an error |
| `Ask` | leaves the transaction open, parks the held connection in `AppState` under a token, returns `Pending { token, affected, summary }` |

`resolve(token, commit: bool)` — commits or rolls back the parked
transaction and returns the result.

Reads take none of this: a statement the classifier calls `Read` runs
exactly as it does now, no transaction, no parking.

**One pending transaction at a time.** The app has one connection and one
editor. Starting another run while one is parked rolls the parked one
back first, and says so — a hidden lock you have forgotten about is worse
than a cancelled statement you can see.

**The timeouts.** `startup_options` in `conn/pool.rs` already sets
`statement_timeout`; this adds `idle_in_transaction_session_timeout` at
15 seconds and `lock_timeout` at 5. They are `-c` startup options, so
they survive `DISCARD ALL` and cannot be undone by a stray `SET` — the
same reasoning that makes `default_transaction_read_only` a real
protection rather than a suggestion.

`resolve` therefore has to treat "the transaction is already gone" as an
ordinary outcome: Postgres may have rolled it back while the dialog was
open. It reports that plainly — the statement did not run — rather than
failing in a way that reads as a bug.

A token that names no parked transaction — because it was already
resolved, or the app restarted — reports that there is nothing to
resolve. It is not an error state: the statement did not run, which is
the same thing the user would have been told had they waited.

Dropping the connection also ends the transaction, so quitting the app or
switching connections while one is parked rolls it back. That is the
correct default and needs no extra machinery.

### What the user sees

A confirmation carrying the number and the statement: `4,812 rows will
change` with Commit and Discard, the same voice as the existing
`ConfirmDialog`. On DDL: `this drops public.orders, ~5M rows`. On a
refusal there is no dialog at all — the error panel already exists and
already explains refusals with reasons.

## Stage B — the write audit log

### Storage

Schema version 6, one table:

```sql
create table if not exists writes (
    id              text primary key,
    at              text not null,
    connection_id   text references connections(id) on delete set null,
    connection_name text not null,
    tag             text not null,
    sql             text not null,
    kind            text not null,
    row_count       integer,
    outcome         text not null,
    reason          text,
    undo_sql        text
);

create index if not exists idx_writes_at on writes(at);
```

`connection_name` and `tag` are copied rather than joined. The row must
still say which database it hit after that connection is renamed or
deleted; an audit line that loses its subject is not an audit line.

`outcome` is one of `committed`, `rolled_back`, `refused`, `failed`. A
rollback is recorded as deliberately as a commit — "I nearly truncated
orders and stopped" is exactly the fact worth having six months later.

Nothing here collapses and nothing is deleted, which is what separates
this table from `recent`.

### What writes to it

Both write paths, at the point each one ends:

- guarded execution, on every outcome including the refusals and the
  transactions Postgres timed out;
- `apply_row_edits`, the grid's batch, which today records nothing.

A failure to write the audit row never fails the user's statement — the
same rule history follows, and for the same reason: the workspace
database is ours, and their query really did run. It goes to stderr.

### Undo

Generated in Rust beside the batch builder in `edit/sql.rs`, from the
rows the grid already holds:

- an update's undo is the reverse update, per row, keyed by the primary
  key that made the edit legal in the first place;
- a delete's undo is an insert of the row that was deleted;
- an insert has no undo recorded, because the key the database assigned
  is not returned by the batch today, and a guess would be worse than an
  honest gap.

Typed SQL records no undo. The column is null and the UI says so rather
than implying the statement is reversible.

The undo is text: readable, copyable, openable in a tab. Running it is a
separate feature and does not need to exist for the log to be worth
having.

### Surface

A third tab in the sidebar section wave 1 made tabbed: `Queries |
History | Writes`. Each row shows the statement, its outcome, its
rowcount, and the connection's tag chip. Ordering and filtering are
decided in a pure frontend module beside `lib/recent.ts`.

## Testing

- `guard/plan.rs` — the verdict table, exhaustively: every combination of
  tag, kind, rowcount and `expect`. Pure, no database.
- `-- expect:` parsing — absent, present, repeated, malformed.
- Integration, against real Postgres via testcontainers: a commit path, a
  rollback path, an `expect` refusal leaving the table untouched, and
  `resolve` called on a transaction the timeout has already ended.
- Audit rows asserted for each outcome, including the refusals.
- Undo generation from a known batch, asserted statement for statement.

Every new test gets a mutation check: delete the code under it, watch it
fail, restore, show both outputs.

## Out of scope

- **Running the undo from a button.** The log holds text.
- **Undo for typed SQL**, and therefore before-images of any kind. The
  reasoning is in the decisions above; revisiting it means revisiting
  whether production data belongs in the workspace file.
- **More than one parked transaction.**
- **Configurable thresholds or timeouts.**
