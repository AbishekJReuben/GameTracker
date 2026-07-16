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
