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
 * Quote a Postgres identifier.
 *
 * Unquoted identifiers are folded to lower case, so a table created as
 * "Order" would not be found, and a reserved word would not parse at
 * all. A literal double quote inside a name is escaped by doubling it.
 */
function quoteIdent(name: string): string {
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
