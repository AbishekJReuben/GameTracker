import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); vi.useFakeTimers({ toFake: ["performance"] }); });
afterEach(() => {
  delete window.__GT_DECODER__; delete window.__GT_DECODER_BINARY__;
  vi.useRealTimers();
});

describe("binary native decoder feed", () => {
  const bytes = new Uint8Array([0, 0, 1, 5]);
  function bridge() {
    const b = { postMessage: vi.fn(), onmessage: null as ((e: { data: string }) => void) | null };
    window.__GT_DECODER_BINARY__ = b;
    window.__GT_DECODER__ = { feed: vi.fn(), disableBinary: vi.fn() };
    return b;
  }

  it("uses binary without calling the Base64 bridge and bounds unacknowledged sends", async () => {
    const b = bridge(); const { feedNativeDecoder } = await import("./nativeDecoder");
    for (let i = 0; i < 4; i++) expect(feedNativeDecoder(i, i === 0, bytes)).toBe(true);
    expect(feedNativeDecoder(4, false, bytes)).toBe(false);
    expect(b.postMessage).toHaveBeenCalledTimes(4);
    expect(window.__GT_DECODER__!.feed).not.toHaveBeenCalled();
    b.onmessage!({ data: "0:ok" });
    expect(feedNativeDecoder(5, true, bytes)).toBe(true);
  });

  it("holds dependent frames after native rejection, until a keyframe", async () => {
    const b = bridge(); const { feedNativeDecoder } = await import("./nativeDecoder");
    feedNativeDecoder(0, true, bytes); b.onmessage!({ data: "0:key" });
    expect(feedNativeDecoder(1, false, bytes)).toBe(false);
    expect(feedNativeDecoder(2, true, bytes)).toBe(true);
    b.onmessage!({ data: "0:ok" });
    expect(feedNativeDecoder(3, false, bytes)).toBe(true);
  });

  it("ignores acknowledgements delayed from a retired native session", async () => {
    const b = bridge(); const { feedNativeDecoder } = await import("./nativeDecoder");
    for (let i = 0; i < 4; i++) feedNativeDecoder(i, true, bytes);
    b.onmessage!({ data: "4294967295:ok" });
    expect(feedNativeDecoder(4, true, bytes)).toBe(false);
    b.onmessage!({ data: "0:ok" });
    expect(feedNativeDecoder(5, true, bytes)).toBe(true);
  });

  it("does not let a late refusal invalidate a newer recovery IDR in transit", async () => {
    const b = bridge(); const { feedNativeDecoder } = await import("./nativeDecoder");
    feedNativeDecoder(0, false, bytes); feedNativeDecoder(1, true, bytes);
    b.onmessage!({ data: "0:key" });
    expect(feedNativeDecoder(2, false, bytes)).toBe(true);
    b.onmessage!({ data: "0:ok" });
    expect(feedNativeDecoder(3, false, bytes)).toBe(true);
  });

  it("retires a broken binary bridge before falling back on a fresh IDR", async () => {
    const b = bridge(); const { feedNativeDecoder } = await import("./nativeDecoder");
    b.postMessage.mockImplementation(() => { throw new Error("unsupported"); });
    expect(feedNativeDecoder(0, true, bytes)).toBe(false);
    expect(window.__GT_DECODER__!.disableBinary).toHaveBeenCalledOnce();
    expect(feedNativeDecoder(1, true, bytes)).toBe(true);
    expect(window.__GT_DECODER__!.feed).toHaveBeenCalledExactlyOnceWith(1, true, "AAABBQ==");
  });

  it("cannot stay wedged forever if WebView stops acknowledging messages", async () => {
    bridge(); const { feedNativeDecoder } = await import("./nativeDecoder");
    for (let i = 0; i < 4; i++) feedNativeDecoder(i, true, bytes);
    vi.advanceTimersByTime(1600);
    expect(feedNativeDecoder(4, true, bytes)).toBe(false);
    expect(window.__GT_DECODER__!.disableBinary).toHaveBeenCalledOnce();
    expect(feedNativeDecoder(5, true, bytes)).toBe(true);
    expect(window.__GT_DECODER__!.feed).toHaveBeenCalledOnce();
  });

  it("keeps old APKs usable without an ArrayBuffer bridge", async () => {
    window.__GT_DECODER__ = { feed: vi.fn() };
    const { feedNativeDecoder } = await import("./nativeDecoder");
    expect(feedNativeDecoder(123, true, bytes)).toBe(true);
    expect(window.__GT_DECODER__.feed).toHaveBeenCalledExactlyOnceWith(123, true, "AAABBQ==");
  });
});

describe("native surface bounds", () => {
  it("drops identical rects and resends after a decoder (re)init", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    vi.doMock("@/lib/tauri", () => ({ isTauri: () => true }));
    (window as unknown as { __GT_COMPANION__?: boolean }).__GT_COMPANION__ = true;
    try {
      const nd = await import("./nativeDecoder");
      const sent = () => invoke.mock.calls.filter((c) => c[0] === "decoder_set_bounds").length;
      const r = { x: 10, y: 20, w: 300, h: 200, visible: true };
      await nd.setNativeDecoderBounds(r);
      await nd.setNativeDecoderBounds({ ...r });
      await nd.setNativeDecoderBounds({ ...r, x: 10.05 }); // sub-¼px layout jitter
      expect(sent()).toBe(1);
      await nd.setNativeDecoderBounds({ ...r, x: 12 });
      expect(sent()).toBe(2);
      // Java forgets its desired rect on init — the same rect must go out again.
      await nd.initNativeDecoder(1920, 1080);
      await nd.setNativeDecoderBounds({ ...r, x: 12 });
      expect(sent()).toBe(3);
      // Sequence numbers stay monotonic across the dedupe (Java drops stale ones).
      const seqs = invoke.mock.calls.filter((c) => c[0] === "decoder_set_bounds").map((c) => c[1].seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    } finally {
      delete (window as unknown as { __GT_COMPANION__?: boolean }).__GT_COMPANION__;
      vi.doUnmock("@tauri-apps/api/core");
      vi.doUnmock("@/lib/tauri");
    }
  });
});
