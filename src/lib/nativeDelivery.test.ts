import { describe, expect, it } from "vitest";
import { parseNativeFrame, videoFragmentSize } from "./nativeDelivery";

function frame(fast: boolean) {
  const bytes = new ArrayBuffer((fast ? 24 : 8) + 5);
  const u8 = new Uint8Array(bytes); const v = new DataView(bytes);
  u8.set([71, 78, 1, fast ? 1 : 0]);
  v.setUint16(4, 1920, true); v.setUint16(6, 1080, true);
  if (fast) { v.setUint32(8, 123, true); v.setUint32(12, 7, true); v.setFloat64(16, 999_990, true); }
  u8.set([0, 0, 0, 1, 0x65], fast ? 24 : 8);
  return bytes;
}
describe("native delivery wire", () => {
  it("keeps the old GN payload and arrival timestamp compatible", () => {
    const f = parseNativeFrame(frame(false), 500, 1_000_000)!;
    expect(f).toMatchObject({ w: 1920, h: 1080, key: true, fast: false, timestamp: 500 });
    expect([...f.payload]).toEqual([0, 0, 0, 1, 0x65]);
  });
  it("strips the fast header and includes encode/IPC time without copying Annex-B", () => {
    const bytes = frame(true); const f = parseNativeFrame(bytes, 500, 1_000_000)!;
    expect(f).toMatchObject({ generation: 123, sequence: 7, timestamp: 490, hostAgeMs: 10 });
    expect(f.payload.buffer).toBe(bytes);
    expect([...f.payload]).toEqual([0, 0, 0, 1, 0x65]);
  });
  it("rejects truncated/unknown headers and tolerates host clock adjustments", () => {
    expect(parseNativeFrame(frame(true).slice(0, 20))).toBeNull();
    const unknown = frame(true); new Uint8Array(unknown)[3] = 2;
    expect(parseNativeFrame(unknown)).toBeNull();
    expect(parseNativeFrame(frame(true), 500, 990_000)?.timestamp).toBe(500);
    expect(parseNativeFrame(frame(true), 500, 2_000_000)?.timestamp).toBe(500);
  });
  it("uses 16KiB only for fast delivery and respects negotiated SCTP limits", () => {
    expect(videoFragmentSize(false)).toBe(61440);
    expect(videoFragmentSize(true)).toBe(16384);
    for (const fast of [false, true]) {
      expect(videoFragmentSize(fast, 8192)).toBe(8192);
      expect(videoFragmentSize(fast, 0)).toBe(videoFragmentSize(fast));
    }
    const payload = new Uint8Array(222_333).map((_, i) => i % 251);
    const size = videoFragmentSize(true, 65536);
    const received = new Uint8Array(payload.length);
    for (let off = 0; off < payload.length; off += size) received.set(payload.subarray(off, off + size), off);
    expect(received).toEqual(payload);
  });
});
