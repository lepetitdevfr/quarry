# Copy and Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select cells in the result grid and copy them as TSV; export all fetched rows to CSV, JSON, or SQL `INSERT`.

**Architecture:** Two new pure modules (`gridSelection.ts`, `exportRows.ts`) hold every decision and are vitest-covered; `ResultGrid` renders selection and reports intent. Files are written by a new narrow Rust command taking a path from `tauri-plugin-dialog`'s native Save panel — deliberately not `tauri-plugin-fs`, which would grant the webview general filesystem write access.

**Tech Stack:** React 19, TypeScript 7, vitest, Rust, `tauri-plugin-dialog`.

**Spec:** `docs/superpowers/specs/2026-08-15-copy-export-design.md`

---

## Baselines

TypeScript 95 tests passing, `npx tsc --noEmit` clean, `npm run build` clean, Rust 145 passing.

**Do not run `cargo clippy` or `cargo fmt`.** Both fail at baseline for reasons recorded in `docs/BACKLOG.md` — two `dead_code` errors in `src-tauri/tests/common/mod.rs`, and a repo that has never been rustfmt-formatted. Neither is this stage's work. If you run clippy to check your own code, the only acceptable new output is nothing: the two known errors and no more.

No database migration in this stage, so no workspace backup is needed.

## File Structure

**Create:**
- `src/lib/gridSelection.ts` + `.test.ts` — anchor/focus rectangle maths
- `src/lib/exportRows.ts` + `.test.ts` — TSV, CSV, JSON, SQL INSERT serialization

**Modify:**
- `src-tauri/Cargo.toml` — add `tauri-plugin-dialog`
- `src-tauri/src/lib.rs` — register the plugin and the new command
- `src-tauri/src/commands.rs` — `write_text_file`
- `src-tauri/capabilities/default.json` — `dialog:default`
- `src-tauri/tests/export_test.rs` — new, covers `write_text_file`
- `package.json` — add `@tauri-apps/plugin-dialog`
- `src/lib/ipc.ts` — `writeTextFile`
- `src/components/ResultGrid.tsx` — selection rendering, Cmd+C, Cmd+A
- `src/components/GridToolbar.tsx` — new, the export menu
- `src/App.tsx` — export handler, wiring
- `src/App.css` — selection and toolbar styles

---

### Task 1: Selection geometry

**Files:**
- Create: `src/lib/gridSelection.ts`
- Test: `src/lib/gridSelection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { isSelected, selectAll, selectionRange } from "./gridSelection";

describe("selectionRange", () => {
  it("normalises a drag down and right", () => {
    expect(selectionRange({ row: 1, col: 2 }, { row: 4, col: 5 })).toEqual({
      top: 1,
      left: 2,
      bottom: 4,
      right: 5,
    });
  });

  it("normalises a drag up and left to the same rectangle", () => {
    // Dragging backwards must select the same cells, or shift-clicking
    // above your anchor selects nothing.
    expect(selectionRange({ row: 4, col: 5 }, { row: 1, col: 2 })).toEqual({
      top: 1,
      left: 2,
      bottom: 4,
      right: 5,
    });
  });

  it("normalises the two mixed diagonals", () => {
    expect(selectionRange({ row: 4, col: 2 }, { row: 1, col: 5 })).toEqual({
      top: 1,
      left: 2,
      bottom: 4,
      right: 5,
    });
    expect(selectionRange({ row: 1, col: 5 }, { row: 4, col: 2 })).toEqual({
      top: 1,
      left: 2,
      bottom: 4,
      right: 5,
    });
  });

  it("gives a single cell when anchor and focus match", () => {
    expect(selectionRange({ row: 3, col: 3 }, { row: 3, col: 3 })).toEqual({
      top: 3,
      left: 3,
      bottom: 3,
      right: 3,
    });
  });
});

describe("isSelected", () => {
  const range = { top: 1, left: 2, bottom: 3, right: 4 };

  it("includes every corner", () => {
    // Inclusive bounds: an off-by-one here silently drops the last row
    // or column from every copy.
    expect(isSelected(range, 1, 2)).toBe(true);
    expect(isSelected(range, 1, 4)).toBe(true);
    expect(isSelected(range, 3, 2)).toBe(true);
    expect(isSelected(range, 3, 4)).toBe(true);
  });

  it("excludes cells just outside", () => {
    expect(isSelected(range, 0, 3)).toBe(false);
    expect(isSelected(range, 4, 3)).toBe(false);
    expect(isSelected(range, 2, 1)).toBe(false);
    expect(isSelected(range, 2, 5)).toBe(false);
  });

  it("selects nothing when there is no range", () => {
    expect(isSelected(null, 0, 0)).toBe(false);
  });
});

describe("selectAll", () => {
  it("covers the whole grid", () => {
    expect(selectAll(10, 3)).toEqual({ top: 0, left: 0, bottom: 9, right: 2 });
  });

  it("is null for an empty result", () => {
    // Cmd+A on nothing must not produce a rectangle over no rows.
    expect(selectAll(0, 3)).toBeNull();
    expect(selectAll(10, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- gridSelection
```

Expected: FAIL — cannot resolve `./gridSelection`.

- [ ] **Step 3: Implement**

Create `src/lib/gridSelection.ts`:

```ts
/** One cell's position in the grid. */
export interface CellRef {
  row: number;
  col: number;
}

/** An inclusive rectangle of selected cells. */
export interface SelectionRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/**
 * The rectangle between the anchor (where the selection started) and the
 * focus (where it now extends to).
 *
 * Normalised, so dragging up-and-left selects the same cells as
 * down-and-right. Without this, shift-clicking above your anchor would
 * produce an inverted rectangle and select nothing.
 */
export function selectionRange(
  anchor: CellRef,
  focus: CellRef,
): SelectionRange {
  return {
    top: Math.min(anchor.row, focus.row),
    left: Math.min(anchor.col, focus.col),
    bottom: Math.max(anchor.row, focus.row),
    right: Math.max(anchor.col, focus.col),
  };
}

/** Bounds are inclusive on all four sides. */
export function isSelected(
  range: SelectionRange | null,
  row: number,
  col: number,
): boolean {
  if (range === null) return false;
  return (
    row >= range.top &&
    row <= range.bottom &&
    col >= range.left &&
    col <= range.right
  );
}

/**
 * Cmd+A. Null for an empty result — a rectangle over zero rows would
 * report as a selection and copy an empty string.
 */
export function selectAll(
  rowCount: number,
  columnCount: number,
): SelectionRange | null {
  if (rowCount === 0 || columnCount === 0) return null;
  return { top: 0, left: 0, bottom: rowCount - 1, right: columnCount - 1 };
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- gridSelection
```

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gridSelection.ts src/lib/gridSelection.test.ts
git commit -m "feat(grid): compute a selection rectangle"
```

---

### Task 2: TSV and CSV

**Files:**
- Create: `src/lib/exportRows.ts`
- Test: `src/lib/exportRows.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { toCsv, toTsv } from "./exportRows";
import type { CellValue, ColumnMeta } from "../types";

const COLUMNS: ColumnMeta[] = [
  { name: "id", type_name: "int4" },
  { name: "name", type_name: "text" },
];

describe("toTsv", () => {
  it("separates cells with tabs and rows with newlines", () => {
    const rows: CellValue[][] = [
      [1, "alice"],
      [2, "bob"],
    ];
    expect(toTsv(COLUMNS, rows, false)).toBe("1\talice\n2\tbob");
  });

  it("includes a header row when asked", () => {
    expect(toTsv(COLUMNS, [[1, "alice"]], true)).toBe("id\tname\n1\talice");
  });

  it("writes an empty field for null, not the word NULL", () => {
    // `formatCell` renders null as the string "NULL" for display. In a
    // paste target that is indistinguishable from a real value.
    expect(toTsv(COLUMNS, [[1, null]], false)).toBe("1\t");
  });

  it("is empty for no rows", () => {
    expect(toTsv(COLUMNS, [], false)).toBe("");
  });
});

describe("toCsv", () => {
  it("always writes a header row", () => {
    expect(toCsv(COLUMNS, [[1, "alice"]])).toBe("id,name\n1,alice");
  });

  it("quotes a field containing a comma", () => {
    expect(toCsv(COLUMNS, [[1, "Smith, Alice"]])).toBe(
      'id,name\n1,"Smith, Alice"',
    );
  });

  it("quotes and doubles an embedded quote", () => {
    // RFC 4180: the escape for " is "".
    expect(toCsv(COLUMNS, [[1, 'say "hi"']])).toBe('id,name\n1,"say ""hi"""');
  });

  it("quotes a field containing a newline", () => {
    expect(toCsv(COLUMNS, [[1, "line1\nline2"]])).toBe(
      'id,name\n1,"line1\nline2"',
    );
  });

  it("writes an empty field for null", () => {
    expect(toCsv(COLUMNS, [[1, null]])).toBe("id,name\n1,");
  });

  it("writes booleans and numbers bare", () => {
    const cols: ColumnMeta[] = [
      { name: "n", type_name: "int4" },
      { name: "ok", type_name: "bool" },
    ];
    expect(toCsv(cols, [[42, true]])).toBe("n,ok\n42,true");
  });

  it("serializes json as its JSON text", () => {
    const cols: ColumnMeta[] = [{ name: "meta", type_name: "jsonb" }];
    expect(toCsv(cols, [[{ a: 1 }]])).toBe('meta,"{""a"":1}"');
  });

  it("writes only headers for no rows", () => {
    expect(toCsv(COLUMNS, [])).toBe("id,name");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- exportRows
```

Expected: FAIL — cannot resolve `./exportRows`.

- [ ] **Step 3: Implement**

Create `src/lib/exportRows.ts`:

```ts
import type { CellValue, ColumnMeta } from "../types";

/**
 * Serialize result rows for the clipboard and for files.
 *
 * These deliberately do NOT use `formatCell`. That produces *display*
 * text — the literal string "NULL" for a null, a JSON blob for an
 * object — which is right in a grid cell and wrong in a file: a CSV
 * needs an empty field where the value is null, and a paste target
 * cannot tell the string "NULL" from a real value. Export works from
 * raw `CellValue`s and formats per target.
 */

/** The text of one cell, before any format-specific quoting. */
function cellText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Tab-separated, for the clipboard. Spreadsheets split pasted text on
 * tabs and newlines, so this lands as cells rather than one blob.
 */
export function toTsv(
  columns: ColumnMeta[],
  rows: CellValue[][],
  withHeader: boolean,
): string {
  const lines = rows.map((row) => row.map(cellText).join("\t"));
  if (withHeader) lines.unshift(columns.map((c) => c.name).join("\t"));
  return lines.join("\n");
}

/** RFC 4180: quote when the field contains a comma, quote, or newline. */
function csvField(value: CellValue): string {
  const text = cellText(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(columns: ColumnMeta[], rows: CellValue[][]): string {
  const header = columns.map((c) => csvField(c.name)).join(",");
  const lines = rows.map((row) => row.map(csvField).join(","));
  return [header, ...lines].join("\n");
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- exportRows
```

Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/exportRows.ts src/lib/exportRows.test.ts
git commit -m "feat(export): serialize rows as TSV and CSV"
```

---

### Task 3: JSON and SQL INSERT

**Files:**
- Modify: `src/lib/exportRows.ts`
- Test: `src/lib/exportRows.test.ts`

`toSqlInsert` is the one function in this stage whose bugs are dangerous rather than cosmetic: a quoting mistake produces SQL that fails to parse, or that parses and does the wrong thing. Test it hardest.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/exportRows.test.ts`:

```ts
import { toJson, toSqlInsert } from "./exportRows";

describe("toJson", () => {
  it("writes an array of objects keyed by column name", () => {
    const rows: CellValue[][] = [[1, "alice"]];
    expect(JSON.parse(toJson(COLUMNS, rows))).toEqual([
      { id: 1, name: "alice" },
    ]);
  });

  it("writes a real null, not the string NULL", () => {
    expect(JSON.parse(toJson(COLUMNS, [[1, null]]))).toEqual([
      { id: 1, name: null },
    ]);
  });

  it("keeps json values as structure, not as a string", () => {
    const cols: ColumnMeta[] = [{ name: "meta", type_name: "jsonb" }];
    expect(JSON.parse(toJson(cols, [[{ a: 1 }]]))).toEqual([
      { meta: { a: 1 } },
    ]);
  });

  it("is an empty array for no rows", () => {
    expect(JSON.parse(toJson(COLUMNS, []))).toEqual([]);
  });
});

describe("toSqlInsert", () => {
  it("writes one INSERT per row with quoted identifiers", () => {
    const sql = toSqlInsert("public", "users", COLUMNS, [[1, "alice"]]);
    expect(sql).toBe(
      `insert into "public"."users" ("id", "name") values (1, 'alice');`,
    );
  });

  it("escapes a single quote by doubling it", () => {
    // The injection-shaped case. A value like O'Brien must not end the
    // string literal.
    const sql = toSqlInsert("public", "users", COLUMNS, [[1, "O'Brien"]]);
    expect(sql).toBe(
      `insert into "public"."users" ("id", "name") values (1, 'O''Brien');`,
    );
  });

  it("does not let a value close the statement", () => {
    const nasty = "'); drop table users; --";
    const sql = toSqlInsert("public", "users", COLUMNS, [[1, nasty]]);
    expect(sql).toBe(
      `insert into "public"."users" ("id", "name") values (1, '''); drop table users; --');`,
    );
    // One statement, one terminator: the payload stayed inside the literal.
    expect(sql.match(/;/g)).toHaveLength(2);
  });

  it("quotes an identifier that needs it", () => {
    const cols: ColumnMeta[] = [{ name: "Order Id", type_name: "int4" }];
    const sql = toSqlInsert("public", "Order", cols, [[1]]);
    expect(sql).toBe(
      `insert into "public"."Order" ("Order Id") values (1);`,
    );
  });

  it("writes numbers, booleans and nulls bare", () => {
    const cols: ColumnMeta[] = [
      { name: "n", type_name: "int4" },
      { name: "ok", type_name: "bool" },
      { name: "gone", type_name: "text" },
    ];
    const sql = toSqlInsert("public", "t", cols, [[42, true, null]]);
    expect(sql).toBe(
      `insert into "public"."t" ("n", "ok", "gone") values (42, true, NULL);`,
    );
  });

  it("writes json as a quoted string literal", () => {
    const cols: ColumnMeta[] = [{ name: "meta", type_name: "jsonb" }];
    const sql = toSqlInsert("public", "t", cols, [[{ a: "x" }]]);
    expect(sql).toBe(
      `insert into "public"."t" ("meta") values ('{"a":"x"}');`,
    );
  });

  it("separates rows with newlines", () => {
    const sql = toSqlInsert("public", "users", COLUMNS, [
      [1, "a"],
      [2, "b"],
    ]);
    expect(sql.split("\n")).toHaveLength(2);
  });

  it("is empty for no rows", () => {
    expect(toSqlInsert("public", "users", COLUMNS, [])).toBe("");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- exportRows
```

Expected: FAIL — `toJson` and `toSqlInsert` are not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/exportRows.ts`:

```ts
export function toJson(columns: ColumnMeta[], rows: CellValue[][]): string {
  const objects = rows.map((row) => {
    const out: Record<string, CellValue> = {};
    columns.forEach((c, i) => {
      // Raw value, not `cellText`: JSON should carry a real null and
      // keep a jsonb column as structure rather than as a string.
      out[c.name] = row[i] ?? null;
    });
    return out;
  });
  return JSON.stringify(objects, null, 2);
}

/**
 * Quote a Postgres identifier: wrap in double quotes, double any
 * embedded double quote.
 *
 * Duplicated from `schema.ts` rather than imported — that module is
 * about the schema tree and autocomplete, and importing it here would
 * tie file export to it for four lines. If a third caller appears, move
 * it somewhere shared.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A SQL string literal: single quotes, with embedded single quotes
 * doubled.
 *
 * This is the function that makes `toSqlInsert` safe. A value like
 * `'); drop table users; --` must stay inside the literal rather than
 * closing it, which is exactly what doubling the quote achieves.
 */
function sqlLiteral(value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * `INSERT` statements for a known target table.
 *
 * Only offered where the target is genuinely known — a table Data tab.
 * A join or expression query has no single target, and generating
 * `insert into some_guess` would be worse than not offering it.
 */
export function toSqlInsert(
  schema: string,
  table: string,
  columns: ColumnMeta[],
  rows: CellValue[][],
): string {
  const target = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const names = columns.map((c) => quoteIdent(c.name)).join(", ");

  return rows
    .map(
      (row) =>
        `insert into ${target} (${names}) values (${row
          .map(sqlLiteral)
          .join(", ")});`,
    )
    .join("\n");
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- exportRows
```

Expected: 25 passed (12 from Task 2, 13 here).

- [ ] **Step 5: Prove the SQL escaping actually bites**

Temporarily change `sqlLiteral`'s string branch to skip escaping:

```ts
  return `'${text}'`;
```

Run `npm test -- exportRows`. Both `escapes a single quote by doubling it` and `does not let a value close the statement` must FAIL. Restore the escaping and confirm they pass again. Report both results — a quoting test that passes without the quoting is worse than no test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/exportRows.ts src/lib/exportRows.test.ts
git commit -m "feat(export): serialize rows as JSON and SQL INSERT"
```

---

### Task 4: The Rust write command

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- Test: `src-tauri/tests/export_test.rs` (create)

- [ ] **Step 1: Write the failing test**

Create `src-tauri/tests/export_test.rs`:

```rust
use quarry_lib::commands::write_text;

#[test]
fn writes_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.csv");

    write_text(path.to_str().unwrap(), "id,name\n1,alice").unwrap();

    let read = std::fs::read_to_string(&path).unwrap();
    assert_eq!(read, "id,name\n1,alice");
}

#[test]
fn overwrites_an_existing_file() {
    // The Save panel already asked about replacing; refusing here would
    // contradict what the user was just told.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.csv");

    write_text(path.to_str().unwrap(), "first").unwrap();
    write_text(path.to_str().unwrap(), "second").unwrap();

    assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
}

#[test]
fn reports_an_unwritable_path_as_an_error() {
    // A directory that does not exist. The UI needs a real error here,
    // not a silent success that leaves the user believing they have a
    // file.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("no-such-dir").join("out.csv");

    assert!(write_text(path.to_str().unwrap(), "data").is_err());
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd src-tauri && cargo test --test export_test
```

Expected: compile error — `write_text` not found in `quarry_lib::commands`.

- [ ] **Step 3: Implement**

Add to `src-tauri/src/commands.rs`, at the end:

```rust
// ---- export -----------------------------------------------------------

/// Write a string to a path the user chose in the Save panel.
///
/// This exists instead of `tauri-plugin-fs` on purpose. That plugin
/// grants the webview a general filesystem write capability; this
/// feature needs to write exactly one file that the user just named in
/// a native dialog. One narrow command is a much smaller door.
///
/// Split from the `#[tauri::command]` wrapper so it can be tested
/// without a Tauri app handle.
pub fn write_text(path: &str, contents: &str) -> Result<(), AppError> {
    std::fs::write(path, contents)
        .map_err(|e| AppError::Export(format!("{path}: {e}")))
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), AppError> {
    write_text(&path, &contents)
}
```

Add the error variant to `src-tauri/src/error.rs`, after `PasswordRequired`:

```rust
    #[error("could not write the file: {0}")]
    Export(String),
```

and to the `match` in its `Serialize` impl:

```rust
            AppError::Export(_) => ("export", None, None),
```

Register the command in `src-tauri/src/lib.rs`, after `commands::set_tab_mode,`:

```rust
            commands::write_text_file,
```

- [ ] **Step 4: Run the tests**

```bash
cd src-tauri && cargo test
```

Expected: 148 passed (145 baseline plus these 3), 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/error.rs src-tauri/src/lib.rs src-tauri/tests/export_test.rs
git commit -m "feat(export): write a file to a chosen path"
```

---

### Task 5: The dialog plugin

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `package.json`, `src/lib/ipc.ts`

This is the first Tauri plugin beyond `opener` and the first capability change in the project. A capability list is a security boundary — add exactly one entry, not a wildcard.

- [ ] **Step 1: Add the Rust dependency**

In `src-tauri/Cargo.toml`, after `tauri-plugin-opener = "2"`:

```toml
tauri-plugin-dialog = "2"
```

- [ ] **Step 2: Register the plugin**

In `src-tauri/src/lib.rs`, beside the existing `.plugin(tauri_plugin_opener::init())` call:

```rust
        .plugin(tauri_plugin_dialog::init())
```

- [ ] **Step 3: Grant the capability**

In `src-tauri/capabilities/default.json`, add to `permissions`:

```json
    "dialog:default"
```

so the array reads `["core:default", "opener:default", "dialog:default"]`.

`dialog:default` covers the ask/message/open/save dialogs. Do not use a wildcard.

- [ ] **Step 4: Add the JS dependency**

```bash
npm install @tauri-apps/plugin-dialog
```

- [ ] **Step 5: Add the IPC call**

In `src/lib/ipc.ts`, after `setTabMode`:

```ts
export async function writeTextFile(
  path: string,
  contents: string,
): Promise<void> {
  return invoke("write_text_file", { path, contents });
}
```

- [ ] **Step 6: Verify it all builds**

```bash
cd src-tauri && cargo build
```

```bash
cd /Users/lepetitdev/dev/quarry && npx tsc --noEmit && npm run build
```

Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json package.json package-lock.json src/lib/ipc.ts
git commit -m "feat(export): add the dialog plugin and its capability"
```

---

### Task 6: Selection and copy in `ResultGrid`

**Files:**
- Modify: `src/components/ResultGrid.tsx`

No test: this project has no component-test harness, which is why Tasks 1-3 hold every decision. Do not add one.

- [ ] **Step 1: Add selection state**

Add the imports:

```tsx
import { isSelected, selectAll, selectionRange } from "../lib/gridSelection";
import type { CellRef, SelectionRange } from "../lib/gridSelection";
import { toTsv } from "../lib/exportRows";
```

Inside the component, after the width state:

```tsx
  const [anchor, setAnchor] = useState<CellRef | null>(null);
  const [focus, setFocus] = useState<CellRef | null>(null);
  const [selectedAll, setSelectedAll] = useState<SelectionRange | null>(null);

  // A rectangle into a result that no longer exists means nothing.
  useEffect(() => {
    setAnchor(null);
    setFocus(null);
    setSelectedAll(null);
    // `shape` is the same trigger the widths use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  const range =
    selectedAll ??
    (anchor && focus ? selectionRange(anchor, focus) : null);
```

- [ ] **Step 2: Select on click**

On the `td`, add a click handler. Note the cell's row index is its **display** position, matching what the user sees and what a copy should produce:

```tsx
                    <td
                      key={i}
                      className={`cell-${kind}${
                        isSelected(range, item.index, i) ? " selected" : ""
                      }`}
                      style={{ width: `${widths[i]}px` }}
                      title={text}
                      onClick={(e) => {
                        setSelectedAll(null);
                        const cell = { row: item.index, col: i };
                        // Shift extends from the existing anchor; a plain
                        // click starts a new selection.
                        if (e.shiftKey && anchor) setFocus(cell);
                        else {
                          setAnchor(cell);
                          setFocus(cell);
                        }
                      }}
                    >
                      {text}
                    </td>
```

- [ ] **Step 3: Copy and select-all**

Add below the `range` computation:

```tsx
  // Cmd+C copies the selection as TSV; Cmd+A selects everything. Both
  // are on the grid container rather than the window so they do not
  // steal the shortcuts while the user is typing in the editor.
  function onKeyDown(e: React.KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;

    if (e.key === "a") {
      e.preventDefault();
      setSelectedAll(selectAll(result.rows.length, result.columns.length));
      return;
    }

    if (e.key === "c") {
      e.preventDefault();
      const copied = range
        ? result.columns.slice(range.left, range.right + 1)
        : result.columns;
      const rows = range
        ? order
            .slice(range.top, range.bottom + 1)
            .map((r) => result.rows[r].slice(range.left, range.right + 1))
        : order.map((r) => result.rows[r]);
      // Headers only when whole columns are covered — a header above a
      // three-row fragment is noise.
      const wholeColumns =
        range === null ||
        (range.top === 0 && range.bottom === result.rows.length - 1);
      void navigator.clipboard.writeText(toTsv(copied, rows, wholeColumns));
    }
  }
```

and put it on the scroll container, which needs to be focusable to receive keys:

```tsx
    <div className="result-grid" ref={scrollRef} onKeyDown={onKeyDown} tabIndex={0}>
```

Note `order` is used, not `result.rows` directly: copy must follow display order, so a sorted grid copies what you see.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/ResultGrid.tsx
git commit -m "feat(grid): select cells and copy them as TSV"
```

---

### Task 7: The export menu

**Files:**
- Create: `src/components/GridToolbar.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/GridToolbar.tsx`:

```tsx
export type ExportFormat = "csv" | "json" | "sql";

interface Props {
  /**
   * SQL INSERT is offered only where the target table is genuinely
   * known — a table Data tab. A join or expression query has no single
   * target, so the option is absent rather than disabled.
   */
  canExportSql: boolean;
  busy: boolean;
  onExport: (format: ExportFormat) => void;
}

export function GridToolbar({ canExportSql, busy, onExport }: Props) {
  return (
    <div className="grid-toolbar">
      <span className="grid-toolbar-label">Export</span>
      <button disabled={busy} onClick={() => onExport("csv")}>
        CSV
      </button>
      <button disabled={busy} onClick={() => onExport("json")}>
        JSON
      </button>
      {canExportSql && (
        <button disabled={busy} onClick={() => onExport("sql")}>
          SQL
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the export handler to `App`**

Add the imports:

```tsx
import { save } from "@tauri-apps/plugin-dialog";
import { GridToolbar } from "./components/GridToolbar";
import type { ExportFormat } from "./components/GridToolbar";
import { toCsv, toJson, toSqlInsert } from "./lib/exportRows";
import { writeTextFile } from "./lib/ipc";
```

`writeTextFile` may need adding to the existing `./lib/ipc` import instead of a new line — check how `execute` and `asAppError` are imported there and follow it.

Add below `changeSort`:

```tsx
  const [exporting, setExporting] = useState(false);

  const exportResult = useCallback(
    async (format: ExportFormat) => {
      if (!result) return;

      const base = tableTarget?.table ?? activeTab?.title ?? "result";
      const extension = format === "sql" ? "sql" : format;

      const path = await save({
        defaultPath: `${base}.${extension}`,
        filters: [{ name: format.toUpperCase(), extensions: [extension] }],
      });

      // `save` returns null when the user cancels. That is not a
      // failure and must not be reported as one.
      if (path === null) return;

      // Display order, so a sorted grid exports sorted.
      const rows = sortedIndices(result.rows, serverSorted ? null : sort).map(
        (i) => result.rows[i],
      );

      let contents: string;
      if (format === "csv") contents = toCsv(result.columns, rows);
      else if (format === "json") contents = toJson(result.columns, rows);
      else if (tableTarget) {
        contents = toSqlInsert(
          tableTarget.schema,
          tableTarget.table,
          result.columns,
          rows,
        );
      } else return;

      setExporting(true);
      try {
        await writeTextFile(path, contents);
      } catch (e) {
        setError(asAppError(e));
      } finally {
        setExporting(false);
      }
    },
    [result, tableTarget, activeTab?.title, sort, serverSorted],
  );
```

This needs `sortedIndices` imported from `./lib/gridSort`, and `serverSorted` extracted as a named value since it is currently computed inline at both `ResultGrid` call sites. Add above `exportResult`:

```tsx
  // Whether the rows already arrived in database order.
  const serverSorted = tableTarget !== null && activeTab?.mode === "data";
```

and replace both inline `serverSorted={tableTarget !== null && activeTab?.mode === "data"}` props with `serverSorted={serverSorted}`.

- [ ] **Step 3: Render the toolbar**

Above each `<ResultGrid …>` — both call sites — add:

```tsx
                <GridToolbar
                  canExportSql={tableTarget !== null}
                  busy={exporting}
                  onExport={(f) => void exportResult(f)}
                />
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm test && npm run build
```

Expected: clean, and **129 tests passing** — 95 baseline, plus 9 from Task 1, plus 25 from Tasks 2 and 3. Report the real number; a mismatch means a task's tests did not all land.

- [ ] **Step 5: Commit**

```bash
git add src/components/GridToolbar.tsx src/App.tsx
git commit -m "feat(export): export a result to a file"
```

---

### Task 8: Styles

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Add the styles**

These use variables that exist in the `:root` block — `--accent`, `--panel`, `--border`, `--muted`, `--s-1`, `--s-2`, `--s-3`, `--t-xs`, `--t-sm`. Confirm before pasting.

```css
/* ---- grid selection and export --------------------------------- */

.result-grid td.selected {
  /* Tinted rather than filled: the value must stay readable, since
     selecting is how you check what you are about to copy. */
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}

.result-grid:focus {
  outline: none;
}

.grid-toolbar {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-1) var(--s-3);
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.grid-toolbar-label {
  color: var(--muted);
  font-size: var(--t-xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.grid-toolbar button {
  height: 22px;
  padding: 0 var(--s-2);
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--muted);
  font-size: var(--t-sm);
}

.grid-toolbar button:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--accent);
}
```

- [ ] **Step 2: Confirm the stylesheet parses**

```bash
npm run build
```

Do not run the app — the owner smoke tests.

- [ ] **Step 3: Commit**

```bash
git add src/App.css
git commit -m "style(grid): style selection and the export toolbar"
```

---

### Task 9: Verify

- [ ] **Step 1: Everything**

```bash
npx tsc --noEmit && npm test && npm run build
```

```bash
cd src-tauri && cargo test
```

Expected: TS clean and all passing; Rust 148 passed, 0 failed.

- [ ] **Step 2: Confirm the capability did not widen**

```bash
cat src-tauri/capabilities/default.json
```

Expected: exactly `["core:default", "opener:default", "dialog:default"]`. No wildcard, no `fs:` entry. If an `fs` permission appears, something took the wrong path — this stage writes files through our own command specifically to avoid it.

- [ ] **Step 3: Hand over for smoke testing**

Report test counts and what to try by hand:

- Click a cell, shift-click another: the rectangle highlights.
- Cmd+C, then paste into a spreadsheet: cells, not one blob.
- Copy a range containing a NULL: the field is empty, not the word NULL.
- Export CSV, open it: headers present, commas and quotes intact.
- Export JSON: nulls are real nulls.
- On a table Data tab, export SQL: statements name the right table.
- On a query tab: no SQL button.
- Cancel the Save panel: nothing happens, no error.
- Sort, then export: the file is in the sorted order.

---

## Notes for the implementer

- **Never use `formatCell` in export.** It is display formatting — `NULL` for null, a blob for JSON. A CSV needs an empty field. This is the single most likely way this stage ships something subtly wrong.
- **`save()` returns null on cancel.** Treat it as a normal outcome and return silently. Reporting it as an error is the classic bug in this flow.
- **Copy and export follow display order**, via `order`/`sortedIndices` — not `result.rows` directly. A sorted grid must copy and export what is on screen.
- **Do not add `tauri-plugin-fs`.** The narrow `write_text_file` command exists specifically so the webview never gets general filesystem write access.
- **Do not run `cargo clippy` or `cargo fmt`.** Known-failing at baseline; see `docs/BACKLOG.md`.
