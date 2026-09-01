import { describe, expect, it } from "vitest";
import {
  buildCompletionSchema,
  flattenSchema,
  matchesFilter,
  previewSql,
  quoteIdent,
} from "./schema";
import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
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
          stats: { estimated_rows: 1234, total_bytes: 8192 },
          comment: "people",
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
  // The namespace is `{[path]: {self, children}}`, which is what lets a
  // table entry carry its own metadata instead of the bare name
  // lang-sql would synthesise.
  type Built = Record<string, { self: Completion; children: Completion[] }>;
  const built = () => buildCompletionSchema(SCHEMA) as Built;
  const labels = (columns: Completion[]) => columns.map((c) => c.label);

  it("maps qualified table names to their columns", () => {
    expect(labels(built()["public.users"].children)).toEqual(["id", "email"]);
    expect(labels(built()["analytics.events"].children)).toEqual(["user_id"]);
  });

  it("also exposes public tables unqualified", () => {
    // `public` is on the default search path, so `users` must complete
    // without typing `public.`.
    expect(labels(built()["users"].children)).toEqual(["id", "email"]);
  });

  it("exposes a non-public table unqualified when the name is unique", () => {
    // This reverses an earlier decision to qualify everything outside
    // `public`. In practice a WHERE clause refers to the table by its
    // bare name — `from analytics.events where events.user_id ...` —
    // which is ordinary SQL, and completing nothing there was the more
    // surprising behaviour of the two.
    expect(labels(built()["events"].children)).toEqual(["user_id"]);
    expect(labels(built()["analytics.events"].children)).toEqual(["user_id"]);
  });

  it("returns an empty object for a null schema", () => {
    expect(buildCompletionSchema(null)).toEqual({});
  });

  it("puts a column's type in the detail line", () => {
    const [id, email] = built()["public.users"].children;
    expect(id.detail).toBe("int4 pk");
    expect(email.detail).toBe("text");
  });

  it("names what a foreign key points at", () => {
    const [userId] = built()["analytics.events"].children;
    // Cross-schema, so the schema is kept: `users.id` alone would be
    // ambiguous from inside `analytics`.
    expect(userId.detail).toBe("int4 pk → public.users.id");
  });

  it("puts nullability and defaults in the info panel, not the line", () => {
    const [id, email] = built()["public.users"].children;
    expect(id.info).toBe("not null");
    expect(email.info).toBe("not null");
    const [total] = built()["public.invoices"].children;
    expect(total.detail).toBe("numeric");
    expect(total.info).toBeUndefined();
  });

  it("offers keys before ordinary columns", () => {
    const [id, email] = built()["public.users"].children;
    expect(id.boost).toBeGreaterThan(email.boost ?? 0);
    const [userId] = built()["analytics.events"].children;
    // A primary key that is also a foreign key is still a primary key.
    expect(userId.boost).toBe(2);
  });

  it("labels a view and leaves an ordinary table unlabelled", () => {
    expect(built()["public.paid_invoices"].self.detail).toBe("view");
    expect(built()["public.users"].self.detail).toBeUndefined();
  });

  it("describes a table by its comment and size", () => {
    expect(built()["public.users"].self.info).toBe("people — ~1,234 rows, 8.2 kB");
    expect(built()["public.invoices"].self.info).toBeUndefined();
  });

  it("sorts a bare non-public name below the public tables it joins", () => {
    // An unqualified name resolves through search_path, which reaches
    // public first, so that is the table being offered first.
    expect(built()["events"].self.boost).toBe(-1);
    expect(built()["users"].self.boost).toBe(1);
    // Qualified, there is nothing to disambiguate.
    expect(built()["analytics.events"].self.boost).toBe(0);
  });

  it("quotes a name that would not read back as itself", () => {
    // lang-sql quotes for us only when it builds the completion itself,
    // which it no longer does for anything here. Neither name below
    // reads back unquoted: one has a capital and a space, the other is
    // a reserved word.
    const [id] = built()["public.users"].children;
    expect(id.apply).toBeUndefined();

    const awkward = buildCompletionSchema({
      schemas: [
        {
          name: "public",
          tables: [
            {
              ...SCHEMA.schemas[0].tables[0],
              name: "Odd Name",
              columns: [
                { ...SCHEMA.schemas[0].tables[0].columns[0], name: "user" },
              ],
            },
          ],
        },
      ],
    }) as Built;

    expect(awkward["public.Odd Name"].children[0].apply).toBe('"user"');
    expect(awkward["public.Odd Name"].self.apply).toBe('"Odd Name"');
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
  it("qualifies the table and quotes nothing that does not need it", () => {
    // The statement is shown to the user, edited by them, and run. Every
    // pair of quotes it does not need is noise in SQL nobody would type.
    expect(previewSql("public", "users")).toBe(
      "select * from public.users limit 500",
    );
  });

  it("quotes a name that would resolve to something else unquoted", () => {
    // Postgres folds an unquoted identifier to lower case, so `Order`
    // bare finds `order` — a different table, or none.
    expect(previewSql("public", "Order")).toBe(
      'select * from public."Order" limit 500',
    );
  });

  it("quotes a reserved word", () => {
    // `select * from public.order` does not parse at all.
    expect(previewSql("public", "order")).toBe(
      'select * from public."order" limit 500',
    );
    expect(previewSql("user", "t")).toBe(
      'select * from "user".t limit 500',
    );
  });

  it("quotes a name that is not a bare identifier at all", () => {
    expect(previewSql("public", "two words")).toBe(
      'select * from public."two words" limit 500',
    );
    expect(previewSql("public", "2023_totals")).toBe(
      'select * from public."2023_totals" limit 500',
    );
  });

  it("escapes an embedded double quote", () => {
    // Legal in Postgres, and the only way this builds broken SQL.
    expect(previewSql("public", 'we"ird')).toBe(
      'select * from public."we""ird" limit 500',
    );
  });

  it("appends an ORDER BY before the limit", () => {
    // Order must precede limit, or the database sorts the page rather
    // than the table — which is the entire point of re-running.
    expect(
      previewSql("public", "users", { column: "created_at", direction: "asc" }),
    ).toBe("select * from public.users order by created_at asc limit 500");
  });

  it("sorts descending", () => {
    expect(
      previewSql("public", "users", { column: "id", direction: "desc" }),
    ).toBe("select * from public.users order by id desc limit 500");
  });

  it("quotes a column name that needs it", () => {
    // A mixed-case or reserved-word column is unreachable unquoted, and
    // an embedded quote must be doubled or the statement is malformed.
    expect(
      previewSql("public", "users", { column: 'we"ird', direction: "asc" }),
    ).toBe('select * from public.users order by "we""ird" asc limit 500');
    expect(
      previewSql("public", "users", { column: "end", direction: "asc" }),
    ).toBe('select * from public.users order by "end" asc limit 500');
  });
});

describe("quoteIdent", () => {
  it("leaves an ordinary lower-case name alone", () => {
    expect(quoteIdent("orders")).toBe("orders");
    expect(quoteIdent("order_items_2")).toBe("order_items_2");
    expect(quoteIdent("_private")).toBe("_private");
  });

  it("quotes anything Postgres would read differently", () => {
    expect(quoteIdent("Orders")).toBe('"Orders"');
    expect(quoteIdent("select")).toBe('"select"');
    expect(quoteIdent("with space")).toBe('"with space"');
    expect(quoteIdent("1st")).toBe('"1st"');
    expect(quoteIdent("")).toBe('""');
  });

  it("does not quote a keyword Postgres accepts as a name", () => {
    // The reserved list, not every keyword: quoting `name` or `value`
    // would put the noise back for words Postgres reads happily.
    expect(quoteIdent("name")).toBe("name");
    expect(quoteIdent("value")).toBe("value");
    expect(quoteIdent("type")).toBe("type");
  });
});

describe("buildCompletionSchema unqualified names", () => {
  // Only which tables are reachable by which name matters here, so the
  // metadata each entry carries is read off as a plain column list.
  const columns = (namespace: SQLNamespace, path: string) =>
    (namespace as Record<string, { children: Completion[] } | undefined>)[
      path
    ]?.children.map((c) => c.label);

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

    expect(columns(built, "od_pdp.invoice")).toEqual(["id", "reason"]);
    expect(columns(built, "invoice")).toEqual(["id", "reason"]);
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

    expect(columns(built, "invoice")).toEqual(["total"]);
    expect(columns(built, "od_pdp.invoice")).toEqual(["reason"]);
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

    expect(columns(built, "invoice")).toBeUndefined();
    expect(columns(built, "a.invoice")).toEqual(["x"]);
    expect(columns(built, "b.invoice")).toEqual(["y"]);
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
