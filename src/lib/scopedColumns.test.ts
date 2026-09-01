import { CompletionContext } from "@codemirror/autocomplete";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { scopedColumnSource } from "./scopedColumns";
import type { Schema } from "../types";

const column = (name: string, type_name = "text", is_primary_key = false) => ({
  name,
  type_name,
  nullable: true,
  default: null,
  is_primary_key,
  references: null,
});

const table = (name: string, columns: string[]) => ({
  schema: "public",
  name,
  columns: columns.map((c) => column(c, "text", c === "id")),
  indexes: [],
  constraints: [],
  stats: null,
  comment: null,
  triggers: [],
  dependents: [],
  kind: "r",
  definition: null,
});

const SCHEMA: Schema = {
  schemas: [
    {
      name: "public",
      tables: [
        table("customers", ["id", "name", "email"]),
        table("orders", ["id", "customer_id", "total"]),
      ],
    },
  ],
};

/**
 * Run the source against a document, with `|` marking the cursor.
 *
 * A real `EditorState` carrying the same lang-sql extension the editor
 * builds, because what the source does depends on the document around
 * the cursor and mocking that would be testing the mock.
 */
function complete(marked: string, explicit = true) {
  const pos = marked.indexOf("|");
  const doc = marked.replace("|", "");
  const state = EditorState.create({
    doc,
    extensions: [sql({ dialect: PostgreSQL, defaultSchema: "public" })],
  });
  return scopedColumnSource(SCHEMA)(new CompletionContext(state, pos, explicit));
}

describe("scopedColumnSource", () => {
  it("offers the columns of the table a WHERE is written against", () => {
    // The complaint this exists for: lang-sql answers here with the
    // name of every table in the database and no column at all.
    const result = complete("select * from customers where |");
    expect(result?.options.map((o) => o.label)).toEqual([
      "id",
      "name",
      "email",
    ]);
  });

  it("offers them while the column name is being typed", () => {
    const result = complete("select * from customers where na|", false);
    // The source does not filter — CodeMirror does, against `from`.
    expect(result?.from).toBe("select * from customers where ".length);
    expect(result?.options.map((o) => o.label)).toContain("name");
  });

  it("offers columns in the select list, which is written before the FROM", () => {
    const result = complete("select | from customers");
    expect(result?.options.map((o) => o.label)).toEqual([
      "id",
      "name",
      "email",
    ]);
  });

  it("says nothing after a qualifier, which lang-sql already answers", () => {
    // Both sources answering would offer every column twice.
    expect(complete("select * from customers c where c.|")).toBeNull();
  });

  it("says nothing on an empty word unless asked", () => {
    expect(complete("select * from customers where |", false)).toBeNull();
    expect(complete("select * from customers where |", true)).not.toBeNull();
  });

  it("says nothing when the statement names no table it knows", () => {
    expect(complete("select * from ghosts where |")).toBeNull();
    expect(complete("select |")).toBeNull();
  });

  it("qualifies its insertions once a join puts two tables in scope", () => {
    const result = complete(
      "select * from customers c join orders o on o.customer_id = c.id where |",
    );
    expect(result?.options.map((o) => o.apply)).toEqual([
      "c.id",
      "c.name",
      "c.email",
      "o.id",
      "o.customer_id",
      "o.total",
    ]);
  });

  it("reads the statement under the cursor, not the whole buffer", () => {
    // Two statements in one tab: the one being typed is the one whose
    // tables are in scope.
    const result = complete(
      "select * from orders;\nselect * from customers where |",
    );
    expect(result?.options.map((o) => o.label)).toEqual([
      "id",
      "name",
      "email",
    ]);
  });
});
