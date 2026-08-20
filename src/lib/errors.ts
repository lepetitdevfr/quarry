import type { AppErrorPayload } from "../types";

/** Narrow an unknown thrown value to our error shape. */
export function asAppError(e: unknown): AppErrorPayload {
  if (typeof e === "object" && e !== null && "kind" in e && "message" in e) {
    return e as AppErrorPayload;
  }
  return {
    kind: "connection",
    message: e instanceof Error ? e.message : String(e),
    code: null,
    position: null,
  };
}

/**
 * The one sentence the app can add to an error Postgres wrote.
 *
 * Postgres explains what went wrong; it does not know how this app
 * works. `42601 cannot insert multiple commands into a prepared
 * statement` is the product's most-hit limitation and reads as a
 * driver fault — the way out is one keystroke the message never
 * mentions.
 *
 * Only errors with a real answer get a hint. A hint on every error is
 * noise, and noise is what the status bar spent its credibility on.
 */
export function hintFor(error: AppErrorPayload): string | null {
  if (
    error.code === "42601" &&
    error.message.toLowerCase().includes("multiple commands")
  ) {
    return "Quarry runs one statement at a time. Put the cursor in the statement you want and press ⌘↵.";
  }
  return null;
}
