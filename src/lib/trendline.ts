/**
 * Delay-gradient overuse detector for DIRECT video (research R7): libwebrtc's
 * GCC trendline estimator + adaptive threshold (TrendlineEstimator,
 * InterArrival), fed one frame at a time.
 *
 * ABR v2's standing-queue signal (`owd - min(owd)`) needs ~110 ms of queue and a
 * couple of smoothed 4 Hz reports before it acts — about a second. The gradient
 * sees a queue *starting* to build: it compares how far apart two frames arrived
 * with how far apart they were sent, so the unknown host↔guest clock offset
 * cancels and no clock sync is needed at all.
 *
 * Inputs per frame: the host timestamp from the GV header (send side) and the
 * guest's arrival time of that header (receive side). The header is its own
 * SCTP message ahead of the frame's fragments, so its arrival measures the queue
 * in front of the frame, not the frame's own serialization.
 */

export type BwState = "normal" | "overuse" | "underuse";

/** libwebrtc defaults (trendline_estimator.cc, inter_arrival.cc). */
const WINDOW = 20;
const SMOOTHING = 0.9;
const THRESHOLD_GAIN = 4;
const MIN_NUM_DELTAS = 60;
const DELTA_COUNTER_MAX = 1000;
const OVERUSING_TIME_MS = 10;
const MAX_ADAPT_OFFSET_MS = 15;
const K_UP = 0.0087;
const K_DOWN = 0.039;
const MAX_TIME_DELTA_MS = 100;
const THRESHOLD_MIN = 6;
const THRESHOLD_MAX = 600;
const THRESHOLD_INIT = 12.5;
/** Frames sent within this of the group's first frame are one group. */
const GROUP_MS = 5;
/** Arrivals this close together after a hold are a burst (Wi-Fi aggregation). */
const BURST_DELTA_MS = 5;
const MAX_BURST_MS = 100;
/** A gap this long (stall, background) invalidates the history. */
const RESET_GAP_MS = 3000;

type Group = { firstSend: number; send: number; firstArr: number; arr: number };

export class DelayTrendline {
  private cur: Group | null = null;
  private prev: Group | null = null;
  private numDeltas = 0;
  private firstArr = -1;
  private accumulated = 0;
  private smoothed = 0;
  private hist: { x: number; y: number }[] = [];
  private prevTrend = 0;
  private overTime = -1;
  private overCount = 0;
  private lastThresholdAt = -1;
  /** The adaptive threshold the modified trend is compared against. */
  threshold = THRESHOLD_INIT;
  /** Slope of the smoothed delay (ms per ms): > 0 filling, < 0 draining. */
  trend = 0;
  /** `min(deltas, 60) × trend × 4` — what is compared against the threshold. */
  modifiedTrend = 0;
  state: BwState = "normal";

  reset() {
    this.cur = null;
    this.prev = null;
    this.numDeltas = 0;
    this.firstArr = -1;
    this.accumulated = 0;
    this.smoothed = 0;
    this.hist = [];
    this.prevTrend = 0;
    this.overTime = -1;
    this.overCount = 0;
    this.lastThresholdAt = -1;
    this.threshold = THRESHOLD_INIT;
    this.trend = 0;
    this.modifiedTrend = 0;
    this.state = "normal";
  }

  /** One frame: host send time and guest arrival time, both in ms (any origins). */
  update(sendMs: number, arrivalMs: number): BwState {
    if (!Number.isFinite(sendMs) || !Number.isFinite(arrivalMs)) return this.state;
    const cur = this.cur;
    if (!cur) {
      this.cur = { firstSend: sendMs, send: sendMs, firstArr: arrivalMs, arr: arrivalMs };
      return this.state;
    }
    // Out of order or a restarted sender clock: start over rather than feed nonsense.
    if (sendMs < cur.firstSend || arrivalMs - cur.arr > RESET_GAP_MS) {
      const keepThreshold = this.threshold;
      this.reset();
      this.threshold = keepThreshold;
      this.cur = { firstSend: sendMs, send: sendMs, firstArr: arrivalMs, arr: arrivalMs };
      return this.state;
    }
    if (sendMs - cur.firstSend <= GROUP_MS || this.inBurst(cur, sendMs, arrivalMs)) {
      cur.send = Math.max(cur.send, sendMs);
      cur.arr = arrivalMs;
      return this.state;
    }
    // `cur` is complete: compare it with the group before it.
    if (this.prev) {
      const sendDelta = cur.send - this.prev.send;
      const arrDelta = cur.arr - this.prev.arr;
      if (arrDelta >= 0) this.estimate(arrDelta, sendDelta, cur.arr);
    }
    this.prev = cur;
    this.cur = { firstSend: sendMs, send: sendMs, firstArr: arrivalMs, arr: arrivalMs };
    return this.state;
  }

  private inBurst(g: Group, sendMs: number, arrivalMs: number): boolean {
    const sendDelta = sendMs - g.send;
    if (sendDelta === 0) return true;
    const arrDelta = arrivalMs - g.arr;
    return arrDelta - sendDelta < 0 && arrDelta <= BURST_DELTA_MS && arrivalMs - g.firstArr < MAX_BURST_MS;
  }

  private estimate(arrDelta: number, sendDelta: number, arrivalMs: number) {
    this.numDeltas = Math.min(this.numDeltas + 1, DELTA_COUNTER_MAX);
    if (this.firstArr < 0) this.firstArr = arrivalMs;
    this.accumulated += arrDelta - sendDelta;
    this.smoothed = SMOOTHING * this.smoothed + (1 - SMOOTHING) * this.accumulated;
    this.hist.push({ x: arrivalMs - this.firstArr, y: this.smoothed });
    if (this.hist.length > WINDOW) this.hist.shift();
    let trend = this.prevTrend;
    if (this.hist.length === WINDOW) trend = slope(this.hist) ?? trend;
    this.trend = trend;
    this.detect(trend, sendDelta, arrivalMs);
  }

  private detect(trend: number, sendDelta: number, now: number) {
    if (this.numDeltas < 2) {
      this.state = "normal";
      return;
    }
    const modified = Math.min(this.numDeltas, MIN_NUM_DELTAS) * trend * THRESHOLD_GAIN;
    this.modifiedTrend = modified;
    if (modified > this.threshold) {
      // Assume the overuse began halfway since the previous sample.
      this.overTime = this.overTime < 0 ? sendDelta / 2 : this.overTime + sendDelta;
      this.overCount++;
      if (this.overTime > OVERUSING_TIME_MS && this.overCount > 1 && trend >= this.prevTrend) {
        this.overTime = 0;
        this.overCount = 0;
        this.state = "overuse";
      }
    } else if (modified < -this.threshold) {
      this.overTime = -1;
      this.overCount = 0;
      this.state = "underuse";
    } else {
      this.overTime = -1;
      this.overCount = 0;
      this.state = "normal";
    }
    this.prevTrend = trend;
    this.adaptThreshold(modified, now);
  }

  private adaptThreshold(modified: number, now: number) {
    if (this.lastThresholdAt < 0) this.lastThresholdAt = now;
    const abs = Math.abs(modified);
    // Don't let a sudden capacity drop teach the threshold to ignore it.
    if (abs > this.threshold + MAX_ADAPT_OFFSET_MS) {
      this.lastThresholdAt = now;
      return;
    }
    const k = abs < this.threshold ? K_DOWN : K_UP;
    const dt = Math.min(now - this.lastThresholdAt, MAX_TIME_DELTA_MS);
    this.threshold = Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, this.threshold + k * (abs - this.threshold) * dt));
    this.lastThresholdAt = now;
  }
}

function slope(points: { x: number; y: number }[]): number | null {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / points.length;
  const my = sy / points.length;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) * (p.x - mx);
  }
  return den === 0 ? null : num / den;
}
