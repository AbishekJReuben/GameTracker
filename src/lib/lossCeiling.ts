/**
 * Loss-aware ceiling for DIRECT video (research R6, docs/STREAMING_RESEARCH_2026-09.md).
 *
 * DIRECT rides a reliable, ordered SCTP data channel. Under random packet loss an
 * SCTP association behaves like one Reno flow: its throughput tops out near the
 * Mathis bound, however much bandwidth the link has. Asking the encoder for more
 * than that does not raise quality — the excess waits in the send buffer and
 * becomes latency (measured: 30 Mb/s target at 0.1 % loss / 20 ms RTT delivered
 * 11.4 Mb/s at p50 414 ms). So the host caps its target at 0.6 × that bound.
 *
 *     C_sctp ≈ 0.85 · MSS · 8 / (RTT · √p)      MSS ≈ 1150 B
 *     B_max  = 0.6 · C_sctp
 *
 * `p` is measured on the STUDIO audio channel ("audio2": unordered, zero
 * retransmits), whose primary sequence numbers expose raw path loss before RED
 * repair — the only unreliable stream we have on the same association.
 */

/** Effective SCTP payload per packet (bytes) after DTLS/SCTP/UDP/IP overhead. */
export const SCTP_MSS_BYTES = 1150;
/** Below this loss rate the bound is far above any bitrate we'd ask for. */
export const LOSS_CEIL_MIN_P = 0.0005;
/** Fraction of the bound we actually target: headroom for loss bursts. */
export const LOSS_CEIL_SHARE = 0.6;
/** Loss window on the phone. */
export const LOSS_WINDOW_MS = 5000;

/** Mathis-style SCTP throughput bound, kbps. 0 = no meaningful bound. */
export function sctpCapacityKbps(lossFrac: number, rttMs: number): number {
  if (!(lossFrac >= LOSS_CEIL_MIN_P) || !(rttMs > 0)) return 0;
  const p = Math.min(lossFrac, 1);
  const rttS = Math.max(rttMs, 1) / 1000;
  return (0.85 * SCTP_MSS_BYTES * 8) / (rttS * Math.sqrt(p)) / 1000;
}

/** The encode-target ceiling (kbps) for a measured loss + RTT. 0 = no ceiling. */
export function lossCeilingKbps(lossFrac: number, rttMs: number): number {
  const c = sctpCapacityKbps(lossFrac, rttMs);
  return c > 0 ? Math.round(c * LOSS_CEIL_SHARE) : 0;
}

export type SeqLoss = {
  /** Loss fraction over the window (0…1). */
  p: number;
  /** Packets missing from the window. */
  lost: number;
  /** Packets the window should have held. */
  span: number;
};

/**
 * Raw sequence-gap loss over a sliding time window. Arrival order does not matter
 * (the channel is unordered) and duplicates are ignored. Sequences are u32 and may
 * wrap; a jump larger than `maxSpan` (a restarted sender) starts a new window
 * rather than reading as a burst of loss.
 */
export class SeqLossWindow {
  private win: { at: number; seq: number }[] = [];

  constructor(
    private readonly windowMs = LOSS_WINDOW_MS,
    private readonly minPackets = 100,
    private readonly maxSpan = 5000,
  ) {}

  push(seq: number, now: number) {
    const last = this.win.length ? this.win[this.win.length - 1].seq : seq;
    // Signed u32 distance from the previous arrival.
    if (Math.abs((seq - last) | 0) > this.maxSpan) this.win = [];
    this.win.push({ at: now, seq: seq >>> 0 });
    this.trim(now);
  }

  reset() {
    this.win = [];
  }

  /** Current loss, or null while the window holds too few packets to say. */
  loss(now: number): SeqLoss | null {
    this.trim(now);
    const n = this.win.length;
    if (n < this.minPackets) return null;
    const base = this.win[0].seq;
    let lo = 0;
    let hi = 0;
    const seen = new Set<number>();
    for (const e of this.win) {
      const d = (e.seq - base) | 0;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
      seen.add(d);
    }
    const span = hi - lo + 1;
    if (span > this.maxSpan) return null;
    const lost = Math.max(0, span - seen.size);
    return { p: lost / span, lost, span };
  }

  private trim(now: number) {
    let i = 0;
    while (i < this.win.length && now - this.win[i].at > this.windowMs) i++;
    if (i > 0) this.win.splice(0, i);
  }
}
