# Cross-Platform Compile and Full CI — Plan

**Goal:** make the crate compile off macOS, so CI can run the whole test suite on Linux where Docker exists.

**Why:** `security_framework::passwords` and the macOS about-menu are the only things tying this crate to macOS. That single dependency is why the Rust CI job runs on `macos-latest` with `cargo test --lib` — 50 unit tests — while ~198 Postgres-backed tests run nowhere but a developer's machine. Both backlog entries ("Windows and Linux support", "CI cannot run the integration tests") are the same fix seen from two ends.

**Scope:** compile and test on Linux. Not shipping Linux or Windows builds — no installers, no signing, no platform QA. The app stays macOS-only for users; it merely stops being macOS-only for the compiler.

**Process note:** lean. The design work is already in the backlog entry, which was written from measurement rather than estimate. No brainstorm, no separate spec.

---

## Design decisions

**`keyring` replaces `security-framework`.** One API over macOS Keychain, Windows Credential Manager and Linux Secret Service. The three function signatures — `save_password`, `load_password`, `delete_password` — do not change, so `commands.rs` and every caller are untouched.

**The error mapping is the whole risk.** `secrets.rs` distinguishes three outcomes today, using raw OSStatus codes:

| Today | Meaning | Must stay |
|---|---|---|
| `errSecItemNotFound` (-25300) | nothing saved | `Ok(None)` from `load`, `Ok(())` from `delete` |
| `errSecAuthFailed` (-25293) | entry exists, this binary may not read it | `Err` with the "enter the password again" sentence |
| anything else | the lookup itself broke | `Err` with the underlying message |

`keyring` reports the first as `Error::NoEntry`, which is portable. The second has no portable equivalent — it is a macOS ACL condition — and surfaces as `Error::PlatformFailure` wrapping the OSStatus. So the auth-failed arm becomes macOS-only, matched behind `#[cfg(target_os = "macos")]` on the wrapped code, with every other platform falling through to the generic error arm. **The sentence must survive on macOS**: it is what tells a user their rebuild, not their database password, is the problem.

**The double Keychain prompt goes away.** `save_password` currently deletes before setting, because a `tauri dev` rebuild changes the signature and macOS then refuses both read and overwrite of the old entry — update-in-place would trap the user permanently. That delete-then-set is two Keychain operations, so macOS asks twice. `keyring`'s `set_password` overwrites in place, so the delete goes and the common path prompts once. Keep a fallback: if `set_password` fails, delete and retry once, which preserves the escape hatch the delete-first order existed to provide.

**`menu.rs` gets a `cfg` gate.** The `AboutMetadata` block and the app-menu shape are macOS concepts. Non-macOS builds get the default menu. This is the first `cfg(target_os)` in the codebase; the backlog entry asks that this stay rare, so it goes in one place with a comment.

**CI becomes two jobs.** Ubuntu runs `cargo test` in full, with Docker already present for testcontainers. macOS runs `clippy`, `fmt` and `cargo build`, because that is the platform users actually run and its Keychain path compiles nowhere else. Neither alone is sufficient: Ubuntu cannot exercise the macOS branch, and macOS cannot run the database tests.

**Out of scope, deliberately:** Windows and Linux *builds* (installers, signing, runners), the `-apple-system` font stack in `App.css`, and `⌘`-versus-`Ctrl` shortcut labels. All cosmetic or distribution work, none of it blocking the compile.

---

## Task 1: Swap `security-framework` for `keyring`

**Files:** `src-tauri/Cargo.toml`, `src-tauri/src/secrets.rs`

- [ ] **Step 1: Write the failing tests.** The existing `secrets.rs` test module covers save/load/delete round-trips against the real Keychain. Keep them, and add:
  - `a_missing_entry_reads_as_none` — `load_password` on an unused account is `Ok(None)`, not `Err`. This is the mapping most likely to break in the swap.
  - `deleting_an_absent_entry_is_ok` — unchanged behaviour, restated against the new error type.
  - `saving_twice_overwrites` — the second `save_password` wins and no delete is needed in between. This is the test that pins the single-prompt path.
- [ ] **Step 2: Run them, confirm the two new ones fail** (`cargo test --lib secrets`).
- [ ] **Step 3: Implement.** `keyring = "3"` replaces `security-framework`. Build an `Entry::new(SERVICE, account)` per call. Map `Err(keyring::Error::NoEntry)` to the empty cases. Keep the macOS auth-failed sentence behind `#[cfg(target_os = "macos")]`, matching on the OSStatus inside `Error::PlatformFailure`.
- [ ] **Step 4: Confirm they pass**, then `cargo test` in full.
- [ ] **Step 5: Mutation check.** Delete the `NoEntry` arm from `load_password` so every error becomes `Err`. Confirm `a_missing_entry_reads_as_none` FAILS, restore, confirm it passes. Report both outputs verbatim. This arm is the difference between "no password saved" and "the app is broken", and it is one line.
- [ ] **Step 6: Commit** — `refactor(secrets): store passwords through the keyring crate`.

## Task 2: Gate the macOS-only menu

**Files:** `src-tauri/src/menu.rs`, `src-tauri/src/lib.rs` if it wires the menu

- [ ] **Step 1:** Put the `AboutMetadata` and custom-menu construction behind `#[cfg(target_os = "macos")]`, with a non-macOS arm that installs the default menu. One comment explaining that ⌘W-closes-a-tab is a macOS behaviour and the Edit submenu is what makes ⌘C/⌘V/⌘Z work in the SQL editor — neither applies elsewhere.
- [ ] **Step 2:** `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` on macOS. Linux is verified by CI in Task 3, not locally — there is no Linux machine here, and cross-compiling needs the GTK/WebKit dev packages.
- [ ] **Step 3: Commit** — `build: compile the menu only where it applies`.

## Task 3: CI runs everything on Linux

**Files:** `.github/workflows/ci.yml`

- [ ] **Step 1:** Restore an `ubuntu-latest` Rust job with the Tauri system dependencies (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`), running `cargo test` in full. Docker is present on that runner, so testcontainers works.
- [ ] **Step 2:** Keep a `macos-latest` job running `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo build`. Comment why both exist: Linux cannot exercise the Keychain branch, macOS cannot run the database tests.
- [ ] **Step 3:** Push and watch the run. **The Linux job failing to compile is the expected first outcome** if anything macOS-only was missed — read the error, fix, push again. That job is the only proof this stage worked.
- [ ] **Step 4: Commit** — `ci: run the full suite on Linux`.

## Task 4: Docs

- [ ] `docs/BACKLOG.md`: close "CI cannot run the integration tests"; rewrite "Windows and Linux support" to cover only what remains — builds, installers, signing, fonts, shortcut labels, real-machine testing.
- [ ] `README.md`: the Development section's CI paragraph currently says the integration tests are a local gate. Correct it.
- [ ] `CLAUDE.md` (then at `docs/ORIENTATION.md`): note that `secrets.rs` is now portable and that `menu.rs` holds the only `cfg(target_os)`.
- [ ] Commit — `docs: record the cross-platform port`.

## Verification

```bash
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
npm test && npm run build
```

Plus a green Ubuntu job, which is the point of the stage and cannot be checked from here.
