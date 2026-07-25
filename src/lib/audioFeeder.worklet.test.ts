import { describe, expect, it } from "vitest";

// Vite serves the worklet's own source as a string — no filesystem access, and
// the test therefore exercises exactly the file that ships.
import SRC from "./audioFeeder.worklet.js?raw";

/**
 * The worklet is a plain script for the audio rendering thread — no imports, no
 * bundler entry — so it is loaded here the same way the browser does: evaluated
 * against the globals `AudioWorkletProcessor` / `registerProcessor` /
 * `sampleRate`. That keeps the file itself free of test-only exports.
 */
const RATE = 48000;

type Feeder = {
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
  process: (inputs: unknown[], outputs: Float32Array[][]) => boolean;
  plcPeriod: number;
};

function makeFeeder(cfg: Record<string, unknown>): Feeder {
  let Ctor: (new () => Feeder) | null = null;
  new Function(
    "sampleRate",
    "AudioWorkletProcessor",
    "registerProcessor",
    SRC,
  )(
    RATE,
    class {
      port = { onmessage: null, postMessage: () => {} };
    },
    (_name: string, cls: new () => Feeder) => {
      Ctor = cls;
    },
  );
  if (!Ctor) throw new Error("worklet did not registerProcessor");
  const feeder = new (Ctor as new () => Feeder)();
  feeder.port.onmessage?.({ data: { cfg: { channels: 2, captureRate: RATE, ...cfg } } });
  return feeder;
}

/** Play `quanta` render blocks and return the left channel, concatenated. */
function pull(feeder: Feeder, quanta: number): number[] {
  const out = [[new Float32Array(128), new Float32Array(128)]];
  const acc: number[] = [];
  for (let i = 0; i < quanta; i++) {
    feeder.process([], out);
    acc.push(...out[0][0]);
  }
  return acc;
}

/** Feed a steady tone, consuming as we go so the buffer never runs away. */
function feedTone(feeder: Feeder, hz: number, quanta: number, phase = { n: 0 }) {
  for (let k = 0; k < quanta; k++) {
    const a = new Float32Array(128 * 2);
    for (let i = 0; i < 128; i++) {
      const v = Math.sin((2 * Math.PI * hz * phase.n++) / RATE);
      a[i * 2] = v;
      a[i * 2 + 1] = v;
    }
    feeder.port.onmessage?.({ data: a.buffer });
    pull(feeder, 1);
  }
}

const rms = (xs: number[]) => Math.sqrt(xs.reduce((s, v) => s + v * v, 0) / xs.length);

describe("gt-pcm-feeder concealment", () => {
  it("locks onto the waveform's pitch period when a hole opens (plc)", () => {
    const f = makeFeeder({ primeMs: 25, targetMs: 35, maxMs: 180, conceal: "plc" });
    feedTone(f, 220, 160);
    pull(f, 15); // starve
    // 48000 / 220 ≈ 218 samples. An off-by-a-few is fine (the crossfade absorbs
    // it); an answer near the search bounds would mean the search is broken.
    expect(f.plcPeriod).toBeGreaterThan(200);
    expect(f.plcPeriod).toBeLessThan(240);
  });

  it("keeps the level up through a hole instead of sliding toward silence", () => {
    const f = makeFeeder({ primeMs: 25, targetMs: 35, maxMs: 180, conceal: "plc" });
    feedTone(f, 220, 160);
    const dry = pull(f, 12);
    // A held/decayed sample collapses toward DC almost immediately; a looped
    // period keeps roughly the source's energy (0.707 for a full-scale sine).
    expect(rms(dry.slice(-512))).toBeGreaterThan(0.3);
  });

  it("gives up rather than droning when the hole runs long", () => {
    const f = makeFeeder({ primeMs: 25, targetMs: 35, maxMs: 180, conceal: "plc" });
    feedTone(f, 220, 160);
    // ~250ms dry — far past the 80ms synthesis cap.
    const dry = pull(f, 95);
    expect(rms(dry.slice(-512))).toBeLessThan(0.05);
  });

  it("leaves the default 'hold' path alone", () => {
    // The RTC feeder and every pre-STUDIO client run this branch; it must stay
    // the shipped behaviour (decay toward the last sample, no period search).
    const f = makeFeeder({ primeMs: 40, targetMs: 65, maxMs: 240 });
    feedTone(f, 220, 160);
    pull(f, 15);
    expect(f.plcPeriod).toBe(0);
  });
});
