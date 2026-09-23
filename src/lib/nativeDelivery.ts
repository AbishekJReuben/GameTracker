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
