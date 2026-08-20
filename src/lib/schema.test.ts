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
          stats: null,
          comment: null,
          triggers: [],
          dependents: [],
          kind: "r",
          definition: null,
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
          stats: null,
          comment: null,
          triggers: [],
          dependents: [],
          kind: "r",
          definition: null,
        },
        {
          schema: "public",
          name: "paid_invoices",
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
          stats: null,
          comment: null,
          triggers: [],
          dependents: [],
          kind: "v",
          definition: "select total from invoices where paid",
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
          stats: null,
          comment: null,
          triggers: [],
          dependents: [],
          kind: "r",
          definition: null,
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

  it("exposes a non-public table unqualified when the name is unique", () => {
    // This reverses an earlier decision to qualify everything outside
    // `public`. In practice a WHERE clause refers to the table by its
    // bare name — `from analytics.events where events.user_id ...` —
    // which is ordinary SQL, and completing nothing there was the more
    // surprising behaviour of the two.
    const built = buildCompletionSchema(SCHEMA);
    expect(built["events"]).toEqual(["user_id"]);
    expect(built["analytics.events"]).toEqual(["user_id"]);
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
      "paid_invoices",
      "users",
    ]);
  });

  it("stops at tables, even when a table id is in the expanded set", () => {
    // Columns, indexes and constraints live in the table detail tab
    // now. A stale table id left in the expanded set from an earlier
    // session must not resurrect a third level.
    const rows = flattenSchema(
      SCHEMA,
      new Set(["schema:public", "table:public.users"]),
      "",
    );
    expect(rows.map((r) => r.label)).toEqual([
      "analytics",
      "public",
      "invoices",
      "paid_invoices",
      "users",
    ]);
    expect(rows.every((r) => r.kind === "schema" || r.kind === "table")).toBe(
      true,
    );
  });

  it("labels a view and a materialised view, and leaves tables unlabelled", () => {
    // The badge exists to stop a user reading a view as a table — and
    // to stop them concluding a `create view` failed because nothing
    // appeared. A badge on every row would be a badge nobody reads, so
    // an ordinary table carries none.
    const rows = flattenSchema(SCHEMA, new Set(["schema:public"]), "");

    expect(rows.find((r) => r.label === "paid_invoices")?.relationLabel).toBe(
      "view",
    );
    expect(rows.find((r) => r.label === "users")?.relationLabel).toBeUndefined();
  });

  it("marks tables as leaves", () => {
    // The twisty is what tells the user a row opens; a table opens a
    // tab instead, so it must not claim to expand.
    const rows = flattenSchema(SCHEMA, new Set(["schema:public"]), "");
    const users = rows.find((r) => r.label === "users")!;
    expect(users.expandable).toBeFalsy();
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

  it("surfaces a table whose column matches, without listing the column", () => {
    // Filtering on a column name is how you find which table holds it,
    // so the match still has to reach the table row. The column itself
    // is no longer a tree row — clicking through shows it.
    const rows = flattenSchema(SCHEMA, new Set(), "email");
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("users");
    expect(labels).not.toContain("email");
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

  it("selects a capped page with no ordering by default", () => {
    expect(previewSql("public", "users")).toBe(
      'select * from "public"."users" limit 500',
    );
  });

  it("appends an ORDER BY before the limit", () => {
    // Order must precede limit, or the database sorts the page rather
    // than the table — which is the entire point of re-running.
    expect(
      previewSql("public", "users", { column: "created_at", direction: "asc" }),
    ).toBe(
      'select * from "public"."users" order by "created_at" asc limit 500',
    );
  });

  it("sorts descending", () => {
    expect(
      previewSql("public", "users", { column: "id", direction: "desc" }),
    ).toBe('select * from "public"."users" order by "id" desc limit 500');
  });

  it("quotes a column name that needs it", () => {
    // A mixed-case or reserved-word column is unreachable unquoted, and
    // an embedded quote must be doubled or the statement is malformed.
    expect(
      previewSql("public", "users", { column: 'we"ird', direction: "asc" }),
    ).toBe('select * from "public"."users" order by "we""ird" asc limit 500');
  });
});

describe("buildCompletionSchema unqualified names", () => {
  const table = (schema: string, name: string, columns: string[]) => ({
    schema,
    name,
    columns: columns.map((c) => ({
      name: c,
      type_name: "text",
      nullable: true,
      default: null,
      is_primary_key: false,
      references: null,
    })),
    indexes: [],
    constraints: [],
    stats: null,
    comment: null,
    triggers: [],
    dependents: [],
    kind: "r",
    definition: null,
  });

  const schemaWith = (...nodes: { name: string; tables: ReturnType<typeof table>[] }[]) => ({
    schemas: nodes,
  });

  it("completes a table in a non-public schema by its bare name", () => {
    // `select * from od_pdp.invoice where invoice.` — nobody re-qualifies
    // in the WHERE, and Postgres does not require it.
    const built = buildCompletionSchema(
      schemaWith({ name: "od_pdp", tables: [table("od_pdp", "invoice", ["id", "reason"])] }),
    );

    expect(built["od_pdp.invoice"]).toEqual(["id", "reason"]);
    expect(built["invoice"]).toEqual(["id", "reason"]);
  });

  it("lets public win when two schemas share a table name", () => {
    // Unqualified SQL resolves through search_path, which starts at
    // public — so the bare name should complete what the query would
    // actually hit.
    const built = buildCompletionSchema(
      schemaWith(
        { name: "od_pdp", tables: [table("od_pdp", "invoice", ["reason"])] },
        { name: "public", tables: [table("public", "invoice", ["total"])] },
      ),
    );

    expect(built["invoice"]).toEqual(["total"]);
    expect(built["od_pdp.invoice"]).toEqual(["reason"]);
  });

  it("leaves an ambiguous bare name out rather than guessing", () => {
    // Two non-public schemas, same table name, no search_path answer.
    // Completing one of them would be wrong half the time.
    const built = buildCompletionSchema(
      schemaWith(
        { name: "a", tables: [table("a", "invoice", ["x"])] },
        { name: "b", tables: [table("b", "invoice", ["y"])] },
      ),
    );

    expect(built["invoice"]).toBeUndefined();
    expect(built["a.invoice"]).toEqual(["x"]);
    expect(built["b.invoice"]).toEqual(["y"]);
  });
});

import { relationLabel } from "./schema";

describe("relationLabel", () => {
  it("names the two kinds the tree has to distinguish", () => {
    expect(relationLabel("v")).toBe("view");
    expect(relationLabel("m")).toBe("matview");
  });

  it("leaves ordinary and partitioned tables unlabelled", () => {
    // A partitioned table is a table: the partitioning is a storage
    // decision, not something you query differently.
    expect(relationLabel("r")).toBeUndefined();
    expect(relationLabel("p")).toBeUndefined();
  });
});
