import type { Schema, SchemaTable } from "../types";

/** One rendered line of the tree. */
export interface SchemaRow {
  /** Stable identity, also the expansion key: `table:public.users`. */
  id: string;
  kind: "schema" | "table" | "column" | "group" | "index" | "constraint";
  label: string;
  depth: number;
  /** Column type, or an index/constraint definition. */
  detail?: string;
  /** Set on rows that can be expanded. */
  expandable?: boolean;
  /** Column markers. */
  isPrimaryKey?: boolean;
  nullable?: boolean;
  /** Tooltip text for a foreign key marker. */
  referencesLabel?: string;
  /** `pg_constraint.contype`, on constraint rows only. */
  constraintKind?: string;
  /** Index rows only — drives the UNIQUE/PK badge. */
  isUniqueIndex?: boolean;
  isPrimaryIndex?: boolean;
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

    for (const table of tables) {
      const tableId = `table:${table.schema}.${table.name}`;
      // A filter that matched a column expands that table so the match
      // is visible; a filter matching only the table name does not.
      const columnHit =
        filtering && table.columns.some((c) => matchesFilter(c.name, filter));
      const tableOpen = expanded.has(tableId) || columnHit;

      rows.push({
        id: tableId,
        kind: "table",
        label: table.name,
        depth: 1,
        expandable: true,
      });

      if (!tableOpen) continue;

      for (const column of table.columns) {
        rows.push({
          id: `column:${table.schema}.${table.name}.${column.name}`,
          kind: "column",
          label: column.name,
          depth: 2,
          detail: column.type_name,
          isPrimaryKey: column.is_primary_key,
          nullable: column.nullable,
          referencesLabel: column.references
            ? `references ${column.references.schema}.${column.references.table}.${column.references.column}`
            : undefined,
        });
      }

      if (table.indexes.length > 0) {
        const groupId = `indexes:${table.schema}.${table.name}`;
        rows.push({
          id: groupId,
          kind: "group",
          label: `indexes (${table.indexes.length})`,
          depth: 2,
          expandable: true,
        });
        if (expanded.has(groupId)) {
          for (const index of table.indexes) {
            rows.push({
              id: `index:${table.schema}.${table.name}.${index.name}`,
              kind: "index",
              label: index.name,
              depth: 3,
              detail: index.definition,
              isUniqueIndex: index.is_unique,
              isPrimaryIndex: index.is_primary,
            });
          }
        }
      }

      if (table.constraints.length > 0) {
        const groupId = `constraints:${table.schema}.${table.name}`;
        rows.push({
          id: groupId,
          kind: "group",
          label: `constraints (${table.constraints.length})`,
          depth: 2,
          expandable: true,
        });
        if (expanded.has(groupId)) {
          for (const constraint of table.constraints) {
            rows.push({
              id: `constraint:${table.schema}.${table.name}.${constraint.name}`,
              kind: "constraint",
              label: constraint.name,
              depth: 3,
              detail: constraint.definition,
              constraintKind: constraint.kind,
            });
          }
        }
      }
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

  for (const node of schema.schemas) {
    for (const table of node.tables) {
      const columns = table.columns.map((c) => c.name);
      built[`${node.name}.${table.name}`] = columns;
      if (node.name === "public") built[table.name] = columns;
    }
  }

  return built;
}
