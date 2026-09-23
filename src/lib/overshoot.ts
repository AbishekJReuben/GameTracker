/**
 * NVENC overshoot correction (research R7, docs/STREAMING_RESEARCH_2026-09.md).
 *
 * NVENC's ultra-low-latency rate control over-delivers low targets on busy content
 * (measured at a 1-frame VBV: a 3 Mb/s command produced 4.5 Mb/s, 6 → 7.5 Mb/s).
 * The bitrate controller decides what should actually reach the wire, so the
 * command handed to NVENC is that rate divided by the overshoot NVENC measurably
 * has. The factor is sampled only in windows where the encoder is visibly binding
 * (output ≥ 90 % of the command, no keyframe, not paused) — light content says
 * nothing about overshoot — and relaxes toward 1 while the screen stays light, so
 * a stale factor can't under-deliver when it gets busy again.
 */
export class OvershootEstimator {
  /** Measured output ÷ command (≥ 1). */
  factor = 1;
  /** Last rate commanded to the encoder (kbps, after correction). */
  cmdKbps = 0;
  /** The factor the current command was computed with. */
  private cmdFactor = 1;
  private winBytes = 0;
  private winStart = 0;
  private winKey = false;
  private winPaused = false;

  constructor(
    private readonly windowMs = 1000,
    private readonly max = 1.8,
    private readonly minCmdKbps = 500,
  ) {}

  /** The command to hand the encoder for a desired on-wire rate (kbps). */
  command(kbps: number): number {
    if (!(kbps > 0)) return kbps;
    this.cmdFactor = this.factor;
    this.cmdKbps = Math.max(this.minCmdKbps, Math.round(kbps / this.factor));
    return this.cmdKbps;
  }

  /**
   * Account one encoded frame. Returns the new factor when it has drifted ≥ 0.04
   * from the one the live command used (worth re-commanding), else null.
   */
  note(bytes: number, key: boolean, paused: boolean, now: number): number | null {
    if (this.winStart === 0) this.winStart = now;
    this.winBytes += bytes;
    this.winKey ||= key;
    this.winPaused ||= paused;
    const span = now - this.winStart;
    if (span < this.windowMs) return null;
    const outKbps = (this.winBytes * 8) / span; // bytes·8 per ms = kbit/s
    const clean = !this.winKey && !this.winPaused && this.cmdKbps > 0;
    const binding = clean && outKbps >= this.cmdKbps * 0.9;
    this.winBytes = 0;
    this.winStart = now;
    this.winKey = false;
    this.winPaused = false;
    const prev = this.factor;
    if (binding) {
      // The factor converges on output-per-unit-commanded, so output ≈ asked.
      this.factor = Math.min(this.max, Math.max(1, prev * 0.7 + (outKbps / this.cmdKbps) * 0.3));
    } else if (clean && prev > 1) {
      this.factor = 1 + (prev - 1) * 0.95;
    }
    return Math.abs(this.factor - this.cmdFactor) >= 0.04 ? this.factor : null;
  }
}
