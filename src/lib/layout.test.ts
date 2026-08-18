import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_HEIGHT,
  DEFAULT_SCHEMA_HEIGHT,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_EDITOR_HEIGHT,
  MIN_SECTION_HEIGHT,
  MIN_SIDEBAR_WIDTH,
  clampEditorHeight,
  clampSectionHeight,
  clampSidebarWidth,
} from "./layout";

describe("clampSidebarWidth", () => {
  it("passes a normal width through untouched", () => {
    expect(clampSidebarWidth(300)).toBe(300);
  });

  it("stops at the minimum", () => {
    expect(clampSidebarWidth(50)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(-200)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it("stops at the maximum", () => {
    expect(clampSidebarWidth(2000)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("keeps the boundaries themselves", () => {
    expect(clampSidebarWidth(MIN_SIDEBAR_WIDTH)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(MAX_SIDEBAR_WIDTH)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("falls back to the default for a value that is not a number", () => {
    // A pointer event on a detached element can yield NaN; rendering a
    // NaN-wide sidebar collapses it with no way to drag it back.
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it("has a default inside its own bounds", () => {
    expect(DEFAULT_SIDEBAR_WIDTH).toBeGreaterThanOrEqual(MIN_SIDEBAR_WIDTH);
    expect(DEFAULT_SIDEBAR_WIDTH).toBeLessThanOrEqual(MAX_SIDEBAR_WIDTH);
  });
});

describe("clampEditorHeight", () => {
  it("passes a normal height through untouched", () => {
    expect(clampEditorHeight(240, 800)).toBe(240);
  });

  it("stops at the minimum", () => {
    expect(clampEditorHeight(10, 800)).toBe(MIN_EDITOR_HEIGHT);
    expect(clampEditorHeight(-400, 800)).toBe(MIN_EDITOR_HEIGHT);
  });

  it("leaves room for the grid", () => {
    // 800 tall, 120 reserved for results: dragging to the bottom stops
    // at 680 rather than swallowing the grid.
    expect(clampEditorHeight(9000, 800)).toBe(680);
  });

  it("keeps the editor usable even in a window too short for both", () => {
    // available - 120 is negative here; the minimum has to win, or the
    // editor collapses to nothing and takes its own drag handle with it.
    expect(clampEditorHeight(300, 100)).toBe(MIN_EDITOR_HEIGHT);
  });

  it("falls back to the default for a value that is not a number", () => {
    expect(clampEditorHeight(Number.NaN, 800)).toBe(DEFAULT_EDITOR_HEIGHT);
  });

  it("has a default at or above its own minimum", () => {
    expect(DEFAULT_EDITOR_HEIGHT).toBeGreaterThanOrEqual(MIN_EDITOR_HEIGHT);
  });
});

describe("clampSectionHeight", () => {
  it("passes a normal height through untouched", () => {
    expect(clampSectionHeight(300, 900)).toBe(300);
  });

  it("stops at the minimum", () => {
    expect(clampSectionHeight(4, 900)).toBe(MIN_SECTION_HEIGHT);
  });

  it("leaves the other section its minimum", () => {
    expect(clampSectionHeight(9000, 900)).toBe(900 - MIN_SECTION_HEIGHT);
  });

  it("keeps the dragged section usable in a sidebar too short for both", () => {
    expect(clampSectionHeight(200, 100)).toBe(MIN_SECTION_HEIGHT);
  });

  it("falls back to the default for a value that is not a number", () => {
    expect(clampSectionHeight(Number.NaN, 900)).toBe(DEFAULT_SCHEMA_HEIGHT);
  });
});
