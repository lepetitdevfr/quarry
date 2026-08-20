import { invoke } from "@tauri-apps/api/core";
import type {
  AppliedRow,
  Connection,
  ConnectionInfo,
  ConnectionInput,
  EditInfo,
  EditStatement,
  GuardStatus,
  LibraryTree,
  Query,
  QueryResult,
  RowDelete,
  RowEdit,
  RowInsert,
  Schema,
  Tab,
  TableMode,
  TabPin,
} from "../types";

/**
 * The only module that talks to Tauri. Everything else imports these
 * functions, so the IPC surface stays visible in one place.
 */

/**
 * Run one statement.
 *
 * `generated` says the SQL is the app's own preview rather than
 * something a person typed, which keeps it out of history and out of
 * the truncation flag. See `runSql` in `App.tsx`, which carries it.
 */
export async function execute(
  sql: string,
  generated: boolean,
): Promise<QueryResult> {
  return invoke<QueryResult>("execute", { sql, generated });
}

/// Shows the statements an apply would run, without running them.
export async function previewEdits(
  edit: EditInfo,
  rows: RowEdit[],
  deletes: RowDelete[],
  inserts: RowInsert[],
): Promise<EditStatement[]> {
  return invoke<EditStatement[]>("preview_edits", {
    edit,
    rows,
    deletes,
    inserts,
  });
}

/// Applies staged cell edits, row deletions and new rows in one
/// transaction, returning what the database stored for each edited or
/// inserted cell and which rows are gone.
export async function applyRowEdits(
  edit: EditInfo,
  rows: RowEdit[],
  deletes: RowDelete[],
  inserts: RowInsert[],
): Promise<AppliedRow[]> {
  return invoke<AppliedRow[]>("apply_row_edits", {
    edit,
    rows,
    deletes,
    inserts,
  });
}

export async function disconnect(): Promise<void> {
  return invoke("disconnect");
}

export { asAppError } from "./errors";

export async function listConnections(): Promise<Connection[]> {
  return invoke<Connection[]>("list_connections");
}

export async function createConnection(
  input: ConnectionInput,
): Promise<Connection[]> {
  return invoke<Connection[]>("create_connection", { input });
}

export async function updateConnection(
  id: string,
  input: ConnectionInput,
): Promise<Connection[]> {
  return invoke<Connection[]>("update_connection", { id, input });
}

export async function deleteConnection(id: string): Promise<Connection[]> {
  return invoke<Connection[]>("delete_connection", { id });
}

export async function connectSaved(
  id: string,
  password?: string,
): Promise<ConnectionInfo> {
  return invoke<ConnectionInfo>("connect_saved", { id, password });
}

/**
 * Dial a connection the user is still typing. Saves nothing, connects
 * nothing, and resolves to the server version.
 *
 * `id` is only passed when editing a saved connection whose password
 * field was left blank, which means "keep the stored one".
 */
export async function testConnection(
  input: ConnectionInput,
  id?: string,
): Promise<string> {
  return invoke<string>("test_connection", { input, id });
}

export async function activeConnection(): Promise<ConnectionInfo | null> {
  return invoke<ConnectionInfo | null>("active_connection");
}

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

export async function openPreviewTab(title: string, sql: string): Promise<Tab[]> {
  return invoke<Tab[]>("open_preview_tab", { title, sql });
}

export async function promoteTab(id: string): Promise<Tab[]> {
  return invoke<Tab[]>("promote_tab", { id });
}

export async function openTableTab(
  schema: string,
  table: string,
  mode: TableMode,
  pin: TabPin,
): Promise<Tab[]> {
  return invoke<Tab[]>("open_table_tab", { schema, table, mode, pin });
}

export async function setTabMode(id: string, mode: TableMode): Promise<Tab[]> {
  return invoke<Tab[]>("set_tab_mode", { id, mode });
}

export async function writeTextFile(
  path: string,
  contents: string,
): Promise<void> {
  return invoke("write_text_file", { path, contents });
}

/// Re-reads the database structure. Used for both the initial load
/// after connecting and the manual refresh button.
export async function refreshSchema(): Promise<Schema> {
  return invoke<Schema>("refresh_schema");
}

export async function guardStatus(): Promise<GuardStatus | null> {
  return invoke<GuardStatus | null>("guard_status");
}

export async function unlock(typedName: string): Promise<void> {
  return invoke("unlock", { typedName });
}

export async function relock(): Promise<void> {
  return invoke("relock");
}
