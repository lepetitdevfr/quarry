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
