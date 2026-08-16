import type { Schema, SchemaDependent, SchemaTrigger } from "../types";

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
  /** `COMMENT ON TABLE`, when there is one. */
  comment: string | null;
  /** Display-ready size and row estimate, or null when unavailable. */
  facts: { rows: string; size: string } | null;
  triggers: SchemaTrigger[];
  dependents: SchemaDependent[];
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
    comment: table.comment,
    facts: table.stats
      ? {
          rows: formatRowEstimate(table.stats.estimated_rows),
          size: formatBytes(table.stats.total_bytes),
        }
      : null,
    triggers: table.triggers,
    dependents: table.dependents,
  };
}

/**
 * A byte count in the largest unit that keeps it readable.
 *
 * Decimal units, matching what `pg_size_pretty` and the rest of the
 * Postgres tooling show, so a number here can be compared with one from
 * psql without mental arithmetic.
 */
export function formatBytes(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }

  // Bytes are whole things; anything larger has been divided and reads
  // better with one decimal.
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * The planner's row estimate, or "unknown".
 *
 * `pg_class.reltuples` is -1 on a table that has never been analyzed.
 * Rendering that as "-1" is absurd and rendering it as "0" is plausible
 * and therefore worse — someone would believe it.
 */
export function formatRowEstimate(estimate: number): string {
  if (estimate < 0) return "unknown";
  return estimate.toLocaleString("en-US");
}

/** A dependent view, with materialised ones called out. */
export function dependentLabel(dependent: SchemaDependent): string {
  const name = `${dependent.schema}.${dependent.name}`;
  // A materialised view holds a copy: changing this table does not
  // change it until it is refreshed, which is worth knowing here.
  return dependent.kind === "m" ? `${name} (materialised)` : name;
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
