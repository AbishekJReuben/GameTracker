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
    // Research R4: bit1 = first frame after a reference-frame invalidation (it only
    // predicts from frames the guest has), bits 2..7 = the frame's 6-bit id.
    rfiClean: (u8[2] & 2) === 2, frameId: u8[2] >> 2,
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
/**
 * HEVC Main, level 4.1, progressive + frame-only (research R8) — what the guest
 * probes, and the host's announce before the first SPS. The real stream announces
 * its own string (`hevcCodecFromAnnexB`), e.g. NVENC's 720p60 is hev1.1.6.L120.90.
 */
export const HEVC_MAIN_CODEC = "hev1.1.6.L123.90";

/** True for an HEVC codec string (hev1/hvc1). */
export const isHevcCodec = (codec: string) => codec.startsWith("hev1") || codec.startsWith("hvc1");

/** Up to `count` RBSP bytes from `start`, emulation-prevention bytes removed. */
function rbspBytes(au: Uint8Array, start: number, count: number): number[] {
  const out: number[] = [];
  let zeros = 0;
  for (let i = start; i < au.length && out.length < count; i++) {
    const b = au[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    zeros = b === 0 ? zeros + 1 : 0;
    out.push(b);
  }
  return out;
}

/**
 * WebCodecs codec string for an HEVC Annex-B access unit that carries an SPS
 * (NAL type 33), else null — ISO/IEC 14496-15 Annex E: profile space + idc, the
 * compatibility flags bit-reversed in hex, tier + level, then the constraint bytes
 * with trailing zero bytes dropped. Reads only the SPS's leading profile_tier_level.
 */
export function hevcCodecFromAnnexB(au: Uint8Array, scan = 1024): string | null {
  const end = Math.min(au.length, scan) - 5;
  for (let i = 0; i < end; i++) {
    if (au[i] !== 0 || au[i + 1] !== 0 || au[i + 2] !== 1) continue;
    if (((au[i + 3] >> 1) & 0x3f) !== 33) continue;
    // 2-byte NAL header, then vps_id/max_sub_layers/nesting (1 byte), then the PTL.
    const r = rbspBytes(au, i + 5, 13);
    if (r.length < 13) return null;
    const space = r[1] >> 6;
    const tier = (r[1] >> 5) & 1;
    const idc = r[1] & 0x1f;
    const compat = ((r[2] << 24) | (r[3] << 16) | (r[4] << 8) | r[5]) >>> 0;
    let rev = 0;
    for (let b = 0; b < 32; b++) if (compat & (1 << b)) rev |= 1 << (31 - b);
    const cons = r.slice(6, 12);
    let n = cons.length;
    while (n > 0 && cons[n - 1] === 0) n--;
    const spaceTag = ["", "A", "B", "C"][space];
    const tail = cons.slice(0, n).map((b) => "." + hex2(b)).join("");
    return `hev1.${spaceTag}${idc}.${(rev >>> 0).toString(16).toUpperCase()}.${tier ? "H" : "L"}${r[12]}${tail}`;
  }
  return null;
}

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
