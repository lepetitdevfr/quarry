import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
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
