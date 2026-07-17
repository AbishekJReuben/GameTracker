/**
 * "gt-pcm-feeder" — plays raw interleaved float32 PCM pushed from the desktop
 * host (WASAPI loopback → Tauri channel → `port.postMessage`, transferred).
 *
 * This runs on the browser's dedicated real-time audio rendering thread. It
 * replaced a main-thread ScriptProcessorNode on purpose: whenever a game loaded
 * the machine (or the webview was busy compositing screen frames) the main
 * thread missed audio deadlines and the phone heard crackling. Keep ALL audio
 * work in here — the main thread only forwards chunks.
 *
 * Playout model (v2 — "hold, don't fade"):
 *  - PRIME before (re)starting so delivery bursts are absorbed.
 *  - Streaming linear resampler at `captureRate / sampleRate`, nudged ±0.25%
 *    toward TARGET (tighter than ±0.4% — less stretchy "robotic" pitch hunt).
 *  - On underrun: HOLD the last sample at full gain. The old fade-out/fade-in
 *    on every brief gap is what users heard as choppy/robotic DIRECT audio —
 *    amplitude pumping on a 10–30ms cadence. A held sample clicks far less
 *    than a gain envelope, and keeps NetEQ-/worklet-fed RTC from pumping too.
 *  - TARGET grows on each underrun up to `maxMs`; eases back after ~8s clean.
 *  - Seq-gap concealment fills holes with a short crossfaded hold (not a fade
 *    to silence) so losses don't drain the buffer into another underrun.
 *
 * Buffer envelope is configurable via `{cfg:{primeMs,targetMs,maxMs}}` so the
 * host's RTC feeder (wider, absorbs IPC jitter) and the phone's DIRECT feeder
 * (leaner) can share one processor.
 *
 * No per-frame allocations in `process()` — GC pauses on the audio thread are
 * themselves a crackle source.
 */
class GtPcmFeeder extends AudioWorkletProcessor {
  constructor() {
    super();
    // Assumed format until the host posts the real one ({cfg}) after capture
    // starts; a mismatch resets the buffer and re-primes (startup blip only).
    this.channels = 2;
    this.captureRate = sampleRate;
    // Bounded jitter buffer: interleaved float32 chunks + a read head.
    this.chunks = [];
    this.head = 0;
    this.avail = 0; // interleaved samples currently buffered
    // Envelope (ms): prime, steer toward target, trim runaway latency.
    // Defaults = DIRECT profile (callers override). Wider than the old 20/30
    // so a single SCTP burst gap under video load doesn't underrun.
    this.primeMs = 40;
    this.targetMs = 65;
    this.maxMs = 240;
    this.baseTargetMs = 65;
    this.priming = true;
    this.gain = 0;
    // Resampler state: interpolating between input frames f0 and f1, phase∈[0,1).
    this.phase = 0;
    this.f0 = new Float32Array(2);
    this.f1 = new Float32Array(2);
    this.cleanQuanta = 0;
    this.underruns = 0;
    /** Consecutive quanta spent holding (for slow re-prime only when truly dry). */
    this.holdQuanta = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof ArrayBuffer) {
        const f32 = new Float32Array(d);
        this.chunks.push(f32);
        this.avail += f32.length;
        // Runaway-latency guard: past target+headroom, trim back to target in one
        // splice (rare — steady-state drift is handled by the resampler).
        const max = this.ms(Math.min(this.maxMs, this.targetMs + 100));
        if (this.avail > max) this.drop(this.avail - this.ms(this.targetMs));
        return;
      }
      if (d && typeof d.gap === "number") {
        // Conceal a known upstream loss (dropped Opus packets — the DIRECT
        // channel is lossy by design and WebCodecs' AudioDecoder has no
        // FEC/PLC hook). Fill with a crossfaded hold so level stays up and
        // the next real packet joins without a gain pump.
        this.conceal(d.gap);
        return;
      }
      if (d && d.cfg) {
        const ch = Math.max(1, Math.min(2, d.cfg.channels | 0));
        const rate = d.cfg.captureRate > 8000 ? d.cfg.captureRate : sampleRate;
        if (typeof d.cfg.primeMs === "number") this.primeMs = Math.max(10, Math.min(160, d.cfg.primeMs));
        if (typeof d.cfg.targetMs === "number") {
          // Only reset the LIVE target when the base actually changes: cfg may be
          // re-sent periodically (the DIRECT channel is lossy, so the host repeats
          // it), and clamping targetMs back down on every repeat would erase the
          // adaptive underrun growth right when it's needed.
          const base = Math.max(20, Math.min(250, d.cfg.targetMs));
          if (base !== this.baseTargetMs) {
            this.baseTargetMs = base;
            this.targetMs = base;
          }
        }
        if (typeof d.cfg.maxMs === "number") this.maxMs = Math.max(this.baseTargetMs, Math.min(400, d.cfg.maxMs));
        if (ch !== this.channels || rate !== this.captureRate) {
          // Framing changed: buffered bytes were queued under the old
          // assumption — drop them and re-prime.
          this.channels = ch;
          this.captureRate = rate;
          this.chunks = [];
          this.head = 0;
          this.avail = 0;
          this.priming = true;
          this.phase = 0;
          this.holdQuanta = 0;
        }
        // Stats poll from the main thread.
        if (d.cfg.stats) {
          this.port.postMessage({
            stats: {
              bufMs: this.channels ? (this.avail / this.channels / sampleRate) * 1000 : 0,
              targetMs: this.targetMs,
              priming: this.priming,
              underruns: this.underruns,
            },
          });
        }
      }
    };
  }

  /** ms → interleaved sample count at the context rate. */
  ms(m) {
    return Math.round((sampleRate * m) / 1000) * this.channels;
  }

  /**
   * Synthesize `gapMs` of filler (capped at 60ms) from a hold of the last
   * buffered sample, with a soft attack so the leading seam doesn't click.
   * Keep gain near full — the old decaying hold (0.85→0.5) pumped amplitude on
   * every lost Opus frame and read as robotic chop under video load.
   */
  conceal(gapMs) {
    if (this.priming || this.avail < this.channels || !(gapMs > 0)) return;
    const frames = Math.round((this.captureRate * Math.min(gapMs, 60)) / 1000);
    if (frames <= 0) return;
    const ch = this.channels;
    const tailChunk = this.chunks[this.chunks.length - 1];
    const tail = new Float32Array(ch);
    for (let c = 0; c < ch; c++) tail[c] = tailChunk[tailChunk.length - ch + c] || 0;
    const fill = new Float32Array(frames * ch);
    const attack = Math.min(48, frames);
    for (let i = 0; i < frames; i++) {
      const a = i < attack ? i / attack : 1;
      const g = a * 0.97; // soft attack, then near-full hold (no decay pump)
      for (let c = 0; c < ch; c++) fill[i * ch + c] = tail[c] * g;
    }
    this.chunks.push(fill);
    this.avail += fill.length;
  }

  /** Discard n interleaved samples from the front of the buffer. */
  drop(n) {
    while (n > 0 && this.chunks.length) {
      const c = this.chunks[0];
      const take = Math.min(n, c.length - this.head);
      this.head += take;
      this.avail -= take;
      n -= take;
      if (this.head >= c.length) {
        this.chunks.shift();
        this.head = 0;
      }
    }
  }

  /** Read one interleaved input frame into dst (no alloc); false on underrun. */
  readFrameInto(dst) {
    if (this.avail < this.channels) return false;
    let got = 0;
    while (got < this.channels && this.chunks.length) {
      const c = this.chunks[0];
      const take = Math.min(this.channels - got, c.length - this.head);
      for (let i = 0; i < take; i++) dst[got + i] = c[this.head + i];
      got += take;
      this.head += take;
      this.avail -= take;
      if (this.head >= c.length) {
        this.chunks.shift();
        this.head = 0;
      }
    }
    return got === this.channels;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const nch = out.length;
    const frames = out[0].length; // render quantum (128)
    // Stay silent (and faded down) until enough is buffered to play cleanly.
    if (this.priming) {
      if (this.avail >= this.ms(this.primeMs)) {
        this.priming = false;
        this.holdQuanta = 0;
        if (!this.readFrameInto(this.f0)) this.f0.fill(0);
        if (!this.readFrameInto(this.f1)) this.f1.set(this.f0);
        this.phase = 0;
      } else {
        for (let c = 0; c < nch; c++) out[c].fill(0);
        this.gain = 0;
        return true;
      }
    }

    // Drift-adaptive playback ratio: steer buffered frames toward TARGET.
    // ±0.25% (was ±0.4%) — less audible pitch hunt when the buffer breathes.
    const targetFrames = this.ms(this.targetMs) / this.channels;
    const availFrames = this.avail / this.channels;
    const err = targetFrames > 0 ? (availFrames - targetFrames) / targetFrames : 0;
    const ratio = (this.captureRate / sampleRate) * (1 + Math.max(-0.0025, Math.min(0.0025, err * 0.04)));
    // Fast attack when coming out of prime; slow release unused (we hold now).
    const slewUp = 1 / Math.max(1, 0.004 * sampleRate); // ~4ms fade-in from silence

    let g = this.gain;
    let holding = false;
    for (let i = 0; i < frames; i++) {
      // Always steer gain toward 1 while playing — never pump to 0 on a brief hold.
      g += Math.min(slewUp, 1 - g);
      for (let c = 0; c < nch; c++) {
        const src = Math.min(c, this.channels - 1);
        out[c][i] = (this.f0[src] * (1 - this.phase) + this.f1[src] * this.phase) * g;
      }
      this.phase += ratio;
      while (this.phase >= 1) {
        this.phase -= 1;
        this.f0.set(this.f1);
        if (!this.readFrameInto(this.f1)) {
          // Hold last frame at full level — no fade-out. That's the new approach.
          this.f1.set(this.f0);
          holding = true;
        }
      }
    }
    this.gain = g;

    if (holding) {
      this.cleanQuanta = 0;
      this.underruns++;
      this.holdQuanta++;
      // Grow the cushion so the next burst gap fits. Bigger step than before so
      // one congestion event doesn't become a string of holds.
      this.targetMs = Math.min(this.maxMs, this.targetMs + 25);
      // Only re-prime after ~80ms of continuous hold with a dry buffer — avoids
      // the machine-gun silence/restart that made DIRECT sound robotic.
      if (this.avail < this.channels && this.holdQuanta * frames > sampleRate * 0.08) {
        this.priming = true;
        this.holdQuanta = 0;
      }
    } else {
      this.holdQuanta = 0;
      if (++this.cleanQuanta * frames > sampleRate * 8 && this.targetMs > this.baseTargetMs) {
        this.cleanQuanta = 0;
        this.targetMs = Math.max(this.baseTargetMs, this.targetMs - 4);
      }
    }
    return true;
  }
}

registerProcessor("gt-pcm-feeder", GtPcmFeeder);
