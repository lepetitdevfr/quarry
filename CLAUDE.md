# Quarry — working notes for Claude

**This file is loaded automatically. Read nothing else until a task needs it.**
It exists so a session does not start by reading the design specs and stage
plans, which cost thousands of lines before any work began.

## What Quarry is

A keyboard-first PostgreSQL desktop client for macOS. Tauri 2 + Rust backend
(`src-tauri/`), React 19 + TypeScript frontend (`src/`). See `git tag` for the
sequence of shipped stages, and `README.md` for what it does.

Releases are manual: Actions → Release → Run workflow. semantic-release picks
the version from the commit messages, builds macOS, Linux and Windows, and
publishes to the **public** repo `lepetitdevfr/quarry-releases` — this repo
stays private. When Actions minutes run out,
`scripts/release-local.sh` does the same three steps on this Mac — macOS
`.dmg` only, since a Mac cannot build the Linux or Windows bundles.

## The load-bearing decisions

These are the ones that explain most of the code. Each has a spec if you need
the reasoning; do not re-derive them.

- **Row identity comes from Postgres, never from parsing SQL.**
  `table_oid`/`column_id` on the prepared statement's columns say which table
  each result cell came from. Editing is refused unless every column agrees on
  one ordinary table whose primary key is in the result.
- **The write-guard is three layers:** UI hides the affordance, the Rust
  classifier refuses the statement, and the session runs
  `default_transaction_read_only=on`. A prod connection unlocks by typing its
  name and relocks after 30 minutes.
- **Edits apply in one transaction**, each statement asserting exactly one
  affected row; anything else rolls the whole batch back. Batch order is
  updates → deletes → inserts.
- **Every decision lives in a pure module with unit tests.** Rust: `guard/`,
  `edit/decide.rs`, `edit/sql.rs`. Frontend: `lib/pendingEdits.ts`,
  `lib/statements.ts`. No component-test harness exists and none is planned.
- **One statement at a time.** `⌘↵` runs the statement under the cursor;
  Postgres refuses multi-statement prepared statements.

## How we work

- One stage per branch. Process scales to the stage: lean by default (short
  plan, one subagent, no brainstorm or spec); the full brainstorm → spec → plan
  flow only for write paths or open design questions. Say which was picked.
- Work inline in the main thread. Subagents are off — they start cold and
  re-derive context the main thread already holds.
- **Ask for mutation results as evidence, not assurances.** Tests in this
  project have passed with the code under them deleted. Delete the code, watch
  the test fail, restore it, and report both outputs.
- Smoke testing is the user's. Once they say a stage is clean: merge
  fast-forward only, tag, push, delete the branch — without asking again.
- Commits use Conventional Commits, no `Co-Authored-By` trailers.

## Verification — all pass on `main`, so any failure is new

**Nothing on GitHub runs these on push any more.** CI triggers only from the
Release workflow (and manually), to keep a private repo's Actions minutes for
builds that ship. Between releases these commands are the only gate, so run
them before you consider a stage done.

```bash
npm test && npm run build
```

```bash
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

Rust integration tests need Docker; they start Postgres 17 via testcontainers.

## Environment facts worth not rediscovering

- Two saved connections: **`railway` is real production — never smoke test
  writes against it.** `lifegame` is local and is where write testing belongs.
- Back up the workspace SQLite with `sqlite3 db ".backup 'out.db'"`, never
  `cp` — the path contains a space, so the destination needs inner quotes, and
  a plain copy of a WAL database captures no tables.
- `src-tauri/src/menu.rs` hand-rolls the macOS menu so ⌘W closes a tab. Its
  Edit submenu is what makes ⌘C/⌘V/⌘Z work in the SQL editor — do not prune it.
- **When a Tauri API does nothing and reports nothing, check
  `src-tauri/capabilities/default.json` first.** `core:default` is narrower
  than it looks: window dragging needed `core:window:allow-start-dragging`
  added explicitly, and the denial was silent. Capability changes need a
  `tauri dev` restart — they compile into the binary.
- **Schema changes are versioned steps, not edits to a converged batch.**
  `src-tauri/src/library/db.rs` holds a `BASELINE` (the v7 schema, still
  idempotent, applied once to every database that predates versioning) and a
  `MIGRATIONS` list of steps past it, stamped into SQLite's `user_version`
  inside the same transaction. To change the schema, append one entry to
  `MIGRATIONS` — never edit a step that has shipped, and never add to the
  baseline. `SCHEMA_VERSION` derives itself from the list length.
- **A migration test must never pin the schema version number.** Assert
  `SCHEMA_VERSION`, not the literal — the test's job is that the new
  table arrived and the old rows survived, and a hardcoded number breaks
  the suite on the next bump. This has been rediscovered three times.
- **Smoke testing starts from a known database.** `scripts/smoke-db/up.sh`
  runs the persistent `quarry-smoke` Postgres on `localhost:55432`;
  `scripts/smoke-db/reset.sh` puts its data back exactly as `seed.sql`
  describes — 500 customers, 5000 orders, 121 revenue rows, one view.
  Run the reset after any smoke test that writes, or the next one starts
  from whatever the last one left. The seed itself only ever runs on an
  empty volume, which is why the reset exists; `up.sh` seeds a volume
  that has no schema but never overwrites data that is there.
- **Tests must never reach the real Keychain.** macOS ties an "Always
  Allow" grant to the requesting binary's signature and `cargo test`
  re-links a differently-signed one on every build, so a suite that
  touches it prompts on every run forever and no amount of allowing
  settles it. `Store::open_at` — the test constructor — wires
  `secrets::EphemeralCredentials`; `Store::open()` wires
  `secrets::Keychain`. Reach credentials through the store
  (`save_connection_password`, `load_connection_password`), never
  `secrets::*_password` directly.
- `src-tauri/src/menu.rs` holds the codebase's **only** `cfg(target_os)`.
  Credentials go through `keyring`, so everything else compiles on any
  platform — keep it that way.
- The window has no title bar (`titleBarStyle: "Overlay"`). A 28px
  `.drag-strip` carries the traffic lights and the window drag; its height and
  `.app.with-sidebar`'s `padding-top` must stay equal.
- GitHub lists "claude" as a contributor. That is a cached GitHub statistic,
  not a git problem; the repo is clean. Do not rewrite history over it.

## Where to look when you need more

| Need | File |
|---|---|
| What to build next, and why | `docs/audits/2026-08-20-unified-roadmap.md` — four waves, ranked by impact |
| Open work, with reasoning | `docs/BACKLOG.md` |
| Product audits behind the roadmap | `docs/audits/` — competitive, UX stress test, strategy |
| Why a feature works the way it does | `docs/superpowers/specs/` — one per feature |
| How a stage was executed | `docs/superpowers/plans/` — execution history, rarely worth reading |
| Running the app, keyboard, limitations | `README.md` |
| House rules for changes | `CONTRIBUTING.md` |

The specs are the reference. The plans are a record of work already done —
read one only when investigating how something got built.
