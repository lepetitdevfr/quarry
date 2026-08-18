import { editingBlockedReason } from "../lib/pendingEdits";
import type { AppErrorPayload, QueryResult } from "../types";

interface Props {
  result: QueryResult | null;
  error: AppErrorPayload | null;
  /** True for a couple of seconds right after a successful save. */
  saved: boolean;
  /** True on a read-only connection that has not been unlocked. */
  locked: boolean;
  /** True while a statement is in flight. */
  busy: boolean;
  /** Seconds the in-flight statement has been running. */
  elapsed: number;
  /**
   * True when the result on screen came from SQL the buffer no longer
   * holds. The rows are still real; they just answer a question that
   * has since been edited.
   */
  stale: boolean;
  /** True when the row count is the statement's LIMIT, not the table. */
  truncated: boolean;
  /** Applied edits, for a moment, after a batch commits. */
  applied: number | null;
}

export function StatusBar({
  result,
  error,
  saved,
  locked,
  busy,
  elapsed,
  stale,
  truncated,
  applied,
}: Props) {
  const savedBadge = saved && <span className="saved-indicator">Saved</span>;
  const appliedBadge = applied !== null && (
    <span className="saved-indicator">
      {applied} change{applied === 1 ? "" : "s"} applied
    </span>
  );

  // Running outranks everything else in the bar. The previous result's
  // row count sitting there unchanged while a statement is in flight is
  // the one moment this bar can actively mislead — it reads as "done".
  if (busy) {
    return (
      <div className="status-bar">
        <span className="status-running">
          Running… {elapsed.toFixed(1)}s
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="status-bar error">
        {error.code && <span className="sqlstate">{error.code}</span>}
        <span>{error.message}</span>
        {savedBadge}
      </div>
    );
  }

  if (!result) {
    return (
      <div className="status-bar">
        Ready
        {savedBadge}
      </div>
    );
  }

  if (result.affected_rows !== null) {
    return (
      <div className="status-bar">
        <span>
          {result.affected_rows} {result.affected_rows === 1 ? "row" : "rows"}{" "}
          affected · {result.duration_ms} ms
        </span>
        {appliedBadge}
        {savedBadge}
      </div>
    );
  }

  return (
    <div className="status-bar">
      <span>
        {result.row_count} {result.row_count === 1 ? "row" : "rows"} ·{" "}
        {result.duration_ms} ms
      </span>
      {/* The limit is the statement's, so the count is a page rather than
          an answer. Saying so here is cheaper than the alternative:
          somebody reading "500 rows" as the size of the table. */}
      {truncated && (
        <span
          className="status-truncated"
          title="the statement's LIMIT was reached — there are more rows"
        >
          truncated
        </span>
      )}
      {stale && (
        <span
          className="status-stale"
          title="the editor has changed since these rows were fetched"
        >
          stale
        </span>
      )}
      {/* "Why can't I edit this?" must always be answerable without
          having to hunt for it — including when the result is perfectly
          editable and it is the connection that is locked. */}
      {editingBlockedReason(result.edit, locked) && (
        <span
          className="status-readonly"
          title={editingBlockedReason(result.edit, locked) ?? undefined}
        >
          read-only · {editingBlockedReason(result.edit, locked)}
        </span>
      )}
      <span className="status-spacer" />
      {appliedBadge}
      {savedBadge}
    </div>
  );
}
