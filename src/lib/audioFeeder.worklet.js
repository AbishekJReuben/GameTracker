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
 * Logic (ported from the old node, tuned against earlier pop complaints):
 *  - PRIME before (re)starting playback so delivery bursts are absorbed.
 *  - A streaming linear resampler consumes input at `captureRate / sampleRate`
 *    (WASAPI runs at the endpoint's mix rate — 44.1k/96k/192k, not always 48k),
 *    nudged ±0.4% (inaudible) to steer the buffer toward TARGET, so clock skew
 *    never forces a trim or an underrun in steady state.
 *  - A slew-limited gain ramp (~6ms) makes every silence↔audio edge click-free.
 *  - TARGET grows on each underrun up to `maxMs`, and eases back after ~10s clean.
 *
 * Buffer envelope is configurable via `{cfg:{primeMs,targetMs,maxMs}}` so the
 * host's RTC feeder (wider, absorbs IPC jitter) and the phone's DIRECT feeder
 * (lean, matches the near-instant video path) can share one processor.
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
    // Defaults = lean DIRECT profile; the host RTC path widens these via cfg.
    // Latency floor (12ms prime / 18ms target) is tuned for the DIRECT path:
    // the data channel delivers PCM in bursts but the AudioWorklet runs at
    // audio-thread priority, so a small buffer clears faster after a stall
    // and keeps total audio latency within one frame of the video path.
    this.primeMs = 12;
    this.targetMs = 18;
    this.maxMs = 90;
    this.baseTargetMs = 18;
    this.priming = true;
    this.gain = 0;
    // Resampler state: interpolating between input frames f0 and f1, phase∈[0,1).
    this.phase = 0;
    this.f0 = new Float32Array(2);
    this.f1 = new Float32Array(2);
    this.cleanQuanta = 0;
    this.underruns = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof ArrayBuffer) {
        const f32 = new Float32Array(d);
        this.chunks.push(f32);
        this.avail += f32.length;
        // Runaway-latency guard: past target+headroom, trim back to target in one
        // splice (rare — steady-state drift is handled by the resampler).
        const max = this.ms(Math.min(this.maxMs, this.targetMs + 80));
        if (this.avail > max) this.drop(this.avail - this.ms(this.targetMs));
        return;
      }
      if (d && d.cfg) {
        const ch = Math.max(1, Math.min(2, d.cfg.channels | 0));
        const rate = d.cfg.captureRate > 8000 ? d.cfg.captureRate : sampleRate;
        if (typeof d.cfg.primeMs === "number") this.primeMs = Math.max(10, Math.min(120, d.cfg.primeMs));
        if (typeof d.cfg.targetMs === "number") {
          this.baseTargetMs = Math.max(15, Math.min(200, d.cfg.targetMs));
          this.targetMs = this.baseTargetMs;
        }
        if (typeof d.cfg.maxMs === "number") this.maxMs = Math.max(this.baseTargetMs, Math.min(300, d.cfg.maxMs));
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
    const targetFrames = this.ms(this.targetMs) / this.channels;
    const availFrames = this.avail / this.channels;
    const err = targetFrames > 0 ? (availFrames - targetFrames) / targetFrames : 0;
    const ratio = (this.captureRate / sampleRate) * (1 + Math.max(-0.004, Math.min(0.004, err * 0.05)));
    const slew = 1 / Math.max(1, 0.006 * sampleRate); // ~6ms full fade in/out

    let g = this.gain;
    let underran = false;
    for (let i = 0; i < frames; i++) {
      const tgt = underran ? 0 : 1;
      g += Math.max(-slew, Math.min(slew, tgt - g));
      for (let c = 0; c < nch; c++) {
        const src = Math.min(c, this.channels - 1);
        out[c][i] = (this.f0[src] * (1 - this.phase) + this.f1[src] * this.phase) * g;
      }
      this.phase += ratio;
      while (this.phase >= 1) {
        this.phase -= 1;
        this.f0.set(this.f1);
        if (!this.readFrameInto(this.f1)) {
          // Buffer emptied mid-quantum: hold the last frame and fade out.
          this.f1.set(this.f0);
          underran = true;
        }
      }
    }
    this.gain = g;

    if (underran) {
      this.cleanQuanta = 0;
      this.underruns++;
      // Bursty delivery (game hogging the CPU delays chunk forwarding): hold
      // more audio before resuming so the next gap fits inside the buffer.
      // Step is +12ms (was 25) so a single underrun can't blow past the video
      // path's latency budget; repeated underruns still climb toward maxMs.
      this.targetMs = Math.min(this.maxMs, this.targetMs + 12);
      // Ran fully dry → refill to PRIME before resuming (prevents machine-gun
      // clicking when the stream is briefly starved).
      if (this.avail < this.channels) this.priming = true;
    } else if (++this.cleanQuanta * frames > sampleRate * 6 && this.targetMs > this.baseTargetMs) {
      // ~6s clean (was 10) → ease latency back down one step. Faster ease-back
      // keeps the post-underrun dwell short so total audio lag tracks the video.
      this.cleanQuanta = 0;
      this.targetMs = Math.max(this.baseTargetMs, this.targetMs - 6);
    }
    return true;
  }
}

registerProcessor("gt-pcm-feeder", GtPcmFeeder);
