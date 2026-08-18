import { describe, expect, it } from "vitest";
import { statementAt, statementRangeAt } from "./statements";

describe("statementAt: semicolons that are not separators", () => {
  it("ignores a semicolon inside a string literal", () => {
    const sql = "select 'a;b'";
    expect(statementAt(sql, 5)).toBe(sql);
  });

  it("ignores a semicolon inside a doubled-quote-escaped literal", () => {
    const sql = "select 'it''s; here'";
    expect(statementAt(sql, 5)).toBe(sql);
  });

  it("ignores a backslash-escaped quote in an E string, and its semicolon", () => {
    const sql = "select e'a\\';b'";
    expect(statementAt(sql, 5)).toBe(sql);
  });

  it("ignores a semicolon inside a quoted identifier", () => {
    const sql = 'select "odd;name" from t';
    expect(statementAt(sql, 5)).toBe(sql);
  });

  it("ignores a semicolon inside a doubled-quote-escaped identifier", () => {
    const sql = 'select "a""b;c" from t';
    expect(statementAt(sql, 5)).toBe(sql);
  });

  it("ignores a semicolon inside a line comment", () => {
    const sql = "select 1 -- a; comment";
    expect(statementAt(sql, 5)).toBe(sql);
  });

  it("ignores a semicolon inside a block comment", () => {
    const sql = "select 1 /* a; b */";
    expect(statementAt(sql, 5)).toBe(sql);
  });

  it("ignores a semicolon inside a nested block comment", () => {
    // Postgres block comments nest, unlike C: the first `*/` only
    // closes the innermost comment, not the whole thing.
    const sql = "select 1 /* a /* b; */ c */";
    expect(statementAt(sql, 5)).toBe(sql);
  });

  it("ignores a semicolon inside a dollar-quoted body", () => {
    const sql =
      "create function f() returns int as $$ begin return 1; end $$ language plpgsql";
    expect(statementAt(sql, 5)).toBe(sql);
  });

  it("ignores a semicolon inside a tagged dollar-quoted body", () => {
    const sql = "select f() as $fn$ select 1; $fn$ from t";
    expect(statementAt(sql, 5)).toBe(sql);
  });

  it("treats $1 as a parameter, not a dollar-quote opener", () => {
    const sql = "select $1; select 2";
    expect(statementAt(sql, 0)).toBe("select $1");
  });

  it("treats a$b as an identifier, not a dollar-quote opener", () => {
    const sql = "select a$b; select 2";
    expect(statementAt(sql, 0)).toBe("select a$b");
  });
});

describe("statementAt: cursor position", () => {
  const sql = "select 1; select 2; select 3";
  // offsets: "select 1;" is 0-8 (semicolon at 8), " select 2;" runs to
  // 19 (semicolon at 18), then " select 3" to the end (28).

  it("returns the statement the cursor is inside", () => {
    expect(statementAt(sql, 13)).toBe("select 2");
  });

  it("returns the statement when the cursor is on its terminating semicolon", () => {
    expect(statementAt(sql, 8)).toBe("select 1");
  });

  it("returns the preceding statement when the cursor is in whitespace between statements", () => {
    expect(statementAt(sql, 9)).toBe("select 1");
  });

  it("returns the preceding statement when the cursor is in a comment between statements", () => {
    const withComment = "select 1; -- note\nselect 2";
    expect(statementAt(withComment, 12)).toBe("select 1");
  });

  it("returns the first statement when the cursor is before it", () => {
    expect(statementAt(sql, 0)).toBe("select 1");
  });

  it("returns the last statement when the cursor is after a trailing semicolon", () => {
    const trailing = "select 1; select 2;";
    expect(statementAt(trailing, trailing.length)).toBe("select 2");
  });

  it("returns empty string for an empty buffer", () => {
    expect(statementAt("", 0)).toBe("");
  });

  it("returns empty string for a buffer holding only comments", () => {
    expect(statementAt("-- just a comment\n/* and a block one */", 5)).toBe(
      "",
    );
  });

  it("returns the whole buffer trimmed when there is no semicolon at all", () => {
    expect(statementAt("  select 1  ", 3)).toBe("select 1");
  });

  it("clamps an out-of-range cursor rather than throwing", () => {
    expect(() => statementAt(sql, -5)).not.toThrow();
    expect(statementAt(sql, -5)).toBe("select 1");
    expect(() => statementAt(sql, 1000)).not.toThrow();
    expect(statementAt(sql, 1000)).toBe("select 3");
  });
});

describe("statementRangeAt", () => {
  it("reports where the statement it returns begins", () => {
    const text = "select 1;\nselect 2;";
    const second = statementRangeAt(text, 12);
    expect(second.sql).toBe("select 2");
    // "select 1;\n" is ten characters, so the second statement starts
    // at ten — not at nine, which is where the raw segment starts
    // before its leading newline is trimmed off.
    expect(second.start).toBe(10);
    expect(text.slice(second.start, second.start + 6)).toBe("select");
  });

  it("skips leading whitespace and comments the way the trim does", () => {
    const text = "  -- a note\n  select 42;";
    const only = statementRangeAt(text, text.length);
    expect(only.sql).toBe("-- a note\n  select 42");
    expect(only.start).toBe(2);
    expect(text.slice(only.start, only.start + 2)).toBe("--");
  });

  it("agrees with statementAt on the statement itself", () => {
    const text = "select 1;\n\nselect 2;\n";
    for (const cursor of [0, 5, 9, 11, 15, 20, text.length]) {
      expect(statementRangeAt(text, cursor).sql).toBe(statementAt(text, cursor));
    }
  });

  it("has nothing to point at in an empty buffer", () => {
    expect(statementRangeAt("   \n  ", 2)).toEqual({ sql: "", start: 0 });
  });
});
