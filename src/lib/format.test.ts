import { describe, expect, it } from "vitest";
import { initials, relativeTime, dateLabel } from "./format";

describe("initials", () => {
  it("returns ? for empty or symbol-only names", () => {
    expect(initials("")).toBe("?");
    expect(initials("***")).toBe("?");
    expect(initials("   ")).toBe("?");
  });

  it("handles single-word names", () => {
    expect(initials("Halo")).toBe("HA");
  });

  it("handles multi-word names", () => {
    expect(initials("Hollow Knight")).toBe("HK");
  });

  it("does not throw on edge-case catalog entries", () => {
    expect(() => initials("")).not.toThrow();
    expect(() => initials("!@#")).not.toThrow();
  });
});

describe("relativeTime", () => {
  it("returns Never for missing dates", () => {
    expect(relativeTime(null)).toBe("Never");
    expect(relativeTime(undefined)).toBe("Never");
    expect(relativeTime("not-a-date")).toBe("Never");
  });
});

describe("dateLabel", () => {
  it("returns em dash for invalid dates", () => {
    expect(dateLabel(null)).toBe("—");
    expect(dateLabel("bad")).toBe("—");
  });
});
