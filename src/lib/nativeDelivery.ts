/** GN container decoding shared by the host and non-visual wire regression tests. */
export function parseNativeFrame(bytes: ArrayBuffer, now = performance.now(), wallNow = Date.now()) {
  const u8 = new Uint8Array(bytes);
  if (u8.length <= 8 || u8[0] !== 0x47 || u8[1] !== 0x4e) return null;
  const dv = new DataView(bytes);
  const fast = u8[3] === 1;
  if ((fast && u8.length <= 24) || u8[3] > 1) return null;
  const age = fast ? wallNow - dv.getFloat64(16, true) : 0;
  // Rust and JS are on the SAME PC. Convert its wall-clock encode timestamp to
  // host performance.now(), the clock synchronized to the receiver. Reject a
  // wall-clock adjustment rather than inventing negative/absurd latency.
  const hostAgeMs = Number.isFinite(age) && age >= 0 && age < 10_000 ? age : 0;
  return {
    payload: u8.subarray(fast ? 24 : 8), key: (u8[2] & 1) === 1,
    w: dv.getUint16(4, true), h: dv.getUint16(6, true), fast,
    generation: fast ? dv.getUint32(8, true) : 0,
    sequence: fast ? dv.getUint32(12, true) : 0,
    hostAgeMs, timestamp: now - hostAgeMs,
  };
}

/** RFC 8831 §6.1: smaller messages let audio/input share SCTP without waiting
 * behind a 60KB video message on implementations without message interleaving.
 * Fragment boundaries are deliberately NOT frame boundaries. Reliability and
 * ordered delivery stay intact, including the existing guest reassembler. */
// 4 KB, for BOTH delivery modes. Measured in Chromium 153 over a UDP emulator
// with a real 16 Mb/s NVENC frame-size trace, zero loss (docs/STREAMING_RESEARCH_2026-09.md R1):
// p50 19.7 ms at 60 KB and 12.7 ms at 16 KB vs 8.5 ms at 4 KB (6 ms RTT); p90
// 40 -> 15 ms. Same reliability, ordering and bytes; more send() calls, which cost
// nothing measurable. It does NOT help under packet loss (see R5).
export const VIDEO_FRAGMENT_BYTES = 4096;

export function videoFragmentSize(_fast: boolean, negotiatedMax?: number) {
  const preferred = VIDEO_FRAGMENT_BYTES;
  return Number.isFinite(negotiatedMax) && negotiatedMax! > 0
    ? Math.min(preferred, Math.floor(negotiatedMax!)) : preferred;
}

/** Constrained Baseline announce — unchanged since 3.9.27, every DIRECT decoder has seen it. */
export const H264_BASELINE_CODEC = "avc1.42C028";
/** Constrained High (set4+set5), level 4.2 — what the guest probes before asking for High. */
export const H264_HIGH_CODEC = "avc1.640C2A";

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

/**
 * WebCodecs codec string for an Annex-B access unit that carries an SPS, else null.
 * The host announces what the stream actually IS, so a profile switch (research R3:
 * Baseline ⇄ Constrained High) re-announces and the guest rebuilds its decoder
 * before the new IDR. Baseline keeps the historical string. The SPS leads the
 * access unit (after an optional AUD/SEI), so only the first bytes are scanned.
 */
export function h264CodecFromAnnexB(au: Uint8Array, scan = 1024): string | null {
  const end = Math.min(au.length, scan) - 6;
  for (let i = 0; i < end; i++) {
    if (au[i] !== 0 || au[i + 1] !== 0 || au[i + 2] !== 1) continue;
    if ((au[i + 3] & 0x1f) === 7) {
      // profile_idc, constraint flags, level_idc — never 00 00, so never escaped.
      const profile = au[i + 4];
      if (profile === 66) return H264_BASELINE_CODEC;
      return `avc1.${hex2(profile)}${hex2(au[i + 5])}${hex2(au[i + 6])}`;
    }
    i += 2;
  }
  return null;
}
