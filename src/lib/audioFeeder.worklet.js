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
 * Playout model (v3 — continuous, bounded concealment):
 *  - PRIME before (re)starting so delivery bursts are absorbed.
 *  - Streaming linear resampler at `captureRate / sampleRate`, nudged ±0.25%
 *    toward TARGET (tighter than ±0.4% — less stretchy "robotic" pitch hunt).
 *  - On a known packet gap: interpolate from the previous sample toward the
 *    next real packet with a smoothstep bridge. This avoids both gain pumping
 *    and the pitched buzz caused by repeating one sample.
 *  - On a true buffer underrun: decay the last sample very slowly until audio
 *    resumes; never synthesize a full-amplitude constant tone.
 *  - TARGET grows on each underrun up to `maxMs`; eases back after ~8s clean.
 *  - Seq-gap concealment is capped at 60ms so a damaged link cannot manufacture
 *    an unbounded stretch of synthetic audio.
 *
 * Buffer envelope is configurable via `{cfg:{primeMs,targetMs,maxMs}}` so the
 * host's RTC feeder (wider, absorbs IPC jitter) and the phone's DIRECT feeder
 * (leaner) can share one processor.
 *
 * `{cfg:{conceal}}` picks how a hole is filled:
 *  - `"hold"` (default, unchanged): decay the last sample / smoothstep across a
 *    known gap. Cheap and safe, but it is a DC-ward slide — on music or speech
 *    a stretch of it is exactly the metallic artefact people call "robotic".
 *  - `"plc"`: real packet-loss concealment. Find the waveform's pitch period by
 *    normalised autocorrelation, then loop that period with a crossfade at the
 *    seam and a per-repetition decay. Pitch and timbre survive, so a repaired
 *    hole is inaudible rather than merely quiet. Used by the STUDIO wire, whose
 *    redundancy makes holes rare enough that spending a few hundred µs on the
 *    ones that get through is free.
 *
 * No per-frame allocations in `process()` — GC pauses on the audio thread are
 * themselves a crackle source. The PLC history ring and scratch buffers are
 * allocated once per format change, and the period search runs ONCE per hole,
 * not per sample.
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
    this.pendingGapMs = 0;
    // ---- concealment ---------------------------------------------------------
    /** "hold" (shipped behaviour) or "plc" (pitch-looping, see the header). */
    this.conceal = "hold";
    /** Interleaved ring of recently PLAYED input frames — the PLC source. */
    this.hist = null;
    this.histFrames = 0; // capacity in frames
    this.histWrite = 0; // next write position, in frames
    this.histFilled = 0; // frames actually written (bounds the period search)
    /** A run is in progress (armed) — distinct from `plcPeriod > 0`, because a
     *  run can legitimately arm and find NO usable period, and re-searching
     *  every frame after that would be a real-time-thread stall. */
    this.plcArmed = false;
    /** Period of the live run, in frames. 0 = none found. */
    this.plcPeriod = 0;
    this.plcPhase = 0;
    this.plcGain = 1;
    this.plcFrames = 0; // frames synthesized in this run (bounds the run)
    this.plcXfade = 0; // crossfade length at the loop seam, in frames
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof ArrayBuffer) {
        const f32 = new Float32Array(d);
        if (this.pendingGapMs > 0) {
          this.bridgeGap(f32, this.pendingGapMs);
          this.pendingGapMs = 0;
        }
        this.chunks.push(f32);
        this.avail += f32.length;
        // Runaway-latency guard: past target+headroom, trim back to target in one
        // splice (rare — steady-state drift is handled by the resampler).
        const max = this.ms(Math.min(this.maxMs, this.targetMs + 100));
        if (this.avail > max) this.drop(this.avail - this.ms(this.targetMs));
        return;
      }
      if (d && typeof d.gap === "number") {
        // Wait for the next real packet so the gap can bridge toward its first
        // sample. Repeating a constant sample creates an audible pitched buzz.
        this.pendingGapMs = Math.min(60, this.pendingGapMs + Math.max(0, d.gap));
        return;
      }
      if (d && d.cfg) {
        const ch = Math.max(1, Math.min(2, d.cfg.channels | 0));
        const rate = d.cfg.captureRate > 8000 ? d.cfg.captureRate : sampleRate;
        if (typeof d.cfg.primeMs === "number") this.primeMs = Math.max(10, Math.min(160, d.cfg.primeMs));
        if (typeof d.cfg.targetMs === "number") {
          // Only reset the LIVE target when the base actually changes: cfg may be
          // re-sent periodically (the DIRECT channel is time-bounded, so an old
          // config can still expire), and clamping targetMs back down on every
          // repeat would erase the adaptive underrun growth right when it's needed.
          const base = Math.max(20, Math.min(250, d.cfg.targetMs));
          if (base !== this.baseTargetMs) {
            this.baseTargetMs = base;
            this.targetMs = base;
          }
        }
        if (typeof d.cfg.maxMs === "number") this.maxMs = Math.max(this.baseTargetMs, Math.min(400, d.cfg.maxMs));
        if (d.cfg.conceal === "plc" || d.cfg.conceal === "hold") this.conceal = d.cfg.conceal;
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
          this.allocHistory();
        }
        if (this.conceal === "plc" && !this.hist) this.allocHistory();
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

  // ---- PLC: pitch-looping concealment ---------------------------------------

  /** Longest pitch period we will look for (~50Hz) — also the history we need. */
  plcMaxLag() {
    return Math.round(this.captureRate * 0.02);
  }

  /** Shortest (~500Hz). Below this a "period" is more likely to be noise. */
  plcMinLag() {
    return Math.max(8, Math.round(this.captureRate * 0.002));
  }

  /** (Re)allocate the history ring. Sized for two periods plus a search window,
   *  which is what the crossfaded loop reads. Allocated on format change only. */
  allocHistory() {
    const frames = Math.max(256, this.plcMaxLag() * 3);
    this.hist = new Float32Array(frames * this.channels);
    this.histFrames = frames;
    this.histWrite = 0;
    this.histFilled = 0;
    this.plcPeriod = 0;
  }

  /** Remember one played input frame (the PLC source material). */
  noteHistory(frame) {
    const h = this.hist;
    if (!h) return;
    const base = this.histWrite * this.channels;
    for (let c = 0; c < this.channels; c++) h[base + c] = frame[c];
    this.histWrite = (this.histWrite + 1) % this.histFrames;
    if (this.histFilled < this.histFrames) this.histFilled++;
  }

  /** Read history `back` frames before the write head, channel `c`. */
  histAt(back, c) {
    let i = this.histWrite - back;
    while (i < 0) i += this.histFrames;
    return this.hist[i * this.channels + c];
  }

  /**
   * Start a concealment run: pick the period whose repetition best matches the
   * most recent audio. Normalised correlation (not raw) so a decaying note
   * doesn't bias every answer toward the shortest lag. Runs once per hole —
   * ~20k multiply-adds, well inside one 2.7ms render quantum.
   */
  plcArm() {
    if (!this.hist) this.allocHistory();
    const maxLag = this.plcMaxLag();
    const minLag = this.plcMinLag();
    this.plcArmed = true;
    this.plcPhase = 0;
    this.plcGain = 1;
    this.plcFrames = 0;
    if (this.histFilled < maxLag * 2) {
      // Not enough material to find a period (session just started) — fall back
      // to the hold behaviour rather than looping garbage.
      this.plcPeriod = 0;
      return;
    }
    const win = maxLag;
    let bestLag = minLag;
    let bestScore = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let dot = 0;
      let energy = 0;
      for (let n = 0; n < win; n++) {
        const a = this.histAt(win - n, 0);
        const b = this.histAt(win - n + lag, 0);
        dot += a * b;
        energy += b * b;
      }
      // +1e-9 keeps silence from scoring as a perfect match at every lag.
      const score = dot / Math.sqrt(energy + 1e-9);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    this.plcPeriod = bestLag;
    // Crossfade the seam over a quarter period, capped at 2ms. Even the best
    // period is only approximate; without this the loop point ticks.
    this.plcXfade = Math.min(Math.floor(bestLag / 4), Math.round(this.captureRate * 0.002));
  }

  /**
   * Produce the next concealed frame into `dst`. Returns false when there is no
   * usable period (caller falls back to hold) or the run has gone on so long
   * that continuing would be inventing music rather than covering a hole.
   */
  plcNext(dst) {
    const p = this.plcPeriod;
    if (p <= 0 || !this.hist) return false;
    // Cap a run at 80ms. Past that the link is not "hiccuping", it is down, and
    // silence is more honest than a synthesized drone.
    if (this.plcFrames > this.captureRate * 0.08) return false;
    const r = this.plcPhase;
    const xf = this.plcXfade;
    const g = this.plcGain;
    for (let c = 0; c < this.channels; c++) {
      // The looped segment is the last `p` frames of real audio.
      let v = this.histAt(p - r, c);
      if (xf > 0 && r >= p - xf) {
        // Approaching the seam: fade into what precedes the loop start, which
        // is the sample that will follow once the phase wraps.
        const t = (r - (p - xf)) / xf;
        const pre = this.histAt(2 * p - r, c);
        v = v * (1 - t) + pre * t;
      }
      dst[c] = v * g;
    }
    this.plcPhase++;
    this.plcFrames++;
    if (this.plcPhase >= p) {
      this.plcPhase = 0;
      // ~-1dB per repetition: a held note fades naturally instead of buzzing.
      this.plcGain *= 0.89;
    }
    return true;
  }

  /** End a concealment run (real audio is available again). */
  plcClear() {
    this.plcArmed = false;
    this.plcPeriod = 0;
    this.plcPhase = 0;
    this.plcGain = 1;
    this.plcFrames = 0;
  }

  /**
   * Bridge a known gap between the last buffered sample and the next packet.
   * Smoothstep gives both joins zero slope and avoids the pitched constant hold.
   */
  bridgeGap(next, gapMs) {
    if (this.priming || !(gapMs > 0) || next.length < this.channels) return;
    const frames = Math.round((this.captureRate * Math.min(gapMs, 60)) / 1000);
    if (frames <= 0) return;
    const ch = this.channels;
    if (this.conceal === "plc") {
      // Fill the known hole with real concealment rather than a slide toward
      // the next packet's first sample. Same length, same seam behaviour — but
      // the listener hears the note continue instead of a swoop.
      this.plcArm();
      if (this.plcPeriod > 0) {
        const fill = new Float32Array(frames * ch);
        const frame = new Float32Array(ch);
        let n = 0;
        for (; n < frames; n++) {
          if (!this.plcNext(frame)) break;
          for (let c = 0; c < ch; c++) fill[n * ch + c] = frame[c];
        }
        this.plcClear();
        if (n > 0) {
          const used = n === frames ? fill : fill.subarray(0, n * ch);
          this.chunks.push(used);
          this.avail += used.length;
        }
        return;
      }
      // No usable period yet — fall through to the smoothstep bridge.
    }
    const tailChunk = this.chunks[this.chunks.length - 1];
    const fill = new Float32Array(frames * ch);
    for (let i = 0; i < frames; i++) {
      const x = (i + 1) / (frames + 1);
      const t = x * x * (3 - 2 * x);
      for (let c = 0; c < ch; c++) {
        const a = tailChunk ? tailChunk[tailChunk.length - ch + c] || 0 : this.f1[c] || 0;
        fill[i * ch + c] = a + ((next[c] || 0) - a) * t;
      }
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
        if (this.readFrameInto(this.f1)) {
          // Real audio again — end any concealment run and keep the history
          // that the NEXT run will be built from.
          if (this.plcArmed) this.plcClear();
          if (this.conceal === "plc") this.noteHistory(this.f1);
        } else {
          // Dry. With PLC, continue the waveform's own pitch; otherwise decay
          // smoothly (a constant sample is an audible buzz either way).
          let filled = false;
          if (this.conceal === "plc") {
            if (!this.plcArmed) this.plcArm();
            filled = this.plcNext(this.f1);
          }
          if (!filled) {
            for (let c = 0; c < this.channels; c++) this.f1[c] = this.f0[c] * 0.999;
          }
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
