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
    // Row 1 holds the null in column 1. Matching Postgres matters:
    // a Data tab sorts server-side, a query tab sorts here, and the
    // two must not disagree about the same data.
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
