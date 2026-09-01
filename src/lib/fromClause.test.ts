import { describe, expect, it } from "vitest";
import { tablesInScope } from "./fromClause";

const ref = (table: string, alias: string | null = null, schema: string | null = null) => ({
  schema,
  table,
  alias,
});

describe("tablesInScope", () => {
  it("reads the one table a simple select names", () => {
    expect(tablesInScope("select * from customers where ")).toEqual([
      ref("customers"),
    ]);
  });

  it("keeps the schema when the statement qualified it", () => {
    expect(tablesInScope("select * from analytics.events")).toEqual([
      ref("events", null, "analytics"),
    ]);
  });

  it("reads an alias, with or without AS", () => {
    expect(tablesInScope("select * from customers c")).toEqual([
      ref("customers", "c"),
    ]);
    expect(tablesInScope("select * from customers as c")).toEqual([
      ref("customers", "c"),
    ]);
  });

  it("does not read the next clause as an alias", () => {
    // `where` follows the table exactly where an alias would.
    expect(tablesInScope("select * from customers where id = 1")).toEqual([
      ref("customers"),
    ]);
    expect(tablesInScope("select * from customers order by id")).toEqual([
      ref("customers"),
    ]);
    expect(tablesInScope("select * from customers limit 10")).toEqual([
      ref("customers"),
    ]);
  });

  it("reads every table in a join", () => {
    expect(
      tablesInScope(
        "select * from customers c join orders o on o.customer_id = c.id",
      ),
    ).toEqual([ref("customers", "c"), ref("orders", "o")]);
  });

  it("reads a left outer join without taking its keywords for names", () => {
    expect(
      tablesInScope("select * from a left outer join b on a.id = b.a_id"),
    ).toEqual([ref("a"), ref("b")]);
  });

  it("reads the comma-separated form", () => {
    expect(tablesInScope("select * from customers c, orders o where ")).toEqual([
      ref("customers", "c"),
      ref("orders", "o"),
    ]);
  });

  it("reads the table an UPDATE and an INSERT name", () => {
    expect(tablesInScope("update customers set name = 'x' where ")).toEqual([
      ref("customers"),
    ]);
    expect(tablesInScope("insert into orders (total) values (1)")).toEqual([
      ref("orders"),
    ]);
    expect(tablesInScope("delete from orders where ")).toEqual([ref("orders")]);
  });

  it("skips a derived table rather than guessing its columns", () => {
    // The columns of a subquery are whatever its SELECT list produced,
    // which the catalog cannot answer.
    expect(
      tablesInScope("select * from (select 1 as n) t join orders o on true"),
    ).toEqual([ref("orders", "o")]);
  });

  it("ignores a FROM inside a comment", () => {
    expect(tablesInScope("select * -- from ghosts\nfrom customers")).toEqual([
      ref("customers"),
    ]);
    expect(tablesInScope("select * /* from /* from */ ghosts */ from customers")).toEqual([
      ref("customers"),
    ]);
  });

  it("ignores a FROM inside a string", () => {
    expect(tablesInScope("select 'from ghosts' from customers")).toEqual([
      ref("customers"),
    ]);
    expect(
      tablesInScope("select $$ from ghosts $$ from customers"),
    ).toEqual([ref("customers")]);
  });

  it("reads a quoted name as a name, never as a keyword", () => {
    // A table really can be called `from`, and its quoting is not part
    // of its name.
    expect(tablesInScope('select * from "Odd Name" x')).toEqual([
      ref("Odd Name", "x"),
    ]);
    expect(tablesInScope('select * from public."from"')).toEqual([
      ref("from", null, "public"),
    ]);
  });

  it("keeps a table joined to itself twice", () => {
    // The aliases are what tell them apart.
    expect(
      tablesInScope("select * from orders o join orders p on o.id = p.parent"),
    ).toEqual([ref("orders", "o"), ref("orders", "p")]);
  });

  it("finds nothing in a statement with no FROM clause", () => {
    expect(tablesInScope("select 1")).toEqual([]);
    expect(tablesInScope("")).toEqual([]);
  });
});
