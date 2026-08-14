import { useEffect, useRef } from "react";
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
  const firstRef = useRef<HTMLButtonElement>(null);

  // Focus the most recently used connection so Enter connects to it.
  // Fast for the common case, but still a deliberate keystroke — the
  // app never connects on its own.
  useEffect(() => {
    if (standalone) firstRef.current?.focus();
  }, [standalone]);

  return (
    <div className={`connection-picker${standalone ? " standalone" : ""}`}>
      {connections.length === 0 && (
        <p className="picker-empty">No saved connections yet.</p>
      )}

      <ul className="picker-list">
        {connections.map((c, i) => (
          <li key={c.id}>
            <button
              ref={i === 0 ? firstRef : undefined}
              className={`picker-row${c.id === activeId ? " active" : ""}`}
              disabled={connecting}
              onClick={() => onPick(c.id)}
            >
              <span className="dot" style={{ background: c.colour }} />
              <span className="picker-name">{c.name}</span>
              <span className="picker-tag">{c.tag}</span>
              <span className="picker-target">
                {c.user}@{c.host}:{c.port}/{c.dbname}
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

      <button className="picker-new" onClick={onNew}>
        + New connection…
      </button>
    </div>
  );
}
