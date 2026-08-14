/** Mirrors Rust `ColumnMeta`. */
export interface ColumnMeta {
  name: string;
  type_name: string;
}

/** Mirrors Rust `QueryResult`. Rows are positional, matching `columns`. */
export interface QueryResult {
  columns: ColumnMeta[];
  rows: CellValue[][];
  row_count: number;
  affected_rows: number | null;
  duration_ms: number;
}

export type CellValue =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

/** Mirrors Rust `ConnectionInfo`. */
export interface ConnectionInfo {
  id: string;
  host: string;
  port: number;
  dbname: string;
  user: string;
  server_version: string;
}

/** Mirrors Rust `Collection`. */
export interface Collection {
  id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: string;
}

/** Mirrors Rust `Query`. `draft_sql` is the autosaved text. */
export interface Query {
  id: string;
  collection_id: string | null;
  name: string;
  sql: string;
  draft_sql: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

/** Mirrors Rust `Tab`. `query_id === null` means an untitled tab. */
export interface Tab {
  id: string;
  query_id: string | null;
  scratch_sql: string | null;
  position: number;
  is_active: boolean;
  cursor_pos: number;
}

/** Mirrors Rust `LibraryTree`. */
export interface LibraryTree {
  collections: Collection[];
  queries: Query[];
}

/** A collection with its children resolved, for rendering. */
export interface TreeNode {
  collection: Collection;
  children: TreeNode[];
  queries: Query[];
}

/** Mirrors Rust `ErrorPayload`. */
export interface AppErrorPayload {
  kind:
    | "invalid_url"
    | "connection"
    | "unknown_connection"
    | "query"
    | "keychain";
  message: string;
  code: string | null;
  position: number | null;
}

export type Tag = "local" | "staging" | "prod";

export type SslMode = "disable" | "prefer" | "require" | "verify-full";

/** Mirrors Rust `Connection`. The password is never sent to the UI. */
export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  dbname: string;
  sslmode: SslMode;
  tag: Tag;
  colour: string;
  last_used_at: string | null;
  created_at: string;
}

/** Mirrors Rust `ConnectionInput`. */
export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  user: string;
  dbname: string;
  sslmode: SslMode;
  tag: Tag;
  colour: string | null;
  /** Absent or empty means "leave the stored password alone". */
  password: string | null;
}
