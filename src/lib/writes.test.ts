import { describe, expect, it } from "vitest";
import { describeWrite, matchesWrite, writeIsHere } from "./writes";
import type { WriteRecord } from "../types";

function record(over: Partial<WriteRecord>): WriteRecord {
  return {
    id: "id",
    at: "2026-08-21T10:00:00Z",
    connection_id: "conn-a",
    connection_name: "smoke",
    tag: "local",
    sql: "update t set a = 1",
    kind: "update",
    row_count: 3,
    outcome: "committed",
    reason: null,
    undo_sql: null,
    ...over,
  };
}

describe("describeWrite", () => {
  it("says what a committed write did", () => {
    expect(describeWrite(record({ row_count: 3 }))).toBe("3 rows · committed");
  });

  it("counts one row as one row", () => {
    expect(describeWrite(record({ row_count: 1 }))).toBe("1 row · committed");
  });

  it("says a rollback happened rather than staying silent about it", () => {
    // The whole reason rollbacks are recorded: "I nearly did this" is
    // the fact worth having.
    expect(
      describeWrite(record({ outcome: "rolled_back", row_count: null })),
    ).toBe("discarded");
  });

  it("gives a refusal its reason", () => {
    const text = describeWrite(
      record({
        outcome: "refused",
        row_count: null,
        reason: "-- expect: 1, but 5 rows matched — rolled back",
      }),
    );
    expect(text).toContain("refused");
    expect(text).toContain("expect");
  });

  it("gives a failure its reason", () => {
    const text = describeWrite(
      record({
        outcome: "failed",
        row_count: null,
        reason: 'relation "t" does not exist',
      }),
    );
    expect(text).toContain("failed");
    expect(text).toContain("does not exist");
  });

  it("says nothing about a rowcount a DDL statement never had", () => {
    expect(describeWrite(record({ kind: "ddl", row_count: null }))).toBe(
      "committed",
    );
  });
});

describe("matchesWrite", () => {
  it("matches on the SQL, case-insensitively", () => {
    expect(matchesWrite(record({ sql: "DELETE FROM orders" }), "orders")).toBe(
      true,
    );
    expect(
      matchesWrite(record({ sql: "DELETE FROM orders" }), "customers"),
    ).toBe(false);
  });

  it("matches on the connection it hit", () => {
    // Six months later, "what did I run against production" is the
    // question being asked.
    expect(matchesWrite(record({ connection_name: "railway" }), "railway")).toBe(
      true,
    );
  });

  it("matches everything on an empty filter", () => {
    expect(matchesWrite(record({}), "")).toBe(true);
  });
});

describe("writeIsHere", () => {
  it("recognises a write against the connection you are on", () => {
    expect(writeIsHere(record({ connection_id: "conn-a" }), "conn-a")).toBe(true);
    expect(writeIsHere(record({ connection_id: "other" }), "conn-a")).toBe(false);
  });

  it("says no when nothing is connected", () => {
    expect(writeIsHere(record({ connection_id: "conn-a" }), null)).toBe(false);
  });

  it("says no for a write whose connection was deleted", () => {
    // It belongs to nobody. Passing it off as work against the current
    // database would be the log inventing a fact.
    expect(writeIsHere(record({ connection_id: null }), "conn-a")).toBe(false);
  });
});
