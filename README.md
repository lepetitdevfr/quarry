# Quarry

A fast, keyboard-first PostgreSQL client for macOS with an Insomnia-style query
library and a production write-guard.

> Working notes, not the real README — that comes at the end.

## Status

Stage 1 of 6 is done: connect to a database, run SQL, browse results in a
virtualized grid. No saved queries, no safety guard yet — **do not point this at
a production database.**

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

## Layout

| Path | What lives there |
|------|------------------|
| `src/` | React + TypeScript UI |
| `src/lib/ipc.ts` | The only module that talks to Tauri |
| `src-tauri/src/conn/` | Connection config and pooling |
| `src-tauri/src/exec/` | Query execution and value conversion |
| `src-tauri/src/secrets.rs` | Keychain access |
| `docs/superpowers/specs/` | Design spec |
| `docs/superpowers/plans/` | Per-stage implementation plans |

Design spec: `docs/superpowers/specs/2026-08-13-quarry-design.md`
