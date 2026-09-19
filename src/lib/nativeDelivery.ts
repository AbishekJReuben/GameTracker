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
export function videoFragmentSize(fast: boolean, negotiatedMax?: number) {
  const preferred = fast ? 16 * 1024 : 61440;
  return Number.isFinite(negotiatedMax) && negotiatedMax! > 0
    ? Math.min(preferred, Math.floor(negotiatedMax!)) : preferred;
}
