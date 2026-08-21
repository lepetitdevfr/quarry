import type { WriteRecord } from "../types";

/**
 * The one quiet line under a write's SQL.
 *
 * A rollback and a refusal say so plainly. They are recorded precisely
 * because they are interesting later, and a log showing only the commits
 * would answer "what did I change" while quietly dropping "what did I
 * nearly change".
 */
export function describeWrite(write: WriteRecord): string {
  if (write.outcome === "rolled_back") return "discarded";
  if (write.outcome === "refused") {
    return write.reason ? `refused · ${write.reason}` : "refused";
  }
  if (write.outcome === "failed") {
    return write.reason ? `failed · ${write.reason}` : "failed";
  }

  // DDL reports no rows, and inventing a number for it would be the
  // screen filling in a fact nobody has.
  const rows =
    write.row_count === null
      ? null
      : `${write.row_count} ${write.row_count === 1 ? "row" : "rows"}`;

  return rows ? `${rows} · committed` : "committed";
}

/** Case-insensitive match on the statement and the database it hit. */
export function matchesWrite(write: WriteRecord, filter: string): boolean {
  if (filter === "") return true;
  const needle = filter.toLowerCase();
  return (
    write.sql.toLowerCase().includes(needle) ||
    write.connection_name.toLowerCase().includes(needle)
  );
}

/**
 * Whether this write belongs to the connection in question.
 *
 * A row whose connection has since been deleted belongs to nobody, and
 * is only ever shown unscoped: it must not pass as work against whatever
 * you happen to be connected to now.
 */
export function writeIsHere(
  write: WriteRecord,
  activeConnectionId: string | null,
): boolean {
  return activeConnectionId !== null && write.connection_id === activeConnectionId;
}
