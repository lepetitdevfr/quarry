import type { Schema, SchemaTable } from "../types";

/**
 * One rendered line of the tree.
 *
 * Two levels only: schemas, and the tables inside them. A table's
 * columns, indexes and constraints are shown by the table detail tab,
 * not here.
 */
export interface SchemaRow {
  /** Stable identity, also the expansion key: `schema:public`. */
  id: string;
  kind: "schema" | "table";
  label: string;
  depth: number;
  /** Set on schema rows, which are the only expandable kind. */
  expandable?: boolean;
  /** Table rows only — identity for opening the detail tab. */
  tableSchema?: string;
  tableName?: string;
  /**
   * What kind of relation a table row is: `table`, `view` or
   * `materialized view`. Absent on an ordinary table, which is the
   * default the eye already assumes — a badge on every row is a badge
   * nobody reads.
   */
  relationLabel?: string;
}

/**
 * How a relation kind is spelled in the tree.
 *
 * `pg_class.relkind` letters, and only the ones the tree lists. A
 * partitioned table is a table: the partitioning is a storage decision,
 * not something you query differently.
 */
export function relationLabel(kind: string): string | undefined {
  if (kind === "v") return "view";
  if (kind === "m") return "matview";
  return undefined;
}

/** Case-insensitive substring match; an empty filter matches everything. */
export function matchesFilter(text: string, filter: string): boolean {
  if (filter === "") return true;
  return text.toLowerCase().includes(filter.toLowerCase());
}

function tableMatches(table: SchemaTable, filter: string): boolean {
  if (filter === "") return true;
  if (matchesFilter(table.name, filter)) return true;
  return table.columns.some((c) => matchesFilter(c.name, filter));
}

/**
 * Turn the tree into the flat list the virtualizer renders.
 *
 * A filter auto-expands whatever it matches: typing a column name
 * surfaces the tables containing it without the user expanding
 * anything, which is what makes a wide schema navigable.
 */
export function flattenSchema(
  schema: Schema | null,
  expanded: Set<string>,
  filter: string,
): SchemaRow[] {
  if (!schema) return [];

  const rows: SchemaRow[] = [];
  const filtering = filter !== "";

  const sortedSchemas = [...schema.schemas].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const node of sortedSchemas) {
    const tables = [...node.tables]
      .filter((t) => tableMatches(t, filter))
      .sort((a, b) => a.name.localeCompare(b.name));

    // While filtering, a schema with no surviving tables disappears.
    if (filtering && tables.length === 0) continue;

    const schemaId = `schema:${node.name}`;
    const schemaOpen = filtering || expanded.has(schemaId);

    rows.push({
      id: schemaId,
      kind: "schema",
      label: node.name,
      depth: 0,
      expandable: true,
    });

    if (!schemaOpen) continue;

    // Tables are leaves. Columns, indexes and constraints used to hang
    // below them; they live in the table detail tab now, where there is
    // room to show a definition without truncating it to sidebar width.
    for (const table of tables) {
      rows.push({
        id: `table:${table.schema}.${table.name}`,
        kind: "table",
        label: table.name,
        depth: 1,
        tableSchema: table.schema,
        tableName: table.name,
        relationLabel: relationLabel(table.kind),
      });
    }
  }

  return rows;
}

/**
 * Build the object `@codemirror/lang-sql` expects: table name → column
 * names. Tables in `public` are exposed twice, qualified and bare,
 * because `public` is on the default search path and nobody types it.
 */
export function buildCompletionSchema(
  schema: Schema | null,
): Record<string, string[]> {
  if (!schema) return {};

  const built: Record<string, string[]> = {};

  // How many schemas hold a table of each name, so a bare name is only
  // offered when it means one thing.
  const owners = new Map<string, string[]>();
  for (const node of schema.schemas) {
    for (const table of node.tables) {
      owners.set(table.name, [...(owners.get(table.name) ?? []), node.name]);
    }
  }

  for (const node of schema.schemas) {
    for (const table of node.tables) {
      const columns = table.columns.map((c) => c.name);
      built[`${node.name}.${table.name}`] = columns;

      // The bare name too, because nobody re-qualifies in a WHERE:
      // `select * from od_pdp.invoice where invoice.reason is not null`
      // is ordinary SQL, and Postgres resolves the alias from the FROM.
      //
      // Only when it is unambiguous. Where two schemas share a name,
      // public wins — unqualified SQL resolves through search_path,
      // which starts there, so completing public's columns matches what
      // the query would actually hit. Two non-public schemas have no
      // such answer, and guessing would be wrong half the time, so the
      // bare name is left out and the qualified one still works.
      const holders = owners.get(table.name) ?? [];
      const unambiguous = holders.length === 1;
      if (unambiguous || node.name === "public") {
        built[table.name] = columns;
      }
    }
  }

  return built;
}


/** How many rows a table preview fetches. */
export const PREVIEW_LIMIT = 500;

/**
 * Words Postgres will not read as a name unless they are quoted.
 *
 * Its reserved category, which is the set that cannot be a table,
 * column or schema name bare. Anything outside it that still needs
 * quoting is caught by the shape test in `quoteIdent`.
 *
 * Kept deliberately as the reserved list and not the whole keyword
 * list: quoting `name` or `value` would put the noise back for words
 * Postgres is perfectly happy to read.
 */
const RESERVED = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc",
  "asymmetric", "both", "case", "cast", "check", "collate", "column",
  "constraint", "create", "current_catalog", "current_date",
  "current_role", "current_time", "current_timestamp", "current_user",
  "default", "deferrable", "desc", "distinct", "do", "else", "end",
  "except", "false", "fetch", "for", "foreign", "from", "grant", "group",
  "having", "in", "initially", "intersect", "into", "lateral", "leading",
  "limit", "localtime", "localtimestamp", "not", "null", "offset", "on",
  "only", "or", "order", "placing", "primary", "references", "returning",
  "select", "session_user", "some", "symmetric", "table", "then", "to",
  "trailing", "true", "union", "unique", "user", "using", "variadic",
  "when", "where", "window", "with",
]);

/**
 * A name Postgres reads back as itself when written bare: lower case,
 * starting with a letter or underscore, and not a reserved word.
 *
 * Anything else — a capital, a space, a hyphen, a leading digit, a
 * reserved word — either resolves to something different or does not
 * parse, and must be quoted.
 */
function needsQuoting(name: string): boolean {
  if (!/^[a-z_][a-z0-9_$]*$/.test(name)) return true;
  return RESERVED.has(name);
}

/**
 * Quote a Postgres identifier, but only where quoting changes the
 * answer.
 *
 * Unquoted identifiers are folded to lower case, so a table created as
 * "Order" would not be found, and a reserved word would not parse at
 * all. Everything else is quoted for nothing: `"public"."orders"` is
 * noise in a statement the user reads, edits and runs, and the app
 * generating SQL nobody would type is the app talking to itself.
 *
 * A literal double quote inside a name is escaped by doubling it.
 */
export function quoteIdent(name: string): string {
  if (!needsQuoting(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

/** Which column a preview is ordered by, when it is ordered at all. */
export interface PreviewOrder {
  column: string;
  direction: "asc" | "desc";
}

/**
 * The SQL a table preview runs.
 *
 * `order` is what makes sorting a Data tab honest. The tab shows at
 * most `PREVIEW_LIMIT` rows, so sorting those in memory would order a
 * page rather than the table. Because this statement is ours — nothing
 * is parsed or wrapped — the ordering can simply be generated in the
 * right place, before the limit.
 */
export function previewSql(
  schema: string,
  table: string,
  order?: PreviewOrder,
): string {
  const target = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const ordering = order
    ? ` order by ${quoteIdent(order.column)} ${order.direction}`
    : "";
  return `select * from ${target}${ordering} limit ${PREVIEW_LIMIT}`;
}
