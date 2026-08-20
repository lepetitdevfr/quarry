import { hintFor } from "../lib/errors";
import type { AppErrorPayload } from "../types";

interface Props {
  error: AppErrorPayload;
  /** Jump the editor's cursor to the reported character. */
  onGoToPosition: (position: number) => void;
  onDismiss: () => void;
}

/**
 * The full text of a failure, above the status bar.
 *
 * The status bar holds one line and does not wrap, which was fine for
 * `relation "usres" does not exist` and useless for the errors that
 * actually need reading — a check constraint quoting its own
 * expression, or a function raising a paragraph. This panel wraps,
 * scrolls, and turns the reported character offset into somewhere to
 * go rather than a number to squint at.
 */
export function ErrorPanel({ error, onGoToPosition, onDismiss }: Props) {
  // Postgres says what broke; this says what to do about it, on the
  // few errors where the app knows something Postgres does not.
  const hint = hintFor(error);

  return (
    <div className="error-panel" role="alert">
      <div className="error-panel-head">
        {error.code && <span className="sqlstate">{error.code}</span>}
        <span className="error-panel-message">{error.message}</span>
        <button className="btn-small" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {hint && <p className="error-panel-hint">{hint}</p>}
      {error.position !== null && (
        <dl>
          <dt>Position</dt>
          <dd>
            character {error.position}{" "}
            <button
              className="link"
              onClick={() => onGoToPosition(error.position!)}
            >
              Show me
            </button>
          </dd>
        </dl>
      )}
    </div>
  );
}
