# Quarry

A fast, keyboard-first PostgreSQL client for macOS with an Insomnia-style query
library and a production write-guard.

> Working notes, not the real README — that comes at the end.

## Status

All planned stages are done: connect and run SQL, the query library with tabs,
saved connections, the schema tree with autocomplete, preview and table-detail
tabs, grid sort/resize, copy and export, the production write-guard, and inline
row editing.

**Inline row editing.** Double-click a cell to edit it, `⌘⌫` to set NULL.
Changes stage as highlighted pending diffs with a bottom bar showing the count;
Confirm applies them in one transaction, and `View SQL` shows the generated
statements first if you want them. A result is editable only when it comes from
one ordinary table whose primary key is in the result — a join, a view, an
aggregate, or a table without a key says why it is read-only. Disabled entirely
on a locked production connection.

A connection tagged **Prod** is read-only until you unlock it by typing its name,
and relocks after 30 minutes. Postgres enforces this itself as a second layer, so
a bug in the classifier is not enough to write to production.

## Requirements

- macOS (Apple Silicon), Xcode Command Line Tools
- Rust (via Homebrew rustup) — if `cargo` is not found, add it to PATH:
  `export PATH="/opt/homebrew/opt/rustup/bin:$PATH"`
- Node 22+
- Docker, for the integration tests only

## Run it

```bash
npm install
npm run tauri dev
```

First build compiles the whole Rust dependency tree and takes a few minutes;
later runs are seconds. The frontend hot-reloads; changing Rust triggers a
rebuild and restart.

## A database to play with

```bash
docker run --rm -d --name quarry-smoke \
  -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17
```

Paste this into the app's connection field:

```
postgres://postgres:postgres@localhost:55432/postgres?sslmode=disable
```

Stop it with `docker stop quarry-smoke`.

## Tests

```bash
npm test
```

```bash
cd src-tauri && cargo test
```

Rust integration tests start their own throwaway Postgres via testcontainers, so
Docker must be running. A further set in `src-tauri/tests/smoke_local.rs` is
`#[ignore]`d because it expects a hand-started database on port 55432:

```bash
cd src-tauri && cargo test --test smoke_local -- --ignored --nocapture
```

## Build a release binary

```bash
npm run tauri build
```

## Keyboard

| Key | Action |
|-----|--------|
| `⌘↵` | Run the statement under the cursor |
| `⇧⌘↵` | Run the whole buffer |
| `↵` / double-click | Edit the focused grid cell |
| `⌘⌫` | Stage SQL `NULL` in the focused cell |
| `esc` | Cancel the cell edit in progress |

## Layout

| Path | What lives there |
|------|------------------|
| `src/` | React + TypeScript UI |
| `src/lib/ipc.ts` | The only module that talks to Tauri |
| `src-tauri/src/conn/` | Connection config and pooling |
| `src-tauri/src/exec/` | Query execution and value conversion |
| `src-tauri/src/guard/` | Statement classification and the lock |
| `src-tauri/src/edit/` | Row-editing decisions, SQL generation, apply |
| `src-tauri/src/secrets.rs` | Keychain access |
| `docs/superpowers/specs/` | Design spec |
| `docs/superpowers/plans/` | Per-stage implementation plans |

Design spec: `docs/superpowers/specs/2026-08-13-quarry-design.md`
