import { describe, expect, it } from "vitest";
import { isSelected, movedCell, selectAll, selectionRange } from "./gridSelection";

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

describe("movedCell", () => {
  const from = { row: 3, col: 2 };

  it("moves by one in each direction", () => {
    expect(movedCell(from, 1, 0, 10, 5)).toEqual({ row: 4, col: 2 });
    expect(movedCell(from, -1, 0, 10, 5)).toEqual({ row: 2, col: 2 });
    expect(movedCell(from, 0, 1, 10, 5)).toEqual({ row: 3, col: 3 });
    expect(movedCell(from, 0, -1, 10, 5)).toEqual({ row: 3, col: 1 });
  });

  it("stops at the edges rather than wrapping", () => {
    expect(movedCell({ row: 0, col: 0 }, -1, -1, 10, 5)).toEqual({
      row: 0,
      col: 0,
    });
    expect(movedCell({ row: 9, col: 4 }, 1, 1, 10, 5)).toEqual({
      row: 9,
      col: 4,
    });
  });

  it("takes a page-sized jump without leaving the grid", () => {
    expect(movedCell(from, 20, 0, 10, 5)).toEqual({ row: 9, col: 2 });
    expect(movedCell(from, -20, 0, 10, 5)).toEqual({ row: 0, col: 2 });
  });

  it("never returns a negative index for an empty result", () => {
    expect(movedCell({ row: 0, col: 0 }, 1, 1, 0, 0)).toEqual({
      row: 0,
      col: 0,
    });
  });
});
