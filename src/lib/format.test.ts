import { describe, expect, it } from "vitest";
import { formatBytes, formatCell, formatRowEstimate } from "./format";
import { UNKNOWN } from "../types";

describe("formatCell", () => {
  it("renders null distinctly from an empty string", () => {
    expect(formatCell(null)).toEqual({ text: "NULL", kind: "null" });
    expect(formatCell("")).toEqual({ text: "", kind: "text" });
  });

  it("renders booleans as lowercase literals", () => {
    expect(formatCell(true)).toEqual({ text: "true", kind: "bool" });
    expect(formatCell(false)).toEqual({ text: "false", kind: "bool" });
  });

  it("renders numbers without locale separators", () => {
    expect(formatCell(1234567)).toEqual({ text: "1234567", kind: "number" });
  });

  it("collapses objects and arrays to single-line JSON", () => {
    expect(formatCell({ k: 1 })).toEqual({ text: '{"k":1}', kind: "json" });
    expect(formatCell([1, 2])).toEqual({ text: "[1,2]", kind: "json" });
  });

  it("passes strings through untouched", () => {
    expect(formatCell("hello")).toEqual({ text: "hello", kind: "text" });
  });

  it("renders an unknown cell distinctly from NULL", () => {
    expect(formatCell(UNKNOWN)).toEqual({ text: "—", kind: "unknown" });
    expect(formatCell(null)).toEqual({ text: "NULL", kind: "null" });
  });
});

describe("table facts", () => {
  it("formats a size in the largest unit that stays readable", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    // Decimal units, like pg_size_pretty: 8192 bytes is 8.2 kB, not the
    // 8.0 a binary kilobyte would give.
    expect(formatBytes(8192)).toBe("8.2 kB");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(3_000_000_000)).toBe("3.0 GB");
  });

  it("says unknown for a table that was never analyzed", () => {
    // pg_class.reltuples is -1 there, not 0. Showing "-1 rows" or
    // "0 rows" would both be lies — one absurd, one plausible and
    // therefore worse.
    expect(formatRowEstimate(-1)).toBe("unknown");
    expect(formatRowEstimate(0)).toBe("0");
    expect(formatRowEstimate(1234567)).toBe("1,234,567");
  });
});
