import { describe, expect, it } from "vitest";
import { DelayTrendline } from "./trendline";

/**
 * A bottleneck link in front of the guest, one DIRECT frame at a time. The GV
 * header (what the trendline times) waits behind the previous frame's bytes; the
 * frame completes after its own bytes. Arrivals get Wi-Fi-like jitter and, now and
 * then, aggregation (two frames delivered together).
 */
type Sim = {
  seconds: number;
  fps?: number;
  meanKB: number;
  capKbps: (tMs: number) => number;
  /** Every Nth frame is `bigMul`× the mean (scene change / IR wave). */
  bigEvery?: number;
  bigMul?: number;
  jitterMs?: number;
  aggregateProb?: number;
  seed?: number;
};
type Frame = { send: number; header: number; done: number };

function simulate(s: Sim): Frame[] {
  const fps = s.fps ?? 60;
  let seed = s.seed ?? 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const out: Frame[] = [];
  let linkFree = 0;
  let held = -1;
  const prop = 12;
  for (let i = 0; i < s.seconds * fps; i++) {
    const t = (i * 1000) / fps;
    let bytes = s.meanKB * 1024 * (0.6 + rnd() * 0.8);
    if (s.bigEvery && i > 0 && i % s.bigEvery === 0) bytes *= s.bigMul ?? 6;
    const start = Math.max(t, linkFree);
    const ser = (bytes * 8) / s.capKbps(t);
    linkFree = start + ser;
    let header = start + prop + rnd() * (s.jitterMs ?? 0);
    const done = linkFree + prop + rnd() * (s.jitterMs ?? 0);
    // Aggregation: the radio holds this frame and delivers it with the next.
    if (held >= 0) {
      header = Math.max(header, held);
      held = -1;
    } else if (rnd() < (s.aggregateProb ?? 0)) {
      held = header + 1000 / fps;
      header = held;
    }
    out.push({ send: t, header, done: Math.max(done, header) });
  }
  return out;
}

/** First time (ms) the detector reports overuse at or after `fromMs`, or -1. */
function firstOveruse(frames: Frame[], fromMs = 0): { at: number; count: number } {
  const d = new DelayTrendline();
  let at = -1;
  let count = 0;
  let prev = "normal";
  for (const f of frames) {
    const st = d.update(f.send, f.header);
    if (st === "overuse" && prev !== "overuse") {
      count++;
      if (at < 0 && f.send >= fromMs) at = f.send;
    }
    prev = st;
  }
  return { at, count };
}

/** When ABR v2's standing-queue rule (smoothed owd − min > 110 ms at 4 Hz) fires. */
function queueRuleFires(frames: Frame[], fromMs: number): number {
  let owd = 0;
  let min = Infinity;
  let ewma = 0;
  let nextReport = 0;
  for (const f of frames) {
    const sample = f.done - f.send;
    owd = owd === 0 ? sample : owd * 0.85 + sample * 0.15;
    min = Math.min(min, sample);
    if (f.send >= nextReport) {
      nextReport = f.send + 250;
      ewma = ewma * 0.6 + (owd - min) * 0.4;
      if (f.send >= fromMs && ewma > 110) return f.send;
    }
  }
  return -1;
}

/**
 * The rule rtcHost applies (ABR_GRAD_QUEUE_MS): a gradient overuse counts only
 * with a standing queue over 30 ms — the guest's EWMA'd one-way delay minus its
 * minimum, smoothed again by the host at each 4 Hz report. Returns when it first
 * fires at or after `fromMs` (relative), and how many reports it fired on.
 */
function hostRule(frames: Frame[], fromMs = 0, floorMs = 30): { at: number; reports: number } {
  const d = new DelayTrendline();
  let owd = 0;
  let min = Infinity;
  let ewma = 0;
  let nextReport = 0;
  let over = false;
  let at = -1;
  let reports = 0;
  for (const f of frames) {
    if (d.update(f.send, f.header) === "overuse") over = true;
    const sample = f.done - f.send;
    owd = owd === 0 ? sample : owd * 0.85 + sample * 0.15;
    min = Math.min(min, sample);
    if (f.send >= nextReport) {
      nextReport = f.send + 250;
      ewma = ewma * 0.6 + (owd - min) * 0.4;
      if (over && ewma > floorMs) {
        reports++;
        if (at < 0 && f.send >= fromMs) at = f.send - fromMs;
      }
      over = d.state === "overuse";
    }
  }
  return { at, reports };
}

// 8 Mb/s of video on average: 16.7 KB/frame at 60 fps.
const MEAN_KB = 16.7;
const RATE_KBPS = (MEAN_KB * 1024 * 8 * 60) / 1000;

describe("delay-gradient overuse detector (R7)", () => {
  const cleanLink: Sim = {
    seconds: 120,
    meanKB: MEAN_KB,
    capKbps: () => RATE_KBPS * 1.6,
    bigEvery: 180,
    bigMul: 6,
    jitterMs: 4,
    aggregateProb: 0.05,
  };

  it("the raw detector sees a big frame's burst as overuse (why the host needs a queue floor)", () => {
    expect(firstOveruse(simulate({ ...cleanLink, bigEvery: undefined })).count).toBe(0);
    expect(firstOveruse(simulate(cleanLink)).count).toBeGreaterThan(10);
  });

  it("with the 30 ms floor, a clean link with jitter, aggregation and 6x frames never cuts", () => {
    expect(hostRule(simulate(cleanLink)).reports).toBe(0);
  });

  it.each([
    [0.8, 600],
    [0.6, 300],
  ])("a drop to %sx capacity is caught in ≤ %i ms, at least twice as fast as the queue rule", (cap, within) => {
    const dropAt = 10_000;
    const frames = simulate({
      seconds: 20,
      meanKB: MEAN_KB,
      capKbps: (t) => (t < dropAt ? RATE_KBPS * 1.6 : RATE_KBPS * cap),
      jitterMs: 4,
      aggregateProb: 0.05,
      bigEvery: 180,
      bigMul: 6,
    });
    const grad = hostRule(frames, dropAt).at;
    const queue = queueRuleFires(frames, dropAt) - dropAt;
    expect(grad).toBeGreaterThanOrEqual(0);
    expect(grad).toBeLessThanOrEqual(within);
    expect(queue).toBeGreaterThanOrEqual(grad * 2);
  });

  it("a draining queue reads as underuse, then normal", () => {
    const d = new DelayTrendline();
    const frames = simulate({
      seconds: 12,
      meanKB: MEAN_KB,
      capKbps: (t) => (t < 4000 ? RATE_KBPS * 1.5 : t < 5000 ? RATE_KBPS * 0.5 : RATE_KBPS * 2),
    });
    const seen = new Set<string>();
    let last = "";
    for (const f of frames) {
      last = d.update(f.send, f.header);
      if (f.send > 5000) seen.add(last);
    }
    expect(seen.has("underuse")).toBe(true);
    expect(last).toBe("normal");
  });

  it("clock offsets cancel: the same link with the guest clock 5 s off gives the same answer", () => {
    const frames = simulate({ seconds: 8, meanKB: MEAN_KB, capKbps: (t) => (t < 4000 ? RATE_KBPS * 2 : RATE_KBPS * 0.7) });
    const a = new DelayTrendline();
    const b = new DelayTrendline();
    for (const f of frames) {
      a.update(f.send, f.header);
      b.update(f.send, f.header + 5000);
    }
    expect(b.state).toBe(a.state);
    expect(b.trend).toBeCloseTo(a.trend, 9);
  });

  it("a sender restart or a long gap starts over instead of inventing a trend", () => {
    const d = new DelayTrendline();
    for (let i = 0; i < 100; i++) d.update(10_000 + i * 16.7, 50 + i * 16.7 + i * 2); // growing queue
    expect(d.trend).toBeGreaterThan(0);
    d.update(5, 3000); // sender clock went backwards
    expect(d.trend).toBe(0);
    expect(d.state).toBe("normal");
  });
});
