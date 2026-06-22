import type { FocusSpan, Session } from "./api";

/** Spans clipped to a session bar's visible [startMs, endMs] window. */
export function clipFocusSpans(
  session: Session,
  sessionStartMs: number,
  sessionEndMs: number,
  nowMs: number
): { startMs: number; endMs: number; focused: boolean }[] {
  const spans = session.focusSpans ?? [];
  const src =
    spans.length > 0
      ? spans
      : fallbackFocusSpans(
          sessionStartMs,
          sessionEndMs,
          nowMs,
          session.runtimeSeconds,
          session.activeSeconds
        );

  const out: { startMs: number; endMs: number; focused: boolean }[] = [];
  for (const span of src) {
    const ss = new Date(span.startUtc).getTime();
    const se = span.endUtc ? new Date(span.endUtc).getTime() : nowMs;
    const a = Math.max(ss, sessionStartMs);
    const b = Math.min(se, sessionEndMs);
    if (b > a) out.push({ startMs: a, endMs: b, focused: span.focused });
  }
  return out;
}

/** Legacy sessions without stored spans — background first, then active (approximate). */
export function fallbackFocusSpans(
  sessionStartMs: number,
  sessionEndMs: number,
  nowMs: number,
  runtimeSeconds: number,
  activeSeconds: number
): FocusSpan[] {
  const endMs = sessionEndMs || nowMs;
  const startIso = new Date(sessionStartMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const rt = Math.max(0, runtimeSeconds);
  const act = Math.max(0, activeSeconds);
  if (rt <= 0 && act <= 0) {
    return [{ startUtc: startIso, endUtc: endIso, focused: false }];
  }
  if (act >= rt || rt === 0) {
    return [{ startUtc: startIso, endUtc: endIso, focused: act > 0 }];
  }
  const bgMs = ((rt - act) / rt) * (endMs - sessionStartMs);
  const split = sessionStartMs + bgMs;
  return [
    { startUtc: startIso, endUtc: new Date(split).toISOString(), focused: false },
    { startUtc: new Date(split).toISOString(), endUtc: endIso, focused: true },
  ];
}

export function appendLiveFocusSpan(
  spans: FocusSpan[],
  session: Session,
  focused: boolean,
  nowMs: number
): FocusSpan[] {
  const seen = new Date(session.lastSeenUtc).getTime();
  if (nowMs - seen >= 8_000) return spans;

  const base = [...spans];
  const last = base[base.length - 1];
  const nowIso = new Date(nowMs).toISOString();
  if (last && !last.endUtc && last.focused === focused) return base;
  if (last && !last.endUtc) {
    base[base.length - 1] = { ...last, endUtc: nowIso };
  }
  base.push({ startUtc: nowIso, endUtc: undefined, focused });
  return base;
}
