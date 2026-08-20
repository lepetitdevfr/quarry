import { describe, expect, it } from "vitest";
import { colourForTag, parseConnectionUrl } from "./connections";

describe("parseConnectionUrl", () => {
  it("fills every field from a full URL", () => {
    expect(parseConnectionUrl("postgres://alice:pw@db.example.com:6432/kolecto")).toEqual({
      host: "db.example.com",
      port: 6432,
      user: "alice",
      dbname: "kolecto",
      sslmode: "prefer",
      password: "pw",
    });
  });

  it("applies postgres defaults for missing parts", () => {
    expect(parseConnectionUrl("postgres:///mydb")).toEqual({
      host: "localhost",
      port: 5432,
      user: "postgres",
      dbname: "mydb",
      sslmode: "prefer",
      password: null,
    });
  });

  it("reads sslmode from the query string", () => {
    const parsed = parseConnectionUrl("postgres://localhost/db?sslmode=require");
    expect(parsed?.sslmode).toBe("require");
  });

  it("maps sslmode=verify-full to verify-full", () => {
    const parsed = parseConnectionUrl("postgres://localhost/db?sslmode=verify-full");
    expect(parsed?.sslmode).toBe("verify-full");
  });

  it("maps sslmode=verify-ca to verify-full", () => {
    const parsed = parseConnectionUrl("postgres://localhost/db?sslmode=verify-ca");
    expect(parsed?.sslmode).toBe("verify-full");
  });

  it("returns null for something that is not a postgres URL", () => {
    expect(parseConnectionUrl("mysql://localhost/db")).toBeNull();
    expect(parseConnectionUrl("not a url")).toBeNull();
  });
});

describe("colourForTag", () => {
  it("gives each tag a distinct default", () => {
    const colours = new Set([
      colourForTag("local"),
      colourForTag("staging"),
      colourForTag("prod"),
    ]);
    expect(colours.size).toBe(3);
  });
});

import { mostRecentlyUsedIndex } from "./connections";

/** Only the field the choice depends on. */
function used(last_used_at: string | null) {
  return { last_used_at };
}

describe("mostRecentlyUsedIndex", () => {
  it("picks the latest timestamp, wherever it sits in the frozen order", () => {
    expect(
      mostRecentlyUsedIndex([
        used("2026-08-01T10:00:00Z"),
        used("2026-08-20T09:00:00Z"),
        used("2026-08-19T23:59:59Z"),
      ]),
    ).toBe(1);
  });

  it("ignores connections that were never used", () => {
    expect(
      mostRecentlyUsedIndex([used(null), used("2026-08-01T10:00:00Z"), used(null)]),
    ).toBe(1);
  });

  it("falls back to the first row when nothing was ever used", () => {
    expect(mostRecentlyUsedIndex([used(null), used(null)])).toBe(0);
  });

  it("does not throw on an empty list", () => {
    expect(mostRecentlyUsedIndex([])).toBe(0);
  });
});
