/** One cell's position in the grid. */
export interface CellRef {
  row: number;
  col: number;
}

/** An inclusive rectangle of selected cells. */
export interface SelectionRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/**
 * The rectangle between the anchor (where the selection started) and the
 * focus (where it now extends to).
 *
 * Normalised, so dragging up-and-left selects the same cells as
 * down-and-right. Without this, shift-clicking above your anchor would
 * produce an inverted rectangle and select nothing.
 */
export function selectionRange(
  anchor: CellRef,
  focus: CellRef,
): SelectionRange {
  return {
    top: Math.min(anchor.row, focus.row),
    left: Math.min(anchor.col, focus.col),
    bottom: Math.max(anchor.row, focus.row),
    right: Math.max(anchor.col, focus.col),
  };
}

/** Bounds are inclusive on all four sides. */
export function isSelected(
  range: SelectionRange | null,
  row: number,
  col: number,
): boolean {
  if (range === null) return false;
  return (
    row >= range.top &&
    row <= range.bottom &&
    col >= range.left &&
    col <= range.right
  );
}

/**
 * Cmd+A. Null for an empty result — a rectangle over zero rows would
 * report as a selection and copy an empty string.
 */
export function selectAll(
  rowCount: number,
  columnCount: number,
): SelectionRange | null {
  if (rowCount === 0 || columnCount === 0) return null;
  return { top: 0, left: 0, bottom: rowCount - 1, right: columnCount - 1 };
}

/**
 * Where an arrow key moves the selection.
 *
 * Clamped rather than wrapped: a grid is a rectangle, and running off
 * the right edge into the start of the next row is not what any
 * spreadsheet or database client does. Returns the same cell when there
 * is nowhere to go, so the caller can treat "moved" and "already at the
 * edge" identically.
 */
export function movedCell(
  from: CellRef,
  rowDelta: number,
  colDelta: number,
  rowCount: number,
  columnCount: number,
): CellRef {
  return {
    row: Math.min(Math.max(0, from.row + rowDelta), Math.max(0, rowCount - 1)),
    col: Math.min(Math.max(0, from.col + colDelta), Math.max(0, columnCount - 1)),
  };
}
