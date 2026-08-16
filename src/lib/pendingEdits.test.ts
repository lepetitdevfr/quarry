import { describe, expect, it } from "vitest";
import {
  addInsert,
  applyPatches,
  cellText,
  count,
  emptyDeletes,
  emptyInserts,
  emptyPending,
  insertValue,
  isDeleted,
  isPending,
  pendingValue,
  removeInsert,
  setInsertCell,
  stage,
  toRowDeletes,
  toRowEdits,
  toRowInserts,
  toggleDelete,
  totalPending,
  editingBlockedReason,
} from "./pendingEdits";
import { UNKNOWN, type QueryResult } from "../types";

function result(): QueryResult {
  return {
    columns: [
      { name: "id", type_name: "int4" },
      { name: "email", type_name: "text" },
    ],
    edit: {
      editable: true,
      reason: null,
      insertable: true,
      insert_reason: null,
      schema: "public",
      table: "users",
      pk: [{ name: "id", result_index: 0 }],
      columns: [
        {
          editable: false,
          column_name: null,
          cast_type: null,
          reason: "primary key",
          insertable: false,
          insert_reason: "generated key",
          choices: null,
          has_default: true,
        },
        {
          editable: true,
          column_name: "email",
          cast_type: '"pg_catalog"."text"',
          reason: null,
          insertable: true,
          insert_reason: null,
          choices: null,
          has_default: false,
        },
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
      { row: 0, cells: [{ column: 1, value: "shouty@x.co" }], kind: "update" },
    ]);

    expect(patched.rows[0][1]).toBe("shouty@x.co");
    // Untouched rows keep their values.
    expect(patched.rows[1][1]).toBe(null);
  });

  it("does not mutate the result it was given", () => {
    const original = result();
    applyPatches(original, [
      { row: 0, cells: [{ column: 1, value: "x@x.co" }], kind: "update" },
    ]);
    expect(original.rows[0][1]).toBe("a@x.co");
  });

  it("drops a deleted row", () => {
    const patched = applyPatches(threeRows(), [
      { row: 1, cells: [], kind: "delete" },
    ]);

    expect(patched.rows).toEqual([
      [1, "a@x.co"],
      [3, "c@x.co"],
    ]);
    expect(patched.row_count).toBe(2);
  });

  it("drops several rows by their original index", () => {
    // Dropping one at a time would shift the indexes under the next
    // patch and remove the wrong row.
    const patched = applyPatches(threeRows(), [
      { row: 0, cells: [], kind: "delete" },
      { row: 1, cells: [], kind: "delete" },
    ]);

    expect(patched.rows).toEqual([[3, "c@x.co"]]);
  });

  it("patches the survivors before the rows around them move", () => {
    const patched = applyPatches(threeRows(), [
      { row: 0, cells: [], kind: "delete" },
      { row: 2, cells: [{ column: 1, value: "patched@x.co" }], kind: "update" },
    ]);

    expect(patched.rows).toEqual([
      [2, "b@x.co"],
      [3, "patched@x.co"],
    ]);
  });
});

function threeRows(): QueryResult {
  const r = result();
  r.rows = [
    [1, "a@x.co"],
    [2, "b@x.co"],
    [3, "c@x.co"],
  ];
  r.row_count = 3;
  return r;
}

describe("toggleDelete", () => {
  it("stages a row deletion", () => {
    const { deletes } = toggleDelete(emptyPending(), emptyDeletes(), 1);
    expect(isDeleted(deletes, 1)).toBe(true);
    expect(deletes.size).toBe(1);
  });

  it("unstages a row that is already staged", () => {
    const first = toggleDelete(emptyPending(), emptyDeletes(), 1);
    const second = toggleDelete(first.pending, first.deletes, 1);
    expect(isDeleted(second.deletes, 1)).toBe(false);
    expect(second.deletes.size).toBe(0);
  });

  it("drops that row's cell edits when it stages the deletion", () => {
    // Applying both would UPDATE a row that is about to disappear.
    const pending = stage(emptyPending(), threeRows(), 1, 1, "z@x.co");
    const next = toggleDelete(pending, emptyDeletes(), 1);
    expect(isPending(next.pending, 1, 1)).toBe(false);
  });

  it("leaves other rows' cell edits alone", () => {
    let pending = stage(emptyPending(), threeRows(), 0, 1, "y@x.co");
    pending = stage(pending, threeRows(), 1, 1, "z@x.co");
    const next = toggleDelete(pending, emptyDeletes(), 1);
    expect(isPending(next.pending, 0, 1)).toBe(true);
    expect(count(next.pending)).toBe(1);
  });

  it("does not restore dropped cell edits when unstaged", () => {
    // Unstaging a deletion cannot resurrect edits it dropped, and
    // pretending otherwise would need history this module does not keep.
    const pending = stage(emptyPending(), threeRows(), 1, 1, "z@x.co");
    const first = toggleDelete(pending, emptyDeletes(), 1);
    const second = toggleDelete(first.pending, first.deletes, 1);
    expect(count(second.pending)).toBe(0);
  });

  it("does not mutate what it was given", () => {
    const pending = stage(emptyPending(), threeRows(), 1, 1, "z@x.co");
    const deletes = emptyDeletes();
    toggleDelete(pending, deletes, 1);
    expect(deletes.size).toBe(0);
    expect(isPending(pending, 1, 1)).toBe(true);
  });
});

describe("totalPending", () => {
  it("counts edited cells and deleted rows together", () => {
    let pending = stage(emptyPending(), threeRows(), 0, 1, "y@x.co");
    pending = stage(pending, threeRows(), 1, 1, "z@x.co");
    const next = toggleDelete(pending, emptyDeletes(), 2);
    // Two cells staged, one of which survived; plus one deletion.
    expect(totalPending(next.pending, next.deletes, emptyInserts())).toBe(3);
  });

  it("is zero when nothing is staged", () => {
    expect(totalPending(emptyPending(), emptyDeletes(), emptyInserts())).toBe(0);
  });
});

describe("toRowDeletes", () => {
  it("carries the key value as text, in a stable order", () => {
    let deletes = toggleDelete(emptyPending(), emptyDeletes(), 2).deletes;
    deletes = toggleDelete(emptyPending(), deletes, 0).deletes;

    // Sorted by row so the generated SQL — and the View SQL panel —
    // does not depend on the order the rows happened to be clicked.
    expect(toRowDeletes(deletes, threeRows())).toEqual([
      { row: 0, pk: ["1"] },
      { row: 2, pk: ["3"] },
    ]);
  });

  it("returns nothing when nothing is staged", () => {
    expect(toRowDeletes(emptyDeletes(), threeRows())).toEqual([]);
  });

  it("throws when a key value is NULL", () => {
    const r = threeRows();
    r.rows[0][0] = null;
    const { deletes } = toggleDelete(emptyPending(), emptyDeletes(), 0);
    expect(() => toRowDeletes(deletes, r)).toThrow(/primary key/i);
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

describe("staged inserts", () => {
  it("stages a blank row and counts it", () => {
    const inserts = addInsert(emptyInserts());
    expect(inserts).toHaveLength(1);
    expect(inserts[0].cells.size).toBe(0);
    expect(totalPending(emptyPending(), emptyDeletes(), inserts)).toBe(1);
  });

  it("removes by id, not by position", () => {
    // Ids must survive an earlier row being discarded, or the grid
    // starts editing the wrong staged row.
    let inserts = addInsert(addInsert(emptyInserts()));
    const secondId = inserts[1].id;
    inserts = removeInsert(inserts, inserts[0].id);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].id).toBe(secondId);
  });

  it("keeps a value, an explicit NULL, and untouched apart", () => {
    let inserts = addInsert(emptyInserts());
    const { id } = inserts[0];

    inserts = setInsertCell(inserts, id, 1, "a@b.c");
    expect(insertValue(inserts, id, 1)).toBe("a@b.c");

    inserts = setInsertCell(inserts, id, 2, null);
    expect(insertValue(inserts, id, 2)).toBeNull();

    // Untouched: absent from the map entirely, which is what leaves the
    // column out of the INSERT so the database applies its default.
    expect(insertValue(inserts, id, 3)).toBeUndefined();
  });

  it("returns a cell to untouched when an empty value is committed", () => {
    let inserts = addInsert(emptyInserts());
    const { id } = inserts[0];

    inserts = setInsertCell(inserts, id, 1, "2026-01-01");
    inserts = setInsertCell(inserts, id, 1, "");

    expect(insertValue(inserts, id, 1)).toBeUndefined();
  });

  it("builds the payload with cells in column order", () => {
    let inserts = addInsert(emptyInserts());
    const { id } = inserts[0];
    inserts = setInsertCell(inserts, id, 2, "pro");
    inserts = setInsertCell(inserts, id, 1, "a@b.c");

    expect(toRowInserts(inserts)).toEqual([
      {
        row: 0,
        cells: [
          { column: 1, value: "a@b.c" },
          { column: 2, value: "pro" },
        ],
      },
    ]);
  });

  it("numbers rows by position in the payload, not by id", () => {
    // `row` is how the reply is matched back, and the backend sees the
    // array it was sent — not the counter behind it.
    let inserts = addInsert(addInsert(emptyInserts()));
    inserts = removeInsert(inserts, inserts[0].id);
    expect(toRowInserts(inserts)[0].row).toBe(0);
  });
});

describe("applyPatches with inserts", () => {
  it("appends returned rows, patches survivors, and drops deletions", () => {
    const base = result();
    base.rows = [
      ["1", "a@b.c"],
      ["2", "c@d.e"],
    ];
    base.row_count = 2;

    const patched = applyPatches(base, [
      { row: 0, kind: "update", cells: [{ column: 1, value: "new@b.c" }] },
      { row: 1, kind: "delete", cells: [] },
      {
        row: 0,
        kind: "insert",
        cells: [
          { column: 0, value: "3" },
          { column: 1, value: "fresh@b.c" },
        ],
      },
    ]);

    expect(patched.rows).toEqual([
      ["1", "new@b.c"],
      ["3", "fresh@b.c"],
    ]);
    expect(patched.row_count).toBe(2);
  });

  it("fills a column the insert did not return with UNKNOWN", () => {
    // A computed column: no value came back, and it must not read as
    // NULL, which would claim the database stored nothing there.
    const base = result();
    base.rows = [];
    base.row_count = 0;

    const patched = applyPatches(base, [
      { row: 0, kind: "insert", cells: [{ column: 0, value: "3" }] },
    ]);

    expect(patched.rows[0][0]).toBe("3");
    expect(patched.rows[0][1]).toBe(UNKNOWN);
  });
});
