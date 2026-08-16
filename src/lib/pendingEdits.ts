import type {
  AppliedRow,
  CellValue,
  EditInfo,
  QueryResult,
  RowDelete,
  RowEdit,
  RowInsert,
} from "../types";
import { UNKNOWN } from "../types";

/**
 * Staged cell edits, keyed by row and column.
 *
 * A `Map` rather than a nested object so counting is O(1) and the key
 * shape is explicit. `value: null` means an explicit SQL NULL, which is
 * a different thing from the empty string.
 */
export type Pending = Map<
  string,
  { row: number; col: number; value: string | null }
>;

export function emptyPending(): Pending {
  return new Map();
}

/**
 * Rows staged for deletion, by their index into `QueryResult.rows`.
 *
 * A `Set` rather than a flag per row: the staged set is small, and the
 * index is the same handle the cell edits use, so the two structures
 * agree on what "row 3" means.
 */
export type PendingDeletes = Set<number>;

export function emptyDeletes(): PendingDeletes {
  return new Set();
}

export function isDeleted(deletes: PendingDeletes, row: number): boolean {
  return deletes.has(row);
}

/**
 * One staged new row.
 *
 * `cells` holds only the columns the user touched: a column absent from
 * the map is left out of the generated INSERT, so the database applies
 * its default. `null` is an explicit SQL NULL, which overrides one.
 *
 * `id` is a counter, never an array index — a staged row must keep its
 * identity when an earlier staged row is discarded, or the editor
 * reopens on the wrong row.
 */
export type PendingInsert = { id: number; cells: Map<number, string | null> };
export type PendingInserts = PendingInsert[];

let nextInsertId = 1;

export function emptyInserts(): PendingInserts {
  return [];
}

export function addInsert(inserts: PendingInserts): PendingInserts {
  return [...inserts, { id: nextInsertId++, cells: new Map() }];
}

export function removeInsert(
  inserts: PendingInserts,
  id: number,
): PendingInserts {
  return inserts.filter((row) => row.id !== id);
}

/**
 * Stage one cell of a new row.
 *
 * Committing an empty string returns the cell to untouched. That is
 * what makes "give me the default back" possible without another
 * chord; the cost is that an empty string cannot be inserted into a
 * text column from the grid, which the spec accepts.
 */
export function setInsertCell(
  inserts: PendingInserts,
  id: number,
  column: number,
  value: string | null,
): PendingInserts {
  return inserts.map((row) => {
    if (row.id !== id) return row;
    const cells = new Map(row.cells);
    if (value === "") cells.delete(column);
    else cells.set(column, value);
    return { ...row, cells };
  });
}

export function insertValue(
  inserts: PendingInserts,
  id: number,
  column: number,
): string | null | undefined {
  return inserts.find((row) => row.id === id)?.cells.get(column);
}

/**
 * The payload the backend expects. `row` is the position in this list,
 * which is the handle the reply comes back with; the id stays on the
 * frontend.
 */
export function toRowInserts(inserts: PendingInserts): RowInsert[] {
  return inserts.map((row, index) => ({
    row: index,
    cells: [...row.cells.entries()]
      .sort(([a], [b]) => a - b)
      .map(([column, value]) => ({ column, value })),
  }));
}

function key(row: number, col: number): string {
  return `${row}:${col}`;
}

/**
 * The text an editor should start from, and the text a staged value is
 * compared against to decide whether anything actually changed.
 */
export function cellText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Stage one cell.
 *
 * Editing a value back to what it was removes the pending change
 * rather than recording a no-op: a pending count that includes changes
 * that change nothing is a lie about how much is about to be written.
 */
export function stage(
  pending: Pending,
  result: QueryResult,
  row: number,
  col: number,
  value: string | null,
): Pending {
  const next = new Map(pending);
  const original = result.rows[row]?.[col] ?? null;

  const unchanged =
    value === null
      ? original === null
      : original !== null && cellText(original) === value;

  if (unchanged) next.delete(key(row, col));
  else next.set(key(row, col), { row, col, value });

  return next;
}

export function count(pending: Pending): number {
  return pending.size;
}

/**
 * Stage or unstage a row deletion.
 *
 * Staging one drops any cell edits staged against that row: applying
 * both would `UPDATE` a row that is about to disappear. Unstaging does
 * not bring them back — this module keeps no history, and inventing one
 * for an undo of an undo is not worth the state.
 *
 * Returns both structures, since one changes the other.
 */
export function toggleDelete(
  pending: Pending,
  deletes: PendingDeletes,
  row: number,
): { pending: Pending; deletes: PendingDeletes } {
  const nextDeletes = new Set(deletes);

  if (nextDeletes.delete(row)) return { pending, deletes: nextDeletes };

  nextDeletes.add(row);

  const nextPending = new Map(pending);
  for (const [k, edit] of pending) {
    if (edit.row === row) nextPending.delete(k);
  }

  return { pending: nextPending, deletes: nextDeletes };
}

/** Total staged changes: edited cells, deleted rows and new rows. */
export function totalPending(
  pending: Pending,
  deletes: PendingDeletes,
  inserts: PendingInserts,
): number {
  return pending.size + deletes.size + inserts.length;
}

/**
 * The payload the backend expects for the staged deletions, one entry
 * per row with the row's primary key values as text.
 *
 * Sorted by row for the same reason `toRowEdits` is: the generated SQL
 * should not depend on the order the rows were clicked.
 */
export function toRowDeletes(
  deletes: PendingDeletes,
  result: QueryResult,
): RowDelete[] {
  return [...deletes]
    .sort((a, b) => a - b)
    .map((row) => ({ row, pk: pkValues(result, row) }));
}

export function isPending(pending: Pending, row: number, col: number): boolean {
  return pending.has(key(row, col));
}

export function pendingValue(
  pending: Pending,
  row: number,
  col: number,
): string | null | undefined {
  return pending.get(key(row, col))?.value;
}

/**
 * Group the staged cells into the payload the backend expects, one
 * entry per row, with the row's primary key values as text.
 */
export function toRowEdits(pending: Pending, result: QueryResult): RowEdit[] {
  const byRow = new Map<number, RowEdit>();

  // Sorted so the generated statements — and the View SQL panel — come
  // out in a stable order rather than in Map insertion order.
  const staged = [...pending.values()].sort(
    (a, b) => a.row - b.row || a.col - b.col,
  );

  for (const edit of staged) {
    let entry = byRow.get(edit.row);
    if (!entry) {
      entry = { row: edit.row, pk: pkValues(result, edit.row), cells: [] };
      byRow.set(edit.row, entry);
    }
    entry.cells.push({ column: edit.col, value: edit.value });
  }

  return [...byRow.values()].sort((a, b) => a.row - b.row);
}

function pkValues(result: QueryResult, row: number): string[] {
  return result.edit.pk.map((k) => {
    const value = result.rows[row]?.[k.result_index] ?? null;
    if (value === null) {
      throw new Error(
        `primary key ${k.name} is NULL in row ${row + 1} — cannot edit this row`,
      );
    }
    return cellText(value);
  });
}

/**
 * Replace edited cells with the values the database returned, drop the
 * rows that were deleted, and append the rows that were inserted.
 *
 * Returns a new result rather than mutating: React re-renders on
 * identity, and the grid would otherwise keep showing the old values.
 *
 * Deleted rows are removed in one pass at the end, filtering on the
 * original index. Splicing them out one at a time would shift every
 * later index under the remaining patches and drop the wrong rows.
 */
export function applyPatches(
  result: QueryResult,
  applied: AppliedRow[],
): QueryResult {
  const patched = result.rows.map((row) => [...row]);

  for (const patch of applied) {
    // Only an update addresses a grid row. An insert's `row` indexes
    // the staged list, so patching by it would overwrite whatever
    // happens to sit at that position in the grid.
    if (patch.kind !== "update") continue;
    for (const cell of patch.cells) {
      if (patched[patch.row]) patched[patch.row][cell.column] = cell.value;
    }
  }

  const removed = new Set(
    applied.filter((a) => a.kind === "delete").map((a) => a.row),
  );
  const kept =
    removed.size === 0 ? patched : patched.filter((_, i) => !removed.has(i));

  // Appended rows are built column by column: anything the INSERT did
  // not return has no known value, which is not the same as NULL.
  const added = applied
    .filter((a) => a.kind === "insert")
    .map((a) => {
      const row: CellValue[] = result.columns.map(() => UNKNOWN);
      for (const cell of a.cells) row[cell.column] = cell.value;
      return row;
    });

  const rows = [...kept, ...added];

  return { ...result, rows, row_count: rows.length };
}

/**
 * Why editing is unavailable, or `null` when it is available.
 *
 * Two different things can switch editing off — the result itself
 * (a join, a view, no primary key) and the connection lock — and a
 * refusal without a reason is the failure this whole surface is
 * supposed to avoid.
 *
 * The result's own reason is reported first when both apply. The other
 * order would send someone to unlock a production connection only for
 * them to discover the join was never editable in the first place.
 */
export function editingBlockedReason(
  edit: EditInfo,
  locked: boolean,
): string | null {
  if (!edit.editable) return edit.reason;
  if (locked) return "this connection is locked — unlock it to edit rows";
  return null;
}
