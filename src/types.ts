/** Mirrors Rust `ColumnMeta`. */
export interface ColumnMeta {
  name: string;
  type_name: string;
}

/** Mirrors Rust `QueryResult`. Rows are positional, matching `columns`. */
export interface QueryResult {
  columns: ColumnMeta[];
  edit: EditInfo;
  rows: CellValue[][];
  row_count: number;
  affected_rows: number | null;
  duration_ms: number;
}

/** Mirrors Rust `PkColumn`. */
export interface PkColumn {
  name: string;
  result_index: number;
}

/** Mirrors Rust `ColumnEdit`: one result column's verdict. */
export interface ColumnEdit {
  editable: boolean;
  column_name: string | null;
  cast_type: string | null;
  /** Why this cell cannot be edited. */
  reason: string | null;
}

/**
 * Mirrors Rust `EditInfo`. Decided in Rust from the metadata Postgres
 * sent about the result; the frontend never works it out itself.
 */
export interface EditInfo {
  editable: boolean;
  /** Why the whole result cannot be edited. */
  reason: string | null;
  schema: string | null;
  table: string | null;
  pk: PkColumn[];
  columns: ColumnEdit[];
}

/** Mirrors Rust `CellEdit`. `value: null` is an explicit SQL NULL. */
export interface CellEdit {
  column: number;
  value: string | null;
}

/** Mirrors Rust `RowEdit`. */
export interface RowEdit {
  row: number;
  pk: string[];
  cells: CellEdit[];
}

/** Mirrors Rust `RowDelete`: one row to delete, addressed by its key. */
export interface RowDelete {
  row: number;
  pk: string[];
}

/** Mirrors Rust `StatementKind`. */
export type StatementKind = "update" | "delete";

/** Mirrors Rust `Statement`, for the View SQL panel. */
export interface EditStatement {
  sql: string;
  params: (string | null)[];
  row: number;
  returned: number[];
  kind: StatementKind;
}

/** Mirrors Rust `AppliedCell`. The value is what the database stored. */
export interface AppliedCell {
  column: number;
  value: CellValue;
}

/** Mirrors Rust `AppliedRow`. */
export interface AppliedRow {
  row: number;
  /** Always empty for a deleted row: there is nothing left to patch. */
  cells: AppliedCell[];
  /** The row is gone: drop it from the grid rather than patching it. */
  deleted: boolean;
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

/** Mirrors Rust `TableMode`. */
export type TableMode = "structure" | "data";

/** Mirrors Rust `TabPin`. `"preview"` is disposable; `"pinned"` is kept. */
export type TabPin = "preview" | "pinned";

/** Mirrors Rust `Tab`. `query_id === null` means an untitled tab. */
export interface Tab {
  id: string;
  query_id: string | null;
  scratch_sql: string | null;
  position: number;
  is_active: boolean;
  cursor_pos: number;
  is_preview: boolean;
  title: string | null;
  /** Both set on a table tab, both null on a query tab. */
  target_schema: string | null;
  target_table: string | null;
  mode: TableMode | null;
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
    | "keychain"
    | "password_required"
    | "write_blocked";
  message: string;
  code: string | null;
  position: number | null;
}

/** Mirrors Rust `GuardStatus`. */
export interface GuardStatus {
  policy: "free" | "read_only";
  /** Seconds left on the unlock; null when locked. */
  unlocked_seconds_remaining: number | null;
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

/** Mirrors Rust `ForeignKey`. */
export interface ForeignKey {
  schema: string;
  table: string;
  column: string;
}

/** Mirrors Rust `Column`. */
export interface SchemaColumn {
  name: string;
  type_name: string;
  nullable: boolean;
  default: string | null;
  is_primary_key: boolean;
  references: ForeignKey | null;
}

/** Mirrors Rust `Index`. */
export interface SchemaIndex {
  name: string;
  definition: string;
  is_unique: boolean;
  is_primary: boolean;
}

/** Mirrors Rust `Constraint`. */
export interface SchemaConstraint {
  name: string;
  kind: string;
  definition: string;
}

/** Mirrors Rust `Table`. */
export interface SchemaTable {
  schema: string;
  name: string;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
  constraints: SchemaConstraint[];
}

/** Mirrors Rust `SchemaNode`. */
export interface SchemaNode {
  name: string;
  tables: SchemaTable[];
}

/** Mirrors Rust `Schema`. */
export interface Schema {
  schemas: SchemaNode[];
}
