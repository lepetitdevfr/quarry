import { describe, expect, it } from "vitest";
import { tableDetail } from "./tableDetail";
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
        },
        {
          schema: "public",
          name: "bare",
          columns: [],
          indexes: [],
          constraints: [],
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
