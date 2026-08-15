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
              name: "orders_pkey",
              definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
              is_unique: true,
              is_primary: true,
            },
          ],
          constraints: [
            { name: "orders_pkey", kind: "p", definition: "PRIMARY KEY (id)" },
            {
              name: "orders_customer_fkey",
              kind: "f",
              definition: "FOREIGN KEY (customer_id) REFERENCES customers(id)",
            },
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
    expect(detail!.columns[1].referencesLabel).toBe("public.customers.id");
    expect(detail!.columns[0].referencesLabel).toBeUndefined();
  });

  it("badges indexes", () => {
    const detail = tableDetail(schema, "public", "orders");

    expect(detail!.indexes[0].badges).toEqual(["PK", "UNIQUE"]);
    expect(detail!.indexes[0].definition).toContain("btree (id)");
  });

  it("groups constraints by kind, in a stable order", () => {
    const detail = tableDetail(schema, "public", "orders");

    expect(detail!.constraints.map((g) => g.label)).toEqual(["Primary key", "Foreign key"]);
    expect(detail!.constraints[0].items[0].name).toBe("orders_pkey");
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
