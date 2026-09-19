import { describe, expect, it, vi } from "vitest";
import { VideoAssembler, decodeOverloaded, nativeVideoPacket } from "./videoReceive";

export function videoHeader(seq: number, len: number, key = false, tsMs = seq * 16) {
  const buffer = new ArrayBuffer(20);
  const v = new DataView(buffer);
  v.setUint8(0, 0x47); v.setUint8(1, 0x56); v.setUint8(2, key ? 1 : 0);
  v.setUint32(4, seq, true); v.setFloat64(8, tsMs, true); v.setUint32(16, len, true);
  return buffer;
}

describe("DIRECT receive wire", () => {
  it("hands a one-fragment AU to decode without allocating/copying it", () => {
    const broken = vi.fn();
    const a = new VideoAssembler(broken);
    a.push(videoHeader(4, 4, true));
    const payload = new Uint8Array([0, 0, 1, 5]).buffer;
    expect(a.push(payload)?.bytes.buffer).toBe(payload);
    expect(broken).not.toHaveBeenCalled();
  });

  it("reassembles arbitrary fragment sizes and immediately releases the AU", () => {
    const a = new VideoAssembler(vi.fn());
    a.push(videoHeader(0, 131073));
    const data = Uint8Array.from({ length: 131073 }, (_, i) => i % 255);
    for (let off = 0; off < data.length; off += 16384) {
      const frame = a.push(data.slice(off, off + 16384).buffer);
      if (off + 16384 < data.length) expect(frame).toBeNull();
      else expect(frame?.bytes).toEqual(data);
    }
    expect(a.push(new ArrayBuffer(1))).toBeNull();
  });

  it("discards a partial AU when the sender resumes with another header", () => {
    const broken = vi.fn();
    const a = new VideoAssembler(broken);
    a.push(videoHeader(1, 100));
    a.push(new ArrayBuffer(40));
    a.push(videoHeader(2, 10, true));
    expect(a.push(new ArrayBuffer(10))?.head.key).toBe(true);
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it("rejects overflowing fragments instead of truncating and decoding garbage", () => {
    const broken = vi.fn();
    const a = new VideoAssembler(broken);
    a.push(videoHeader(1, 30));
    expect(a.push(new ArrayBuffer(31))).toBeNull();
    expect(broken).toHaveBeenCalledOnce();
    a.push(videoHeader(2, 4, true));
    expect(a.push(new ArrayBuffer(4))).not.toBeNull();
  });

  it("detects missing frames but accepts sequence wrap and a fresh session", () => {
    const broken = vi.fn();
    const a = new VideoAssembler(broken);
    for (const seq of [0xffffffff, 0, 1]) {
      a.push(videoHeader(seq, 1)); a.push(new ArrayBuffer(1));
    }
    expect(broken).not.toHaveBeenCalled();
    a.push(videoHeader(3, 1)); a.push(new ArrayBuffer(1));
    expect(broken).toHaveBeenCalledOnce();
    a.reset();
    a.push(videoHeader(0, 1)); a.push(new ArrayBuffer(1));
    expect(broken).toHaveBeenCalledOnce();
  });

  it.each([[0, 1], [16_000_001, 1], [100, NaN], [100, Infinity], [100, -1]])(
    "rejects invalid length/timestamp %s/%s before allocation", (len, ts) => {
      const broken = vi.fn();
      const a = new VideoAssembler(broken);
      a.push(videoHeader(0, len, true, ts));
      expect(a.push(new ArrayBuffer(4))).toBeNull();
      expect(broken).toHaveBeenCalled();
    },
  );

  it("bounds submitted work as well as the public decode request queue", () => {
    expect(decodeOverloaded(0, 0, 1000)).toBe(false);
    expect(decodeOverloaded(0, 2, 25)).toBe(false);
    expect(decodeOverloaded(4, 4, 25)).toBe(true);
    expect(decodeOverloaded(0, 6, 25)).toBe(true);
    expect(decodeOverloaded(0, 1, 151)).toBe(true);
  });

  it("packs binary bridge metadata and exactly the payload view", () => {
    const data = new Uint8Array([99, 0, 0, 1, 5, 88]).subarray(1, 5);
    const packet = nativeVideoPacket(123456789.5, true, data, 42);
    const header = new DataView(packet);
    expect([...new Uint8Array(packet).subarray(0, 4)]).toEqual([0x47, 0x44, 2, 1]);
    expect(header.getFloat64(4, true)).toBe(123456789.5);
    expect(header.getUint32(12, true)).toBe(4);
    expect(header.getUint32(16, true)).toBe(42);
    expect([...new Uint8Array(packet).subarray(20)]).toEqual([...data]);
  });
});
