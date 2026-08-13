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
