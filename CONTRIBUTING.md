# Contributing

Bug reports, questions and pull requests are all welcome. This file covers the
two things about this codebase that are not obvious from reading it.

## Every decision lives in a pure module

Anything that decides something — whether a statement is a write, whether a
result can be edited, which SQL an edit generates, where the statement under
the cursor begins — lives in a module that takes plain data and returns plain
data, with no pool, no state and no clock:

| Module | Decides |
|---|---|
| `src-tauri/src/guard/` | whether a statement writes, and whether the lock allows it |
| `src-tauri/src/edit/decide.rs` | whether a result can be edited or take new rows |
| `src-tauri/src/edit/sql.rs` | the exact SQL and bound parameters an edit produces |
| `src/lib/statements.ts` | which statement the cursor is in |
| `src/lib/pendingEdits.ts` | what is staged, and what the grid shows after applying |

Components and Tauri command handlers stay thin: they carry data to these
modules and render what comes back. There is no component-test harness and
none is planned — if a component needs a test, the decision inside it belongs
in a pure module instead.

The payoff is that the tests are a case table rather than a sample. Adding a
rule means adding a row, not building a fixture.

## Tests have to fail when the code is wrong

Several tests in this project have, at one time or another, passed with the
code beneath them deleted — a migration test that never ran the migration, a
rowcount assert the test could not reach. So for anything load-bearing:

**Delete or weaken the code under your test, watch the test fail, then restore
it.** If it still passes, the test is decoration. This applies especially to
anything guarding a write: rollback behaviour, rowcount asserts, and the lock.

## Before opening a pull request

```bash
npm test
```

```bash
npm run build
```

```bash
cd src-tauri && cargo test
```

```bash
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

All four pass on `main` with no known-failing baselines, so anything red is
new. Integration tests need Docker running; they start their own Postgres 17.

## Style

Comments explain **why**, not what. The interesting comments in this codebase
record a decision and the option it beat — see `edit/sql.rs` on why identifiers
are quoted the way they are, or `guard/` on why the whole buffer is classified.
Match that register; skip comments that restate the line below them.

Commits use [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`) with a short subject.

## Design history

`docs/superpowers/specs/` holds a design spec per feature that needed one, and
`docs/superpowers/plans/` the implementation plan that followed it. They record
why decisions went the way they did, including rejected alternatives. Worth
reading before changing behaviour — several apparent oddities are deliberate
and explained there. `docs/BACKLOG.md` tracks deferred work with its reasoning.
