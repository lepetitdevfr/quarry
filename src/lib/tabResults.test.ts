import { describe, expect, it } from "vitest";
import {
  emptyTabResult,
  pruneResults,
  resultFor,
  withResult,
} from "./tabResults";
import type { TabResults } from "./tabResults";
import type { QueryResult } from "../types";

/** A result whose only interesting property is which tab it belongs to. */
function rows(count: number): QueryResult {
  return {
    columns: [],
    edit: {
      editable: false,
      reason: null,
      insertable: false,
      insert_reason: null,
      schema: null,
      table: null,
      pk: [],
      columns: [],
    },
    rows: [],
    row_count: count,
    affected_rows: null,
    duration_ms: 1,
  };
}

describe("resultFor", () => {
  it("shows a tab that has run nothing an empty screen", () => {
    // The defect: a fresh tab used to display whatever the previous tab
    // had fetched.
    const all: TabResults = { a: { ...emptyTabResult(), result: rows(15) } };
    expect(resultFor(all, "b").result).toBe(null);
  });

  it("shows a tab its own result", () => {
    const all: TabResults = { a: { ...emptyTabResult(), result: rows(15) } };
    expect(resultFor(all, "a").result?.row_count).toBe(15);
  });

  it("is empty when no tab is open at all", () => {
    expect(resultFor({}, null).result).toBe(null);
    expect(resultFor({}, undefined).ranSql).toBe("");
  });
});

describe("withResult", () => {
  it("writes one tab without touching another", () => {
    let all: TabResults = {};
    all = withResult(all, "a", { result: rows(15), ranSql: "select 15" });
    all = withResult(all, "b", { result: rows(3), ranSql: "select 3" });

    expect(all.a.result?.row_count).toBe(15);
    expect(all.a.ranSql).toBe("select 15");
    expect(all.b.result?.row_count).toBe(3);
  });

  it("merges into what the tab already had", () => {
    let all = withResult({}, "a", { result: rows(15), ranSql: "select 15" });
    all = withResult(all, "a", { sort: { column: 2, direction: "desc" } });

    expect(all.a.result?.row_count).toBe(15);
    expect(all.a.sort).toEqual({ column: 2, direction: "desc" });
  });

  it("drops a write that has no tab to belong to", () => {
    // Rows with no owner are the whole defect. Storing them under a
    // made-up key would put them back on screen for whoever asked next.
    expect(withResult({}, null, { result: rows(15) })).toEqual({});
    expect(withResult({}, undefined, { result: rows(15) })).toEqual({});
  });
});

describe("pruneResults", () => {
  it("takes a closed tab's rows with it", () => {
    let all = withResult({}, "a", { result: rows(15) });
    all = withResult(all, "b", { result: rows(3) });

    const kept = pruneResults(all, ["b"]);

    expect(Object.keys(kept)).toEqual(["b"]);
  });

  it("returns the very same object when nothing was dropped", () => {
    // Identity, not equality: App prunes from an effect that runs on
    // every tab-list change, and a fresh object each time would set
    // state on every render forever.
    let all = withResult({}, "a", { result: rows(15) });
    all = withResult(all, "b", { result: rows(3) });

    expect(pruneResults(all, ["a", "b"])).toBe(all);
  });

  it("clears everything when the last tab closes", () => {
    const all = withResult({}, "a", { result: rows(15) });
    expect(pruneResults(all, [])).toEqual({});
  });
});
