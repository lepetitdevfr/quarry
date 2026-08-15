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
