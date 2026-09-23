/**
 * Main-thread health for the stream stats HUD.
 *
 * On the phone the WebView's main thread does everything the stream needs from JS:
 * it receives every data-channel message (video fragments, audio, pongs), reassembles
 * frames, feeds the decoder and sends input — AND renders the Control UI. A long task
 * there (a heavy React render, a layout thrash) delays all of it at once, and shows
 * up as a video hitch, an audio underrun and laggy input together. Counting long
 * tasks (>50 ms, the browser's own definition) makes that visible instead of guessed.
 *
 * Best-effort: where the `longtask` entry type is unsupported (Safari, jsdom) the
 * stats simply stay at zero.
 */

type Sample = { end: number; ms: number };

let observer: PerformanceObserver | null = null;
let users = 0;
const samples: Sample[] = [];
const WINDOW_MS = 10_000;

function trim(now: number) {
  while (samples.length && now - samples[0].end > WINDOW_MS) samples.shift();
  if (samples.length > 500) samples.splice(0, samples.length - 500);
}

/** Record one long task (exported for tests; the observer calls this). */
export function noteLongTask(startTime: number, duration: number) {
  samples.push({ end: startTime + duration, ms: duration });
  trim(startTime + duration);
}

/** Start observing (ref-counted — call the returned stop when done). */
export function startMainThreadMonitor(): () => void {
  users++;
  if (!observer && typeof PerformanceObserver !== "undefined") {
    try {
      const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes;
      if (!supported || supported.includes("longtask")) {
        observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) noteLongTask(e.startTime, e.duration);
        });
        observer.observe({ type: "longtask", buffered: true } as PerformanceObserverInit);
      }
    } catch {
      observer = null;
    }
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    users = Math.max(0, users - 1);
    if (users === 0) {
      observer?.disconnect();
      observer = null;
      samples.length = 0;
    }
  };
}

/** Long tasks over the last 10 s: how many, total and worst duration (ms). */
export function mainThreadStats(now = performance.now()): { count: number; totalMs: number; maxMs: number } {
  trim(now);
  let totalMs = 0;
  let maxMs = 0;
  for (const s of samples) {
    totalMs += s.ms;
    if (s.ms > maxMs) maxMs = s.ms;
  }
  return { count: samples.length, totalMs: Math.round(totalMs), maxMs: Math.round(maxMs) };
}

/** Test hook. */
export function resetMainThreadStats() {
  samples.length = 0;
}
