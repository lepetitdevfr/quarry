# Copy and Export — Design Spec

**Date:** 2026-08-15
**Status:** Approved, ready for implementation planning

Select cells in the result grid and copy them. Export the whole result
to CSV, JSON, or — where the target table is known — SQL `INSERT`
statements.

---

## 1. Motivation

Everything the grid shows is currently trapped in it. Getting a result
into a spreadsheet, a ticket, or a colleague's inbox means re-running
the query somewhere else. The grid can sort and resize now; it still
cannot give you the data.

## 2. Scope

### In scope

- Cell selection: click, shift-click for a rectangle, Cmd+A for all.
- Cmd+C copies the selection as TSV, so it pastes into a spreadsheet
  as cells rather than as one blob of text.
- Export all fetched rows to CSV or JSON, and to SQL `INSERT` where a
  target table is known.
- A native Save panel, and a narrow Rust command that writes the file.

### Out of scope

- **Re-running the query to export more than was fetched.** Export
  writes what the grid holds. A Data tab exports its 500 rows.
- **Streaming to disk.** Follows from the above: the rows are already
  in memory, so there is nothing to stream.
- **Exporting only the selection.** Selection is copy's job.
- Inline editing, and the production write-guard that must precede it.

## 3. Selection

`src/lib/gridSelection.ts`, pure and DOM-free.

A selection is an anchor cell and a focus cell; the selected region is
the rectangle between them.

- `selectionRange(anchor, focus)` → `{ top, left, bottom, right }`,
  normalised so a drag up-and-left behaves exactly like one
  down-and-right.
- `isSelected(range, row, col)` → drives cell styling.

Click sets anchor and focus together. Shift-click moves focus only.
Cmd+A selects every cell.

Selection handlers live on `td`. Sorting lives on `th`, and the resize
handle already stops its own pointer and click events — so this cannot
disturb the header behaviour.

Selection is cleared when the result changes, since a rectangle into a
result that no longer exists is meaningless.

## 4. Serialization

`src/lib/exportRows.ts`, pure. Four functions, no DOM, no file access.

| Function | Produces |
|---|---|
| `toTsv(columns, rows)` | Clipboard text: tabs between cells, newlines between rows |
| `toCsv(columns, rows)` | RFC 4180 |
| `toJson(columns, rows)` | Array of objects keyed by column name |
| `toSqlInsert(schema, table, columns, rows)` | One `INSERT` per row |

**Export must not use `formatCell`.** That function produces *display*
text — the string `NULL` for a null, a JSON blob for an object — which
is right for a grid cell and wrong for a file. A CSV needs an empty
field where the value is null, and JSON needs a real `null`. Export
serializes raw `CellValue`s and formats them per target.

Escaping per format:

- **CSV:** a field containing a comma, a double quote, or a newline is
  wrapped in double quotes, and embedded quotes are doubled.
- **JSON:** `JSON.stringify` handles it; SQL NULL becomes JSON `null`.
- **SQL:** identifiers through the existing `quoteIdent`; string values
  escaped by doubling single quotes; numbers and booleans bare; null as
  the bare keyword `NULL`.

`toSqlInsert` is the one function here whose bugs are dangerous rather
than cosmetic — a quoting mistake produces SQL that is broken, or worse,
that runs and does the wrong thing. It gets the heaviest tests.

## 5. Copy

Cmd+C copies the selected range as TSV, via
`navigator.clipboard.writeText`. No plugin required.

Headers are included only when the selection covers whole columns. With
no selection at all, Cmd+C copies the entire result.

## 6. Export

`tauri-plugin-dialog` provides the native Save panel. The chosen path is
passed to a new Rust command:

```rust
write_text_file(path: String, contents: String) -> Result<(), AppError>
```

**Why a command rather than `tauri-plugin-fs`:** fs would grant the
webview a general filesystem write capability. This app needs to write
one file that the user just named in a native dialog. A single narrow
command is a far smaller door, and it keeps the capability list honest.

Format is chosen from a small menu on the grid toolbar: CSV, JSON, and —
only on a table Data tab, where the target table is genuinely known —
SQL `INSERT`. On a query tab the SQL option is absent rather than
disabled: a join or an expression query has no single target table, and
generating `INSERT INTO some_guess` would be worse than not offering it.

The default filename comes from the table name, or the tab title,
with the extension matching the format.

Export writes **all fetched rows in display order**, so a sorted grid
produces a sorted file and the export matches what is on screen.

## 7. Errors

A failed write — permissions, a full disk, a path that vanished —
surfaces through the existing error path.

**A cancelled dialog is not an error.** The plugin returns `null` when
the user cancels, which is easy to mistake for a failure and report as
one. Cancelling must be silent.

## 8. Testing

**`gridSelection`** — range normalisation in all four drag directions;
a single-cell selection; select-all; `isSelected` on the boundaries.

**`exportRows`** — CSV quoting for a comma, an embedded quote, and a
newline; null as an empty CSV field but `null` in JSON; TSV cell and row
separators; SQL escaping of a value containing a single quote;
identifier quoting for a mixed-case table; numbers and booleans emitted
bare; an empty result in every format.

**Rust** — `write_text_file` writes a file, overwrites an existing one,
and returns an error for an unwritable path.

The grid component and the dialog itself are not directly tested: this
project has no component-test harness, and the plugin is someone else's
code. Keeping every decision in the two pure modules is what makes that
acceptable.

## 9. What this stage adds to the app's surface

The first Tauri plugin beyond `opener`, and the first capability change:
`dialog:default` joins `core:default` and `opener:default`. Worth
noticing rather than waving through — a capability list is a security
boundary, and this is the stage that starts growing it.

## 10. Stage order after this

1. **The production write-guard** — Section 4 of the original design
   spec, still unbuilt. Prod connections read-only until explicitly
   unlocked.
2. **Inline row editing** — which the original spec requires be
   "disabled entirely on `ReadOnly` connections", so it follows the
   guard rather than preceding it.
