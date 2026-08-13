# Saved Connections and Fast Switching — Design Spec

**Date:** 2026-08-14
**Status:** Approved, ready for implementation planning
**Supersedes:** the original Stage 3 (environments, variables, write-guard), which
moves later in the roadmap

Save connection configurations and switch between databases in two clicks.

---

## 1. Motivation

Today the app forgets everything on quit: every launch means pasting a
connection URL again. Working across a local database and a staging one means
retyping both.

This stage makes connections first-class records — named, tagged, and
switchable from the header.

**A note on ordering.** The write-guard was the original motivation for the
whole project. Making connections easier to switch makes an accidental
production query *more* likely, not less. The guard is deferred deliberately,
and the `tag` field below is the hook it will read when it arrives. Until then
the app offers no protection against writing to a connection tagged `prod`.

## 2. Scope

### In scope

- A `connections` table: name, target, tag, colour, last-used
- Passwords in the macOS Keychain, keyed by connection id
- A header dropdown listing saved connections, most-recently-used first
- Switching: disconnect the current connection, connect the new one
- Creating, editing, and deleting connections
- A connection picker on launch — the app never auto-connects
- Refactoring `AppState` from a pool map to a single active connection

### Out of scope

- Environments and `{{variable}}` substitution
- The production write-guard (the `tag` field is groundwork only)
- More than one live connection at a time
- Connection folders or grouping — a flat, most-recently-used list is enough
- SSH tunnels, TLS certificate configuration (unchanged non-goals)
- Importing connections from DBeaver, `.pgpass`, or similar

## 3. Decisions

**One connection at a time.** Switching disconnects the previous connection.
Local connections reconnect fast enough that keeping idle sockets open is not
worth the extra state.

**Connections live in the existing workspace database**, as a fifth table
beside `collections`, `queries`, `tabs`, and `meta`. Same `db.rs`, same
migration path, same `Store` pattern. A separate database or a config file
would mean two storage mechanisms for no gain.

**Tabs are global; results are not.** Switching keeps open tabs — they are SQL
text and connection-independent — and clears the result grid. Results from the
previous database must never sit on screen under a new connection's name.

**A failed switch leaves you disconnected.** No silent fallback to the previous
connection: believing you switched when you did not is the dangerous state.

**The app never connects on its own.** Launch opens the picker and waits for a
deliberate choice. Auto-reconnecting to the last used connection would be more
convenient, but with no write-guard yet it means the app could boot straight
into a production database with a query already in the editor from last
session. One click is a cheap price for always knowing what you are attached
to.

**Tag and colour ship now**, even though nothing enforces them yet. Adding them
later would mean a schema migration, and the tag is what the guard will read.

## 4. Data

### `connections` table

| Column | Type | Notes |
|---|---|---|
| `id` | text primary key | UUID v4, generated in Rust |
| `name` | text not null | User-facing label, e.g. `kolecto-dev` |
| `host` | text not null | |
| `port` | integer not null | |
| `user` | text not null | |
| `dbname` | text not null | |
| `sslmode` | text not null | `disable` / `prefer` / `require` |
| `tag` | text not null | `local` / `staging` / `prod` |
| `colour` | text not null | Hex, defaulted from the tag |
| `last_used_at` | text | ISO 8601; NULL until first use |
| `created_at` | text not null | ISO 8601 |

**No password column.** Passwords go to the Keychain under the existing
`com.quarry.app` service, with the connection id as the account — exactly how
`secrets.rs` is already keyed.

Deleting a connection deletes its Keychain entry in the same operation. A
failure to delete the credential is surfaced, not swallowed: `delete_password`
already distinguishes "absent" from "could not delete".

## 5. Architecture

### State

`AppState` currently holds `Mutex<HashMap<String, Pool>>`, from when Stage 1
anticipated several live connections. With one connection at a time that map is
misleading, so it becomes:

```rust
active: Mutex<Option<ActiveConnection>>   // { id, pool, info }
```

Consequences, all simplifications:

- `execute` loses its `connection_id` argument — there is only one connection
- `AppError::UnknownConnection` is deleted
- the duplicate-id pool leak found in the Stage 1 review disappears
- `disconnect` closes the pool and clears the slot

This touches Stage 1 code. The existing 102 tests passing afterwards is the
acceptance bar.

### Modules

| File | Responsibility |
|---|---|
| `src-tauri/src/library/connections.rs` | Connection CRUD, `last_used_at` |
| `src-tauri/src/library/db.rs` | *(modify)* add the table, bump `SCHEMA_VERSION` |
| `src-tauri/src/commands.rs` | *(modify)* connection commands, `AppState` refactor |
| `src/components/ConnectionPicker.tsx` | Header dropdown |
| `src/components/ConnectionEditor.tsx` | Create and edit form |
| `src/hooks/useConnections.ts` | Connection state and actions |

### Commands

| Command | JS arguments | Returns |
|---|---|---|
| `list_connections` | — | `Connection[]` |
| `create_connection` | `input` | `Connection[]` |
| `update_connection` | `id, input` | `Connection[]` |
| `delete_connection` | `id` | `Connection[]` |
| `connect_saved` | `id, password?` | `ConnectionInfo` |
| `disconnect` | — | `null` |
| `active_connection` | — | `ConnectionInfo \| null` |

`password` on `connect_saved` is only for the case where the Keychain has no
entry; normally it is omitted and the password is read from the Keychain.

Argument names are camelCase from JS; returned fields stay snake_case, matching
the existing convention.

### Switching

1. Close the current pool, clear the slot
2. Read the target's password from the Keychain
3. Build a pool, `ping` it
4. On success: store as active, stamp `last_used_at`, clear results in the UI
5. On failure: stay disconnected, surface the SQLSTATE, leave the picker open

### Startup

The app launches disconnected and shows the connection picker as a centred
panel, the same place the URL form appears today. Connections are listed
most-recently-used first, with the top one focused so Enter connects to it —
fast for the common case, but still a deliberate act.

Tabs and their text restore behind the picker, so the workspace is intact the
moment a connection is chosen. Running anything requires a connection; the Run
button stays disabled until then.

There is no auto-connect, and no "remember and reconnect" setting to turn one
on. If that changes later it belongs behind the write-guard, not before it.

## 6. Interface

```
┌──────────────────────────────────────────────┐
│ ● kolecto-dev ▾   postgres@localhost:5432    │  ← thin tag-coloured bar
├──────────────────────────────────────────────┤
│ ● kolecto-dev          local      ⌄ open     │
│ ● kolecto-staging      staging               │
│ ● kolecto-prod         prod                  │
│ ──────────────────────────────────           │
│ + New connection…                            │
│ ⚙ Manage connections…                        │
└──────────────────────────────────────────────┘
```

The list is sorted by `last_used_at` descending. Each row shows a coloured dot
**and** the tag word — colour alone excludes colourblind users, and this is the
distinction that matters most. A thin tag-coloured bar runs along the header so
a production connection is obvious without opening anything.

**New connection** reuses the existing URL-paste field, plus name, tag, and
colour (defaulted from the tag). Pasting a `postgres://…` URL fills in host,
port, user, database, and sslmode.

**Manage connections** lists connections with edit and delete. Deleting asks for
confirmation via the existing `ConfirmDialog` and removes the Keychain entry.

**First run** has no connections, so the picker shows the new-connection form
directly — what happens today, except the result is saved.

While a switch is in flight the dropdown shows a spinner; the editor stays
usable and results clear immediately.

## 7. Errors

| Case | Behavior |
|---|---|
| Wrong password (`28P01`) | Disconnected, SQLSTATE shown, inline password retry |
| No such database (`3D000`) | Disconnected, SQLSTATE shown, offer to edit |
| Host unreachable | Disconnected, message shown, picker stays open |
| Keychain entry missing | Inline password prompt; offer to save it on success |
| Keychain locked | Same as missing — `load_password` fails open by design |

## 8. Testing

- **Store:** CRUD, `last_used_at` ordering (including connections never used,
  which sort last), deleting a connection removes its Keychain entry — against
  a temp database
- **Single-active invariant:** connecting to B while A is active closes A's pool
  and leaves exactly one active connection
- **Startup:** the app starts with no active connection and opens the picker;
  no command connects without an explicit `connect_saved` call
- **TypeScript:** unit tests for the sort/filter helper behind the picker
- **Regression:** all 102 existing tests pass after the `AppState` refactor —
  this is the main risk in the stage

## 9. Debt resolved here

From the Stage 1 review:

- `load_password` was written but never called — this stage is its caller
- duplicate-id pool leak — gone with the single-active refactor
- `AppError::UnknownConnection` dead path — deleted

Still outstanding, deferred to their natural stages: unbounded row buffering
(with cancellation), multi-statement input (with the parser), and array/enum
rendering (with the schema work).

## 10. Roadmap after this stage

1. Environments, `{{variables}}`, and the **write-guard** — reads the `tag`
   field this stage adds
2. Schema tree and autocomplete
3. History, command palette, export
4. Inline row editing

Deferred UI work is tracked in `docs/BACKLOG.md`.
