import { describe, expect, it } from "vitest";
import {
  dependentLabel,
  formatBytes,
  formatRowEstimate,
  tableDetail,
} from "./tableDetail";
import type { Schema } from "../types";

const schema: Schema = {
  schemas: [
    {
      name: "public",
      tables: [
        {
          schema: "public",
          name: "orders",
          columns: [
            {
              name: "id",
              type_name: "int4",
              nullable: false,
              default: "nextval('orders_id_seq')",
              is_primary_key: true,
              references: null,
            },
            {
              name: "customer_id",
              type_name: "int4",
              nullable: true,
              default: null,
              is_primary_key: false,
              references: { schema: "public", table: "customers", column: "id" },
            },
          ],
          indexes: [
            {
              name: "orders_customer_idx",
              definition: "CREATE INDEX orders_customer_idx ON public.orders USING btree (customer_id)",
              is_unique: false,
              is_primary: false,
            },
            {
              name: "orders_email_key",
              definition: "CREATE UNIQUE INDEX orders_email_key ON public.orders USING btree (email)",
              is_unique: true,
              is_primary: false,
            },
            {
              name: "orders_pkey",
              definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
              is_unique: true,
              is_primary: true,
            },
          ],
          // Deliberately not in canonical order: `c` and `u` come before
          // `p`, so a grouping bug that just preserves input order can't
          // pass the ordering test by accident. `t` (constraint trigger)
          // is a real Postgres contype not in CONSTRAINT_KINDS, covering
          // the unknown-kind fallback — with two of them, to also catch
          // a fallback that fails to aggregate same-kind constraints.
          constraints: [
            { name: "orders_check", kind: "c", definition: "CHECK (amount > 0)" },
            { name: "orders_email_key", kind: "u", definition: "UNIQUE (email)" },
            { name: "orders_pkey", kind: "p", definition: "PRIMARY KEY (id)" },
            {
              name: "orders_customer_fkey",
              kind: "f",
              definition: "FOREIGN KEY (customer_id) REFERENCES customers(id)",
            },
            { name: "orders_trigger_a", kind: "t", definition: "CONSTRAINT TRIGGER a" },
            { name: "orders_trigger_b", kind: "t", definition: "CONSTRAINT TRIGGER b" },
          ],
          stats: null,
          comment: null,
          triggers: [],
          dependents: [],
          kind: "r",
          definition: null,
        },
        {
          schema: "public",
          name: "bare",
          columns: [],
          indexes: [],
          constraints: [],
          stats: null,
          comment: null,
          triggers: [],
          dependents: [],
          kind: "r",
          definition: null,
        },
        {
          schema: "public",
          name: "paid_orders",
          columns: [],
          indexes: [],
          constraints: [],
          stats: null,
          comment: null,
          triggers: [],
          dependents: [],
          kind: "v",
          definition: "select * from orders where paid",
        },
      ],
    },
  ],
};

describe("tableDetail", () => {
  it("returns the columns of the named table", () => {
    const detail = tableDetail(schema, "public", "orders");

    expect(detail).not.toBeNull();
    expect(detail!.columns.map((c) => c.name)).toEqual(["id", "customer_id"]);
    expect(detail!.columns[0].isPrimaryKey).toBe(true);
    expect(detail!.columns[0].default).toBe("nextval('orders_id_seq')");
    expect(detail!.columns[0].nullableLabel).toBe("no");
    expect(detail!.columns[1].nullableLabel).toBe("yes");
    expect(detail!.columns[1].referencesLabel).toBe("public.customers.id");
    expect(detail!.columns[0].referencesLabel).toBeUndefined();
  });

  it("badges indexes", () => {
    const detail = tableDetail(schema, "public", "orders");

    expect(detail!.indexes[0].badges).toEqual([]);
    expect(detail!.indexes[1].badges).toEqual(["UNIQUE"]);
    expect(detail!.indexes[2].badges).toEqual(["PK", "UNIQUE"]);
    expect(detail!.indexes[2].definition).toContain("btree (id)");
  });

  it("groups constraints by kind, in a stable order regardless of input order", () => {
    const detail = tableDetail(schema, "public", "orders");

    expect(detail!.constraints.map((g) => g.label)).toEqual([
      "Primary key",
      "Foreign key",
      "Unique",
      "Check",
      "t",
    ]);
    expect(detail!.constraints[0].items[0].name).toBe("orders_pkey");
  });

  it("groups an unrecognised constraint kind under its raw letter instead of dropping it", () => {
    const detail = tableDetail(schema, "public", "orders");

    const fallback = detail!.constraints.find((g) => g.kind === "t");
    expect(fallback).toBeDefined();
    expect(fallback!.label).toBe("t");
    expect(fallback!.items.map((i) => i.name)).toEqual(["orders_trigger_a", "orders_trigger_b"]);
  });

  it("reports empty sections rather than omitting them", () => {
    const detail = tableDetail(schema, "public", "bare");

    expect(detail!.columns).toEqual([]);
    expect(detail!.indexes).toEqual([]);
    expect(detail!.constraints).toEqual([]);
  });

  it("returns null when the table is not in the schema", () => {
    // A dropped table, or a schema that has not loaded yet. The caller
    // shows an empty state; it must not be able to crash on undefined.
    expect(tableDetail(schema, "public", "gone")).toBeNull();
    expect(tableDetail(schema, "other", "orders")).toBeNull();
    expect(tableDetail(null, "public", "orders")).toBeNull();
  });
});

describe("table facts", () => {
  it("formats a size in the largest unit that stays readable", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    // Decimal units, like pg_size_pretty: 8192 bytes is 8.2 kB, not the
    // 8.0 a binary kilobyte would give.
    expect(formatBytes(8192)).toBe("8.2 kB");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(3_000_000_000)).toBe("3.0 GB");
  });

  it("says unknown for a table that was never analyzed", () => {
    // pg_class.reltuples is -1 there, not 0. Showing "-1 rows" or
    // "0 rows" would both be lies — one absurd, one plausible and
    // therefore worse.
    expect(formatRowEstimate(-1)).toBe("unknown");
    expect(formatRowEstimate(0)).toBe("0");
    expect(formatRowEstimate(1234567)).toBe("1,234,567");
  });

  it("labels a materialised view distinctly from a view", () => {
    expect(dependentLabel({ schema: "public", name: "v", kind: "v" })).toBe(
      "public.v",
    );
    expect(dependentLabel({ schema: "public", name: "m", kind: "m" })).toBe(
      "public.m (materialised)",
    );
  });
});

describe("tableDetail on a view", () => {
  it("carries the defining query and says which kind it is", () => {
    // A structure tab for a view that showed only its columns would
    // answer the wrong half of "what is this?".
    const detail = tableDetail(schema, "public", "paid_orders")!;

    expect(detail.definition).toBe("select * from orders where paid");
    expect(detail.relationLabel).toBe("view");
  });

  it("leaves an ordinary table with no definition and no label", () => {
    const detail = tableDetail(schema, "public", "orders")!;

    expect(detail.definition).toBe(null);
    expect(detail.relationLabel).toBeUndefined();
  });
});
