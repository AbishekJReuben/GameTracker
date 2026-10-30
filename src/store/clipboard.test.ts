import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipItem } from "@/lib/clip";

const api = vi.hoisted(() => ({ changes: vi.fn(), tags: vi.fn(async () => []), search: vi.fn(), pinned: vi.fn(async () => []), list: vi.fn(async () => []), setPinned: vi.fn(async () => {}) }));
vi.mock("@/lib/clip", () => ({ clip: api }));
import { mergeChanges, useClipboard, visibleClips } from "./clipboard";

const note = (id: string, createdUtc: string, extra: Partial<ClipItem> = {}): ClipItem => ({ id, kind: "text", text: id, size: 0, createdUtc, deviceId: "pc", source: "desktop", pinned: false, ...extra });

describe("mergeChanges", () => {
  const items = [note("c", "2026-10-03"), note("b", "2026-10-02")];

  it("puts a new note first and leaves the rest alone", () => {
    expect(mergeChanges(items, [], [note("d", "2026-10-04")]).items.map((i) => i.id)).toEqual(["d", "c", "b"]);
  });
  it("drops tombstones from both lists", () => {
    const merged = mergeChanges(items, [note("c", "2026-10-03", { pinned: true })], [note("c", "2026-10-03", { deleted: true })]);
    expect(merged.items.map((i) => i.id)).toEqual(["b"]);
    expect(merged.pinned).toEqual([]);
  });
  it("moves a note between the pinned list and back", () => {
    const pinned = mergeChanges(items, [], [note("b", "2026-10-02", { pinned: true })]);
    expect(pinned.pinned.map((i) => i.id)).toEqual(["b"]);
    expect(pinned.items.map((i) => i.id)).toEqual(["c", "b"]);
    expect(mergeChanges(pinned.items, pinned.pinned, [note("b", "2026-10-02")]).pinned).toEqual([]);
  });
  it("leaves a change older than the loaded pages for paging to find", () => {
    expect(mergeChanges(items, [], [note("a", "2026-10-01")]).items.map((i) => i.id)).toEqual(["c", "b"]);
  });
  it("replaces an edited note instead of duplicating it", () => {
    const merged = mergeChanges(items, [], [note("b", "2026-10-05", { text: "edited" })]);
    expect(merged.items.map((i) => [i.id, i.text])).toEqual([["b", "edited"], ["c", "c"]]);
  });
});

describe("visibleClips with search results", () => {
  it("shows database hits, which match on text the store doesn't hold", () => {
    const hit = note("deep", "2026-10-01", { text: "first 8 KB without the word" });
    const s = { items: [note("x", "2026-10-02")], pinned: [], filter: "all" as const, search: "needle", results: [hit] };
    expect(visibleClips(s).rest.map((i) => i.id)).toEqual(["deep"]);
  });
  it("still applies the other filters to them", () => {
    const s = { items: [], pinned: [], filter: "image" as const, search: "needle", results: [note("deep", "2026-10-01")] };
    expect(visibleClips(s).rest).toEqual([]);
  });
});

describe("sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useClipboard.setState({ items: [], pinned: [], rev: 5, search: "", results: null });
  });

  it("collapses a burst of notices into one more pass", async () => {
    let release = () => {};
    api.changes.mockImplementationOnce(() => new Promise((r) => { release = () => r({ rev: 6, reload: false, items: [note("a", "2026-10-01")] }); }));
    api.changes.mockResolvedValue({ rev: 7, reload: false, items: [] });
    const first = useClipboard.getState().sync();
    for (let i = 0; i < 20; i++) void useClipboard.getState().sync();
    release();
    await first;
    expect(api.changes).toHaveBeenCalledTimes(2);
    expect(useClipboard.getState().rev).toBe(7);
  });
  it("reloads when too much changed to merge", async () => {
    api.changes.mockResolvedValueOnce({ rev: 900, reload: true, items: [] });
    api.changes.mockResolvedValue({ rev: 900, reload: false, items: [] });
    await useClipboard.getState().sync();
    expect(api.list).toHaveBeenCalled();
  });
});
