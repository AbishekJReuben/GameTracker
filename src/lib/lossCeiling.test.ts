import { describe, expect, it } from "vitest";
import { LOSS_CEIL_MIN_P, SeqLossWindow, lossCeilingKbps, sctpCapacityKbps } from "./lossCeiling";

describe("sctpCapacityKbps", () => {
  it("matches the measured SCTP collapse (0.1 % loss, 20 ms RTT → ~11.4 Mb/s)", () => {
    const c = sctpCapacityKbps(0.001, 20);
    // Formula gives 12.4 Mb/s; the lab measured 11.4 — same ballpark, as intended.
    expect(c).toBeGreaterThan(11_000);
    expect(c).toBeLessThan(13_500);
  });

  it("falls with loss and with RTT", () => {
    expect(sctpCapacityKbps(0.004, 20)).toBeCloseTo(sctpCapacityKbps(0.001, 20) / 2, 3);
    expect(sctpCapacityKbps(0.001, 40)).toBeCloseTo(sctpCapacityKbps(0.001, 20) / 2, 3);
  });

  it("has no bound below the loss floor or without an RTT", () => {
    expect(sctpCapacityKbps(LOSS_CEIL_MIN_P / 2, 20)).toBe(0);
    expect(sctpCapacityKbps(0, 20)).toBe(0);
    expect(sctpCapacityKbps(0.01, 0)).toBe(0);
    expect(sctpCapacityKbps(Number.NaN, 20)).toBe(0);
  });
});

describe("lossCeilingKbps", () => {
  it("targets 60 % of the bound", () => {
    expect(lossCeilingKbps(0.001, 20)).toBe(Math.round(sctpCapacityKbps(0.001, 20) * 0.6));
    expect(lossCeilingKbps(0, 20)).toBe(0);
  });
});

describe("SeqLossWindow", () => {
  const fill = (w: SeqLossWindow, from: number, n: number, skip: (i: number) => boolean, t0 = 0) => {
    for (let i = 0; i < n; i++) if (!skip(i)) w.push((from + i) >>> 0, t0 + i * 10);
  };

  it("reports nothing until it has enough packets", () => {
    const w = new SeqLossWindow(5000, 100);
    fill(w, 0, 50, () => false);
    expect(w.loss(500)).toBeNull();
  });

  it("counts gaps regardless of arrival order", () => {
    const w = new SeqLossWindow(5000, 100);
    const seqs = Array.from({ length: 400 }, (_, i) => i).filter((i) => i % 100 !== 50);
    // Shuffle deterministically — the channel is unordered.
    seqs.sort((a, b) => ((a * 7919) % 400) - ((b * 7919) % 400));
    seqs.forEach((s, i) => w.push(s, i * 10));
    const l = w.loss(seqs.length * 10)!;
    expect(l.span).toBe(400);
    expect(l.lost).toBe(4);
    expect(l.p).toBeCloseTo(0.01, 5);
  });

  it("ignores duplicates", () => {
    const w = new SeqLossWindow(5000, 10);
    for (let i = 0; i < 200; i++) {
      w.push(i, i * 10);
      w.push(i, i * 10 + 1);
    }
    expect(w.loss(2000)!.lost).toBe(0);
  });

  it("survives u32 wrap", () => {
    const w = new SeqLossWindow(5000, 100);
    fill(w, 0xffffff00, 400, (i) => i === 300); // crosses 0xffffffff → 0 at i = 256
    const l = w.loss(3990)!;
    expect(l.span).toBe(400);
    expect(l.lost).toBe(1);
  });

  it("forgets old packets", () => {
    const w = new SeqLossWindow(1000, 20);
    fill(w, 0, 200, (i) => i % 5 === 0); // 2 s lossy
    expect(w.loss(1990)!.lost).toBeGreaterThan(10);
    fill(w, 200, 150, () => false, 2000); // then 1.5 s clean
    const l = w.loss(3490)!;
    expect(l.lost).toBe(0);
  });

  it("starts over when the sender restarts its sequence", () => {
    const w = new SeqLossWindow(5000, 100);
    fill(w, 1_000_000, 200, () => false);
    fill(w, 0, 200, () => false, 2000);
    const l = w.loss(4000)!;
    expect(l.span).toBe(200);
    expect(l.lost).toBe(0);
  });
});
