import { formatCell } from "./format";
import type { CellValue } from "../types";

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
