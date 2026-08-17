import { describe, expect, it } from "vitest";
import { compareVersions, shouldNotify } from "./updates";

describe("compareVersions", () => {
  it("orders by each numeric part, not as text", () => {
    // "0.10.0" sorts before "0.9.0" as a string, which would tell a user
    // on 0.10.0 to downgrade.
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.2.1")).toBeLessThan(0);
  });

  it("ignores a leading v, which release tags carry and versions do not", () => {
    expect(compareVersions("v0.3.0", "0.3.0")).toBe(0);
  });

  it("treats a missing part as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  it("puts a prerelease below its own release", () => {
    // 0.3.0-beta.1 is not 0.3.0. Telling someone on the release to
    // "update" to a prerelease would be a downgrade.
    expect(compareVersions("0.3.0-beta.1", "0.3.0")).toBeLessThan(0);
    expect(compareVersions("0.3.0", "0.3.0-beta.1")).toBeGreaterThan(0);
  });
});

describe("shouldNotify", () => {
  const args = (over: Partial<Parameters<typeof shouldNotify>[0]> = {}) => ({
    current: "0.2.0",
    latest: "0.3.0",
    dismissed: null,
    enabled: true,
    ...over,
  });

  it("notifies about a newer version", () => {
    expect(shouldNotify(args())).toBe(true);
  });

  it("says nothing when already current or ahead", () => {
    expect(shouldNotify(args({ latest: "0.2.0" }))).toBe(false);
    // A dev build can be ahead of the last release; that is not an update.
    expect(shouldNotify(args({ current: "0.4.0" }))).toBe(false);
  });

  it("stays quiet about a version the user dismissed", () => {
    expect(shouldNotify(args({ dismissed: "0.3.0" }))).toBe(false);
  });

  it("speaks up again when a newer one arrives after a dismissal", () => {
    // Dismissing 0.3.0 means "not that one", not "never again".
    expect(shouldNotify(args({ latest: "0.4.0", dismissed: "0.3.0" }))).toBe(true);
  });

  it("says nothing when the check is turned off", () => {
    expect(shouldNotify(args({ enabled: false }))).toBe(false);
  });

  it("says nothing when either version is unreadable", () => {
    // A tag that is not a version at all — better silent than wrong.
    expect(shouldNotify(args({ latest: "nightly" }))).toBe(false);
    expect(shouldNotify(args({ current: "" }))).toBe(false);
  });
});
