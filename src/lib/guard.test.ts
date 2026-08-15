import { describe, expect, it } from "vitest";
import { formatCountdown } from "./guard";

describe("formatCountdown", () => {
  it("formats minutes and seconds", () => {
    expect(formatCountdown(1800)).toBe("30:00");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(9)).toBe("0:09");
  });

  it("never shows a negative time", () => {
    // The banner ticks locally between polls, so it can run past the
    // real deadline. Showing "-0:03" would look broken; the server is
    // the authority either way.
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});
