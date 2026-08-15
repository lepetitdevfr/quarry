# Grid Sort and Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click a column header to sort the result; drag a column border to resize it, double-click to fit it to content.

**Architecture:** Frontend only — no Rust, no IPC, no migration. All decisions live in two pure modules (`src/lib/gridSort.ts`, `src/lib/gridWidths.ts`) that vitest covers directly; `ResultGrid` renders and reports intent. Sort state is owned by `App`, which routes it: a table Data tab re-runs the query with `ORDER BY` appended to our own generated `previewSql`, while a query tab sorts the fetched rows in memory.

**Tech Stack:** React 19, TypeScript 7, vitest, `@tanstack/react-virtual`.

**Spec:** `docs/superpowers/specs/2026-08-15-grid-sort-resize-design.md`

---

## Two corrections to the spec, from reading the code

The spec says the table "moves to `table-layout: fixed`". It is **already** fixed — `src/App.css:94` and `:104`. Nothing to change there.

The spec suggests a `<colgroup>`. That will not work here. Virtualized rows are absolutely positioned and each `tbody tr` is given `display: table; table-layout: fixed` of its own (`App.css:100-105`) so its columns line up with the header. A `colgroup` belongs to the outer table and does not reach those per-row tables. **Widths must be applied as inline styles on both the `th` and every `td`.** Task 6 does this.

## Baselines

Before starting: TypeScript 57 tests passing, `npx tsc --noEmit` clean, `npm run build` clean, Rust 145 passing (untouched by this plan — do not run `cargo` anything).

Do not run `cargo clippy` or `cargo fmt`: both fail at baseline for reasons documented in `docs/BACKLOG.md`, unrelated to this work.

## File Structure

**Create:**
- `src/lib/gridSort.ts` — comparator, sort cycle, index permutation, truncation detection
- `src/lib/gridSort.test.ts`
- `src/lib/gridWidths.ts` — initial widths, fit-to-content, resize arithmetic
- `src/lib/gridWidths.test.ts`

**Modify:**
- `src/lib/schema.ts` — `previewSql` gains optional ordering
- `src/lib/schema.test.ts` — cover it
- `src/components/ResultGrid.tsx` — sort UI, width UI (the only component touched)
- `src/App.tsx` — owns sort state, routes client vs server sorting
- `src/App.css` — header affordances, resize handle

---

### Task 1: The comparator

**Files:**
- Create: `src/lib/gridSort.ts`
- Test: `src/lib/gridSort.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { compareCells } from "./gridSort";

describe("compareCells", () => {
  it("orders numbers numerically, not as text", () => {
    // The bug this exists to prevent: a string sort puts 10 before 9.
    expect(compareCells(9, 10)).toBeLessThan(0);
    expect(compareCells(10, 9)).toBeGreaterThan(0);
    expect(compareCells(5, 5)).toBe(0);
  });

  it("orders strings with localeCompare", () => {
    expect(compareCells("apple", "banana")).toBeLessThan(0);
    expect(compareCells("Banana", "apple")).toBeGreaterThan(0);
  });

  it("orders false before true", () => {
    expect(compareCells(false, true)).toBeLessThan(0);
    expect(compareCells(true, false)).toBeGreaterThan(0);
    expect(compareCells(true, true)).toBe(0);
  });

  it("sorts nulls last, whichever side they are on", () => {
    // Direction is applied by the caller, so the comparator always
    // reports null as greater. `sortedIndices` re-pins them.
    expect(compareCells(null, 5)).toBeGreaterThan(0);
    expect(compareCells(5, null)).toBeLessThan(0);
    expect(compareCells(null, null)).toBe(0);
  });

  it("falls back to formatted text on a mixed-type column", () => {
    // Real Postgres output can mix types in one column (a union, a
    // json field). The comparator must order them somehow and must
    // never throw.
    expect(() => compareCells(5, "apple")).not.toThrow();
    expect(compareCells(5, "apple")).toBeLessThan(0);
  });

  it("orders json by its formatted text", () => {
    expect(compareCells({ a: 1 }, { b: 1 })).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- gridSort
```

Expected: FAIL — cannot resolve `./gridSort`.

- [ ] **Step 3: Implement**

Create `src/lib/gridSort.ts`:

```ts
import { formatCell } from "./format";
import type { CellValue } from "../types";

/**
 * Order two cells for sorting.
 *
 * Always reports null as the greater value; `sortedIndices` is what
 * decides which end nulls land on, because that depends on direction.
 *
 * A column is not guaranteed to hold one type — a union, or a json
 * column, can mix them. Anything the typed branches do not both match
 * falls through to comparing display text, so this cannot throw on real
 * Postgres output.
 */
export function compareCells(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b);
  }

  return formatCell(a).text.localeCompare(formatCell(b).text);
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- gridSort
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gridSort.ts src/lib/gridSort.test.ts
git commit -m "feat(grid): compare cells for sorting"
```

---

### Task 2: The sort cycle and index permutation

**Files:**
- Modify: `src/lib/gridSort.ts`
- Test: `src/lib/gridSort.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/gridSort.test.ts`:

```ts
import { nextSort, sortedIndices } from "./gridSort";
import type { CellValue } from "../types";

const ROWS: CellValue[][] = [
  ["carol", 30],
  ["alice", null],
  ["bob", 9],
  ["dave", 10],
];

describe("nextSort", () => {
  it("cycles ascending, descending, off on the same column", () => {
    // Off has to be reachable, or there is no way back to the order
    // the query returned.
    expect(nextSort(null, 0)).toEqual({ column: 0, direction: "asc" });
    expect(nextSort({ column: 0, direction: "asc" }, 0)).toEqual({
      column: 0,
      direction: "desc",
    });
    expect(nextSort({ column: 0, direction: "desc" }, 0)).toBeNull();
  });

  it("starts a different column ascending", () => {
    expect(nextSort({ column: 0, direction: "desc" }, 1)).toEqual({
      column: 1,
      direction: "asc",
    });
  });
});

describe("sortedIndices", () => {
  it("returns row order, not copied rows", () => {
    const order = sortedIndices(ROWS, { column: 0, direction: "asc" });
    expect(order).toEqual([1, 2, 0, 3]);
  });

  it("sorts descending", () => {
    const order = sortedIndices(ROWS, { column: 0, direction: "desc" });
    expect(order).toEqual([3, 0, 2, 1]);
  });

  it("puts nulls last ascending and first descending, like Postgres", () => {
    // Column 1 holds 30, null, 9, 10. Ascending: 9, 10, 30, then the
    // null. Descending: the null, then 30, 10, 9. Matching Postgres
    // matters because a Data tab sorts server-side and a query tab
    // sorts here — the two must not disagree about the same data.
    expect(sortedIndices(ROWS, { column: 1, direction: "asc" })).toEqual([
      2, 3, 0, 1,
    ]);
    expect(sortedIndices(ROWS, { column: 1, direction: "desc" })).toEqual([
      1, 0, 3, 2,
    ]);
  });

  it("returns query order when there is no sort", () => {
    expect(sortedIndices(ROWS, null)).toEqual([0, 1, 2, 3]);
  });

  it("keeps equal values in their original order", () => {
    const tied: CellValue[][] = [["x", 1], ["x", 2], ["x", 3]];
    const order = sortedIndices(tied, { column: 0, direction: "asc" });
    expect(order).toEqual([0, 1, 2]);
  });

  it("handles a column of all nulls", () => {
    const nulls: CellValue[][] = [[null], [null], [null]];
    expect(sortedIndices(nulls, { column: 0, direction: "asc" })).toEqual([
      0, 1, 2,
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- gridSort
```

Expected: FAIL — `nextSort` and `sortedIndices` are not exported.

- [ ] **Step 3: Implement**

Add to `src/lib/gridSort.ts`, above `compareCells`:

```ts
export type SortDirection = "asc" | "desc";

export interface SortState {
  /** Index into `QueryResult.columns`. */
  column: number;
  direction: SortDirection;
}

/**
 * What clicking a header does next: ascending, then descending, then
 * off. Clicking a different column starts that column ascending.
 */
export function nextSort(
  current: SortState | null,
  column: number,
): SortState | null {
  if (current === null || current.column !== column) {
    return { column, direction: "asc" };
  }
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}
```

and below `compareCells`:

```ts
/**
 * The order rows should be displayed in, as indices into `rows`.
 *
 * Returning a permutation rather than sorted rows keeps the virtualizer
 * rendering straight out of `result.rows`, so sorting a large result
 * copies nothing.
 *
 * Nulls are pinned last ascending and first descending — Postgres's own
 * default. `Array.prototype.sort` is stable in every engine we target,
 * which is what holds equal values in query order.
 */
export function sortedIndices(
  rows: CellValue[][],
  sort: SortState | null,
): number[] {
  const order = rows.map((_, i) => i);
  if (sort === null) return order;

  const sign = sort.direction === "asc" ? 1 : -1;

  return order.sort((left, right) => {
    const a = rows[left][sort.column];
    const b = rows[right][sort.column];

    // Nulls sort last ascending and first descending, so the pin
    // itself flips with `sign` rather than being fixed at one end.
    // Returning a bare 1/-1 here would pin nulls last in BOTH
    // directions, contradicting Postgres — and this is exactly the
    // place the design says the two sort paths must agree.
    if (a === null && b === null) return 0;
    if (a === null) return sign;
    if (b === null) return -sign;

    return sign * compareCells(a, b);
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- gridSort
```

Expected: 13 passed (6 from Task 1, 7 here).

- [ ] **Step 5: Commit**

```bash
git add src/lib/gridSort.ts src/lib/gridSort.test.ts
git commit -m "feat(grid): cycle sort state and order rows"
```

---

### Task 3: Truncation detection

**Files:**
- Modify: `src/lib/gridSort.ts`
- Test: `src/lib/gridSort.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/gridSort.test.ts`:

```ts
import { isTruncated } from "./gridSort";

describe("isTruncated", () => {
  it("flags a result that exactly fills its own LIMIT", () => {
    // 500 rows back from `limit 500` almost certainly means there are
    // more. Sorting these in memory is not sorting the table.
    expect(isTruncated(500, "select * from users limit 500")).toBe(true);
  });

  it("does not flag a result short of its LIMIT", () => {
    expect(isTruncated(12, "select * from users limit 500")).toBe(false);
  });

  it("does not flag a statement with no LIMIT", () => {
    expect(isTruncated(500, "select * from users")).toBe(false);
  });

  it("treats SQL it cannot read as complete", () => {
    // Conservative on purpose: a spurious "this is truncated" warning
    // on every ordinary query would train the user to ignore it.
    expect(isTruncated(500, "")).toBe(false);
    expect(isTruncated(500, "select * from t limit $1")).toBe(false);
  });

  it("is case-insensitive and tolerates trailing whitespace and a semicolon", () => {
    expect(isTruncated(500, "SELECT * FROM users LIMIT 500;  ")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- gridSort
```

Expected: FAIL — `isTruncated` is not exported.

- [ ] **Step 3: Implement**

Add to `src/lib/gridSort.ts`:

```ts
/**
 * Whether the result looks like only part of what the query would
 * return — a row count that exactly fills a `LIMIT` in the statement.
 *
 * Deliberately conservative. This drives a warning marker, and a
 * warning that appears on ordinary queries is a warning the user learns
 * to ignore, so anything unreadable (a parameter, no limit, SQL this
 * regex does not match) counts as complete.
 */
export function isTruncated(rowCount: number, sql: string): boolean {
  const match = /\blimit\s+(\d+)\s*;?\s*$/i.exec(sql);
  if (!match) return false;
  return rowCount === Number(match[1]);
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- gridSort
```

Expected: 18 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gridSort.ts src/lib/gridSort.test.ts
git commit -m "feat(grid): detect a truncated result"
```

---

### Task 4: Column widths

**Files:**
- Create: `src/lib/gridWidths.ts`
- Test: `src/lib/gridWidths.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/gridWidths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MAX_INITIAL_WIDTH,
  MIN_WIDTH,
  fitWidth,
  initialWidths,
  resized,
} from "./gridWidths";
import type { CellValue, ColumnMeta } from "../types";

const COLUMNS: ColumnMeta[] = [
  { name: "id", type_name: "int4" },
  { name: "bio", type_name: "text" },
];

const ROWS: CellValue[][] = [
  [1, "a short bio"],
  [2, "x".repeat(400)],
];

describe("initialWidths", () => {
  it("gives one width per column", () => {
    expect(initialWidths(COLUMNS, ROWS)).toHaveLength(2);
  });

  it("never returns less than the minimum", () => {
    // A one-character column still has to be clickable and readable.
    const narrow = initialWidths([{ name: "n", type_name: "int4" }], [[1]]);
    expect(narrow[0]).toBeGreaterThanOrEqual(MIN_WIDTH);
  });

  it("caps a very wide column", () => {
    // Without a cap, one 400-character text column pushes every other
    // column off screen and the grid opens useless.
    const widths = initialWidths(COLUMNS, ROWS);
    expect(widths[1]).toBeLessThanOrEqual(MAX_INITIAL_WIDTH);
  });

  it("gives a wider column more room than a narrow one", () => {
    const widths = initialWidths(COLUMNS, ROWS);
    expect(widths[1]).toBeGreaterThan(widths[0]);
  });

  it("sizes an empty result from its headers alone", () => {
    const widths = initialWidths(COLUMNS, []);
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeGreaterThanOrEqual(MIN_WIDTH);
  });
});

describe("fitWidth", () => {
  it("sizes to the widest cell in that column", () => {
    expect(fitWidth(1, COLUMNS, ROWS)).toBeGreaterThan(fitWidth(0, COLUMNS, ROWS));
  });

  it("respects the minimum", () => {
    expect(fitWidth(0, COLUMNS, [[1], [2]])).toBeGreaterThanOrEqual(MIN_WIDTH);
  });

  it("is not capped, unlike the initial width", () => {
    // Fitting is an explicit request for the whole value, so the cap
    // that keeps the default layout sane does not apply.
    expect(fitWidth(1, COLUMNS, ROWS)).toBeGreaterThan(MAX_INITIAL_WIDTH);
  });
});

describe("resized", () => {
  it("adds the delta to one column and leaves the rest alone", () => {
    expect(resized([100, 200], 0, 50)).toEqual([150, 200]);
  });

  it("clamps at the minimum so a column cannot vanish", () => {
    expect(resized([100, 200], 0, -1000)).toEqual([MIN_WIDTH, 200]);
  });

  it("ignores an index outside the list", () => {
    expect(resized([100, 200], 7, 50)).toEqual([100, 200]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- gridWidths
```

Expected: FAIL — cannot resolve `./gridWidths`.

- [ ] **Step 3: Implement**

Create `src/lib/gridWidths.ts`:

```ts
import { formatCell } from "./format";
import type { CellValue, ColumnMeta } from "../types";

/** Narrow enough to be tidy, wide enough to stay clickable. */
export const MIN_WIDTH = 64;

/**
 * Ceiling on a *measured* width only. One 400-character text column
 * would otherwise open the grid with every other column off screen.
 * Dragging and fit-to-content deliberately ignore this.
 */
export const MAX_INITIAL_WIDTH = 420;

/** Rough width of one character in the grid's font, in pixels. */
const CHAR_PX = 7.5;

/** Cell padding plus the sort indicator, in pixels. */
const PADDING_PX = 28;

/**
 * Rows scanned when measuring. Measuring all of them would walk a
 * 100k-row result on every query for a number that only decides an
 * initial layout the user can drag.
 */
const SAMPLE_ROWS = 50;

function widthFor(textLength: number): number {
  return Math.ceil(textLength * CHAR_PX) + PADDING_PX;
}

/** The longest rendered text in a column, header included. */
function longest(
  index: number,
  columns: ColumnMeta[],
  rows: CellValue[][],
  sample: number,
): number {
  const header = columns[index];
  // The header shows the name and the type name beside it.
  let longestText = header.name.length + header.type_name.length + 2;

  for (const row of rows.slice(0, sample)) {
    const cell = row[index];
    if (cell === undefined) continue;
    longestText = Math.max(longestText, formatCell(cell).text.length);
  }

  return longestText;
}

/**
 * Starting width per column, measured from the header and a sample of
 * rows, clamped at both ends.
 */
export function initialWidths(
  columns: ColumnMeta[],
  rows: CellValue[][],
): number[] {
  return columns.map((_, i) => {
    const measured = widthFor(longest(i, columns, rows, SAMPLE_ROWS));
    return Math.min(MAX_INITIAL_WIDTH, Math.max(MIN_WIDTH, measured));
  });
}

/**
 * Width that shows the whole of a column's widest value — what
 * double-clicking a border asks for.
 *
 * Uncapped: the user asked to see the value, so the cap that keeps the
 * default layout readable would defeat the request. Every row is
 * measured, not a sample, for the same reason.
 */
export function fitWidth(
  index: number,
  columns: ColumnMeta[],
  rows: CellValue[][],
): number {
  const measured = widthFor(longest(index, columns, rows, rows.length));
  return Math.max(MIN_WIDTH, measured);
}

/** Apply a drag to one column. An unknown index changes nothing. */
export function resized(
  widths: number[],
  index: number,
  delta: number,
): number[] {
  if (index < 0 || index >= widths.length) return widths;
  return widths.map((w, i) =>
    i === index ? Math.max(MIN_WIDTH, w + delta) : w,
  );
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- gridWidths
```

Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gridWidths.ts src/lib/gridWidths.test.ts
git commit -m "feat(grid): measure and resize column widths"
```

---

### Task 5: `previewSql` ordering

**Files:**
- Modify: `src/lib/schema.ts:132-135`
- Test: `src/lib/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe` block structure in `src/lib/schema.test.ts` (add a new top-level `describe`):

```ts
describe("previewSql", () => {
  it("selects a capped page with no ordering by default", () => {
    expect(previewSql("public", "users")).toBe(
      'select * from "public"."users" limit 500',
    );
  });

  it("appends an ORDER BY before the limit", () => {
    // Order must precede limit, or the database sorts the page rather
    // than the table — which is the entire point of re-running.
    expect(
      previewSql("public", "users", { column: "created_at", direction: "asc" }),
    ).toBe(
      'select * from "public"."users" order by "created_at" asc limit 500',
    );
  });

  it("sorts descending", () => {
    expect(
      previewSql("public", "users", { column: "id", direction: "desc" }),
    ).toBe('select * from "public"."users" order by "id" desc limit 500');
  });

  it("quotes a column name that needs it", () => {
    // A mixed-case or reserved-word column is unreachable unquoted, and
    // an embedded quote must be doubled or the statement is malformed.
    expect(
      previewSql("public", "users", { column: 'we"ird', direction: "asc" }),
    ).toBe('select * from "public"."users" order by "we""ird" asc limit 500');
  });
});
```

Add `previewSql` to the existing import at the top of `src/lib/schema.test.ts`.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- schema
```

Expected: FAIL — `previewSql` takes 2 arguments, not 3.

- [ ] **Step 3: Implement**

Replace `previewSql` in `src/lib/schema.ts`:

```ts
/** Which column a preview is ordered by, when it is ordered at all. */
export interface PreviewOrder {
  column: string;
  direction: "asc" | "desc";
}

/**
 * The SQL a table preview runs.
 *
 * `order` is what makes sorting a Data tab honest. The tab shows at
 * most `PREVIEW_LIMIT` rows, so sorting those in memory would order a
 * page rather than the table. Because this statement is ours — nothing
 * is parsed or wrapped — the ordering can simply be generated in the
 * right place, before the limit.
 */
export function previewSql(
  schema: string,
  table: string,
  order?: PreviewOrder,
): string {
  const target = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const ordering = order
    ? ` order by ${quoteIdent(order.column)} ${order.direction}`
    : "";
  return `select * from ${target}${ordering} limit ${PREVIEW_LIMIT}`;
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- schema
```

Expected: all pass, including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schema.ts src/lib/schema.test.ts
git commit -m "feat(grid): order a table preview in the database"
```

---

### Task 6: Sorting in `ResultGrid`

**Files:**
- Modify: `src/components/ResultGrid.tsx`

`ResultGrid` is a controlled component for sorting: `App` owns the state, because a Data tab's sort is a query re-run rather than a local reorder. The grid reports intent and renders.

No test — there is no component-test harness in this project (no testing-library, no jsdom), which is exactly why Tasks 1-4 put every decision in pure modules. Do not add one; that is out of scope for this stage.

- [ ] **Step 1: Rewrite the component**

```tsx
import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatCell } from "../lib/format";
import { isTruncated, nextSort, sortedIndices } from "../lib/gridSort";
import type { SortState } from "../lib/gridSort";
import type { QueryResult } from "../types";

interface Props {
  result: QueryResult;
  /** The statement that produced `result`, for truncation detection. */
  sql: string;
  sort: SortState | null;
  onSortChange: (sort: SortState | null) => void;
  /**
   * True when the rows arrived already ordered by the database — a
   * table Data tab, which re-runs with `ORDER BY`. Sorting them again
   * here would be wasted work at best and, on a truncated result,
   * wrong.
   */
  serverSorted: boolean;
}

const ROW_HEIGHT = 28;

export function ResultGrid({
  result,
  sql,
  sort,
  onSortChange,
  serverSorted,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Only the visible rows are mounted. Without this a 100k-row result
  // creates 100k DOM nodes and the window stops responding.
  const virtualizer = useVirtualizer({
    count: result.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (result.columns.length === 0) {
    return <div className="grid-empty">Statement returned no columns.</div>;
  }

  const order = serverSorted
    ? result.rows.map((_, i) => i)
    : sortedIndices(result.rows, sort);

  // Only a locally sorted page can mislead: a Data tab's ordering was
  // done by the database over the whole table.
  const partial = !serverSorted && sort !== null && isTruncated(result.rows.length, sql);

  return (
    <div className="result-grid" ref={scrollRef}>
      <table>
        <thead>
          <tr>
            {/* Ordinal gutter. Empty header: numbering the numbering
                column would be noise. */}
            <th className="row-num" aria-label="Row number" />
            {result.columns.map((c, i) => (
              // Column names can repeat (e.g. `SELECT 1 as n, 2 as n`), so
              // the index is used as the key instead of the name.
              <th
                key={i}
                title={c.type_name}
                className={sort?.column === i ? "sorted" : undefined}
                onClick={() => onSortChange(nextSort(sort, i))}
              >
                {c.name}
                <span className="col-type">{c.type_name}</span>
                {sort?.column === i && (
                  <span className="sort-arrow">
                    {sort.direction === "asc" ? "▲" : "▼"}
                  </span>
                )}
                {sort?.column === i && partial && (
                  <span
                    className="sort-partial"
                    title={`sorted within the first ${result.rows.length} rows fetched, not the whole table`}
                  >
                    !
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = result.rows[order[item.index]];
            return (
              <tr
                key={item.key}
                style={{
                  position: "absolute",
                  transform: `translateY(${item.start}px)`,
                  height: `${ROW_HEIGHT}px`,
                }}
              >
                <td className="row-num">{item.index + 1}</td>
                {row.map((cell, i) => {
                  const { text, kind } = formatCell(cell);
                  return (
                    <td key={i} className={`cell-${kind}`} title={text}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

Note the row lookup: `result.rows[order[item.index]]`. The virtualizer still counts and positions rows by display position, while `order` maps that to the underlying row. The ordinal gutter deliberately keeps showing display position, so the numbers stay 1..n after a sort.

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: errors in `src/App.tsx` only — it does not pass the four new props yet. Task 8 fixes that. Any error inside `ResultGrid.tsx` itself is yours to fix now.

- [ ] **Step 3: Commit**

```bash
git add src/components/ResultGrid.tsx
git commit -m "feat(grid): sort by clicking a column header"
```

---

### Task 7: Resizing in `ResultGrid`

**Files:**
- Modify: `src/components/ResultGrid.tsx`

- [ ] **Step 1: Add width state and the drag handle**

Add to the imports:

```tsx
import { useEffect, useState } from "react";
import { fitWidth, initialWidths, resized } from "../lib/gridWidths";
```

(keep the existing `useRef` import — the line becomes `import { useEffect, useRef, useState } from "react";`)

Inside the component, after the `virtualizer`:

```tsx
  const [widths, setWidths] = useState<number[]>(() =>
    initialWidths(result.columns, result.rows),
  );

  // A new result may have entirely different columns, so measured
  // widths from the previous one mean nothing. `result` is a fresh
  // object per run, so identity is the right trigger.
  useEffect(() => {
    setWidths(initialWidths(result.columns, result.rows));
  }, [result]);

  // Drag state lives in a ref, not state: it changes on every
  // pointermove and re-rendering a virtualized grid at that rate is
  // what makes a resize feel laggy.
  const drag = useRef<{ index: number; startX: number; startWidth: number } | null>(
    null,
  );

  function onHandleDown(e: React.PointerEvent, index: number) {
    // Stop the click reaching the header, or every resize also sorts.
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { index, startX: e.clientX, startWidth: widths[index] };
  }

  function onHandleMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    // Measured from where the drag started, never from the previous
    // frame: accumulating per-frame deltas drifts away from the pointer
    // as soon as one frame is dropped.
    const width = Math.max(MIN_WIDTH, d.startWidth + (e.clientX - d.startX));
    setWidths((current) => current.map((w, i) => (i === d.index ? width : w)));
  }

  function onHandleUp(e: React.PointerEvent) {
    if (drag.current === null) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
  }
```

Import `MIN_WIDTH` alongside the others:

```tsx
import { MIN_WIDTH, fitWidth, initialWidths, resized } from "../lib/gridWidths";
```

`resized` is still used by the keyboard path below.

- [ ] **Step 2: Apply the widths and render the handle**

Give the `th` an explicit width and a handle child:

```tsx
              <th
                key={i}
                title={c.type_name}
                style={{ width: `${widths[i]}px` }}
                className={sort?.column === i ? "sorted" : undefined}
                onClick={() => onSortChange(nextSort(sort, i))}
              >
                {c.name}
                <span className="col-type">{c.type_name}</span>
                {sort?.column === i && (
                  <span className="sort-arrow">
                    {sort.direction === "asc" ? "▲" : "▼"}
                  </span>
                )}
                {sort?.column === i && partial && (
                  <span
                    className="sort-partial"
                    title={`sorted within the first ${result.rows.length} rows fetched, not the whole table`}
                  >
                    !
                  </span>
                )}
                <span
                  className="col-resize"
                  onPointerDown={(e) => onHandleDown(e, i)}
                  onPointerMove={onHandleMove}
                  onPointerUp={onHandleUp}
                  onDoubleClick={(e) => {
                    // Without this the double-click also cycles the sort
                    // twice on its way through the header.
                    e.stopPropagation();
                    setWidths((current) =>
                      current.map((w, index) =>
                        index === i
                          ? fitWidth(i, result.columns, result.rows)
                          : w,
                      ),
                    );
                  }}
                  onKeyDown={(e) => {
                    // Keyboard-first app: a column must be resizable
                    // without a pointer.
                    if (e.key === "ArrowLeft") setWidths((c) => resized(c, i, -16));
                    if (e.key === "ArrowRight") setWidths((c) => resized(c, i, 16));
                  }}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${c.name}`}
                  tabIndex={0}
                />
              </th>
```

and the matching `td`:

```tsx
                  return (
                    <td
                      key={i}
                      className={`cell-${kind}`}
                      style={{ width: `${widths[i]}px` }}
                      title={text}
                    >
                      {text}
                    </td>
                  );
```

The `td` width is not redundant. Each `tbody tr` is laid out as its own `display: table; table-layout: fixed` element (`App.css:100-105`) so virtualized rows line up with the header — which also means the header's widths do not reach them. Both sides need it.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: still only the `App.tsx` prop errors from Task 6.

- [ ] **Step 4: Commit**

```bash
git add src/components/ResultGrid.tsx
git commit -m "feat(grid): resize columns by dragging a border"
```

---

### Task 8: Wire it into `App`

**Files:**
- Modify: `src/App.tsx`

`App` owns sort state because a Data tab's sort is a query execution.

- [ ] **Step 1: Import and add state**

Add to the imports:

```tsx
import type { SortState } from "./lib/gridSort";
```

After the `detail` memo (around line 95), add:

```tsx
  // Sort lives here rather than in the grid because a table Data tab
  // sorts by re-running the query, which only App can do.
  const [sort, setSort] = useState<SortState | null>(null);
  // The statement behind the current result, for truncation detection
  // and for re-running a Data tab in a new order.
  const [ranSql, setRanSql] = useState("");
```

- [ ] **Step 2: Record the SQL, and stop blanking the grid on failure**

Replace `runSql` (line 167) entirely with this version. Two changes: it records the statement, and it no longer calls `setResult(null)` in the `catch`.

```tsx
  const runSql = useCallback(
    async (sql: string) => {
      if (!connection) return;
      setBusy(true);
      setError(null);
      try {
        setResult(await execute(sql));
        setRanSql(sql);
      } catch (e) {
        setError(asAppError(e));
        // The previous result deliberately stays on screen. A sort on a
        // Data tab is a re-run, so a failed sort would otherwise throw
        // away the rows you already had — worse than the failure.
      } finally {
        setBusy(false);
      }
    },
    [connection],
  );
```

Note what is deliberately *not* here: `sort` is not cleared. A Data-tab sort re-runs through this function and must not wipe the sort it just applied. Clearing belongs to the callers in Step 3.

- [ ] **Step 3: Clear the sort when the result's shape changes**

In `run` (the Cmd+Enter path, line 185) and in `openTableData`, reset the sort — a new query may have entirely different columns:

```tsx
  const run = useCallback(() => {
    setSort(null);
    void runSql(text);
  }, [runSql, text]);
```

```tsx
  const openTableData = useCallback(
    async (schemaName: string, tableName: string) => {
      setSort(null);
      await actions.openTableTab(schemaName, tableName, "data", true);
      await runSql(previewSql(schemaName, tableName));
    },
    [actions, runSql],
  );
```

Do the same in `changeTableMode`, which also runs a fresh preview:

```tsx
  const changeTableMode = useCallback(
    async (next: TableMode) => {
      if (!activeTab || !tableTarget) return;
      setSort(null);
      await actions.setTabMode(activeTab.id, next);
      if (next === "data") await runSql(previewSql(tableTarget.schema, tableTarget.table));
    },
    [activeTab, tableTarget, actions, runSql],
  );
```

- [ ] **Step 4: Route the sort**

Add below `changeTableMode`:

```tsx
  // A Data tab re-runs with ORDER BY, because its rows are capped at
  // PREVIEW_LIMIT and sorting that page in memory would answer a
  // question nobody asked. A query tab sorts its fetched rows, since
  // re-running would either strip a LIMIT the user wrote or return the
  // very same rows.
  const changeSort = useCallback(
    async (next: SortState | null) => {
      setSort(next);

      if (!tableTarget || activeTab?.mode !== "data") return;

      const column = next === null ? undefined : result?.columns[next.column]?.name;
      await runSql(
        previewSql(
          tableTarget.schema,
          tableTarget.table,
          column && next ? { column, direction: next.direction } : undefined,
        ),
      );
    },
    [tableTarget, activeTab?.mode, result, runSql],
  );
```

Keeping the previous result on a failed sort is already handled — Step 2 removed the `setResult(null)` from `runSql`'s `catch`.

- [ ] **Step 5: Pass the props**

Both `ResultGrid` usages in the render (inside `TableView`'s children, and in the query-tab branch) need the new props. Replace each `{result && <ResultGrid result={result} />}` with:

```tsx
            {result && (
              <ResultGrid
                result={result}
                sql={ranSql}
                sort={sort}
                onSortChange={(next) => void changeSort(next)}
                serverSorted={tableTarget !== null && activeTab?.mode === "data"}
              />
            )}
```

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit && npm test && npm run build
```

Expected: clean, all tests pass, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat(grid): route sorting by tab kind"
```

---

### Task 9: Styles

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Add the styles**

Append to `src/App.css`. These use variables that exist in the file's `:root` — `--border`, `--muted`, `--faint`, `--accent`, `--error`, `--t-xs`, `--s-1`. Check them before pasting and substitute the nearest existing one if any is missing.

```css
/* ---- grid sort and resize -------------------------------------- */

.result-grid thead th {
  /* The resize handle is positioned against this. */
  position: sticky;
  cursor: pointer;
  user-select: none;
}

.result-grid thead th.row-num {
  cursor: default;
}

.result-grid thead th.sorted {
  color: var(--accent);
}

.sort-arrow {
  margin-left: var(--s-1);
  font-size: var(--t-xs);
}

/* The sort covered only the rows already fetched, not the table. */
.sort-partial {
  margin-left: var(--s-1);
  color: var(--error);
  font-weight: 700;
  cursor: help;
}

.col-resize {
  position: absolute;
  top: 0;
  right: 0;
  width: 7px;
  height: 100%;
  cursor: col-resize;
  /* Sits above the header's own click target so a drag never sorts. */
  z-index: 2;
}

.col-resize:hover,
.col-resize:focus-visible {
  background: var(--accent);
  outline: none;
}
```

- [ ] **Step 2: Look at it**

Do not run the app — the owner smoke tests. Confirm the stylesheet parses:

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/App.css
git commit -m "style(grid): style the sort and resize affordances"
```

---

### Task 10: Verify the whole thing

- [ ] **Step 1: TypeScript**

```bash
npx tsc --noEmit && npm test && npm run build
```

Expected: clean. Baseline was 57 tests; this plan adds 33 (18 gridSort, 11 gridWidths, 4 previewSql), so expect 90.

- [ ] **Step 2: Rust is untouched**

```bash
git diff --stat main..HEAD -- src-tauri/
```

Expected: no output. This stage changes no Rust; if it did, something went wrong.

- [ ] **Step 3: Hand over for smoke testing**

Report the test counts and the things to try by hand:

- Run a query, click a header: ascending, descending, then back to query order.
- Sort a numeric column and confirm 9 sorts before 10, not after.
- Sort a column containing NULLs: they land last ascending, first descending.
- Open a table's Data tab and sort it — confirm it re-runs (the row set should change, not just reorder, on a table with more than 500 rows).
- Drag a column border; double-click a border to fit; tab to a handle and use the arrow keys.
- Re-run a query and confirm widths and sort reset.

---

## Notes for the implementer

- **Do not add a component-test harness.** Tasks 1-5 exist so that every decision is testable without one. If you find yourself wanting to test `ResultGrid` directly, the logic you want to test probably belongs in `gridSort.ts` or `gridWidths.ts`.
- **Both `th` and `td` need explicit widths.** Virtualized rows lay out as their own tables (`App.css:100-105`), so a width on the header alone does not reach them.
- **The table is already `table-layout: fixed`.** Nothing to change there, despite what the spec's §6 implies.
- **Do not run `cargo` anything, `cargo clippy`, or `cargo fmt`.** No Rust changes here, and both lint commands fail at baseline for reasons already recorded in `docs/BACKLOG.md`.
