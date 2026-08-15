import { formatCell } from "./format";
import type { CellValue } from "../types";

export type SortDirection = "asc" | "desc";

export interface SortState {
  /** Index into `QueryResult.columns`. */
  column: number;
  direction: SortDirection;
}

/**
 * What clicking a header does next: ascending, then descending, then
 * off. Clicking a different column starts that column ascending.
 */
export function nextSort(
  current: SortState | null,
  column: number,
): SortState | null {
  if (current === null || current.column !== column) {
    return { column, direction: "asc" };
  }
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}

/**
 * Order two cells for sorting.
 *
 * Always reports null as the greater value; `sortedIndices` is what
 * decides which end nulls land on, because that depends on direction.
 *
 * A column is not guaranteed to hold one type — a union, or a json
 * column, can mix them. Anything the typed branches do not both match
 * falls through to comparing display text, so this cannot throw on real
 * Postgres output.
 */
export function compareCells(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b);
  }

  return formatCell(a).text.localeCompare(formatCell(b).text);
}

/**
 * The order rows should be displayed in, as indices into `rows`.
 *
 * Returning a permutation rather than sorted rows keeps the virtualizer
 * rendering straight out of `result.rows`, so sorting a large result
 * copies nothing.
 *
 * Nulls are pinned last ascending and first descending — Postgres's own
 * default. `Array.prototype.sort` is stable in every engine we target,
 * which is what holds equal values in query order.
 */
export function sortedIndices(
  rows: CellValue[][],
  sort: SortState | null,
): number[] {
  const order = rows.map((_, i) => i);
  if (sort === null) return order;

  const sign = sort.direction === "asc" ? 1 : -1;

  return order.sort((left, right) => {
    const a = rows[left][sort.column];
    const b = rows[right][sort.column];

    // Nulls sort last ascending and first descending, so the pin
    // itself flips with `sign` rather than being fixed at one end.
    if (a === null && b === null) return 0;
    if (a === null) return sign;
    if (b === null) return -sign;

    return sign * compareCells(a, b);
  });
}

/**
 * Whether the result looks like only part of what the query would
 * return — a row count that exactly fills a `LIMIT` in the statement.
 *
 * Deliberately conservative. This drives a warning marker, and a
 * warning that appears on ordinary queries is a warning the user learns
 * to ignore, so anything unreadable (a parameter, no limit, SQL this
 * regex does not match) counts as complete.
 */
export function isTruncated(rowCount: number, sql: string): boolean {
  const match = /\blimit\s+(\d+)\s*;?\s*$/i.exec(sql);
  if (!match) return false;
  return rowCount === Number(match[1]);
}
