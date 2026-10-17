/** Session-owned recovery, independent of focus polling and RTCP getStats(). */
export class HostCaptureRecovery {
  private pending: Promise<void> | null = null;
  constructor(
    private alive: () => boolean,
    private stop: () => Promise<void>,
    private start: () => Promise<void> | undefined,
    private onError: (error: unknown) => void,
  ) {}
  restart(): Promise<void> {
    if (!this.alive()) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        // Stop must complete before start: separate IPC requests are not an
        // ordering guarantee, and a late stop otherwise kills the new pipeline.
        await this.stop();
        if (!this.alive()) return;
        await this.start();
      } catch (error) { if (this.alive()) this.onError(error); }
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
}

export interface CaptureProgress { producedFrames: number; emittedFrames?: number }
export class CaptureStallWatchdog {
  private busy = false;
  private progress: number | null = null;
  private progressedAt = 0;
  constructor(
    private alive: () => boolean,
    private paused: () => boolean,
    private sample: () => Promise<CaptureProgress>,
    private recover: () => Promise<void>,
    private now: () => number = () => performance.now(),
  ) {}
  async poll(): Promise<void> {
    if (this.busy) return;
    if (!this.alive() || this.paused()) { this.progress = null; return; }
    this.busy = true;
    try {
      const sample = await this.sample();
      // An in-flight callback from a closed peer cannot restart its successor.
      if (!this.alive() || this.paused()) { this.progress = null; return; }
      const progress = sample.emittedFrames ?? sample.producedFrames;
      const now = this.now();
      if (progress !== this.progress) { this.progress = progress; this.progressedAt = now; }
      else if (now - this.progressedAt >= 5000) {
        this.progressedAt = now;
        await this.recover();
      }
    } catch { /* native backstop also covers an unresponsive IPC command */ }
    finally { this.busy = false; }
  }
}
