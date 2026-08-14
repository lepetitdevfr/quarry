import { describe, expect, it } from "vitest";
import {
  buildCompletionSchema,
  flattenSchema,
  matchesFilter,
  previewSql,
} from "./schema";
import type { Schema } from "../types";

const SCHEMA: Schema = {
  schemas: [
    {
      name: "public",
      tables: [
        {
          schema: "public",
          name: "users",
          columns: [
            {
              name: "id",
              type_name: "int4",
              nullable: false,
              default: null,
              is_primary_key: true,
              references: null,
            },
            {
              name: "email",
              type_name: "text",
              nullable: false,
              default: null,
              is_primary_key: false,
              references: null,
            },
          ],
          indexes: [
            {
              name: "users_pkey",
              definition: "CREATE UNIQUE INDEX users_pkey ON public.users (id)",
              is_unique: true,
              is_primary: true,
            },
          ],
          constraints: [],
        },
        {
          schema: "public",
          name: "invoices",
          columns: [
            {
              name: "total",
              type_name: "numeric",
              nullable: true,
              default: null,
              is_primary_key: false,
              references: null,
            },
          ],
          indexes: [],
          constraints: [],
        },
      ],
    },
    {
      name: "analytics",
      tables: [
        {
          schema: "analytics",
          name: "events",
          columns: [
            {
              name: "user_id",
              type_name: "int4",
              nullable: false,
              default: null,
              is_primary_key: true,
              references: { schema: "public", table: "users", column: "id" },
            },
          ],
          indexes: [],
          constraints: [],
        },
      ],
    },
  ],
};

describe("buildCompletionSchema", () => {
  it("maps qualified table names to their columns", () => {
    const built = buildCompletionSchema(SCHEMA);
    expect(built["public.users"]).toEqual(["id", "email"]);
    expect(built["analytics.events"]).toEqual(["user_id"]);
  });

  it("also exposes public tables unqualified", () => {
    // `public` is on the default search path, so `users` must complete
    // without typing `public.`.
    const built = buildCompletionSchema(SCHEMA);
    expect(built["users"]).toEqual(["id", "email"]);
  });

  it("does not expose non-public tables unqualified", () => {
    const built = buildCompletionSchema(SCHEMA);
    expect(built["events"]).toBeUndefined();
  });

  it("returns an empty object for a null schema", () => {
    expect(buildCompletionSchema(null)).toEqual({});
  });
});

describe("flattenSchema", () => {
  it("returns only schema rows when nothing is expanded", () => {
    const rows = flattenSchema(SCHEMA, new Set(), "");
    expect(rows.map((r) => r.label)).toEqual(["analytics", "public"]);
    expect(rows.every((r) => r.kind === "schema")).toBe(true);
  });

  it("reveals tables when a schema is expanded", () => {
    const rows = flattenSchema(SCHEMA, new Set(["schema:public"]), "");
    expect(rows.map((r) => r.label)).toEqual([
      "analytics",
      "public",
      "invoices",
      "users",
    ]);
  });

  it("reveals columns and group rows when a table is expanded", () => {
    const rows = flattenSchema(
      SCHEMA,
      new Set(["schema:public", "table:public.users"]),
      "",
    );
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("id");
    expect(labels).toContain("email");
    expect(labels).toContain("indexes (1)");
  });

  it("indents deeper rows", () => {
    const rows = flattenSchema(SCHEMA, new Set(["schema:public"]), "");
    const schemaRow = rows.find((r) => r.label === "public")!;
    const tableRow = rows.find((r) => r.label === "users")!;
    expect(tableRow.depth).toBeGreaterThan(schemaRow.depth);
  });

  it("carries table identity on table rows", () => {
    const rows = flattenSchema(SCHEMA, new Set(["schema:public"]), "");
    const users = rows.find((r) => r.label === "users")!;
    expect(users.tableSchema).toBe("public");
    expect(users.tableName).toBe("users");
  });
});

describe("matchesFilter", () => {
  it("keeps tables whose name matches", () => {
    const rows = flattenSchema(SCHEMA, new Set(), "invo");
    expect(rows.map((r) => r.label)).toContain("invoices");
  });

  it("auto-expands to reveal a matching column", () => {
    // Typing a column name should surface the table containing it,
    // without the user expanding anything by hand.
    const rows = flattenSchema(SCHEMA, new Set(), "email");
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("users");
    expect(labels).toContain("email");
    expect(labels).not.toContain("invoices");
  });

  it("is case-insensitive", () => {
    expect(matchesFilter("Users", "user")).toBe(true);
    expect(matchesFilter("users", "USER")).toBe(true);
  });

  it("treats an empty filter as matching everything", () => {
    expect(matchesFilter("anything", "")).toBe(true);
  });
});

describe("previewSql", () => {
  it("qualifies and quotes the table", () => {
    expect(previewSql("public", "users")).toBe(
      'select * from "public"."users" limit 500',
    );
  });

  it("survives a name that needs quoting", () => {
    // An unquoted mixed-case or reserved-word name silently resolves to
    // something else, or fails outright.
    expect(previewSql("public", "Order")).toBe(
      'select * from "public"."Order" limit 500',
    );
  });

  it("escapes an embedded double quote", () => {
    // Legal in Postgres, and the only way this builds broken SQL.
    expect(previewSql("public", 'we"ird')).toBe(
      'select * from "public"."we""ird" limit 500',
    );
  });
});
