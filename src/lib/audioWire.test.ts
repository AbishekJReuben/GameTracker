import { describe, it, expect } from "vitest";

import { AUDIO_HDR_BYTES, audioPacket, audioSeqGap, audioSeqOf, isOpusPacket } from "./audioWire";

/** A framed Opus packet with `payload` bytes after the header. */
function framed(seq: number, payload: number[]): ArrayBuffer {
  const buf = audioPacket(seq, payload.length);
  new Uint8Array(buf, AUDIO_HDR_BYTES).set(payload);
  return buf;
}

describe("audioWire", () => {
  it("round-trips a framed Opus packet", () => {
    const ab = framed(7, [1, 2, 3]);
    expect(ab.byteLength).toBe(AUDIO_HDR_BYTES + 3);
    expect(isOpusPacket(ab)).toBe(true);
    expect(audioSeqOf(ab)).toBe(7);
    expect([...new Uint8Array(ab, AUDIO_HDR_BYTES)]).toEqual([1, 2, 3]);
  });

  it("survives a u32 sequence at the top of its range", () => {
    const ab = framed(0xffffffff, [9]);
    expect(audioSeqOf(ab)).toBe(0xffffffff);
  });

  it("rejects raw float32 PCM — the other format on this channel", () => {
    // The realistic case: a buffer of ordinary audio samples must never be
    // mistaken for a framed packet, or the Opus decoder gets fed noise.
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1, 0.001]);
    expect(isOpusPacket(pcm.buffer)).toBe(false);
  });

  it("rejects a header with no payload", () => {
    expect(isOpusPacket(audioPacket(1, 0))).toBe(false);
  });

  it("rejects short and wrong-magic buffers", () => {
    expect(isOpusPacket(new ArrayBuffer(0))).toBe(false);
    expect(isOpusPacket(new ArrayBuffer(4))).toBe(false);
    const wrong = framed(1, [5]);
    new Uint8Array(wrong)[1] = 0x42; // 'B' — not our magic
    expect(isOpusPacket(wrong)).toBe(false);
    const wrongFmt = framed(1, [5]);
    new Uint8Array(wrongFmt)[2] = 0; // raw-PCM fmt, not Opus
    expect(isOpusPacket(wrongFmt)).toBe(false);
  });

  describe("audioSeqGap", () => {
    it("reports no loss for the first packet or a clean run", () => {
      expect(audioSeqGap(-1, 0)).toBe(0);
      expect(audioSeqGap(-1, 12345)).toBe(0);
      expect(audioSeqGap(4, 5)).toBe(0);
    });

    it("counts the packets actually missed", () => {
      expect(audioSeqGap(4, 6)).toBe(1);
      expect(audioSeqGap(4, 9)).toBe(4);
    });

    it("counts loss across a u32 wrap", () => {
      expect(audioSeqGap(0xffffffff, 0)).toBe(0);
      expect(audioSeqGap(0xfffffffe, 1)).toBe(2);
    });

    it("ignores repeats and reorders rather than reporting absurd loss", () => {
      expect(audioSeqGap(5, 5)).toBe(0);
      expect(audioSeqGap(5, 4)).toBe(0);
    });

    it("ignores an encoder restart (seq back to 0) instead of blaming the link", () => {
      expect(audioSeqGap(50_000, 0)).toBe(0);
      expect(audioSeqGap(50_000, 1)).toBe(0);
    });
  });
});
