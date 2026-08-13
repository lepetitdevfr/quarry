import { invoke } from "@tauri-apps/api/core";
import type { ConnectionInfo, QueryResult } from "../types";

/**
 * The only module that talks to Tauri. Everything else imports these
 * functions, so the IPC surface stays visible in one place.
 */

export async function connect(
  id: string,
  url: string,
  rememberPassword: boolean,
): Promise<ConnectionInfo> {
  return invoke<ConnectionInfo>("connect", { id, url, rememberPassword });
}

export async function execute(
  connectionId: string,
  sql: string,
): Promise<QueryResult> {
  return invoke<QueryResult>("execute", { connectionId, sql });
}

export async function disconnect(connectionId: string): Promise<void> {
  return invoke("disconnect", { connectionId });
}

export { asAppError } from "./errors";
