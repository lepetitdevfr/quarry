import { describe, expect, it } from "vitest";
import { groupRecent, summarise } from "./recent";
import type { RecentItem } from "../types";

function item(over: Partial<RecentItem>): RecentItem {
  return {
    id: "id",
    kind: "run",
    sql: "select 1",
    connection_id: "conn-a",
    title: null,
    first_at: "2026-08-20T10:00:00Z",
    last_at: "2026-08-20T10:00:00Z",
    run_count: 1,
    duration_ms: 5,
    row_count: 1,
    error: null,
    ...over,
  };
}

describe("groupRecent", () => {
  it("puts the active connection's work first, keeping the rest below", () => {
    // Nothing is hidden by connection: a query written against staging
    // stays findable while connected to production.
    const rows = groupRecent(
      [
        item({ id: "1", connection_id: "other", sql: "select other" }),
        item({ id: "2", connection_id: "conn-a", sql: "select mine" }),
      ],
      "conn-a",
      "",
    );

    expect(rows.map((r) => r.item.id)).toEqual(["2", "1"]);
    expect(rows[0].here).toBe(true);
    expect(rows[1].here).toBe(false);
  });

  it("keeps each group newest first", () => {
    const rows = groupRecent(
      [
        item({ id: "old", last_at: "2026-08-19T10:00:00Z" }),
        item({ id: "new", last_at: "2026-08-20T10:00:00Z" }),
      ],
      "conn-a",
      "",
    );

    expect(rows.map((r) => r.item.id)).toEqual(["new", "old"]);
  });

  it("filters on the SQL, case-insensitively", () => {
    const rows = groupRecent(
      [
        item({ id: "1", sql: "SELECT * FROM orders" }),
        item({ id: "2", sql: "select 1" }),
      ],
      "conn-a",
      "orders",
    );

    expect(rows.map((r) => r.item.id)).toEqual(["1"]);
  });

  it("filters on a closed tab's title too", () => {
    const rows = groupRecent(
      [item({ id: "1", kind: "closed", title: "revenue draft", sql: "select 1" })],
      "conn-a",
      "revenue",
    );

    expect(rows).toHaveLength(1);
  });

  it("treats an item whose connection was deleted as elsewhere, not as here", () => {
    // The work outlives its origin; it must not masquerade as belonging
    // to whatever you happen to be connected to now.
    const rows = groupRecent([item({ connection_id: null })], "conn-a", "");

    expect(rows[0].here).toBe(false);
  });

  it("puts nothing in the here group when no connection is live", () => {
    const rows = groupRecent([item({ connection_id: "conn-a" })], null, "");

    expect(rows[0].here).toBe(false);
  });
});

describe("summarise", () => {
  it("gives a run its count when it has been run more than once", () => {
    expect(summarise(item({ run_count: 4 }))).toContain("4×");
  });

  it("says nothing about the count of a single run", () => {
    expect(summarise(item({ run_count: 1 }))).not.toContain("×");
  });

  it("marks a run whose last attempt failed", () => {
    expect(summarise(item({ error: "syntax error" }))).toContain("failed");
  });

  it("does not claim a row count on a run that failed", () => {
    // The rows are from the last attempt that worked, if any; saying
    // "1 row" beside "failed" would describe two different runs at once.
    const text = summarise(item({ error: "syntax error", row_count: 1 }));
    expect(text).not.toContain("row");
  });

  it("describes a closed tab as unsaved rather than as a run", () => {
    const text = summarise(
      item({ kind: "closed", run_count: 0, duration_ms: null, row_count: null }),
    );
    expect(text).toContain("unsaved");
    expect(text).not.toContain("×");
  });
});

describe("groupRecent scoped to one connection", () => {
  it("hides other connections' work when scoped here", () => {
    const rows = groupRecent(
      [
        item({ id: "mine", connection_id: "conn-a" }),
        item({ id: "theirs", connection_id: "other" }),
      ],
      "conn-a",
      "",
      "here",
    );

    expect(rows.map((r) => r.item.id)).toEqual(["mine"]);
  });

  it("shows everything when scoped all", () => {
    const rows = groupRecent(
      [
        item({ id: "mine", connection_id: "conn-a" }),
        item({ id: "theirs", connection_id: "other" }),
      ],
      "conn-a",
      "",
      "all",
    );

    expect(rows).toHaveLength(2);
  });

  it("shows everything when scoped here with no connection", () => {
    // An empty list would read as "you have no history" rather than
    // "you are not connected to anything".
    const rows = groupRecent([item({ connection_id: "conn-a" })], null, "", "here");

    expect(rows).toHaveLength(1);
  });

  it("hides work whose connection was deleted when scoped here", () => {
    // It belongs to nobody, so it must not pass as work against the
    // database you are on.
    const rows = groupRecent([item({ connection_id: null })], "conn-a", "", "here");

    expect(rows).toHaveLength(0);
  });

  it("still filters within the scope", () => {
    const rows = groupRecent(
      [
        item({ id: "1", connection_id: "conn-a", sql: "select from orders" }),
        item({ id: "2", connection_id: "conn-a", sql: "select 1" }),
      ],
      "conn-a",
      "orders",
      "here",
    );

    expect(rows.map((r) => r.item.id)).toEqual(["1"]);
  });
});
