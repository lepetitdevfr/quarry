import { describe, expect, it } from "vitest";
import { asAppError } from "./errors";

describe("asAppError", () => {
  it("passes a real backend error object through unchanged", () => {
    const payload = {
      kind: "query",
      message: "relation does not exist",
      code: "42P01",
      position: 15,
    };
    expect(asAppError(payload)).toEqual(payload);
  });

  it("wraps a thrown string", () => {
    expect(asAppError("boom")).toEqual({
      kind: "connection",
      message: "boom",
      code: null,
      position: null,
    });
  });

  it("extracts the message from a thrown Error instance, without the 'Error: ' prefix", () => {
    expect(asAppError(new Error("boom"))).toEqual({
      kind: "connection",
      message: "boom",
      code: null,
      position: null,
    });
  });

  it("does not throw on null and stringifies it", () => {
    expect(asAppError(null)).toEqual({
      kind: "connection",
      message: "null",
      code: null,
      position: null,
    });
  });

  it("does not throw on undefined and stringifies it", () => {
    expect(asAppError(undefined)).toEqual({
      kind: "connection",
      message: "undefined",
      code: null,
      position: null,
    });
  });
});

import { hintFor } from "./errors";

/** The payload shape a Postgres failure arrives in. */
function queryError(message: string, code: string | null) {
  return { kind: "query" as const, message, code, position: null };
}

describe("hintFor", () => {
  it("teaches ⌘↵ on the multi-statement refusal", () => {
    const hint = hintFor(
      queryError(
        "cannot insert multiple commands into a prepared statement",
        "42601",
      ),
    );
    expect(hint).toContain("⌘↵");
    expect(hint).toContain("one statement at a time");
  });

  it("does not hint on other syntax errors sharing the SQLSTATE", () => {
    // 42601 is all of syntax_error. A hint about running one statement
    // on a plain typo would be advice for a problem the user does not
    // have.
    expect(hintFor(queryError('syntax error at or near "slect"', "42601"))).toBe(
      null,
    );
  });

  it("does not hint on an ordinary failure", () => {
    expect(
      hintFor(queryError('relation "usres" does not exist', "42P01")),
    ).toBe(null);
  });

  it("does not hint on an error with no SQLSTATE at all", () => {
    expect(hintFor(queryError("connection closed", null))).toBe(null);
  });
});
