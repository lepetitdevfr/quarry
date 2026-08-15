import { editingBlockedReason } from "../lib/pendingEdits";
import type { AppErrorPayload, QueryResult } from "../types";

interface Props {
  result: QueryResult | null;
  error: AppErrorPayload | null;
  /** True for a couple of seconds right after a successful save. */
  saved: boolean;
  /** True on a read-only connection that has not been unlocked. */
  locked: boolean;
}

export function StatusBar({ result, error, saved, locked }: Props) {
  const savedBadge = saved && <span className="saved-indicator">Saved</span>;

  if (error) {
    return (
      <div className="status-bar error">
        {error.code && <span className="sqlstate">{error.code}</span>}
        <span>{error.message}</span>
        {error.position !== null && (
          <span className="position">at character {error.position}</span>
        )}
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
        {result.affected_rows} {result.affected_rows === 1 ? "row" : "rows"}{" "}
        affected · {result.duration_ms} ms
        {savedBadge}
      </div>
    );
  }

  return (
    <div className="status-bar">
      {result.row_count} {result.row_count === 1 ? "row" : "rows"} ·{" "}
      {result.duration_ms} ms
      {/* "Why can't I edit this?" must always be answerable without
          having to hunt for it — including when the result is perfectly
          editable and it is the connection that is locked. */}
      {editingBlockedReason(result.edit, locked) && (
        <span
          className="status-readonly"
          title={editingBlockedReason(result.edit, locked) ?? undefined}
        >
          {" · "}read-only · {editingBlockedReason(result.edit, locked)}
        </span>
      )}
      {savedBadge}
    </div>
  );
}
