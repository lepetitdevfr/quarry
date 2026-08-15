import type { CellValue, ColumnMeta } from "../types";

/**
 * Serialize result rows for the clipboard and for files.
 *
 * These deliberately do NOT use `formatCell`. That produces *display*
 * text — the literal string "NULL" for a null, a JSON blob for an
 * object — which is right in a grid cell and wrong in a file: a CSV
 * needs an empty field where the value is null, and a paste target
 * cannot tell the string "NULL" from a real value. Export works from
 * raw `CellValue`s and formats per target.
 */

/** The text of one cell, before any format-specific quoting. */
function cellText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Tab-separated, for the clipboard. Spreadsheets split pasted text on
 * tabs and newlines, so this lands as cells rather than one blob.
 */
export function toTsv(
  columns: ColumnMeta[],
  rows: CellValue[][],
  withHeader: boolean,
): string {
  const lines = rows.map((row) => row.map(cellText).join("\t"));
  if (withHeader) lines.unshift(columns.map((c) => c.name).join("\t"));
  return lines.join("\n");
}

/** RFC 4180: quote when the field contains a comma, quote, or newline. */
function csvField(value: CellValue): string {
  const text = cellText(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(columns: ColumnMeta[], rows: CellValue[][]): string {
  const header = columns.map((c) => csvField(c.name)).join(",");
  const lines = rows.map((row) => row.map(csvField).join(","));
  return [header, ...lines].join("\n");
}
