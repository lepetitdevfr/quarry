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
