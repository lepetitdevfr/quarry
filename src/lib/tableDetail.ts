import type { Schema } from "../types";

/**
 * The structure view's whole data model. Everything the view needs is
 * computed here so the component stays a renderer and the logic stays
 * testable without a DOM.
 */
export interface TableDetail {
  schema: string;
  name: string;
  columns: DetailColumn[];
  indexes: DetailIndex[];
  constraints: ConstraintGroup[];
}

export interface DetailColumn {
  name: string;
  type: string;
  nullable: boolean;
  /** Display text for the nullable column — decided here, not in the view. */
  nullableLabel: string;
  default: string | null;
  isPrimaryKey: boolean;
  /** `schema.table.column`, on single-column foreign keys only. */
  referencesLabel?: string;
}

export interface DetailIndex {
  name: string;
  definition: string;
  /** PK before UNIQUE, so the badges read the same on every row. */
  badges: string[];
}

export interface ConstraintGroup {
  kind: string;
  label: string;
  items: { name: string; definition: string }[];
}

/**
 * `pg_constraint.contype` spelled out, in the order the sections are
 * shown. A kind outside this list still renders, under its raw letter —
 * a future Postgres release adding one must not make constraints vanish.
 */
const CONSTRAINT_KINDS: [string, string][] = [
  ["p", "Primary key"],
  ["f", "Foreign key"],
  ["u", "Unique"],
  ["c", "Check"],
  ["x", "Exclusion"],
];

/**
 * Build the structure view for one table, or null when it is not in the
 * schema — a dropped table, a schema that has not loaded, or no
 * connection at all.
 */
export function tableDetail(
  schema: Schema | null,
  schemaName: string,
  tableName: string,
): TableDetail | null {
  const node = schema?.schemas.find((s) => s.name === schemaName);
  const table = node?.tables.find((t) => t.name === tableName);
  if (!table) return null;

  return {
    schema: schemaName,
    name: tableName,
    columns: table.columns.map((c) => ({
      name: c.name,
      type: c.type_name,
      nullable: c.nullable,
      nullableLabel: c.nullable ? "yes" : "no",
      default: c.default,
      isPrimaryKey: c.is_primary_key,
      referencesLabel: c.references
        ? `${c.references.schema}.${c.references.table}.${c.references.column}`
        : undefined,
    })),
    indexes: table.indexes.map((i) => ({
      name: i.name,
      definition: i.definition,
      badges: [...(i.is_primary ? ["PK"] : []), ...(i.is_unique ? ["UNIQUE"] : [])],
    })),
    constraints: groupConstraints(table.constraints),
  };
}

function groupConstraints(
  constraints: { name: string; kind: string; definition: string }[],
): ConstraintGroup[] {
  const known = CONSTRAINT_KINDS.map(([kind, label]) => ({
    kind,
    label,
    items: constraints
      .filter((c) => c.kind === kind)
      .map((c) => ({ name: c.name, definition: c.definition })),
  })).filter((g) => g.items.length > 0);

  const seen = new Set(CONSTRAINT_KINDS.map(([kind]) => kind));
  const others = [...new Set(constraints.map((c) => c.kind))]
    .filter((kind) => !seen.has(kind))
    .map((kind) => ({
      kind,
      label: kind,
      items: constraints
        .filter((c) => c.kind === kind)
        .map((c) => ({ name: c.name, definition: c.definition })),
    }));

  return [...known, ...others];
}
