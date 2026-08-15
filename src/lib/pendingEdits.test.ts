import { describe, expect, it } from "vitest";
import {
  applyPatches,
  cellText,
  count,
  emptyPending,
  isPending,
  pendingValue,
  stage,
  toRowEdits,
  editingBlockedReason,
} from "./pendingEdits";
import type { QueryResult } from "../types";

function result(): QueryResult {
  return {
    columns: [
      { name: "id", type_name: "int4" },
      { name: "email", type_name: "text" },
    ],
    edit: {
      editable: true,
      reason: null,
      schema: "public",
      table: "users",
      pk: [{ name: "id", result_index: 0 }],
      columns: [
        { editable: false, column_name: null, cast_type: null, reason: "primary key" },
        { editable: true, column_name: "email", cast_type: '"pg_catalog"."text"', reason: null },
      ],
    },
    rows: [
      [1, "a@x.co"],
      [2, null],
    ],
    row_count: 2,
    affected_rows: null,
    duration_ms: 1,
  };
}

describe("cellText", () => {
  it("renders values as the text an editor should start from", () => {
    expect(cellText("a@x.co")).toBe("a@x.co");
    expect(cellText(7)).toBe("7");
    expect(cellText(true)).toBe("true");
    expect(cellText(null)).toBe("");
    expect(cellText({ a: 1 })).toBe('{"a":1}');
  });
});

describe("stage", () => {
  it("records a changed cell", () => {
    const pending = stage(emptyPending(), result(), 0, 1, "b@x.co");
    expect(count(pending)).toBe(1);
    expect(pendingValue(pending, 0, 1)).toBe("b@x.co");
    expect(isPending(pending, 0, 1)).toBe(true);
  });

  it("drops the change when the value is edited back to the original", () => {
    let pending = stage(emptyPending(), result(), 0, 1, "b@x.co");
    pending = stage(pending, result(), 0, 1, "a@x.co");
    // Staging a no-op UPDATE would show a pending count for a change
    // that is not one.
    expect(count(pending)).toBe(0);
    expect(isPending(pending, 0, 1)).toBe(false);
  });

  it("treats empty text on a NULL cell as a real change", () => {
    // NULL and '' are different values; typing nothing into a NULL
    // cell means the empty string, and must stage.
    const pending = stage(emptyPending(), result(), 1, 1, "");
    expect(count(pending)).toBe(1);
  });

  it("drops a NULL staged onto a cell that is already NULL", () => {
    const pending = stage(emptyPending(), result(), 1, 1, null);
    expect(count(pending)).toBe(0);
  });

  it("stages NULL over a value", () => {
    const pending = stage(emptyPending(), result(), 0, 1, null);
    expect(count(pending)).toBe(1);
    expect(pendingValue(pending, 0, 1)).toBe(null);
  });

  it("counts two cells in one row as two changes", () => {
    let pending = stage(emptyPending(), result(), 0, 1, "b@x.co");
    pending = stage(pending, result(), 1, 1, "c@x.co");
    expect(count(pending)).toBe(2);
  });
});

describe("toRowEdits", () => {
  it("groups cells by row and carries the key value as text", () => {
    let pending = stage(emptyPending(), result(), 0, 1, "b@x.co");
    pending = stage(pending, result(), 1, 1, "c@x.co");

    const edits = toRowEdits(pending, result());

    expect(edits).toHaveLength(2);
    expect(edits[0]).toEqual({
      row: 0,
      pk: ["1"],
      cells: [{ column: 1, value: "b@x.co" }],
    });
    expect(edits[1].pk).toEqual(["2"]);
  });

  it("returns nothing when nothing is staged", () => {
    expect(toRowEdits(emptyPending(), result())).toEqual([]);
  });

  it("throws when a key value is NULL", () => {
    const r = result();
    r.rows[0][0] = null;
    const pending = stage(emptyPending(), r, 0, 1, "b@x.co");
    // A NULL key cannot address a row. This is unreachable through a
    // real primary key, which is NOT NULL by definition — but the
    // payload builder is the last place that can notice.
    expect(() => toRowEdits(pending, r)).toThrow(/primary key/i);
  });
});

describe("applyPatches", () => {
  it("replaces cells with what the database returned", () => {
    const patched = applyPatches(result(), [
      { row: 0, cells: [{ column: 1, value: "shouty@x.co" }] },
    ]);

    expect(patched.rows[0][1]).toBe("shouty@x.co");
    // Untouched rows keep their values.
    expect(patched.rows[1][1]).toBe(null);
  });

  it("does not mutate the result it was given", () => {
    const original = result();
    applyPatches(original, [{ row: 0, cells: [{ column: 1, value: "x@x.co" }] }]);
    expect(original.rows[0][1]).toBe("a@x.co");
  });
});

describe("editingBlockedReason", () => {
  const editable = result().edit;
  const notEditable = {
    ...editable,
    editable: false,
    reason: "this result joins 2 tables — an UPDATE cannot tell which row to change",
  };

  it("is null when the result is editable and the connection is unlocked", () => {
    expect(editingBlockedReason(editable, false)).toBe(null);
  });

  it("names the lock when only the connection blocks editing", () => {
    // The case that made this function necessary: a perfectly editable
    // result on a locked prod connection, where nothing on screen
    // explained why double-clicking a cell did nothing.
    expect(editingBlockedReason(editable, true)).toMatch(/locked/);
  });

  it("gives the result's own reason when the result is not editable", () => {
    expect(editingBlockedReason(notEditable, false)).toMatch(/joins 2 tables/);
  });

  it("prefers the result's reason over the lock when both apply", () => {
    // Reporting the lock first would send someone to unlock production
    // only to find the join was never editable anyway.
    expect(editingBlockedReason(notEditable, true)).toMatch(/joins 2 tables/);
  });
});
