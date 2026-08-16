# Run the Statement Under the Cursor — Plan

**Goal:** `⌘↵` runs the statement the cursor sits in; `⇧⌘↵` runs the whole buffer, as `⌘↵` does today.

**Why now:** `specs/2026-08-13-quarry-design.md:243` asked for this and the README claimed it for months, but neither binding existed — `App.tsx`'s `run` always sent the whole editor contents. A buffer with two statements cannot be run at all, because Postgres refuses a multi-statement prepared statement (`42601`). See `docs/BACKLOG.md`, "Run the statement under the cursor".

**Process note:** deliberately lean — no brainstorm, no spec. One pure function whose case table is already known, plus two bindings. The design questions were settled in the backlog entry. Full flow stays the default for anything touching write paths or with unsettled design.

**Architecture:** one pure module, `src/lib/statements.ts`, unit-tested under Vitest. The components stay thin: `SqlEditor` reads the cursor from CodeMirror and hands the extracted SQL to `onRun`; nothing else changes. The write-guard is untouched — it classifies whatever string is sent, so it now classifies the extracted statement, which is strictly narrower than the buffer.

---

## Task 1: `statementAt` (subagent)

**Files:** create `src/lib/statements.ts`, `src/lib/statements.test.ts`.

**Interface:**

```ts
/**
 * The statement the cursor sits in, ready to send, or "" when there is
 * none (an empty buffer, or nothing but comments).
 *
 * `cursor` is an offset into `text`. The returned statement has its
 * terminating semicolon and surrounding whitespace stripped.
 */
export function statementAt(text: string, cursor: number): string;
```

**The whole difficulty is that a semicolon is not always a separator.** Each of these is one statement, not two, and each needs a test:

| Case | Example |
|---|---|
| String literal | `select 'a;b'` |
| Escaped quote in a literal | `select 'it''s; here'` |
| `E` string with a backslash escape | `select e'a\';b'` |
| Quoted identifier | `select "odd;name" from t` |
| Escaped quote in an identifier | `select "a""b;c" from t` |
| Line comment | `select 1 -- a; comment` |
| Block comment | `select 1 /* a; b */` |
| **Nested** block comment | `select 1 /* a /* b; */ c */` — Postgres nests these, unlike C |
| Dollar-quoted body | `create function f() returns int as $$ begin return 1; end $$ language plpgsql` |
| Tagged dollar quote | `... as $fn$ select 1; $fn$ ...` |
| A `$` that is not a quote | `select $1`, `select a$b` — a dollar quote's tag is `$[A-Za-z_][A-Za-z0-9_]*$` or bare `$$` |

Plus the cursor-position cases:

| Cursor is… | Returns |
|---|---|
| inside a statement | that statement |
| on the semicolon ending a statement | that statement |
| in whitespace or a comment between two statements | the **preceding** one — you just typed it |
| before the first statement | the first |
| after a trailing semicolon at end of buffer | the last statement |
| in an empty buffer, or one holding only comments | `""` |

Also: a buffer with no semicolon at all returns the whole buffer trimmed; `cursor` out of range is clamped rather than throwing.

**Steps:**

- [ ] Write the failing tests, one per row of both tables above.
- [ ] Run `npm test -- statements`, confirm they fail.
- [ ] Implement. A single left-to-right scan carrying a small state (in-single-quote, in-identifier, in-line-comment, in-block-comment-with-depth, in-dollar-quote-with-tag) is enough; nothing here needs a parser, and a regex cannot do it because the states nest.
- [ ] Run again, confirm they pass, then `npm test` and `npm run build`.
- [ ] **Mutation check:** delete the dollar-quote branch, confirm the dollar-quoted-body test FAILS, restore, confirm it passes. Report both outputs verbatim.
- [ ] Commit: `feat(editor): find the statement under the cursor`.

## Task 2: Bindings (inline, main thread)

**Files:** `src/components/SqlEditor.tsx`, `src/App.tsx`, `README.md`.

- `Props.onRun` becomes `(sql?: string) => void`; `App`'s `run` becomes `(sql?: string) => runSql(sql ?? text)`, so the toolbar button and the table-detail re-run paths keep their current whole-buffer behaviour.
- `Mod-Enter` reads `view.state.doc.toString()` and `view.state.selection.main.head`, calls `statementAt`, and passes the result — running nothing when it is `""`.
- `Shift-Mod-Enter` calls `onRun()` with no argument: the whole buffer, which still fails on multiple statements, correctly.
- The Run button keeps its `⌘↵` label but must send the statement under the cursor too, or the button and the chord disagree.
- README: restore the two-row Keyboard entry, now truthfully.

**Verify:** `npm test`, `npm run build`, `cd src-tauri && cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`.
