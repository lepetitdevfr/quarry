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
