import type { CellValue, ColumnMeta } from "../types";
import { UNKNOWN } from "../types";

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
  if (value === UNKNOWN || value === null) return "";
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

export function toJson(columns: ColumnMeta[], rows: CellValue[][]): string {
  const objects = rows.map((row) => {
    const out: Record<string, CellValue> = {};
    columns.forEach((c, i) => {
      // Raw value, not `cellText`: JSON should carry a real null and
      // keep a jsonb column as structure rather than as a string. An
      // unknown cell has no JSON representation of its own, so it
      // collapses to null like an absent value does.
      const cell = row[i];
      out[c.name] = cell === UNKNOWN ? null : (cell ?? null);
    });
    return out;
  });
  return JSON.stringify(objects, null, 2);
}

/**
 * Quote a Postgres identifier: wrap in double quotes, double any
 * embedded double quote.
 *
 * Duplicated from `schema.ts` rather than imported — that module is
 * about the schema tree and autocomplete, and importing it here would
 * tie file export to it for four lines. If a third caller appears, move
 * it somewhere shared.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A SQL string literal: single quotes, with embedded single quotes
 * doubled.
 *
 * This is the function that makes `toSqlInsert` safe. A value like
 * `'); drop table users; --` must stay inside the literal rather than
 * closing it, which is exactly what doubling the quote achieves.
 */
function sqlLiteral(value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * `INSERT` statements for a known target table.
 *
 * Only offered where the target is genuinely known — a table Data tab.
 * A join or expression query has no single target, and generating
 * `insert into some_guess` would be worse than not offering it.
 */
export function toSqlInsert(
  schema: string,
  table: string,
  columns: ColumnMeta[],
  rows: CellValue[][],
): string {
  const target = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const names = columns.map((c) => quoteIdent(c.name)).join(", ");

  return rows
    .map(
      (row) =>
        `insert into ${target} (${names}) values (${row
          .map(sqlLiteral)
          .join(", ")});`,
    )
    .join("\n");
}
