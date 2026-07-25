/**
 * Wire format for DIRECT audio (the "audio" data channel).
 *
 * Two formats ride this channel and they must never be confused, because the
 * host can switch between them mid-session (Opus is negotiated once the real
 * capture format is known, which is *after* a guest may already have opted in):
 *
 *  - **Opus** — an 8-byte header followed by one Opus packet.
 *  - **raw f32** — a headerless buffer of interleaved float32 samples, byte-for
 *    -byte what every build shipped before Opus existed (old APKs still get it).
 *
 * The header exists so routing is decided by the DATA, not by out-of-band state.
 * The format cfg travels on the audio channel, the mode ack on the control
 * channel, and the samples on a third — with no ordering guarantee between them,
 * any state-based routing has a window where it feeds Opus bytes to the PCM
 * worklet (a burst of noise) or PCM to the Opus decoder.
 *
 * Layout (little-endian):
 *   0  u8   'G' 0x47
 *   1  u8   'A' 0x41
 *   2  u8   fmt  (2 = opus)
 *   3  u8   flags (reserved, 0)
 *   4  u32  seq   (per encoder session; wraps)
 *   8  ...  payload
 */

export const AUDIO_HDR_BYTES = 8;
const MAGIC_0 = 0x47; // 'G'
const MAGIC_1 = 0x41; // 'A'
/** fmt byte for an Opus payload. 0/1 are reserved for raw PCM variants. */
export const AUDIO_FMT_OPUS = 2;
/** fmt byte for a redundancy-carrying Opus packet (STUDIO path — see below). */
export const AUDIO_FMT_OPUS_RED = 3;

/** Build the 8-byte header for an Opus packet of `payloadBytes`. */
export function audioPacket(seq: number, payloadBytes: number): ArrayBuffer {
  const buf = new ArrayBuffer(AUDIO_HDR_BYTES + payloadBytes);
  const dv = new DataView(buf);
  dv.setUint8(0, MAGIC_0);
  dv.setUint8(1, MAGIC_1);
  dv.setUint8(2, AUDIO_FMT_OPUS);
  dv.setUint8(3, 0);
  dv.setUint32(4, seq >>> 0, true);
  return buf;
}

/**
 * True when `ab` is a framed Opus packet.
 *
 * Requires a non-empty payload: an 8-byte-exact buffer is a header with nothing
 * in it, which no encoder produces. A raw f32 buffer *can* coincidentally begin
 * with these three bytes, but only the host decides the format — while it is
 * sending raw it never sends anything else, so the worst case is one 128-sample
 * chunk (~2.7ms) skipped, which the worklet's gain ramp conceals.
 */
export function isOpusPacket(ab: ArrayBuffer): boolean {
  if (ab.byteLength <= AUDIO_HDR_BYTES) return false;
  const u8 = new Uint8Array(ab, 0, 3);
  return u8[0] === MAGIC_0 && u8[1] === MAGIC_1 && u8[2] === AUDIO_FMT_OPUS;
}

/** Sequence number of a framed packet. Caller must have checked isOpusPacket. */
export function audioSeqOf(ab: ArrayBuffer): number {
  return new DataView(ab).getUint32(4, true);
}

/**
 * Packets missed between `prev` and `seq`, tolerating u32 wrap.
 *
 * Returns 0 for the first packet (`prev < 0`), for a repeat/reorder, and for a
 * gap so large it means the counter restarted (a rebuilt encoder) rather than
 * real loss — attributing 4 billion lost packets to an encoder restart would be
 * worse than useless.
 */
export function audioSeqGap(prev: number, seq: number, maxGap = 1000): number {
  if (prev < 0) return 0;
  const gap = (seq - prev - 1) >>> 0;
  return gap > 0 && gap < maxGap ? gap : 0;
}

// ---- STUDIO path: Opus + explicit redundancy (RFC 2198 "RED" in spirit) -----
//
// The classic DIRECT audio channel is ordered + `maxPacketLifeTime:60`, so a
// packet that misses its window is simply gone and the guest has to conceal a
// hole. Opus' own in-band FEC can't help us: recovering it needs libopus'
// `decode_fec=1`, which WebCodecs' `AudioDecoder` does not expose.
//
// Explicit redundancy works with ANY decoder: every packet also carries the
// PREVIOUS packet's payload, so losing one packet costs nothing at all — the
// next arrival still contains it. That lets STUDIO run on an UNORDERED,
// ZERO-RETRANSMIT channel (no head-of-line blocking, no waiting, never late)
// and still play a continuous waveform. The cost is ~2× a 10ms-frame Opus
// stream (~260kbps), which is noise next to a multi-megabit video share.
//
// Layout (little-endian):
//   0  u8   'G' 0x47
//   1  u8   'A' 0x41
//   2  u8   fmt = 3 (opus + redundancy)
//   3  u8   count  — Opus units in this packet, 1..4; unit 0 is the NEWEST
//   4  u32  seq    — sequence of unit 0; unit i is seq - i
//   8  u16 × count — payload lengths, in unit order
//   ...  payloads, back to back, in unit order
export const AUDIO_RED_MAX_UNITS = 4;

/** Build one redundancy packet. `units[0]` is the newest (primary) payload. */
export function audioRedPacket(seq: number, units: Uint8Array[]): ArrayBuffer {
  const count = Math.min(AUDIO_RED_MAX_UNITS, units.length);
  let total = AUDIO_HDR_BYTES + count * 2;
  for (let i = 0; i < count; i++) total += units[i].byteLength;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint8(0, MAGIC_0);
  dv.setUint8(1, MAGIC_1);
  dv.setUint8(2, AUDIO_FMT_OPUS_RED);
  dv.setUint8(3, count);
  dv.setUint32(4, seq >>> 0, true);
  let off = AUDIO_HDR_BYTES + count * 2;
  const out = new Uint8Array(buf);
  for (let i = 0; i < count; i++) {
    dv.setUint16(AUDIO_HDR_BYTES + i * 2, units[i].byteLength, true);
    out.set(units[i], off);
    off += units[i].byteLength;
  }
  return buf;
}

/** True when `ab` is a redundancy-carrying Opus packet. */
export function isOpusRedPacket(ab: ArrayBuffer): boolean {
  if (ab.byteLength <= AUDIO_HDR_BYTES) return false;
  const u8 = new Uint8Array(ab, 0, 3);
  return u8[0] === MAGIC_0 && u8[1] === MAGIC_1 && u8[2] === AUDIO_FMT_OPUS_RED;
}

/** One decoded unit of a redundancy packet: its own sequence and payload. */
export type AudioRedUnit = { seq: number; payload: Uint8Array };

/**
 * Split a redundancy packet into its units, NEWEST FIRST. Returns an empty list
 * for anything malformed — a truncated packet must never be handed to the
 * decoder as if it were whole (garbage in an Opus decoder is audible).
 */
export function parseOpusRed(ab: ArrayBuffer): AudioRedUnit[] {
  if (!isOpusRedPacket(ab)) return [];
  const dv = new DataView(ab);
  const count = dv.getUint8(3);
  if (count < 1 || count > AUDIO_RED_MAX_UNITS) return [];
  const headEnd = AUDIO_HDR_BYTES + count * 2;
  if (ab.byteLength < headEnd) return [];
  const seq = dv.getUint32(4, true);
  const lens: number[] = [];
  let need = headEnd;
  for (let i = 0; i < count; i++) {
    const len = dv.getUint16(AUDIO_HDR_BYTES + i * 2, true);
    lens.push(len);
    need += len;
  }
  if (need !== ab.byteLength) return [];
  const out: AudioRedUnit[] = [];
  let off = headEnd;
  for (let i = 0; i < count; i++) {
    if (lens[i] > 0) {
      out.push({ seq: (seq - i) >>> 0, payload: new Uint8Array(ab, off, lens[i]) });
    }
    off += lens[i];
  }
  return out;
}

/**
 * Stateful linear resampler for interleaved PCM. Keeping the fractional source
 * position and the prior tail across WASAPI packets avoids a discontinuity at
 * every chunk boundary (the old one-shot resampler restarted at phase zero).
 */
export class StreamingAudioResampler {
  private pos = 0;
  private tail: Float32Array | null = null;

  constructor(
    private readonly channels: number,
    private readonly srcRate: number,
    private readonly dstRate: number,
  ) {}

  process(src: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
    const ch = this.channels;
    const srcFrames = Math.floor(src.length / ch);
    if (ch < 1 || srcFrames < 1 || this.srcRate === this.dstRate) return src;

    const prefix = this.tail ? 1 : 0;
    const frames = srcFrames + prefix;
    if (frames < 2) {
      this.tail = src.slice(0, ch);
      return new Float32Array(0);
    }

    const sample = (frame: number, channel: number) => {
      if (prefix && frame === 0) return this.tail![channel] || 0;
      return src[(frame - prefix) * ch + channel] || 0;
    };
    const step = this.srcRate / this.dstRate;
    const outFrames = Math.max(0, Math.ceil((frames - 1 - this.pos) / step));
    const out = new Float32Array(outFrames * ch);
    let written = 0;
    while (this.pos < frames - 1) {
      const i0 = Math.floor(this.pos);
      const frac = this.pos - i0;
      for (let c = 0; c < ch; c++) {
        const a = sample(i0, c);
        const b = sample(i0 + 1, c);
        out[written * ch + c] = a + (b - a) * frac;
      }
      written++;
      this.pos += step;
    }
    this.pos -= frames - 1;
    this.tail = src.slice((srcFrames - 1) * ch, srcFrames * ch);
    return written === outFrames ? out : out.slice(0, written * ch);
  }
}
