import { describe, expect, it } from "vitest";
import { OvershootEstimator } from "./overshoot";

/** Drive the estimator with a model encoder: output(cmd) kbps at 60 fps for `secs`. */
function run(
  est: OvershootEstimator,
  wantKbps: number,
  output: (cmdKbps: number) => number,
  secs: number,
  opts: { t0?: number; key?: (i: number) => boolean; paused?: boolean } = {},
) {
  let cmd = est.command(wantKbps);
  let t = opts.t0 ?? 0;
  let out = 0;
  for (let i = 0; i < secs * 60; i++) {
    t += 1000 / 60;
    out = output(cmd);
    const bytes = (out * 1000) / 8 / 60;
    if (est.note(bytes, opts.key?.(i) ?? false, opts.paused ?? false, t) !== null) cmd = est.command(wantKbps);
  }
  return { cmd, out, t };
}

describe("OvershootEstimator", () => {
  it("converges a multiplicative 1.5× overshoot so output matches the ask", () => {
    const est = new OvershootEstimator();
    const { out } = run(est, 3000, (c) => c * 1.5, 30);
    expect(est.factor).toBeGreaterThan(1.4);
    expect(out).toBeGreaterThan(2850);
    expect(out).toBeLessThan(3150);
  });

  it("handles the measured additive shape (3 → 4.5, 6 → 7.5 Mb/s) at 6 Mb/s", () => {
    const est = new OvershootEstimator();
    const { out } = run(est, 6000, (c) => c + 1500, 40);
    expect(Math.abs(out - 6000)).toBeLessThan(400);
  });

  it("clamps at the maximum rather than starving the encoder", () => {
    const est = new OvershootEstimator(1000, 1.8);
    run(est, 2000, (c) => c * 3, 40);
    expect(est.factor).toBeCloseTo(1.8, 5);
  });

  it("learns nothing from light content, and relaxes an old factor", () => {
    const est = new OvershootEstimator();
    const r = run(est, 3000, (c) => c * 1.5, 30);
    const learned = est.factor;
    run(est, 3000, () => 500, 60, { t0: r.t }); // a still screen: far under the command
    expect(est.factor).toBeLessThan(learned);
    expect(est.factor).toBeGreaterThanOrEqual(1);
  });

  it("never goes below 1 for an encoder that under-delivers", () => {
    const est = new OvershootEstimator();
    run(est, 5000, (c) => c * 0.95, 30);
    expect(est.factor).toBe(1);
  });

  it("ignores windows with a keyframe or a paused encoder", () => {
    const est = new OvershootEstimator();
    run(est, 3000, (c) => c * 1.5, 10, { key: (i) => i % 30 === 0 });
    expect(est.factor).toBe(1);
    run(est, 3000, (c) => c * 1.5, 10, { paused: true, t0: 20_000 });
    expect(est.factor).toBe(1);
  });

  it("passes through a non-positive (auto) rate untouched", () => {
    expect(new OvershootEstimator().command(0)).toBe(0);
  });
});
