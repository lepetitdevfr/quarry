import { describe, expect, it } from "vitest";
import { toCsv, toTsv } from "./exportRows";
import type { CellValue, ColumnMeta } from "../types";

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
