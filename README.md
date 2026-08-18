# Quarry

[![CI](https://github.com/lepetitdevfr/quarry/actions/workflows/ci.yml/badge.svg)](https://github.com/lepetitdevfr/quarry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A fast, keyboard-first PostgreSQL client for macOS, with an Insomnia-style
query library and a production write-guard that is on by default.

Quarry exists because the two things that go wrong with a database GUI are
losing your queries and running the wrong one against production. So queries
live in a saved, named library rather than in scratch tabs you close by
accident, and a connection tagged **Prod** refuses to write until you
deliberately unlock it.

Built with Tauri 2, Rust and React — a native window, not a browser tab, and
no server between the app and your database.

## Status

Everything planned for v1 is built: connecting and running SQL, the query
library with tabs, saved connections with Keychain-stored passwords, a schema
tree with autocomplete, preview and table-detail tabs, grid sort and resize,
copy and export, the production write-guard, and inline row editing with
deletion and insertion.

There are no packaged downloads yet — you build it yourself, and it is macOS
(Apple Silicon) only. See [Limitations](#limitations).

## What it does

**Run SQL.** `⌘↵` runs the statement your cursor is in, so a scratchpad of
several statements works the way you expect. Results stream into a virtualized
grid that stays responsive on large result sets; columns sort and resize, and
`NULL` is rendered distinctly from an empty string everywhere, because the
difference changes what you write next.

**Keep your queries.** A collection tree of saved queries, each mirrored to a
`.sql` file on disk so the library is greppable and diffable outside the app.
Tabs behave like a real editor: a single click opens a preview tab that the
next click replaces, a double click pins it.

**Know the schema.** A sidebar tree of schemas, tables, columns, keys and
indexes, feeding SQL autocomplete. Double-clicking a table opens a detail tab
with its structure, or its rows.

**Edit rows in place.** Double-click a cell to change it, `⌘⌫` for SQL `NULL`,
`⇧⌘⌫` to stage a row for deletion, `⇧⌘N` to stage a new one. Enum and boolean
cells offer their values as a list. Changes stage as highlighted diffs with a
count, and Confirm applies them in a single transaction — every statement must
affect exactly one row or the whole batch rolls back, so a partial apply cannot
leave the grid disagreeing with the database.

The generated `WHERE` comes from the primary key, never from parsing your SQL:
Postgres itself reports which table and column each result cell came from. A
result is editable only when it comes from one ordinary table whose primary key
is in the result, and when it is not, the grid says which rule stopped it — a
join, a view, an aggregate, a missing key — rather than silently going
read-only.

**Refuse to write to production.** A connection tagged **Prod** is read-only
until you unlock it by typing its name, and relocks after 30 minutes. The lock
is enforced three times over: the UI hides the affordances, the Rust classifier
refuses the statement, and the session runs with
`default_transaction_read_only=on` so Postgres refuses it too. A bug in the
classifier is not enough to write to production.

## Download

[**Latest release**](https://github.com/lepetitdevfr/quarry-releases/releases/latest)
· [Download page](https://lepetitdevfr.github.io/quarry-releases/)

**Everything here is beta.** Quarry is pre-1.0 and unsigned, and one person
has used it in earnest. It reads and writes real databases — keep the
write-guard on for anything that matters.

**macOS (Apple Silicon)** is the tested build: a `.dmg`, or a `.zip` of the
`.app`. **Linux (`.deb`, `.AppImage`) and Windows (`.msi`, `.exe`) are beta** —
they build in CI and have never been run on a real machine. Their credential
stores, kernel keyutils and Credential Manager, are compiled but unexercised,
and the fonts and `⌘` labels are still macOS-shaped.

The build is **unsigned**, so macOS quarantines it and refuses the first open.
Clear the flag after dragging Quarry to Applications:

```bash
xattr -dr com.apple.quarantine /Applications/Quarry.app
```

This is not a workaround for a broken app — it is what an app without a $99/yr
Apple Developer signature looks like on macOS. If that trade is not acceptable,
build from source below; the result is identical.

## Staying up to date

Quarry checks the releases repo once at launch and shows a quiet banner when a
newer version exists. It links to the download page rather than installing
anything: builds are unsigned and there is no updater, so an app that replaced
itself would be claiming more than it can honestly do. "Stop checking" in the
banner turns the check off for good.

## Requirements

- macOS (Apple Silicon), Xcode Command Line Tools
- Rust, via Homebrew rustup — if `cargo` is not found:
  `export PATH="/opt/homebrew/opt/rustup/bin:$PATH"`
- Node 22+
- Docker, for the integration tests only

## Run it

```bash
npm install
```

```bash
npm run tauri dev
```

The first build compiles the whole Rust dependency tree and takes a few
minutes; later runs start in seconds. The frontend hot-reloads; changing Rust
triggers a rebuild and restart.

Build a release binary:

```bash
npm run tauri build
```

## A database to play with

```bash
docker run --rm -d --name quarry-smoke -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17
```

Paste this into the app's connection field:

```
postgres://postgres:postgres@localhost:55432/postgres?sslmode=disable
```

Stop it with `docker stop quarry-smoke`.

## Keyboard

| Key | Action |
|-----|--------|
| `⌘↵` | Run the statement under the cursor |
| `⇧⌘↵` | Run the whole buffer (one statement's worth, or Postgres refuses it) |
| `↵` / double-click | Edit the focused grid cell |
| `⌘⌫` | Stage SQL `NULL` in the focused cell |
| `⇧⌘⌫` | Stage the selected row for deletion, or undo it (discards a staged new row) |
| `⇧⌘N` | Stage a new row in the result grid |
| `esc` | Cancel the cell edit in progress |
| `⌘S` | Save the current query to the library |
| `⌘W` | Close the active tab (the window, once no tabs are left) |
| `⇧⌘W` | Close the window |

## Limitations

Honest list, not a roadmap. Items with a plan behind them are in
[`docs/BACKLOG.md`](docs/BACKLOG.md).

- **All builds are beta, macOS included.** Pre-1.0, unsigned, and exercised by
  one person on one machine. Linux and Windows are further back still: they
  compile and package in CI but have never been run, their credential backends
  are unexercised, and the fonts and shortcut labels assume a Mac.
- **Downloads are unsigned.** They install, but macOS quarantines them until
  you clear the flag (see [Download](#download)). Signing needs a paid Apple
  Developer account.
- **One statement at a time.** Postgres refuses a multi-statement prepared
  statement, so `⇧⌘↵` on a buffer holding several fails. `⌘↵` runs the one
  under the cursor.
- **One live connection at a time.** Switching closes the previous pool.
- **Editing has edges:** primary keys of existing rows cannot be edited, views
  are not editable even when Postgres would allow it, the last write wins on a
  concurrent change, and an empty string cannot be inserted into a text column
  from the grid.

## Development

```bash
npm test
```

```bash
cd src-tauri && cargo test
```

```bash
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

All of these pass on `main`; there are no known-failing baselines, so a failure
is something you just changed.

**Releasing is manual.** Actions → Release → Run workflow. semantic-release
reads the commits since the last tag, picks the version, writes the changelog,
tags, then builds and publishes. Merging to `main` does not release: three
platforms take about twenty minutes and most commits do not deserve a build.
Tick *dry run* to rehearse without publishing.

CI runs all of it: an Ubuntu job runs the full Rust suite, database tests
included, and a macOS job runs clippy, fmt, the unit tests and a build. Both
exist for a reason — Linux has the Docker daemon testcontainers needs, macOS
is the platform users run and the only one that compiles the Keychain path.

Rust integration tests start a throwaway Postgres 17 through testcontainers, so
Docker must be running. A further set in `src-tauri/tests/smoke_local.rs` is
`#[ignore]`d because it expects a hand-started database on port 55432:

```bash
cd src-tauri && cargo test --test smoke_local -- --ignored --nocapture
```

**Every decision lives in a pure module with unit tests** — `guard/` for
statement classification, `edit/decide.rs` and `edit/sql.rs` for row editing,
`lib/statements.ts` for finding the statement under the cursor,
`lib/pendingEdits.ts` for staged changes. Components and command handlers stay
thin enough to be read at a glance, which is what keeps the test suite a case
table rather than a sample.

### Layout

| Path | What lives there |
|------|------------------|
| `src/` | React + TypeScript UI |
| `src/lib/ipc.ts` | The only module that talks to Tauri |
| `src-tauri/src/conn/` | Connection config and pooling |
| `src-tauri/src/exec/` | Query execution and value conversion |
| `src-tauri/src/guard/` | Statement classification and the lock |
| `src-tauri/src/edit/` | Row-editing decisions, SQL generation, apply |
| `src-tauri/src/library/` | Saved queries, tabs, and the SQLite workspace |
| `src-tauri/src/schema/` | Catalog introspection |
| `src-tauri/src/menu.rs` | The app menu, so ⌘W closes a tab |
| `src-tauri/src/secrets.rs` | Keychain access |
| `CLAUDE.md` | Orientation for a new contributor, human or otherwise |
| `docs/superpowers/specs/` | Design specs, one per feature that needed one |
| `docs/superpowers/plans/` | Per-stage implementation plans |
| `docs/BACKLOG.md` | Deferred work, each entry with its reasoning |

The original design spec is
[`docs/superpowers/specs/2026-08-13-quarry-design.md`](docs/superpowers/specs/2026-08-13-quarry-design.md).
The specs are worth reading before changing behaviour: each records why a
decision went the way it did, including the options that were rejected.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — in particular the two house rules,
that every decision lives in a pure module with unit tests, and that a test
must be shown to fail when the code under it is broken.

Security issues go through [SECURITY.md](SECURITY.md), privately, not through
a public issue.

## License

[MIT](LICENSE) © Lepetitdev

