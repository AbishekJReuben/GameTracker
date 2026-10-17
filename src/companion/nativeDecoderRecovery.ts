/** Recover silent MediaCodec/Surface stalls without treating an idle desktop or
 * an Android background/sleep gap as a decoder failure. Budgets survive codec
 * replacement: one good frame cannot refund an endless restart loop. */
export class NativeDecoderRecovery {
  private previous: { at: number; fed: number; output: string } | null = null;
  private fedAtProgress = 0;
  private stalledAt: number | null = null;
  private keyRequested = false;
  private restarts: number[] = [];

  resetProgress() {
    this.previous = null;
    this.stalledAt = null;
    this.keyRequested = false;
  }

  reset() { this.resetProgress(); this.restarts = []; }

  observe(sample: { now: number; fed: number; output: string; receiving: boolean; csdQueued: boolean }) {
    const prior = this.previous;
    this.previous = { at: sample.now, fed: sample.fed, output: sample.output };
    const result = (action: 'wait' | 'keyframe' | 'restart' | 'fallback', stalledMs = 0) =>
      ({ action, stalledMs, fedSinceProgress: Math.max(0, sample.fed - this.fedAtProgress) });
    if (!prior || sample.now - prior.at > 1500 || sample.now < prior.at ||
        sample.fed < prior.fed || sample.output !== prior.output) {
      this.fedAtProgress = sample.fed;
      this.stalledAt = null;
      this.keyRequested = false;
      return result('wait');
    }
    if (!sample.receiving || sample.fed <= this.fedAtProgress) {
      this.stalledAt = null;
      this.keyRequested = false;
      return result('wait');
    }
    this.stalledAt ??= sample.now;
    const stalledMs = sample.now - this.stalledAt;
    // First heal a lost reference chain, without disturbing a healthy codec.
    if (!this.keyRequested && stalledMs >= 750) {
      this.keyRequested = true;
      return result('keyframe', stalledMs);
    }
    if (stalledMs < (sample.csdQueued ? 2000 : 8000)) return result('wait', stalledMs);
    this.restarts = this.restarts.filter(at => sample.now - at < 60000);
    if (this.restarts.length >= 2) return result('fallback', stalledMs);
    this.restarts.push(sample.now);
    const restart = result('restart', stalledMs);
    this.resetProgress();
    return restart;
  }
}
