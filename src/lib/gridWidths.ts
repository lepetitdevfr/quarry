import { formatCell } from "./format";
import type { CellValue, ColumnMeta } from "../types";

/** Narrow enough to be tidy, wide enough to stay clickable. */
export const MIN_WIDTH = 64;

/**
 * Ceiling on a *measured* width only. One 400-character text column
 * would otherwise open the grid with every other column off screen.
 * Dragging and fit-to-content deliberately ignore this.
 */
export const MAX_INITIAL_WIDTH = 420;

/** Rough width of one character in the grid's font, in pixels. */
const CHAR_PX = 7.5;

/** Cell padding plus the sort indicator, in pixels. */
const PADDING_PX = 28;

/**
 * Rows scanned when measuring. Measuring all of them would walk a
 * 100k-row result on every query for a number that only decides an
 * initial layout the user can drag.
 */
const SAMPLE_ROWS = 50;

function widthFor(textLength: number): number {
  return Math.ceil(textLength * CHAR_PX) + PADDING_PX;
}

/** The longest rendered text in a column, header included. */
function longest(
  index: number,
  columns: ColumnMeta[],
  rows: CellValue[][],
  sample: number,
): number {
  const header = columns[index];
  // The header shows the name and the type name beside it.
  let longestText = header.name.length + header.type_name.length + 2;

  for (const row of rows.slice(0, sample)) {
    const cell = row[index];
    if (cell === undefined) continue;
    longestText = Math.max(longestText, formatCell(cell).text.length);
  }

  return longestText;
}

/**
 * Starting width per column, measured from the header and a sample of
 * rows, clamped at both ends.
 */
export function initialWidths(
  columns: ColumnMeta[],
  rows: CellValue[][],
): number[] {
  return columns.map((_, i) => {
    const measured = widthFor(longest(i, columns, rows, SAMPLE_ROWS));
    return Math.min(MAX_INITIAL_WIDTH, Math.max(MIN_WIDTH, measured));
  });
}

/**
 * Width that shows the whole of a column's widest value — what
 * double-clicking a border asks for.
 *
 * Uncapped: the user asked to see the value, so the cap that keeps the
 * default layout readable would defeat the request. Every row is
 * measured, not a sample, for the same reason.
 */
export function fitWidth(
  index: number,
  columns: ColumnMeta[],
  rows: CellValue[][],
): number {
  const measured = widthFor(longest(index, columns, rows, rows.length));
  return Math.max(MIN_WIDTH, measured);
}

/**
 * Identity of a result's column shape.
 *
 * Measured widths are meaningless once the columns change, but they are
 * still valid when the *same* columns come back — which is exactly what
 * a sort on a Data tab produces, since it re-runs the query and returns
 * a fresh result object holding the same columns. Keying the re-measure
 * on this rather than on result identity is what stops a sort from
 * throwing away a width you dragged.
 *
 * The separator is a null character because it cannot appear in a
 * Postgres identifier, so no pair of distinct column lists can collide.
 */
export function columnsKey(columns: ColumnMeta[]): string {
  return columns.map((c) => c.name).join("\0");
}

/** Apply a drag to one column. An unknown index changes nothing. */
export function resized(
  widths: number[],
  index: number,
  delta: number,
): number[] {
  if (index < 0 || index >= widths.length) return widths;
  return widths.map((w, i) =>
    i === index ? Math.max(MIN_WIDTH, w + delta) : w,
  );
}
