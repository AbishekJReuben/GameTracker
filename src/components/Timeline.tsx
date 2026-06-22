import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Session } from "@/lib/api";
import { accentFor, dur, hourLabel } from "@/lib/format";
import { appendLiveFocusSpan, clipFocusSpans } from "@/lib/focusSpans";
import { useApp, useMotionEnabled } from "@/store/app";
import { type TimelineRange, rangeToMinutes } from "@/lib/timelineZoom";

export type { TimelineRange } from "@/lib/timelineZoom";

const DAY = 86_400_000;
const BAR_H = 30;
const BAR_H_COMPACT = 22;
const LANE_GAP = 8;
const LANE_GAP_COMPACT = 5;

interface Window {
  start: number;
  end: number;
  title: string;
  ticks: { pos: number; label: string }[];
}

function segmentGradient(color: string, focused: boolean) {
  const top = focused ? 72 : 22;
  const bottom = focused ? 55 : 14;
  return `linear-gradient(180deg, color-mix(in srgb, ${color} ${top}%, #07080f), color-mix(in srgb, ${color} ${bottom}%, #07080f))`;
}

function buildWindow(range: TimelineRange, offset: number, use24: boolean): Window {
  const now = new Date();
  if (range === "1w") {
    const end0 = new Date(now);
    end0.setHours(0, 0, 0, 0);
    end0.setDate(end0.getDate() + 1 - offset * 7);
    const end = end0.getTime();
    const start = end - 7 * DAY;
    const ticks = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start + i * DAY);
      return { pos: ((i + 0.5) / 7) * 100, label: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) };
    });
    const title = offset === 0 ? "This week" : `${new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(end - DAY).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    return { start, end, title, ticks };
  }
  if (range === "1m") {
    const end0 = new Date(now);
    end0.setHours(0, 0, 0, 0);
    end0.setDate(end0.getDate() + 1 - offset * 30);
    const end = end0.getTime();
    const start = end - 30 * DAY;
    const ticks = Array.from({ length: 6 }, (_, i) => {
      const t = start + (i / 5) * 30 * DAY;
      return { pos: (i / 5) * 100, label: new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) };
    });
    const title = offset === 0 ? "Last 30 days" : `${new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(end - DAY).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    return { start, end, title, ticks };
  }
  const end0 = new Date(now.getFullYear() - offset, now.getMonth() + 1, 1);
  const end = end0.getTime();
  const start = new Date(now.getFullYear() - offset - 1, now.getMonth() + 1, 1).getTime();
  const ticks: { pos: number; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(start);
    d.setMonth(d.getMonth() + i);
    ticks.push({ pos: ((d.getTime() - start) / (end - start)) * 100, label: d.toLocaleDateString(undefined, { month: "narrow" }) });
  }
  const title = offset === 0 ? "Last 12 months" : `${new Date(start).getFullYear()}–${new Date(end).getFullYear()}`;
  return { start, end, title, ticks };
}

export function buildFixedWindow(minutes: number, endMs: number, offset: number, use24: boolean): Window {
  const span = minutes * 60_000;
  const end = endMs - offset * span;
  const start = end - span;
  const tickCount = minutes <= 15 ? 6 : minutes <= 60 ? 5 : minutes <= 360 ? 6 : 7;
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const t = start + (i / Math.max(1, tickCount - 1)) * span;
    return {
      pos: span > 0 ? ((t - start) / span) * 100 : 0,
      label: new Date(t).toLocaleTimeString(undefined, { hour: use24 ? "2-digit" : "numeric", minute: "2-digit", hour12: !use24 }),
    };
  });
  const title =
    minutes === 5
      ? offset === 0
        ? "Last 5 minutes"
        : new Date(start).toLocaleTimeString(undefined, { hour: use24 ? "2-digit" : "numeric", minute: "2-digit", hour12: !use24 })
      : minutes === 60
        ? offset === 0
          ? "Last hour"
          : new Date(start).toLocaleTimeString(undefined, { hour: use24 ? "2-digit" : "numeric", minute: "2-digit", hour12: !use24 })
        : minutes === 360
          ? "Last 6 hours"
          : minutes === 1440
            ? "Last 24 hours"
            : offset === 0
              ? `Last ${minutes} min`
              : new Date(start).toLocaleString(undefined, { month: "short", day: "numeric", hour: use24 ? "2-digit" : "numeric", minute: "2-digit", hour12: !use24 });
  return { start, end, title, ticks };
}

interface Placed {
  s: Session;
  lane: number;
  left: number;
  width: number;
  color: string;
  clipStartMs: number;
  clipEndMs: number;
  startMs: number;
  endMs: number;
}

function placeSessions(sessions: Session[], win: Window, colorFor: (s: Session) => string): { placed: Placed[]; lanes: number } {
  const span = win.end - win.start || 1;
  const inWindow = sessions
    .map((s) => {
      const startMs = new Date(s.startUtc).getTime();
      const endMs = s.endUtc ? new Date(s.endUtc).getTime() : Date.now();
      return { s, startMs, endMs: Math.max(endMs, startMs + 60_000) };
    })
    .filter((x) => x.endMs > win.start && x.startMs < win.end)
    .sort((a, b) => a.startMs - b.startMs);

  const laneEnds: number[] = [];
  const placed: Placed[] = [];
  for (const x of inWindow) {
    const cs = Math.max(x.startMs, win.start);
    const ce = Math.min(x.endMs, win.end);
    let lane = laneEnds.findIndex((end) => cs >= end - 1);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(ce);
    } else {
      laneEnds[lane] = ce;
    }
    placed.push({
      s: x.s,
      lane,
      left: ((cs - win.start) / span) * 100,
      width: Math.max(0.6, ((ce - cs) / span) * 100),
      color: colorFor(x.s),
      clipStartMs: cs,
      clipEndMs: ce,
      startMs: x.startMs,
      endMs: x.endMs,
    });
  }
  return { placed, lanes: Math.max(1, laneEnds.length) };
}

function hostOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    const u = url.includes("://") ? url : `https://${url}`;
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Most recent distinct window activities (title + browser URL) for a session. */
function distinctActivities(session: Session, limit = 4) {
  const spans = session.activitySpans ?? [];
  const seen = new Set<string>();
  const out: { title?: string | null; host: string | null }[] = [];
  for (let i = spans.length - 1; i >= 0 && out.length < limit; i--) {
    const a = spans[i];
    if (!a.title && !a.url) continue;
    const key = `${a.title ?? ""}|${a.url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: a.title, host: hostOf(a.url) });
  }
  return out;
}

function liveFocused(session: Session, tracking: ReturnType<typeof useApp.getState>["tracking"]): boolean | undefined {
  if (!tracking) return undefined;
  if (tracking.gameId === session.gameId && tracking.isPlaying) return !tracking.isIdle;
  if (tracking.appId === session.gameId && tracking.appIsActive) return !tracking.isIdle;
  return undefined;
}

export function Timeline({
  sessions,
  range,
  colorFor,
  link = true,
  maxLanes = 14,
  fixedRangeMinutes,
  hideStepper = false,
  compact = false,
  footer,
  emptyLabel = "No play recorded in this window",
}: {
  sessions: Session[];
  range?: TimelineRange;
  colorFor?: (s: Session) => string;
  link?: boolean;
  maxLanes?: number;
  fixedRangeMinutes?: number;
  hideStepper?: boolean;
  compact?: boolean;
  footer?: ReactNode;
  emptyLabel?: string;
}) {
  const navigate = useNavigate();
  const use24 = useApp((s) => s.prefs.timeFormat === "24h");
  const tracking = useApp((s) => s.tracking);
  const enabled = useMotionEnabled();
  const [offset, setOffset] = useState(0);
  const [hoveredAct, setHoveredAct] = useState<string | null>(null);

  useEffect(() => setOffset(0), [range, fixedRangeMinutes]);

  const nowMs = useMemo(
    () => Date.now(),
    [
      tracking?.sessionActiveSeconds,
      tracking?.sessionRuntimeSeconds,
      tracking?.appSessionActiveSeconds,
      tracking?.isPlaying,
      tracking?.appIsActive,
      tracking?.isIdle,
      sessions,
    ]
  );

  const color = useMemo(
    () => colorFor ?? ((s: Session) => s.accentColor || accentFor(s.gameId)[0]),
    [colorFor]
  );

  const win = useMemo(() => {
    if (fixedRangeMinutes != null) return buildFixedWindow(fixedRangeMinutes, nowMs, offset, use24);
    const minutes = range ? rangeToMinutes(range) : null;
    if (minutes != null) return buildFixedWindow(minutes, nowMs, offset, use24);
    return buildWindow(range ?? "1h", offset, use24);
  }, [fixedRangeMinutes, nowMs, use24, range, offset]);

  const { placed, lanes } = useMemo(() => placeSessions(sessions, win, color), [sessions, win, color]);

  const shownLanes = Math.min(lanes, maxLanes);
  const barH = compact ? BAR_H_COMPACT : BAR_H;
  const laneGap = compact ? LANE_GAP_COMPACT : LANE_GAP;
  const trackH = shownLanes * (barH + laneGap) + (compact ? 2 : 6);
  const tooltipClass =
    "pointer-events-none absolute left-1/2 z-[250] w-max max-w-[min(320px,90vw)] -translate-x-1/2 rounded-xl border border-line bg-bg-850 px-2.5 py-1.5 text-[11px] shadow-float";
  const actTooltipClass =
    "pointer-events-none absolute left-1/2 z-[250] w-max max-w-[min(280px,80vw)] -translate-x-1/2 rounded-lg border border-line bg-bg-850 px-2 py-1.5 text-left text-[10px] shadow-float";
  const nowPos = ((nowMs - win.start) / (win.end - win.start)) * 100;
  const totalActive = placed.reduce((a, p) => a + p.s.activeSeconds, 0);
  const totalRuntime = placed.reduce((a, p) => a + p.s.runtimeSeconds, 0);
  const showRuntimeHint = totalRuntime > totalActive + 30;

  return (
    <div>
      {!hideStepper && (
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => setOffset((o) => o + 1)} className="btn btn-subtle h-8 w-8 px-0" title="Previous">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="min-w-[150px] text-center font-display text-sm font-700 text-ink">{win.title}</div>
            <button
              onClick={() => setOffset((o) => Math.max(0, o - 1))}
              disabled={offset === 0}
              className="btn btn-subtle h-8 w-8 px-0 disabled:opacity-30"
              title="Next"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="text-xs text-ink-dim">
            <span className="font-700 text-ink-soft">{placed.length}</span> sessions ·{" "}
            <span className="font-700 text-ink-soft">{dur(totalActive)}</span> focused
            {showRuntimeHint && (
              <>
                {" "}
                · <span className="font-700 text-ink-faint">{dur(totalRuntime)}</span> runtime
              </>
            )}
          </div>
        </div>
      )}

      {hideStepper && (
        <div className="mb-2 flex items-center justify-between text-xs text-ink-dim">
          <span className="font-700 text-ink">{win.title}</span>
          <span>
            <span className="font-700 text-ink-soft">{placed.length}</span> sessions ·{" "}
            <span className="font-700 text-ink-soft">{dur(totalActive)}</span> focused
          </span>
        </div>
      )}

      <div className="relative ml-0 h-5">
        {win.ticks.map((t, i) => (
          <motion.div
            key={i}
            className="absolute top-0 -translate-x-1/2 text-[10px] font-600 tabular-nums text-ink-dim"
            style={{ left: `${t.pos}%` }}
            initial={enabled ? { opacity: 0, y: -4 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.02 }}
          >
            {t.label}
          </motion.div>
        ))}
      </div>

      <div
        className="relative w-full overflow-visible rounded-2xl border border-line bg-bg-900/40 p-2"
        style={{ minHeight: trackH + (compact ? 8 : 12), paddingBottom: compact ? 8 : 20 }}
      >
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
          {enabled && (
            <svg className="absolute inset-0 h-full w-full opacity-[0.35]" aria-hidden>
              <defs>
                <pattern id="tl-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                  <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#tl-grid)" />
            </svg>
          )}
          {win.ticks.map((t, i) => (
            <div key={i} className="absolute inset-y-2 w-px bg-white/[0.04]" style={{ left: `${t.pos}%` }} />
          ))}
        </div>

        {nowPos >= 0 && nowPos <= 100 && (
          <div className="absolute inset-y-1 z-20 w-px" style={{ left: `${nowPos}%`, background: "color-mix(in srgb, var(--accent-3) 80%, transparent)" }}>
            <span className="absolute -top-0.5 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-accent-3" style={{ boxShadow: "0 0 8px var(--accent-3)" }} />
          </div>
        )}

        <div className="relative" style={{ height: trackH }}>
          {placed
            .filter((p) => p.lane < shownLanes)
            .map((p, i) => {
              const wide = p.width > 8;
              const barSpan = p.clipEndMs - p.clipStartMs || 1;
              let spans = p.s.focusSpans ?? [];
              const live = liveFocused(p.s, tracking);
              if (live != null && nowMs - new Date(p.s.lastSeenUtc).getTime() < 8_000) {
                spans = appendLiveFocusSpan(spans, p.s, live, nowMs);
              }
              const segments = clipFocusSpans({ ...p.s, focusSpans: spans }, p.clipStartMs, p.clipEndMs, nowMs);

              return (
                <motion.button
                  key={p.s.id}
                  onClick={() => link && navigate(`/game/${p.s.gameId}`)}
                  className="group/bar absolute z-[1] overflow-visible text-left hover:z-[40]"
                  style={{
                    left: `${p.left}%`,
                    width: `${p.width}%`,
                    top: p.lane * (barH + laneGap) + (compact ? 2 : 4),
                    height: barH,
                  }}
                  initial={enabled ? { scaleX: 0, opacity: 0, x: -8 } : false}
                  animate={{ scaleX: 1, opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(i * 0.012, 0.4), duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                  whileHover={enabled ? { y: -1 } : undefined}
                >
                  <div
                    className="absolute inset-0 overflow-hidden rounded-lg"
                    style={{
                      boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${p.color} 35%, transparent)`,
                    }}
                  >
                    <div className="pointer-events-none absolute inset-0 flex items-center">
                    {segments.map((seg, si) => {
                      const leftPct = ((seg.startMs - p.clipStartMs) / barSpan) * 100;
                      const widthPct = ((seg.endMs - seg.startMs) / barSpan) * 100;
                      return (
                        <span
                          key={si}
                          className="absolute inset-y-0"
                          style={{
                            left: `${leftPct}%`,
                            width: `${Math.max(widthPct, 0.4)}%`,
                            background: segmentGradient(p.color, seg.focused),
                            opacity: seg.focused ? 1 : 0.42,
                          }}
                        />
                      );
                    })}
                    {wide && (
                      <span className="relative z-[2] truncate px-2 text-[11px] font-700 text-white/95 drop-shadow">
                        {p.s.gameName}
                      </span>
                    )}
                    </div>
                  </div>
                    {/* Activity slices sit outside overflow-hidden so hover tooltips are visible. */}
                    {(p.s.activitySpans ?? []).map((a, ai) => {
                      if (!a.title && !a.url) return null;
                      const aStart = Math.max(new Date(a.startUtc).getTime(), p.clipStartMs);
                      const aEnd = Math.min(a.endUtc ? new Date(a.endUtc).getTime() : nowMs, p.clipEndMs);
                      if (aEnd <= aStart) return null;
                      const leftPct = ((aStart - p.clipStartMs) / barSpan) * 100;
                      const widthPct = ((aEnd - aStart) / barSpan) * 100;
                      const host = hostOf(a.url);
                      const live = !a.endUtc;
                      const actKey = `${p.s.id}-${ai}`;
                      const fmtT = (ms: number) =>
                        new Date(ms).toLocaleTimeString(undefined, { hour: use24 ? "2-digit" : "numeric", minute: "2-digit", hour12: !use24 });
                      return (
                        <div
                          key={`act-${ai}`}
                          className="absolute inset-y-0 z-[5] border-l border-white/25 first:border-l-0 hover:bg-white/15"
                          style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.5)}%` }}
                          onMouseEnter={() => setHoveredAct(actKey)}
                          onMouseLeave={() => setHoveredAct((cur) => (cur === actKey ? null : cur))}
                        >
                          <span
                            className={`${actTooltipClass} transition-opacity duration-150 ${
                              hoveredAct === actKey ? "opacity-100" : "opacity-0"
                            } ${p.lane === 0 ? "bottom-full mb-2" : "top-full mt-2"}`}
                          >
                            <span className="block truncate font-700 text-ink">{a.title ?? host ?? "Activity"}</span>
                            {a.url && <span className="block truncate text-ink-dim">{a.url}</span>}
                            {host && a.title && !a.url?.includes(host) && (
                              <span className="block truncate text-ink-faint">{host}</span>
                            )}
                            <span className="block tabular-nums text-ink-faint">
                              {fmtT(aStart)} → {live ? "now" : fmtT(aEnd)}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  <span
                    className={`${tooltipClass} transition-opacity duration-150 ${
                      hoveredAct?.startsWith(p.s.id) ? "opacity-0" : "opacity-0 group-hover/bar:opacity-100"
                    } ${p.lane === 0 ? "top-full mt-2" : "bottom-full mb-2"}`}
                  >
                    <div className="whitespace-nowrap">
                      <span className="font-800">{p.s.gameName}</span>
                      <span className="mx-1 text-ink-dim">·</span>
                      {dur(p.s.activeSeconds)} focused
                      {p.s.runtimeSeconds > p.s.activeSeconds && (
                        <>
                          <span className="mx-1 text-ink-dim">·</span>
                          {dur(p.s.runtimeSeconds)} runtime
                        </>
                      )}
                    </div>
                    <div className="whitespace-nowrap text-[10px] text-ink-dim">
                      {new Date(p.startMs).toLocaleTimeString(undefined, { hour: use24 ? "2-digit" : "numeric", minute: "2-digit", hour12: !use24 })}
                      {" → "}
                      {new Date(p.endMs).toLocaleTimeString(undefined, { hour: use24 ? "2-digit" : "numeric", minute: "2-digit", hour12: !use24 })}
                    </div>
                    {(p.s.activitySpans?.length ?? 0) > 0 && (
                      <div className="mt-1 border-t border-line pt-1 text-[10px] text-ink-faint">Hover a slice for the URL / window at that moment</div>
                    )}
                  </span>
                </motion.button>
              );
            })}
        </div>

        {placed.length === 0 && (
          <div className="absolute inset-0 grid place-items-center text-xs text-ink-faint">{emptyLabel}</div>
        )}
        {lanes > shownLanes && (
          <div className="mt-1 text-right text-[10px] text-ink-faint">+{lanes - shownLanes} more overlapping lanes</div>
        )}
      </div>

      {placed.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-faint">
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-3 w-6 rounded bg-accent-3 opacity-100" /> Solid = in focus
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-3 w-6 rounded bg-accent-3 opacity-40" /> Faded = background / idle
          </span>
          <span>Hover a bar for session details{placed.some((p) => (p.s.activitySpans?.length ?? 0) > 0) ? " and window activity" : ""}</span>
        </div>
      )}

      {footer && <div className="mt-4 border-t border-line pt-4">{footer}</div>}
    </div>
  );
}
