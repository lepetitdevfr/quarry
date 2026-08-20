import { useEffect, useRef, useState } from "react";
import { formatCountdown } from "../lib/guard";
import type { PendingWrite } from "../types";

interface Props {
  pending: PendingWrite;
  /** How long the server will hold the transaction, in seconds. */
  seconds: number;
  onCommit: () => void;
  onDiscard: () => void;
}

/**
 * The statement has already run. What is being decided is whether it
 * stays.
 *
 * The countdown is not decoration. Postgres ends this transaction when
 * it expires — that is what makes holding one safe at all — and a
 * deadline you can watch approach is a different thing from one that
 * fires silently. It is the difference between the app expiring your
 * transaction and the app appearing to lose it.
 */
export function PendingWriteDialog({
  pending,
  seconds,
  onCommit,
  onDiscard,
}: Props) {
  const [left, setLeft] = useState(seconds);
  const discardRef = useRef<HTMLButtonElement>(null);

  // Discard takes the focus, not Commit. A stray Enter on a dialog about
  // a production write must not be the thing that commits it.
  useEffect(() => discardRef.current?.focus(), [pending.token]);

  useEffect(() => {
    setLeft(seconds);
    const started = Date.now();
    const handle = window.setInterval(() => {
      setLeft(seconds - Math.floor((Date.now() - started) / 1000));
    }, 250);
    return () => window.clearInterval(handle);
  }, [seconds, pending.token]);

  // Expired: the server has ended it, so the only honest thing left to
  // offer is the button that acknowledges that.
  const expired = left <= 0;

  return (
    <div className="modal-backdrop">
      <div
        className="confirm-dialog pending-write"
        role="alertdialog"
        onKeyDown={(e) => {
          // Escape discards. It is the reading every other dialog in the
          // app has, and here the safe one happens to agree.
          if (e.key === "Escape") {
            e.preventDefault();
            onDiscard();
          }
        }}
      >
        <p className="pending-summary">{pending.summary}</p>
        <pre className="pending-sql">{pending.sql}</pre>
        <p className="pending-countdown">
          {expired
            ? "rolled back — it was not confirmed in time"
            : `rolls back in ${formatCountdown(left)}`}
        </p>
        <div className="confirm-actions">
          <button
            className="secondary"
            type="button"
            ref={discardRef}
            onClick={onDiscard}
          >
            {expired ? "Close" : "Discard"}
          </button>
          <button
            className="danger"
            type="button"
            onClick={onCommit}
            disabled={expired}
          >
            Commit
          </button>
        </div>
      </div>
    </div>
  );
}
