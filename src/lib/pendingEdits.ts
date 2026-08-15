import type {
  AppliedRow,
  CellValue,
  EditInfo,
  QueryResult,
  RowEdit,
} from "../types";

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
 * Replace edited cells with the values the database returned.
 *
 * Returns a new result rather than mutating: React re-renders on
 * identity, and the grid would otherwise keep showing the old values.
 */
export function applyPatches(
  result: QueryResult,
  applied: AppliedRow[],
): QueryResult {
  const rows = result.rows.map((row) => [...row]);

  for (const patch of applied) {
    for (const cell of patch.cells) {
      if (rows[patch.row]) rows[patch.row][cell.column] = cell.value;
    }
  }

  return { ...result, rows };
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
