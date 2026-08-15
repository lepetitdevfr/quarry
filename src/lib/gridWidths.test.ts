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
