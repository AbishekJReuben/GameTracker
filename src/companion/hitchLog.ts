/**
 * Ring-buffer hitch journal for Remote Control.
 *
 * Records brief spikes (frame gaps, E2E jumps, decode stalls, host skips, audio
 * underruns) so a "Copy hitch log" paste tells us WHERE the hiccup came from
 * without needing logcat. Kept small (last ~40 events) and cheap to sample.
 */

export type HitchKind =
  | "frame-gap"
  | "e2e-jump"
  | "decode-spike"
  | "host-skip"
  | "audio-underrun"
  | "jb-grow"
  | "native-stall"
  | "other";

export type HitchEvent = {
  /** ms since session start (or wall clock if no origin set). */
  t: number;
  kind: HitchKind;
  /** One-line human summary, e.g. "frame gap 48ms (expect ~25)". */
  detail: string;
  /** Optional structured fields for later parsing. */
  meta?: Record<string, number | string | boolean>;
};

const MAX = 40;
const events: HitchEvent[] = [];
let originMs = 0;
let lastNotify: ((e: HitchEvent) => void) | null = null;

/** Call once when a Control session goes live. */
export function hitchReset(): void {
  events.length = 0;
  originMs = performance.now();
}

export function hitchOnNotify(cb: ((e: HitchEvent) => void) | null): void {
  lastNotify = cb;
}

export function hitchNote(
  kind: HitchKind,
  detail: string,
  meta?: Record<string, number | string | boolean>,
): void {
  const t = originMs > 0 ? Math.round(performance.now() - originMs) : Date.now();
  const e: HitchEvent = { t, kind, detail, meta };
  events.push(e);
  while (events.length > MAX) events.shift();
  try {
    lastNotify?.(e);
  } catch {
    /* UI listener fault — never break the stream */
  }
}

export function hitchSnapshot(): HitchEvent[] {
  return events.slice();
}

/** Paste-ready block for diagnostics / clipboard. */
export function hitchFormat(): string {
  if (events.length === 0) return "(no hitches recorded this session)";
  const lines = [
    `=== hitch log (last ${events.length}, t=ms since connect) ===`,
    ...events.map((e) => {
      const meta =
        e.meta && Object.keys(e.meta).length
          ? " " + JSON.stringify(e.meta)
          : "";
      return `+${(e.t / 1000).toFixed(3)}s [${e.kind}] ${e.detail}${meta}`;
    }),
  ];
  return lines.join("\n");
}

/** Detect a frame-interval hitch given the previous/current paint times. */
export function hitchMaybeFrameGap(prevAt: number, nowAt: number, expectMs: number): void {
  if (!(prevAt > 0) || !(expectMs > 0)) return;
  const gap = nowAt - prevAt;
  // >2.5× the expected cadence, and at least 40ms absolute, counts as a hitch.
  if (gap >= Math.max(40, expectMs * 2.5)) {
    hitchNote("frame-gap", `frame gap ${Math.round(gap)}ms (expect ~${Math.round(expectMs)})`, {
      gapMs: Math.round(gap),
      expectMs: Math.round(expectMs),
    });
  }
}

/** Detect a sudden jump in glass-to-glass E2E. */
export function hitchMaybeE2eJump(prev: number, next: number): void {
  if (!(prev > 0) || !(next > 0)) return;
  const d = next - prev;
  if (d >= 25) {
    hitchNote("e2e-jump", `E2E ${Math.round(prev)}→${Math.round(next)}ms (+${Math.round(d)})`, {
      prev: Math.round(prev),
      next: Math.round(next),
      delta: Math.round(d),
    });
  }
}
