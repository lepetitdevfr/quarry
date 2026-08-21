# Backlog

Deferred work that is not yet assigned to a stage plan. Anything here is a
real commitment, not a maybe — it was consciously postponed, not dropped.

**Sequencing lives elsewhere:** the order in which new work should happen is
[`audits/2026-08-20-unified-roadmap.md`](audits/2026-08-20-unified-roadmap.md) —
four waves ranked by impact and differentiation, reconciled from the August
2026 audits. This file stays what it is: the reasoning behind individually
deferred items. Note that some entries here were cut or superseded by that
roadmap (cell peek, insert-name-at-cursor, the modal insert form stay
rejected; table-stats extras shipped with table detail).

## Schema tree extras

**Deferred:** 2026-08-14, while designing the schema tree. Each was consciously
cut to keep that stage tight; none is hard once the tree exists.

- **Views and materialised views in the tree.** Excluded on purpose, but it
  means a view can be queried and never seen. The fix is one character in the
  `relkind` filter in `schema/introspect.rs` plus a marker in the UI.
- **Insert a qualified name at the cursor** from a tree row.
- **Copy `CREATE TABLE` DDL.** Postgres has no built-in DDL function, so this
  means assembling columns, defaults, keys, and indexes from the catalog —
  the introspection stage already gathers everything needed.

## Move a query between collections — RESOLVED

**Deferred:** 2026-08-14. **Closed:** 2026-08-16, with option 1 as this entry
recommended: a `⋯` menu on the query row listing every other collection.

The decision lives in `moveTargets` in `src/lib/tree.ts` with unit tests — full
paths as labels so two folders sharing a name stay distinguishable, the
query's current home left out because a menu entry that does nothing reads as
a bug, and the top level offered only when the query is filed somewhere.
`QueryTree` renders it and calls the `actions.moveQuery` that already existed.

**Still open:** drag and drop, and reordering. Reordering needs the backend
work this entry always named — today only a query's parent can change, so
sibling `position` recalculation does not exist.


## Recover from a poisoned mutex instead of panicking — RESOLVED

**Deferred:** 2026-08-14. **Closed:** 2026-08-16.

The seven `.expect("state lock poisoned")` calls are gone. `AppState` gained
`active()` and `schema()` accessors and `Store::lock` recovers, all three via
`unwrap_or_else(|e| e.into_inner())`: the data behind these locks is a
`HashMap` insert, an `Option` swap or a SQLite connection, structurally valid
either way, so recovering beats bricking every later call.

Proven rather than assumed — `a_poisoned_library_lock_still_serves_the_next_caller`
poisons the lock from a panicking thread and then reads the library. Restoring
the `expect` makes it fail with `library lock poisoned: PoisonError { .. }`.

The three remaining `expect` calls are the startup fail-fast in `lib.rs`, which
this entry always said were correct as they are.


## CI cannot run the integration tests — RESOLVED

**Found:** 2026-08-16, when the first CI run failed. **Closed:** the same
day, by the cross-platform port below.

`secrets.rs` moved from `security-framework` to the `keyring` crate and
`menu.rs` gained the codebase's only `cfg(target_os)`, so the crate compiles
on Linux. CI now runs two Rust jobs: Ubuntu runs the whole suite, database
tests included, because Docker is there; macOS runs clippy, fmt, the unit
tests and a build, because it is the platform users run and the only one that
compiles the Keychain branch.


## Signing and notarising the macOS build

**Assessed:** 2026-08-21, without doing it — the owner has not bought an Apple
Developer membership yet and does not want to now. Written down so the day it
happens is an hour of work rather than an afternoon of research.

The unified roadmap classifies this as a **release gate**, not a feature: it
does nothing for anyone who has already installed, and its whole value is
acquisition. It blocks no wave and must be done before v1 is announced.

Two things it buys beyond removing the Gatekeeper warning:

- **It fixes the Keychain re-prompt.** macOS ties an "Always Allow" grant to
  the requesting binary's code signature, which is why a rebuilt binary loses
  access to entries it saved moments earlier. A stable Developer ID signature
  on released builds makes the grant stick — this is an in-app defect, not
  only a download-page one.
- **It is the precondition for an updater** that is not "download the dmg
  again".

### What it takes

Membership is $99/year; enrolment is usually same-day, occasionally ~48 hours
if Apple asks for identity verification. Then:

1. Create a **Developer ID Application** certificate in the developer portal
   (not a Mac App Store one — this is distribution outside the store) and
   export it as a `.p12` with a password.
2. Add repository secrets: `APPLE_CERTIFICATE` (the `.p12`, base64),
   `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (the certificate's
   common name, e.g. `Developer ID Application: NAME (TEAMID)`), and for
   notarisation either `APPLE_ID` + `APPLE_PASSWORD` (an app-specific
   password, not the account one) + `APPLE_TEAM_ID`, or an App Store Connect
   key as `APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_PATH`.
3. Pass them as `env:` on the existing **Build** step in
   `.github/workflows/release.yml`. Nothing else changes: Tauri 2 signs,
   submits for notarisation and staples the ticket itself when those variables
   are present, so there is no `codesign` or `notarytool` scripting to write.

Budget the first run at build time plus five to fifteen minutes of
notarisation. Notarisation requires the hardened runtime, which Tauri enables
when signing; if the Keychain access turns out to need an entitlements file,
that is the one thing here that could take longer than an hour.

### Decide at the same time: Intel

The release matrix has a single macOS entry, `aarch64-macos`, so Intel Macs
are not served at all today. Signing does not change that, but the two
questions arrive together — either a universal binary or a second matrix row,
and both are a bigger conversation than signing itself.

## Windows and Linux builds

**Assessed:** 2026-08-15. **Code port done:** 2026-08-16 — see
`plans/2026-08-16-cross-platform.md`. What is left is distribution, not
compilation.

The crate now builds off macOS: `keyring` covers macOS Keychain, Windows
Credential Manager and Linux keyutils behind the same three functions, and
the only `cfg(target_os)` in the codebase is the macOS menu in `menu.rs`.
**Keep it that way** — this entry exists to keep the constraint visible.

Remaining, in order of cost:

1. **Real-machine testing.** The Windows and Linux credential backends have
   never been run, only compiled. `keyring`'s Linux feature here is
   `linux-native` (kernel keyutils) rather than Secret Service, chosen
   because a headless CI runner has no D-Bus session — a desktop Linux user
   may want the opposite, and that is a one-line change in `Cargo.toml`.
2. **Fonts.** Six `-apple-system` / `SF Pro` / `SF Mono` references in
   `App.css` need fallbacks.
3. **Shortcut labels.** Both `metaKey` uses are already `metaKey || ctrlKey`;
   this is showing "Ctrl+S" rather than "⌘S".
4. **CI, signing and installers.** The largest item and mostly money: a
   runner per platform, an Authenticode certificate for Windows, AppImage or
   `.deb` for Linux.


## One Keychain prompt instead of one per connection — RESOLVED

**Raised:** 2026-08-16, after the prompt count came down from four to one per
connection. **Closed:** 2026-08-19.

macOS authorises Keychain access per *item*, so N saved connections meant N
prompts — one each, and in `tauri dev` again after every rebuild, because
entries are tied to the signing identity.

Every password now lives in one item, account `connections`, holding a JSON
map keyed by connection id: one ACL, one prompt. A `BLOB_LOCK` mutex
serialises the read-modify-write, because two threads saving different
connections would otherwise each read the same map and write back their own.

A password written by a pre-blob build is migrated the first time it is read
— returned to the caller, copied into the blob, old item deleted — so the
extra prompt happens once per legacy entry and never again. `save` and
`delete` clear a legacy item too, or a stale credential would sit there
unreachable, or come back on the next read.

The costs named when this was raised were accepted as stated: one opaque
entry in Keychain Access instead of a legible one per connection, and any
read decrypts every credential.

**The tests no longer touch the real store.** `Items` is a three-method trait
over the credential store, and the blob rules are tested against an in-memory
fake. This is not tidiness: macOS binds an "Always Allow" grant to the
requesting binary's code signature, and `cargo test` re-links a
differently-signed test binary on every build — so real-store tests prompted
on every single run, and allowing them never settled it. One real round-trip
test survives, `#[ignore]`d:

```bash
cd src-tauri && cargo test -- --ignored the_real_store
```

## Table detail extras

**Deferred:** 2026-08-15, while designing table detail tabs
(`specs/2026-08-15-table-detail-tabs-design.md`). Each needs a new catalog
query and a round-trip per table open, which the three shipped sections do
not.

- **Live table stats.** Estimated row count (`pg_class.reltuples`, which reads
  `-1` on a never-analyzed table), on-disk size (`pg_total_relation_size`), and
  table/column comments (`obj_description`/`col_description`).
- **Triggers and dependent views.** `pg_trigger` rows, plus the views that
  depend on this table via a `pg_depend` walk.
- **Copy `CREATE TABLE` DDL** (see above) belongs in this view once the
  assembly work is done.

## Row editing extras

**Deferred:** 2026-08-16, while designing inline row editing
(`specs/2026-08-16-inline-row-editing-design.md`). The machinery all three need
— identity from `table_oid`, generated SQL, the transaction with its rowcount
assert — now exists, so each is much cheaper than it would have been before.


- **Inserting an empty string into a text column.** Committing an empty
  input returns an insert cell to *untouched*, which is what makes "give me
  the default back" possible without another chord — so `''` and untouched
  are the same gesture and an empty string cannot be inserted from the grid.
  Accepted deliberately in §5 of the insert spec. Rare, and the workaround
  is one hand-written `INSERT`. A fix would need a second gesture, and the
  chord space around `⌘⌫` is already crowded.

- **A modal insert form for wide tables.** A form with one labelled field per
  column is honestly easier to fill than a horizontally scrolled grid row.
  Rejected for v1 in §12 of the insert spec because it is a second editing
  surface with its own staging and validation. Revisit if filling rows in the
  grid turns out to hurt in practice.
- **Foreign-key value suggestions, and choices from a `CHECK` constraint.**
  The enum and boolean selectors come free from the driver's type metadata. A
  foreign key would need a lookup against another table, and a
  `check (x in (…))` would need constraint-expression parsing — the thing the
  editing design refuses to do. Both are real features, not fields.
- **Editing a primary key.** Mechanically fine — the `WHERE` uses the original
  value — but excluded from v1 because it is rare and it is the one edit that
  can orphan a foreign key silently.
- **Optimistic concurrency.** Today the last write wins: a concurrent change to
  the same cell is overwritten without warning. Checking original values in the
  `WHERE` was rejected because the `json` type has no equality operator, so it
  would need a per-type carve-out that gives some columns weaker guarantees than
  others. A row version or `xmin` check would avoid that and is the better shape
  if this ever becomes a real problem.
- **A bigint key past 2^53.** Key values reach the frontend as JSON numbers and
  go back as text, so an `int8` key above 9,007,199,254,740,992 would round-trip
  wrong. The grid already displays such a value wrong today, so this is
  pre-existing rather than new — but editing is where it would do damage rather
  than merely mislead.


## An unidentified flake in the Rust suite

**Seen once:** 2026-08-16, during the migration-test fix. One full
`cargo test` reported `203 passed, 1 failed` where every run either side
reported `209 passed, 0 failed`. Four consecutive runs since have been
clean.

The failing test's name was lost — the run was filtered through `awk` for
counts only, so the failure line was never captured. That is the real
mistake worth not repeating: **capture full output to a file when running
the suite, and grep the file**, rather than piping the run itself through
a filter.

Note the arithmetic: 203 + 1 = 204, five short of 209. So five tests did
not report at all, which points at a test binary dying rather than an
assertion failing — consistent with a testcontainers container failing to
start under parallel load, since several binaries each boot their own
Postgres simultaneously. That is a hypothesis, not a diagnosis.

Not chased further because it has not recurred. If it comes back, the
first move is `cargo test 2>&1 | tee /tmp/run.txt` and reading the file.
