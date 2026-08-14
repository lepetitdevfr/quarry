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
