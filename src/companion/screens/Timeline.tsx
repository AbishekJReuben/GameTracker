/**
 * Companion Timeline — a mobile port of the desktop Timeline route: a horizontal
 * gantt of your sessions across a time window (24h / 7d / 30d), lane-packed so
 * overlapping sessions stay readable, plus a grouped session list. Sessions come
 * over the remote link (`/api/sessions?fromUtc=…`, which the host now supports).
 */

import { useMemo, useState } from "react";
import { Loader2, Clock, Zap } from "lucide-react";
import type { Session, Game } from "@/lib/api";
import { accentFor, dur, timeLabel } from "@/lib/format";
import { useRemote } from "../useRemote";
import { openGame } from "../ui";
import { MarqueeFX } from "../Marquee";

type Range = "24h" | "7d" | "30d";
type Kind = "all" | "game" | "app";

const RANGE_MS: Record<Range, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
const RANGE_OPTS: { id: Range; label: string }[] = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
];

const colorFor = (s: Session) => (s.kind === "app" ? "#22d3ee" : s.accentColor || accentFor(s.gameId)[0]);

export function TimelineScreen() {
  const [range, setRange] = useState<Range>("24h");
  const [kind, setKind] = useState<Kind>("all");
  // Over-fetch a bit past the window so a session that started before it still shows.
  const fromUtc = useMemo(() => new Date(Date.now() - RANGE_MS[range] - 6 * 3600_000).toISOString(), [range]);
  const { data: raw, loading } = useRemote<Session[]>(`/api/sessions?fromUtc=${encodeURIComponent(fromUtc)}&limit=500`, 15000);
  const { data: games } = useRemote<Game[]>("/api/games", 60000);

  const now = Date.now();
  const windowStart = now - RANGE_MS[range];
  const span = now - windowStart;

  const sessions = useMemo(() => {
    return (raw ?? [])
      .filter((s) => (kind === "all" ? true : s.kind === kind))
      .filter((s) => new Date(s.endUtc ?? s.lastSeenUtc).getTime() >= windowStart)
      .sort((a, b) => new Date(a.startUtc).getTime() - new Date(b.startUtc).getTime());
  }, [raw, kind, windowStart]);

  // Greedy lane packing: place each session in the first lane whose last bar ended.
  const lanes = useMemo(() => {
    const laneEnds: number[] = [];
    const placed: { s: Session; lane: number; left: number; width: number }[] = [];
    for (const s of sessions) {
      const start = Math.max(new Date(s.startUtc).getTime(), windowStart);
      const end = Math.min(new Date(s.endUtc ?? s.lastSeenUtc).getTime(), now);
      let lane = laneEnds.findIndex((e) => e <= start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(end);
      } else {
        laneEnds[lane] = end;
      }
      placed.push({ s, lane, left: ((start - windowStart) / span) * 100, width: Math.max(((end - start) / span) * 100, 0.6) });
    }
    return { placed, count: Math.max(1, laneEnds.length) };
  }, [sessions, windowStart, now, span]);

  const ticks = useMemo(() => {
    const out: { left: number; label: string }[] = [];
    if (range === "24h") {
      for (let h = 0; h <= 24; h += 6) {
        const t = windowStart + h * 3600_000;
        out.push({ left: ((t - windowStart) / span) * 100, label: new Date(t).getHours() + ":00" });
      }
    } else {
      const days = range === "7d" ? 7 : 30;
      const step = range === "7d" ? 1 : 5;
      for (let d = 0; d <= days; d += step) {
        const t = windowStart + d * 86_400_000;
        out.push({ left: ((t - windowStart) / span) * 100, label: new Date(t).toLocaleDateString(undefined, { month: "numeric", day: "numeric" }) });
      }
    }
    return out;
  }, [range, windowStart, span]);

  const dayGroups = useMemo(() => {
    const byDay = new Map<string, Session[]>();
    for (const s of [...sessions].reverse()) {
      const d = new Date(s.startUtc);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(s);
    }
    return [...byDay.entries()].map(([key, list]) => ({
      key,
      label: dayHeading(new Date(list[0].startUtc)),
      list,
      active: list.reduce((a, s) => a + s.activeSeconds, 0),
    }));
  }, [sessions]);

  const laneH = 14;

  return (
    <div className="flex h-full flex-col">
      {/* controls */}
      <div className="shrink-0 space-y-2 border-b border-line p-3">
        <div className="flex gap-1.5">
          {RANGE_OPTS.map((o) => (
            <button key={o.id} onClick={() => setRange(o.id)} className={`flex-1 rounded-lg py-2 text-xs font-700 transition ${range === o.id ? "bg-accent-3 text-white" : "bg-white/[0.04] text-ink-dim"}`}>{o.label}</button>
          ))}
        </div>
        <div className="flex gap-1.5">
          {(["all", "game", "app"] as Kind[]).map((k) => (
            <button key={k} onClick={() => setKind(k)} className={`flex-1 rounded-lg py-1.5 text-xs font-700 capitalize transition ${kind === k ? "bg-white/[0.12] text-white" : "bg-white/[0.04] text-ink-dim"}`}>{k === "all" ? "All" : `${k}s`}</button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && !raw ? (
          <div className="grid h-full place-items-center text-sm text-ink-dim"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading timeline…</div>
        ) : sessions.length === 0 ? (
          <div className="grid h-40 place-items-center text-sm text-ink-dim">No sessions in this range</div>
        ) : (
          <>
            {/* gantt */}
            <div className="relative overflow-hidden rounded-2xl border border-line bg-bg-900/40 p-3">
              <MarqueeFX variant="drift" games={games ?? []} opacity={0.1} tier="base" />
              <div className="relative z-10 w-full overflow-hidden" style={{ height: lanes.count * laneH + 22 }}>
                {/* tick gridlines + labels */}
                {ticks.map((t, i) => (
                  <div key={i} className="absolute top-0 bottom-5 w-px bg-white/[0.05]" style={{ left: `${t.left}%` }} />
                ))}
                {/* bars */}
                {lanes.placed.map(({ s, lane, left, width }) => (
                  <button
                    key={s.id}
                    onClick={() => openGame(s.gameId)}
                    title={`${s.gameName} · ${dur(s.activeSeconds)}`}
                    className="absolute rounded-full active:opacity-80"
                    style={{ left: `${left}%`, width: `${width}%`, top: lane * laneH + 2, height: laneH - 4, background: colorFor(s), boxShadow: `0 0 8px -3px ${colorFor(s)}` }}
                  />
                ))}
                {/* tick labels */}
                {ticks.map((t, i) => (
                  <span key={i} className="absolute bottom-0 -translate-x-1/2 text-[9px] tabular-nums text-ink-faint" style={{ left: `${Math.min(97, Math.max(3, t.left))}%` }}>{t.label}</span>
                ))}
              </div>
              <div className="relative z-10 mt-2 flex gap-3 text-[10px] text-ink-dim">
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded bg-green" /> Games</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded bg-accent-3" /> Apps</span>
                <span className="ml-auto">{sessions.length} sessions</span>
              </div>
            </div>

            {/* grouped list */}
            <div className="mt-4 space-y-3">
              {dayGroups.map((g) => (
                <div key={g.key}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-800 uppercase tracking-wider text-ink-soft">{g.label}</span>
                    <span className="text-[10px] tabular-nums text-ink-faint">{g.list.length} · {dur(g.active)}</span>
                  </div>
                  <div className="divide-y divide-line/40 rounded-2xl border border-line bg-bg-900/30">
                    {g.list.map((s) => (
                      <button key={s.id} onClick={() => openGame(s.gameId)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorFor(s) }} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-700">{s.gameName}</div>
                          <div className="text-xs text-ink-dim">{timeLabel(s.startUtc, false)}</div>
                        </div>
                        <div className="text-right">
                          <div className="flex items-center gap-1 text-sm font-800 tabular-nums"><Zap className="h-3.5 w-3.5 text-green" />{dur(s.activeSeconds)}</div>
                          <div className="flex items-center justify-end gap-1 text-[11px] text-ink-faint"><Clock className="h-3 w-3" />{dur(s.runtimeSeconds)}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function dayHeading(d: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const that = new Date(d);
  that.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
