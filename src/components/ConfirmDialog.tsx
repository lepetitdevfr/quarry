import { useEffect, useRef } from "react";

interface Props {
  message: string;
  confirmLabel: string;
  /**
   * Whether confirming destroys something. Every current caller does —
   * but the flag stays explicit rather than assumed, so a future
   * non-destructive confirmation does not inherit red styling.
   */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A small in-app confirmation modal, replacing `window.confirm` (which
 * a Tauri WKWebView does not implement — it silently no-ops instead of
 * showing a dialog).
 *
 * Focus lands on **Cancel**, and Enter is left to whichever button holds
 * focus rather than being wired to confirm at the dialog level. Both are
 * deliberate reversals: this dialog's only callers delete a query, a
 * collection and everything in it, or a connection and its stored
 * password, and every one of those messages ends "This cannot be
 * undone." A dialog that destroys on a reflexive Return is the thing
 * this app exists to not be.
 */
export function ConfirmDialog({
  message,
  confirmLabel,
  destructive = true,
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
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
            className="secondary"
            type="button"
            ref={cancelRef}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className={destructive ? "danger" : undefined}
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
