import { describe, expect, it } from "vitest";
import type { ClipItem } from "@/lib/clip";
import { buildRows, dayLabel, statusOf, stepSelection } from "./model";

const note = (id: string, createdUtc: string, pinned = false): ClipItem => ({
  id,
  kind: "text",
  text: id,
  size: 1,
  createdUtc,
  deviceId: "pc",
  source: "manual",
  pinned,
});

const now = new Date(2026, 9, 30, 15, 0, 0);
const iso = (daysAgo: number, hour = 12) => new Date(2026, 9, 30 - daysAgo, hour).toISOString();

describe("day labels", () => {
  it("names the recent days and dates the rest", () => {
    expect(dayLabel(iso(0), now)).toBe("Today");
    expect(dayLabel(iso(1), now)).toBe("Yesterday");
    expect(dayLabel(iso(3), now)).toMatch(/day$/);
    expect(dayLabel(iso(20), now)).toMatch(/\d/);
  });

  it("goes by the local day, not 24 hours", () => {
    expect(dayLabel(new Date(2026, 9, 29, 23, 30).toISOString(), new Date(2026, 9, 30, 0, 30))).toBe("Yesterday");
  });

  it("survives a bad timestamp", () => {
    expect(dayLabel("nonsense", now)).toBe("Earlier");
  });
});

describe("rows", () => {
  it("puts pinned notes first and heads each day", () => {
    const rows = buildRows([note("p", iso(9), true)], [note("a", iso(0)), note("b", iso(0, 9)), note("c", iso(1))], now);
    expect(rows.map((r) => (r.kind === "label" ? `#${r.text}` : r.key))).toEqual(["#Pinned", "p", "#Today", "a", "b", "#Yesterday", "c"]);
  });

  it("has unique keys", () => {
    const rows = buildRows([note("p", iso(0), true)], [note("a", iso(0))], now);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it("is empty for no notes", () => {
    expect(buildRows([], [], now)).toEqual([]);
  });
});

describe("selection", () => {
  const rows = buildRows([], [note("a", iso(0)), note("b", iso(0)), note("c", iso(1))], now);

  it("starts at the near end", () => {
    expect(stepSelection(rows, null, 1)).toBe("a");
    expect(stepSelection(rows, null, -1)).toBe("c");
  });

  it("steps over day labels and stops at the ends", () => {
    expect(stepSelection(rows, "b", 1)).toBe("c");
    expect(stepSelection(rows, "c", 1)).toBe("c");
    expect(stepSelection(rows, "a", -1)).toBe("a");
  });

  it("has nothing to pick in an empty list", () => {
    expect(stepSelection([], null, 1)).toBeNull();
  });
});

describe("sync pill", () => {
  const at = 1_000_000;
  const report = (over: Record<string, unknown>) => ({ started: "true", wsState: "open", updatedMs: at, ...over });

  it("says when sync is off", () => {
    expect(statusOf(null, at).tone).toBe("off");
    expect(statusOf(report({ started: "false" }), at).tone).toBe("off");
  });

  it("counts devices only when there's more than one", () => {
    expect(statusOf(report({ deviceCount: 1 }), at).text).toBe("Synced");
    expect(statusOf(report({ deviceCount: 3 }), at).text).toBe("Synced · 3 devices");
  });

  it("doesn't trust a report that has stopped arriving", () => {
    expect(statusOf(report({ updatedMs: at - 60_000 }), at)).toEqual({ text: "Sync paused", tone: "warn" });
  });

  it("tells connecting from failing", () => {
    expect(statusOf(report({ wsState: "connecting", lastError: "(none)" }), at).tone).toBe("wait");
    expect(statusOf(report({ wsState: "closed", lastError: "boom" }), at).tone).toBe("warn");
  });
});
