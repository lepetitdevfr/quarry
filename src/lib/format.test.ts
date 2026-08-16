import { describe, expect, it } from "vitest";
import { formatCell } from "./format";
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
