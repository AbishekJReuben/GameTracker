/**
 * DIRECT video over RTP — the "append carrier" (research R5,
 * docs/STREAMING_RESEARCH_2026-09.md).
 *
 * Why: DIRECT's reliable, ordered SCTP data channel turns ANY packet loss into
 * hundreds of milliseconds of stall — congestion control is per-association and
 * loss-based, and nothing from JS can change that. The browser's RTP stack does not
 * behave that way (NACK/RTX, a pacer, GCC). Measured Chromium↔Chromium through a
 * loss emulator: 2 % loss, SCTP 2.6 Mb/s at 934 ms vs the carrier 15.6 Mb/s at 25 ms.
 *
 * How: the host sends a tiny VP8 track (64×64 dummy frames, one per encoded screen
 * frame). An RTCRtpScriptTransform on the host appends the NVENC access unit(s) to
 * each encoded VP8 frame; on the phone a receiver transform — which runs BEFORE the
 * jitter buffer — cuts them off, hands them to the existing DIRECT decode path and
 * re-enqueues the untouched VP8 frame, so the dummy stream stays healthy (no PLI
 * storms). VP8, not H.264, as the carrier: libwebrtc's packet buffer head-of-line
 * blocks H.264 deltas and a starved H.264 decoder PLIs ~3×/s.
 *
 * Verified on the Moto g57's WebView 151 (loopback, 30 KB appended per frame):
 * 340/341 frames delivered intact, 57 fps, p50 16 ms / p90 24 ms.
 *
 * This file is the pure part (framing, ordering, SDP) so it can be unit-tested; the
 * transforms themselves live in carrier.worker.ts.
 *
 * Wire format of one carrier frame (little-endian):
 *   [VP8 frame, vp8Len bytes]
 *   records × count, each: [len u32][flags u8][seq u32][tsMs f64] + len bytes
 *       flags bit0 = keyframe, bit1 = config (UTF-8 JSON, same as the video
 *       channel's codec announce; seq unused)
 *   trailer (16 bytes): [recordsBytes u32][vp8Len u32][count u16][version u8][0 u8]["GTAU"]
 */

export const CARRIER_VERSION = 1;
export const CARRIER_TRAILER = 16;
export const CARRIER_RECORD_HEAD = 17;
const MAGIC = [0x47, 0x54, 0x41, 0x55]; // "GTAU"

export const REC_KEY = 1;
export const REC_CONFIG = 2;

export type CarrierRecord = {
  flags: number;
  seq: number;
  tsMs: number;
  data: Uint8Array;
};

/** VP8 frame + records → one carrier frame. */
export function packCarrierFrame(vp8: Uint8Array, records: CarrierRecord[]): ArrayBuffer {
  let recordsBytes = 0;
  for (const r of records) recordsBytes += CARRIER_RECORD_HEAD + r.data.byteLength;
  const total = vp8.byteLength + recordsBytes + CARRIER_TRAILER;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(vp8, 0);
  let at = vp8.byteLength;
  for (const r of records) {
    dv.setUint32(at, r.data.byteLength, true);
    dv.setUint8(at + 4, r.flags);
    dv.setUint32(at + 5, r.seq >>> 0, true);
    dv.setFloat64(at + 9, r.tsMs, true);
    out.set(r.data, at + CARRIER_RECORD_HEAD);
    at += CARRIER_RECORD_HEAD + r.data.byteLength;
  }
  dv.setUint32(at, recordsBytes, true);
  dv.setUint32(at + 4, vp8.byteLength, true);
  dv.setUint16(at + 8, records.length, true);
  dv.setUint8(at + 10, CARRIER_VERSION);
  dv.setUint8(at + 11, 0);
  out.set(MAGIC, at + 12);
  return out.buffer;
}

/**
 * Split a received carrier frame. Returns null when the frame carries nothing of
 * ours (an ordinary VP8 frame, or anything malformed) — the caller then passes it
 * through untouched. Record `data` are copies, safe to transfer.
 */
export function unpackCarrierFrame(buf: ArrayBuffer): { vp8Len: number; records: CarrierRecord[] } | null {
  const n = buf.byteLength;
  if (n < CARRIER_TRAILER) return null;
  const b = new Uint8Array(buf);
  const t = n - CARRIER_TRAILER;
  if (b[t + 12] !== MAGIC[0] || b[t + 13] !== MAGIC[1] || b[t + 14] !== MAGIC[2] || b[t + 15] !== MAGIC[3]) return null;
  const dv = new DataView(buf);
  const recordsBytes = dv.getUint32(t, true);
  const vp8Len = dv.getUint32(t + 4, true);
  const count = dv.getUint16(t + 8, true);
  if (dv.getUint8(t + 10) !== CARRIER_VERSION) return null;
  if (vp8Len + recordsBytes + CARRIER_TRAILER !== n) return null;
  const records: CarrierRecord[] = [];
  let at = vp8Len;
  for (let i = 0; i < count; i++) {
    if (at + CARRIER_RECORD_HEAD > t) return null;
    const len = dv.getUint32(at, true);
    const end = at + CARRIER_RECORD_HEAD + len;
    if (end > t) return null;
    records.push({
      flags: dv.getUint8(at + 4),
      seq: dv.getUint32(at + 5, true),
      tsMs: dv.getFloat64(at + 9, true),
      data: b.slice(at + CARRIER_RECORD_HEAD, end),
    });
    at = end;
  }
  if (at !== t) return null;
  return { vp8Len, records };
}

/**
 * Orders DIRECT frames by the host's frame sequence across BOTH transports (the
 * SCTP video channel and the RTP carrier share one counter), so a transport switch
 * needs no keyframe. Delivers in order; holds a frame that arrives ahead of a gap
 * for up to `maxHoldMs` / `maxHeld` frames, then skips the gap and reports it as
 * lost (the caller must then wait for a keyframe — a delta after a lost frame is
 * garbage). A keyframe ahead of a gap is delivered at once: it restarts the chain.
 * Late duplicates are dropped; a jump of more than `resetSpan` either way is a new
 * host session and restarts the counter.
 */
export class SeqOrderer<T> {
  private next = -1;
  private held = new Map<number, { item: T; key: boolean; at: number }>();

  constructor(
    private readonly maxHoldMs = 250,
    private readonly maxHeld = 12,
    private readonly resetSpan = 1000,
  ) {}

  reset() {
    this.next = -1;
    this.held.clear();
  }

  get expected() {
    return this.next;
  }

  get holding() {
    return this.held.size;
  }

  push(seq: number, key: boolean, item: T, now: number): { out: T[]; lost: boolean } {
    seq >>>= 0;
    if (this.next < 0) {
      this.next = (seq + 1) >>> 0;
      return { out: [item], lost: false };
    }
    const d = (seq - this.next) | 0;
    if (d < -this.resetSpan || d > this.resetSpan) {
      // New host session (counter restarted) — take it as the new start.
      this.held.clear();
      this.next = (seq + 1) >>> 0;
      return { out: [item], lost: false };
    }
    if (d < 0) return { out: [], lost: false }; // late duplicate
    if (d === 0) {
      this.next = (seq + 1) >>> 0;
      return { out: [item, ...this.drain()], lost: false };
    }
    if (key) {
      // A keyframe needs nothing before it: deliver now and forget the gap.
      for (const s of [...this.held.keys()]) if (((s - seq) | 0) < 0) this.held.delete(s);
      this.next = (seq + 1) >>> 0;
      return { out: [item, ...this.drain()], lost: false };
    }
    this.held.set(seq, { item, key, at: now });
    return this.poll(now);
  }

  /** Time-driven: give up on a gap that has been open too long. */
  poll(now: number): { out: T[]; lost: boolean } {
    if (!this.held.size) return { out: [], lost: false };
    let oldest = Infinity;
    for (const h of this.held.values()) oldest = Math.min(oldest, h.at);
    if (this.held.size <= this.maxHeld && now - oldest < this.maxHoldMs) return { out: [], lost: false };
    // Skip to the lowest held sequence.
    let low = -1;
    for (const s of this.held.keys()) if (low < 0 || ((s - low) | 0) < 0) low = s;
    this.next = low >>> 0;
    return { out: this.drain(), lost: true };
  }

  private drain(): T[] {
    const out: T[] = [];
    for (;;) {
      const h = this.held.get(this.next);
      if (!h) break;
      this.held.delete(this.next);
      out.push(h.item);
      this.next = (this.next + 1) >>> 0;
    }
    return out;
  }
}

/**
 * Start the carrier's VP8 near its working bitrate. `boostStartBitrate` only
 * touches the first video m-section's existing fmtp lines, and VP8 normally has
 * none — so the carrier would start at Chromium's ~300 kb/s and queue every
 * appended access unit behind it (the spike measured 1.3 s). Adds (or extends) the
 * fmtp line of every VP8 payload in the m-section with the given mid.
 */
export function boostCarrierSdp(sdp: string, mid: string, startKbps: number, minKbps: number, maxKbps: number): string {
  try {
    const lines = sdp.split("\r\n");
    const hint = `x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps};x-google-max-bitrate=${maxKbps}`;
    const out: string[] = [];
    let section: string[] = [];
    const flush = () => {
      if (!section.length) return;
      const isCarrier = section.some((l) => l === `a=mid:${mid}`);
      if (!isCarrier) {
        out.push(...section);
      } else {
        const vp8 = new Set<string>();
        for (const l of section) {
          const m = /^a=rtpmap:(\d+) VP8\/90000$/i.exec(l);
          if (m) vp8.add(m[1]);
        }
        const withFmtp = new Set<string>();
        const patched = section.map((l) => {
          const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
          if (f && vp8.has(f[1])) {
            withFmtp.add(f[1]);
            return f[2].includes("x-google-start-bitrate") ? l : `a=fmtp:${f[1]} ${f[2]};${hint}`;
          }
          return l;
        });
        for (const l of patched) {
          out.push(l);
          const m = /^a=rtpmap:(\d+) VP8\/90000$/i.exec(l);
          if (m && !withFmtp.has(m[1])) out.push(`a=fmtp:${m[1]} ${hint}`);
        }
      }
      section = [];
    };
    for (const l of lines) {
      if (l.startsWith("m=")) flush();
      section.push(l);
    }
    flush();
    return out.join("\r\n");
  } catch {
    return sdp;
  }
}
