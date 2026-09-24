import { describe, expect, it } from "vitest";
import {
  H264_BASELINE_CODEC,
  h264CodecFromAnnexB,
  hevcCodecFromAnnexB,
  isHevcCodec,
  parseNativeFrame,
  videoFragmentSize,
} from "./nativeDelivery";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

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
  it("names an HEVC stream from its SPS, escapes and all (R8)", () => {
    // VPS + SPS + PPS exactly as NVENC emitted them for 1280x720@60 (codec-hevc-6m).
    const au = hex(
      "0000000140010c01ffff016000000300900000030000030078ac09" +
        "00000001420101016000000300900000030000030078a00280802e1f1396b4a421192e3016a02020c0800000" +
        "000000014401c0f7c0cc90" +
        "000000012601af19",
    );
    expect(hevcCodecFromAnnexB(au)).toBe("hev1.1.6.L120.90");
    expect(isHevcCodec("hev1.1.6.L120.90")).toBe(true);
    expect(isHevcCodec(H264_BASELINE_CODEC)).toBe(false);
    // A delta frame (no SPS) and an H.264 AU are not HEVC keyframes.
    expect(hevcCodecFromAnnexB(hex("000000010201d0"))).toBeNull();
    expect(hevcCodecFromAnnexB(hex("0000000167428028da01e0089f960000000168ce3c80"))).toBeNull();
  });
  it("encodes tier, profile space and non-zero constraint bytes (R8)", () => {
    // Main 10 (idc 2, compat flag 2), High tier, level 5.1, two constraint bytes.
    const sps = hex("000001" + "4201" + "01" + "22" + "20000000" + "b00400000000" + "99");
    expect(hevcCodecFromAnnexB(sps)).toBe("hev1.2.4.H153.B0.04");
  });
  it("reads the RFI clean flag and the 6-bit frame id from the flags byte (R4)", () => {
    const bytes = frame(false);
    new Uint8Array(bytes)[2] = (45 << 2) | 2;
    const f = parseNativeFrame(bytes)!;
    expect(f).toMatchObject({ key: false, rfiClean: true, frameId: 45 });
    new Uint8Array(bytes)[2] = 1;
    expect(parseNativeFrame(bytes)).toMatchObject({ key: true, rfiClean: false, frameId: 0 });
  });
  it("rejects truncated/unknown headers and tolerates host clock adjustments", () => {
    expect(parseNativeFrame(frame(true).slice(0, 20))).toBeNull();
    const unknown = frame(true); new Uint8Array(unknown)[3] = 2;
    expect(parseNativeFrame(unknown)).toBeNull();
    expect(parseNativeFrame(frame(true), 500, 990_000)?.timestamp).toBe(500);
    expect(parseNativeFrame(frame(true), 500, 2_000_000)?.timestamp).toBe(500);
  });
  it("sends 4 KiB fragments in both modes and respects negotiated SCTP limits", () => {
    expect(videoFragmentSize(false)).toBe(4096);
    expect(videoFragmentSize(true)).toBe(4096);
    for (const fast of [false, true]) {
      expect(videoFragmentSize(fast, 2048)).toBe(2048);
      expect(videoFragmentSize(fast, 0)).toBe(videoFragmentSize(fast));
    }
    const payload = new Uint8Array(222_333).map((_, i) => i % 251);
    const size = videoFragmentSize(true, 65536);
    const received = new Uint8Array(payload.length);
    for (let off = 0; off < payload.length; off += size) received.set(payload.subarray(off, off + size), off);
    expect(received).toEqual(payload);
  });
});

describe("h264CodecFromAnnexB", () => {
  const au = (...nals: number[][]) => new Uint8Array(nals.flatMap((n) => [0, 0, 0, 1, ...n]));

  it("names Constrained High from the SPS", () => {
    expect(h264CodecFromAnnexB(au([0x09, 0xf0], [0x67, 100, 0x0c, 42, 0xac], [0x68, 0xee], [0x65, 0x88])))
      .toBe("avc1.640C2A");
  });

  it("keeps the historical Baseline string", () => {
    expect(h264CodecFromAnnexB(au([0x67, 66, 0xc0, 42, 0xda], [0x65, 0x88]))).toBe(H264_BASELINE_CODEC);
  });

  it("returns null for access units without an SPS", () => {
    expect(h264CodecFromAnnexB(au([0x41, 0x9a, 0x00]))).toBeNull();
    expect(h264CodecFromAnnexB(new Uint8Array(3))).toBeNull();
  });

  it("works with 3-byte start codes", () => {
    expect(h264CodecFromAnnexB(new Uint8Array([0, 0, 1, 0x67, 100, 0x0c, 51, 0x00]))).toBe("avc1.640C33");
  });
});
