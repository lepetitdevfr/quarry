import { describe, expect, it } from "vitest";
import { toCsv, toJson, toSqlInsert, toTsv } from "./exportRows";
import type { CellValue, ColumnMeta } from "../types";
import { UNKNOWN } from "../types";

const COLUMNS: ColumnMeta[] = [
  { name: "id", type_name: "int4" },
  { name: "name", type_name: "text" },
];

describe("toTsv", () => {
  it("separates cells with tabs and rows with newlines", () => {
    const rows: CellValue[][] = [
      [1, "alice"],
      [2, "bob"],
    ];
    expect(toTsv(COLUMNS, rows, false)).toBe("1\talice\n2\tbob");
  });

  it("includes a header row when asked", () => {
    expect(toTsv(COLUMNS, [[1, "alice"]], true)).toBe("id\tname\n1\talice");
  });

  it("writes an empty field for null, not the word NULL", () => {
    // `formatCell` renders null as the string "NULL" for display. In a
    // paste target that is indistinguishable from a real value.
    expect(toTsv(COLUMNS, [[1, null]], false)).toBe("1\t");
  });

  it("is empty for no rows", () => {
    expect(toTsv(COLUMNS, [], false)).toBe("");
  });
});

describe("toCsv", () => {
  it("always writes a header row", () => {
    expect(toCsv(COLUMNS, [[1, "alice"]])).toBe("id,name\n1,alice");
  });

  it("quotes a field containing a comma", () => {
    expect(toCsv(COLUMNS, [[1, "Smith, Alice"]])).toBe(
      'id,name\n1,"Smith, Alice"',
    );
  });

  it("quotes and doubles an embedded quote", () => {
    // RFC 4180: the escape for " is "".
    expect(toCsv(COLUMNS, [[1, 'say "hi"']])).toBe('id,name\n1,"say ""hi"""');
  });

  it("quotes a field containing a newline", () => {
    expect(toCsv(COLUMNS, [[1, "line1\nline2"]])).toBe(
      'id,name\n1,"line1\nline2"',
    );
  });

  it("writes an empty field for null", () => {
    expect(toCsv(COLUMNS, [[1, null]])).toBe("id,name\n1,");
  });

  it("writes booleans and numbers bare", () => {
    const cols: ColumnMeta[] = [
      { name: "n", type_name: "int4" },
      { name: "ok", type_name: "bool" },
    ];
    expect(toCsv(cols, [[42, true]])).toBe("n,ok\n42,true");
  });

  it("serializes json as its JSON text", () => {
    const cols: ColumnMeta[] = [{ name: "meta", type_name: "jsonb" }];
    expect(toCsv(cols, [[{ a: 1 }]])).toBe('meta\n"{""a"":1}"');
  });

  it("writes only headers for no rows", () => {
    expect(toCsv(COLUMNS, [])).toBe("id,name");
  });
});

describe("toJson", () => {
  it("writes an array of objects keyed by column name", () => {
    const rows: CellValue[][] = [[1, "alice"]];
    expect(JSON.parse(toJson(COLUMNS, rows))).toEqual([
      { id: 1, name: "alice" },
    ]);
  });

  it("writes a real null, not the string NULL", () => {
    expect(JSON.parse(toJson(COLUMNS, [[1, null]]))).toEqual([
      { id: 1, name: null },
    ]);
  });

  it("keeps json values as structure, not as a string", () => {
    const cols: ColumnMeta[] = [{ name: "meta", type_name: "jsonb" }];
    expect(JSON.parse(toJson(cols, [[{ a: 1 }]]))).toEqual([
      { meta: { a: 1 } },
    ]);
  });

  it("is an empty array for no rows", () => {
    expect(JSON.parse(toJson(COLUMNS, []))).toEqual([]);
  });
});

describe("unknown cell", () => {
  it("exports an unknown cell as an empty field, like a null", () => {
    // It must never reach String(), which would ship "Symbol(unknown)"
    // into a user's CSV.
    expect(toCsv([{ name: "a", type_name: "text" }], [[UNKNOWN]])).toBe(
      "a\n",
    );
    expect(toTsv([{ name: "a", type_name: "text" }], [[UNKNOWN]], false)).toBe(
      "",
    );
    expect(toJson([{ name: "a", type_name: "text" }], [[UNKNOWN]])).toContain(
      '"a": null',
    );
  });
});

describe("toSqlInsert", () => {
  it("writes one INSERT per row with quoted identifiers", () => {
    const sql = toSqlInsert("public", "users", COLUMNS, [[1, "alice"]]);
    expect(sql).toBe(
      `insert into "public"."users" ("id", "name") values (1, 'alice');`,
    );
  });

  it("escapes a single quote by doubling it", () => {
    // The injection-shaped case. A value like O'Brien must not end the
    // string literal.
    const sql = toSqlInsert("public", "users", COLUMNS, [[1, "O'Brien"]]);
    expect(sql).toBe(
      `insert into "public"."users" ("id", "name") values (1, 'O''Brien');`,
    );
  });

  it("does not let a value close the statement", () => {
    const nasty = "'); drop table users; --";
    const sql = toSqlInsert("public", "users", COLUMNS, [[1, nasty]]);
    expect(sql).toBe(
      `insert into "public"."users" ("id", "name") values (1, '''); drop table users; --');`,
    );
    // The payload's own two semicolons plus the statement terminator: all
    // three stayed inside the literal rather than one becoming a real
    // statement boundary.
    expect(sql.match(/;/g)).toHaveLength(3);
  });

  it("quotes an identifier that needs it", () => {
    const cols: ColumnMeta[] = [{ name: "Order Id", type_name: "int4" }];
    const sql = toSqlInsert("public", "Order", cols, [[1]]);
    expect(sql).toBe(
      `insert into "public"."Order" ("Order Id") values (1);`,
    );
  });

  it("writes numbers, booleans and nulls bare", () => {
    const cols: ColumnMeta[] = [
      { name: "n", type_name: "int4" },
      { name: "ok", type_name: "bool" },
      { name: "gone", type_name: "text" },
    ];
    const sql = toSqlInsert("public", "t", cols, [[42, true, null]]);
    expect(sql).toBe(
      `insert into "public"."t" ("n", "ok", "gone") values (42, true, NULL);`,
    );
  });

  it("writes json as a quoted string literal", () => {
    const cols: ColumnMeta[] = [{ name: "meta", type_name: "jsonb" }];
    const sql = toSqlInsert("public", "t", cols, [[{ a: "x" }]]);
    expect(sql).toBe(
      `insert into "public"."t" ("meta") values ('{"a":"x"}');`,
    );
  });

  it("separates rows with newlines", () => {
    const sql = toSqlInsert("public", "users", COLUMNS, [
      [1, "a"],
      [2, "b"],
    ]);
    expect(sql.split("\n")).toHaveLength(2);
  });

  it("is empty for no rows", () => {
    expect(toSqlInsert("public", "users", COLUMNS, [])).toBe("");
  });
});
