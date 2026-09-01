import type { CellValue } from "../types";
import { UNKNOWN } from "../types";

export type CellKind = "null" | "bool" | "number" | "json" | "text" | "unknown";

export interface FormattedCell {
  text: string;
  kind: CellKind;
}

/**
 * Turn a raw cell into display text plus a kind used for styling.
 *
 * The null/empty-string distinction matters: a grid that renders both
 * as blank makes it impossible to tell a missing value from a present
 * one, which changes what query you write next.
 */
export function formatCell(value: CellValue): FormattedCell {
  if (value === UNKNOWN) return { text: "—", kind: "unknown" };
  if (value === null) return { text: "NULL", kind: "null" };
  if (typeof value === "boolean") {
    return { text: value ? "true" : "false", kind: "bool" };
  }
  if (typeof value === "number") return { text: String(value), kind: "number" };
  if (typeof value === "object") {
    return { text: JSON.stringify(value), kind: "json" };
  }
  return { text: value, kind: "text" };
}

/**
 * A byte count in the largest unit that keeps it readable.
 *
 * Decimal units, matching what `pg_size_pretty` and the rest of the
 * Postgres tooling show, so a number here can be compared with one from
 * psql without mental arithmetic.
 */
export function formatBytes(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }

  // Bytes are whole things; anything larger has been divided and reads
  // better with one decimal.
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * The planner's row estimate, or "unknown".
 *
 * `pg_class.reltuples` is -1 on a table that has never been analyzed.
 * Rendering that as "-1" is absurd and rendering it as "0" is plausible
 * and therefore worse — someone would believe it.
 */
export function formatRowEstimate(estimate: number): string {
  if (estimate < 0) return "unknown";
  return estimate.toLocaleString("en-US");
}
