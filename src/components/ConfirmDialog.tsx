import { useEffect, useRef } from "react";

interface Props {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A small in-app confirmation modal, replacing `window.confirm` (which
 * a Tauri WKWebView does not implement — it silently no-ops instead of
 * showing a dialog). Focus moves to the confirm button on mount so
 * Escape/Enter land on this dialog rather than on the editor
 * underneath, and Tab is trapped between the two buttons.
 */
export function ConfirmDialog({ message, confirmLabel, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Stop the event here so it never reaches window-level
          // listeners (or CodeMirror, if it somehow still had focus).
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter") {
            e.preventDefault();
            onConfirm();
          } else if (e.key === "Tab") {
            e.preventDefault();
            if (document.activeElement === confirmRef.current) cancelRef.current?.focus();
            else confirmRef.current?.focus();
          }
        }}
      >
        <p>{message}</p>
        <div className="confirm-actions">
          <button
            className="confirm-cancel"
            type="button"
            ref={cancelRef}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="confirm-confirm"
            type="button"
            ref={confirmRef}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
