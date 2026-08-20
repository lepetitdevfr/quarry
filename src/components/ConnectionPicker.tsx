import { useEffect, useMemo, useRef } from "react";
import { mostRecentlyUsedIndex } from "../lib/connections";
import type { Connection } from "../types";

interface Props {
  connections: Connection[];
  activeId: string | null;
  connecting: boolean;
  onPick: (id: string) => void;
  onNew: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  /** Rendered as a centred launch panel rather than a dropdown. */
  standalone?: boolean;
}

export function ConnectionPicker({
  connections,
  activeId,
  connecting,
  onPick,
  onNew,
  onEdit,
  onDelete,
  standalone = false,
}: Props) {
  const recentRef = useRef<HTMLButtonElement>(null);

  // The list order is frozen alphabetically, so the most recently used
  // connection is no longer row 0 — it has to be found. Focusing row 0
  // regardless would point Enter at whichever name sorts first, and one
  // of these rows is production.
  const recent = useMemo(
    () => mostRecentlyUsedIndex(connections),
    [connections],
  );

  // Focus the most recently used connection so Enter connects to it.
  // Fast for the common case, but still a deliberate keystroke — the
  // app never connects on its own.
  useEffect(() => {
    if (standalone) recentRef.current?.focus();
  }, [standalone, recent]);

  return (
    <div className={`connection-picker${standalone ? " standalone" : ""}`}>
      {connections.length === 0 && (
        <p className="picker-empty">
          No connections yet. Add one with a Postgres URL — the password goes
          to the macOS Keychain, never to disk.
        </p>
      )}

      <ul className="picker-list">
        {connections.map((c, i) => (
          <li key={c.id}>
            <button
              ref={i === recent ? recentRef : undefined}
              className={`picker-row${c.id === activeId ? " active" : ""}`}
              disabled={connecting}
              // The name is what identifies a connection — it is typed by
              // the person who made it. The target stays as the tooltip
              // for the moment the name is not enough to tell two apart.
              title={`${c.user}@${c.host}:${c.port}/${c.dbname}`}
              onClick={() => onPick(c.id)}
            >
              <span className="picker-name">{c.name}</span>
              {/* The colour rides on the tag chip, which says what it
                  means. As a bare dot it read as a health light — a
                  paused local database still showed a confident green. */}
              <span
                className="picker-tag overline"
                style={{
                  color: c.colour,
                  borderColor: c.colour,
                }}
              >
                {c.tag}
              </span>
            </button>
            <button
              className="row-action"
              title="Edit connection"
              onClick={() => onEdit(c.id)}
            >
              ✎
            </button>
            <button
              className="row-action"
              title="Delete connection"
              onClick={() => onDelete(c.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {/* Primary on the launch screen, where it is the only thing to do;
          quiet in the dropdown, where it sits under a list of real
          choices. */}
      <button
        className={`picker-new${standalone && connections.length === 0 ? " primary" : ""}`}
        onClick={onNew}
      >
        {standalone && connections.length === 0
          ? "Add a connection"
          : "+ New connection…"}
      </button>
    </div>
  );
}
