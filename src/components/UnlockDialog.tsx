import { useState } from "react";

interface Props {
  connectionName: string;
  onConfirm: (typedName: string) => void;
  onCancel: () => void;
}

/**
 * Unlocking requires typing the connection's name.
 *
 * Not authentication — anyone at the keyboard can read the name off the
 * header. The point is deliberateness: a button can be clicked by
 * reflex, a name cannot be typed by reflex.
 */
export function UnlockDialog({ connectionName, onConfirm, onCancel }: Props) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === connectionName;

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Unlock ${connectionName}`}
        onKeyDown={(e) => {
          // Escape was handled on the input alone, so it did nothing
          // once focus moved to either button.
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <h2>Unlock {connectionName}</h2>
        <p className="modal-body">
          This is a production connection. Writes are blocked until you
          unlock it, and it relocks automatically after 30 minutes.
        </p>
        <p className="modal-body">
          Type <strong>{connectionName}</strong> to confirm.
        </p>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches) onConfirm(typed);
            if (e.key === "Escape") onCancel();
          }}
          spellCheck={false}
        />
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="danger"
            disabled={!matches}
            onClick={() => onConfirm(typed)}
          >
            Unlock
          </button>
        </div>
      </div>
    </div>
  );
}
