import { describe, it, expect } from "vitest";

import {
  AUDIO_HDR_BYTES,
  StreamingAudioResampler,
  audioPacket,
  audioRedPacket,
  audioSeqGap,
  audioSeqOf,
  isOpusPacket,
  isOpusRedPacket,
  parseOpusRed,
} from "./audioWire";

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

  describe("STUDIO redundancy packets", () => {
    const u = (...b: number[]) => Uint8Array.from(b);

    it("round-trips units newest-first with descending sequences", () => {
      const ab = audioRedPacket(10, [u(1, 2, 3), u(4, 4), u(5)]);
      expect(isOpusRedPacket(ab)).toBe(true);
      const units = parseOpusRed(ab);
      expect(units.map((x) => x.seq)).toEqual([10, 9, 8]);
      expect([...units[0].payload]).toEqual([1, 2, 3]);
      expect([...units[1].payload]).toEqual([4, 4]);
      expect([...units[2].payload]).toEqual([5]);
    });

    it("is never confused with a classic Opus packet in either direction", () => {
      // Both formats can share a session (the host switches when the guest
      // re-negotiates), so routing must be decided by the fmt byte alone.
      const red = audioRedPacket(3, [u(9, 9)]);
      const plain = audioPacket(3, 2);
      expect(isOpusPacket(red)).toBe(false);
      expect(isOpusRedPacket(plain)).toBe(false);
      expect(parseOpusRed(plain)).toEqual([]);
    });

    it("survives a u32 sequence wrap in the redundant units", () => {
      const units = parseOpusRed(audioRedPacket(1, [u(1), u(2), u(3)]));
      expect(units.map((x) => x.seq)).toEqual([1, 0, 0xffffffff]);
    });

    it("caps at AUDIO_RED_MAX_UNITS instead of overflowing the count byte", () => {
      const many = [u(1), u(2), u(3), u(4), u(5), u(6)];
      expect(parseOpusRed(audioRedPacket(20, many))).toHaveLength(4);
    });

    it("rejects a truncated packet rather than decoding a partial payload", () => {
      const ab = audioRedPacket(5, [u(1, 2, 3, 4), u(7, 7)]);
      expect(parseOpusRed(ab.slice(0, ab.byteLength - 2))).toEqual([]);
    });

    it("skips zero-length units (a padded packet has nothing to decode)", () => {
      const ab = audioRedPacket(4, [u(1, 1), new Uint8Array(0)]);
      const units = parseOpusRed(ab);
      expect(units).toHaveLength(1);
      expect(units[0].seq).toBe(4);
    });
  });

  it("keeps resample phase continuous across capture packet boundaries", () => {
    const src = Float32Array.from({ length: 441 }, (_, i) => Math.sin((i * Math.PI) / 31));
    const whole = new StreamingAudioResampler(1, 44100, 48000).process(src);
    const splitResampler = new StreamingAudioResampler(1, 44100, 48000);
    const a = splitResampler.process(src.subarray(0, 200));
    const b = splitResampler.process(src.subarray(200));
    const split = new Float32Array(a.length + b.length);
    split.set(a);
    split.set(b, a.length);

    expect(split.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(split[i]).toBeCloseTo(whole[i], 5);
    }
  });
});
