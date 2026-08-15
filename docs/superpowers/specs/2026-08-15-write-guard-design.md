# Production Write-Guard — Design Spec

**Date:** 2026-08-15
**Status:** Approved, ready for implementation planning

Production connections are read-only until explicitly unlocked. Every
statement passes one chokepoint in Rust, and Postgres itself refuses
writes as a second net.

This implements Section 4 of `2026-08-13-quarry-design.md`, which called
it "the central feature".

---

## 1. Motivation

Nothing structural stops a query intended for dev from running against
prod. The `railway` connection is tagged PROD today and a `DELETE`
against it would run exactly as fast as against localhost.

This is also the gate on inline row editing, which the original spec
requires be "disabled entirely on `ReadOnly` connections". Editing is
the easiest possible path to an accidental production write — a
highlighted cell and a Save button — so the guard comes first.

## 2. Policy

| Policy | Behaviour |
|---|---|
| `Free` | Everything runs. Local and staging. |
| `ReadOnly` | Writes rejected until unlocked. Prod. |

Policy is **derived from the existing tag** — `Prod → ReadOnly`,
everything else `Free`. No new column, no migration.
`Tag::from_stored` already resolves anything unrecognised to `Prod`, so
a corrupted row lands locked rather than open.

There is deliberately **no middle "confirm each write" policy**. A
confirmation modal on a routine path gets dismissed reflexively, which
is the exact failure this feature exists to prevent. The lock is the
whole mechanism.

`ActiveConnection` gains `policy` and `unlocked_until: Option<Instant>`.
Neither is persisted: restarting relocks.

## 3. Classification

A new module, `src-tauri/src/guard/`, parsing with `sqlparser` under the
Postgres dialect. Classification is a pure function of a string — no
database, no state — which is what makes it testable in bulk.

**Read:**
- `SELECT` without `FOR UPDATE` / `FOR SHARE`
- `EXPLAIN` without `ANALYZE`
- `SHOW`
- `WITH` whose body **and every CTE** are reads

**Write — everything else:**
- `INSERT` / `UPDATE` / `DELETE` / `MERGE`
- All DDL, `TRUNCATE`
- `COPY … FROM`, `SELECT INTO`
- `CALL`, `DO`, `GRANT`
- `SELECT … FOR UPDATE` / `FOR SHARE`
- Any `WITH` containing a data-modifying CTE

**Unparseable is a write.** On a locked connection it is denied, with an
error naming the statement.

The whole buffer is classified and denied if **any** statement is a
write. Execution is untouched: `run_query` still calls
`client.prepare`, so a multi-statement buffer still fails at prepare
exactly as it does today. Multi-statement execution stays a separate
decision.

### The cost of strictness, accepted deliberately

`sqlparser` does not parse everything Postgres accepts — dollar-quoted
function bodies, some operators, certain `COPY` and `EXPLAIN` forms. On
a locked connection those are refused **even when they are harmless
reads**, and the only way through is to unlock.

That is the right trade. The alternative — a keyword fallback when the
parse fails — reintroduces exactly the string-matching the parser exists
to replace, and a comment or a CTE can fool it. A guard that is wrong in
the safe direction is annoying; one that is wrong in the other direction
is the reason the feature exists.

A one-shot "run anyway" button is rejected for the same reason as the
"confirm each write" policy: a bypass button is not a smaller lock, it
is no lock.

## 4. Enforcement, in two layers

The classifier is **not trusted on its own.**

1. **Session default.** Prod pools add
   `-c default_transaction_read_only=on` to the startup options, beside
   the existing `statement_timeout`. It survives the `DISCARD ALL` that
   runs when a connection returns to the pool, because it *is* the reset
   value — so every checkout starts read-only.
2. **Explicit opt-out while unlocked.** Execution wraps the statement in
   `BEGIN READ WRITE … COMMIT`, which overrides the session default for
   that transaction.

The point of the pair: **any future code path that forgets the
classifier is still refused by Postgres.** Inline editing, two stages
away, will issue `UPDATE`s through a path that does not exist yet. This
is what makes the design defense in depth rather than two spellings of
the same check.

**`BEGIN READ WRITE` overriding the session default must be proven by a
test against a real Postgres**, not assumed. The suite already uses
testcontainers. This is load-bearing enough that confidence is not
evidence.

## 5. Unlock

- **Per connection, per session. Never persisted** — restarting relocks.
- Requires typing the connection name exactly, or it is refused.
- **Fixed 30 minutes** from unlocking, not sliding. A sliding window can
  be kept alive indefinitely, which is the failure this guards against:
  a connection quietly writable for hours.
- Rust checks the deadline on every execute and is the **only**
  authority. The frontend countdown is display.
- An explicit `relock()` exists for finishing early.

## 6. Frontend

- A banner while unlocked: live countdown, Relock button.
- **Red window chrome while unlocked**, so the state is unmistakable
  across the whole window rather than in one corner of it.
- The unlock dialog requires the connection name typed exactly.
- A denial is **its own error kind**, quoting the offending statement
  and offering Unlock — not a generic query error. The user must be able
  to tell "the guard stopped this" from "Postgres rejected this".

## 7. Testing

**Classifier**, in bulk, as pure unit tests: every read form; every write
form; `WITH` containing a data-modifying CTE; `SELECT … FOR UPDATE`;
`EXPLAIN ANALYZE` versus plain `EXPLAIN`; unparseable input; empty
input; comment-only input.

**Guard decision:** `Free` allows a write; `ReadOnly` denies one;
unlocked allows; an expired unlock denies; the deadline is checked
against the clock rather than trusted from the frontend.

**Against a real Postgres:**
- `BEGIN READ WRITE` overrides `default_transaction_read_only=on`.
- A write is refused by the server when the classifier is bypassed
  entirely — proving layer 2 stands on its own.

## 8. Out of scope

- Multi-statement execution.
- A per-connection policy override independent of the tag. Changing a
  connection's policy means changing its tag, which is the honest thing
  anyway: if you are guarding it, it is prod.
- Inline row editing, which follows this stage and depends on it.

## 9. Stage order after this

**Inline row editing** — edits stage as pending diffs with highlighted
cells; a bottom bar shows the pending count with Cancel and Review;
review shows the generated `UPDATE` statements; applying runs them in a
single transaction. Disabled entirely on a locked connection. Rows
without a primary key are not editable and must say why, since an
`UPDATE` cannot otherwise identify one row.
