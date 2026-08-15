import type { EditStatement } from "../types";

interface Props {
  count: number;
  /** Generated statements, shown only while the SQL panel is open. */
  statements: EditStatement[] | null;
  busy: boolean;
  onViewSql: () => void;
  onHideSql: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The pending-changes bar.
 *
 * Confirm applies straight away. Viewing the SQL is an affordance, not
 * a gate: a mandatory review on a routine path gets dismissed by
 * reflex, and a reflexively dismissed dialog looks like a safeguard
 * without being one. The connection lock is the safeguard.
 */
export function EditBar({
  count,
  statements,
  busy,
  onViewSql,
  onHideSql,
  onCancel,
  onConfirm,
}: Props) {
  if (count === 0) return null;

  return (
    <div className="edit-bar">
      {statements !== null && (
        <div className="edit-sql">
          {statements.map((s, i) => (
            <pre key={i}>
              {s.sql}
              {"\n"}
              {s.params
                .map((p, n) => `$${n + 1} = ${p === null ? "NULL" : p}`)
                .join("\n")}
            </pre>
          ))}
        </div>
      )}
      <div className="edit-bar-row">
        <span className="edit-count">
          {count} pending change{count === 1 ? "" : "s"}
        </span>
        <button
          className="secondary"
          onClick={statements === null ? onViewSql : onHideSql}
          disabled={busy}
        >
          {statements === null ? "View SQL" : "Hide SQL"}
        </button>
        <button className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button onClick={onConfirm} disabled={busy}>
          {busy ? "Applying…" : "Confirm"}
        </button>
      </div>
    </div>
  );
}
