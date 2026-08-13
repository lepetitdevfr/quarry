import { invoke } from "@tauri-apps/api/core";
import type { ConnectionInfo, LibraryTree, Query, QueryResult, Tab } from "../types";

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

export async function libraryTree(): Promise<LibraryTree> {
  return invoke<LibraryTree>("library_tree");
}

export async function createCollection(
  name: string,
  parentId: string | null,
): Promise<LibraryTree> {
  return invoke<LibraryTree>("create_collection", { name, parentId });
}

export async function renameCollection(
  id: string,
  name: string,
): Promise<LibraryTree> {
  return invoke<LibraryTree>("rename_collection", { id, name });
}

export async function deleteCollection(id: string): Promise<LibraryTree> {
  return invoke<LibraryTree>("delete_collection", { id });
}

export async function createQuery(
  name: string,
  sql: string,
  collectionId: string | null,
): Promise<Query> {
  return invoke<Query>("create_query", { name, sql, collectionId });
}

export async function renameQuery(id: string, name: string): Promise<LibraryTree> {
  return invoke<LibraryTree>("rename_query", { id, name });
}

export async function saveQuery(id: string, sql: string): Promise<void> {
  return invoke("save_query", { id, sql });
}

export async function saveDraft(id: string, sql: string): Promise<void> {
  return invoke("save_draft", { id, sql });
}

export async function moveQuery(
  id: string,
  collectionId: string | null,
): Promise<LibraryTree> {
  return invoke<LibraryTree>("move_query", { id, collectionId });
}

export async function deleteQuery(id: string): Promise<LibraryTree> {
  return invoke<LibraryTree>("delete_query", { id });
}

export async function listTabs(): Promise<Tab[]> {
  return invoke<Tab[]>("list_tabs");
}

export async function openTab(queryId: string | null): Promise<Tab[]> {
  return invoke<Tab[]>("open_tab", { queryId });
}

export async function activateTab(id: string): Promise<Tab[]> {
  return invoke<Tab[]>("activate_tab", { id });
}

export async function closeTab(id: string): Promise<Tab[]> {
  return invoke<Tab[]>("close_tab", { id });
}

export async function saveScratch(id: string, sql: string): Promise<void> {
  return invoke("save_scratch", { id, sql });
}

export async function setCursor(id: string, pos: number): Promise<void> {
  return invoke("set_cursor", { id, pos });
}
