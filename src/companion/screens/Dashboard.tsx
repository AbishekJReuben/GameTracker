/**
 * Companion Dashboard — a mobile port of the desktop Dashboard route. Same content
 * (now-playing, headline stats, top games, status pills, activity heatmap, play
 * patterns, recent + longest sessions, derived insights) but data comes over the
 * remote link (`useRemote`) and cover art through `loadMedia` (see ../ui `Art`).
 * Pure desktop chart components are reused directly.
 */

import { useMemo } from "react";
import {
  Zap,
  Flame,
  CalendarDays,
  Library as LibraryIcon,
  Clock,
  Focus,
  Layers,
  Coffee,
  Radio,
  TrendingUp,
  TrendingDown,
  Gamepad2,
} from "lucide-react";
import type { Dashboard, TrackingState } from "@/lib/api";
import { StatTile } from "@/components/StatTile";
import { Sparkline } from "@/components/Sparkline";
import { Heatmap } from "@/components/Heatmap";
import { PolarHours, WeekdayBars } from "@/components/Charts";
import { dur, hours, relativeTime, timeLabel } from "@/lib/format";
import { useRemote } from "../useRemote";
import { Art, openGame } from "../ui";

type HeatDay = { date: string; seconds: number };
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function DashboardScreen() {
  const { data, loading } = useRemote<Dashboard>("/api/dashboard", 30000);
  const { data: now } = useRemote<TrackingState>("/api/tracking", 3000);
  const { data: heat } = useRemote<HeatDay[]>("/api/heatmap?days=182&kind=game", 60000);
  const { data: hourOfDay } = useRemote<number[]>("/api/hourofday?kind=game", 60000);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 5) return "Burning the midnight oil";
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  const weekday = useMemo(() => {
    const sums = Array(7).fill(0);
    (heat ?? []).forEach((d) => {
      const [y, m, dd] = d.date.split("-").map(Number);
      sums[new Date(y, m - 1, dd).getDay()] += d.seconds;
    });
    return { values: sums, labels: WEEKDAY_LABELS };
  }, [heat]);

  const streak = useMemo(() => {
    const days = heat ?? [];
    if (days.length === 0) {
      const c = data?.currentStreak ?? 0;
      return c > 0 ? { gaming: true, count: c } : { gaming: false, count: 1 };
    }
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    let i = sorted.length - 1;
    const gaming = sorted[i].seconds > 0;
    let count = 0;
    while (i >= 0 && sorted[i].seconds > 0 === gaming) {
      count += 1;
      i -= 1;
    }
    return { gaming, count: Math.max(1, count) };
  }, [heat, data]);

  const weekDelta = useMemo(() => {
    if (!data) return 0;
    const prev = data.weekActivePrev;
    if (prev <= 0) return data.weekActive > 0 ? 100 : 0;
    return Math.round(((data.weekActive - prev) / prev) * 100);
  }, [data]);

  const playInsights = useMemo(() => {
    const list: { label: string; value: string; sub?: string }[] = [];
    const wkTotal = weekday.values.reduce((a, b) => a + b, 0);
    if (wkTotal > 0) {
      const pi = weekday.values.indexOf(Math.max(...weekday.values));
      list.push({ label: "Peak day", value: weekday.labels[pi], sub: dur(weekday.values[pi]) });
    }
    if (data && data.avgSessionActive > 0) list.push({ label: "Avg session", value: dur(Math.round(data.avgSessionActive)) });
    if (hourOfDay) {
      const total = hourOfDay.reduce((a, b) => a + b, 0);
      if (total > 0) {
        const night = [22, 23, 0, 1, 2, 3, 4].reduce((a, h) => a + (hourOfDay[h] ?? 0), 0);
        list.push({ label: "Night owl", value: `${Math.round((night / total) * 100)}%`, sub: "after 10pm" });
      }
    }
    if (heat) {
      const days = heat.slice(-30).filter((d) => d.seconds > 0).length;
      list.push({ label: "Active days", value: String(days), sub: "last 30" });
    }
    return list;
  }, [heat, weekday, data, hourOfDay]);

  const playing = now && (now.isPlaying || now.appIsActive) && !now.paused;
  const nowName = now?.isPlaying ? now.gameName : now?.appName;

  return (
    <div className="space-y-5 p-4">
      {/* header */}
      <div>
        <div className="font-display text-2xl font-800">{greeting}</div>
        <div className="text-sm text-ink-dim">
          {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
        </div>
      </div>

      {/* now playing */}
      {playing && (
        <div className="flex items-center gap-3 overflow-hidden rounded-2xl border border-line bg-bg-900/60 p-3">
          <NowArt now={now} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-green">
              <Radio className="h-3.5 w-3.5" /> Now playing
            </div>
            <div className="truncate font-700">{nowName ?? "—"}</div>
          </div>
          <div className="shrink-0 text-right text-sm font-800 tabular-nums text-green">
            {dur((now?.isPlaying ? now.todayActiveSeconds : now?.appTodayActiveSeconds) ?? 0)}
          </div>
        </div>
      )}

      {/* headline stats */}
      <div className="grid grid-cols-2 gap-3">
        <StatTile icon={<Zap className="h-[18px] w-[18px]" />} label="Today" value={data ? data.todayActive / 3600 : 0} decimals={1} suffix="h" accent="#34d399" hint={data ? `${dur(data.todayRuntime)} runtime` : ""} />
        <StatTile
          icon={<CalendarDays className="h-[18px] w-[18px]" />}
          label="This week"
          value={data ? data.weekActive / 3600 : 0}
          decimals={1}
          suffix="h"
          accent="#22d3ee"
          hint={
            data && (
              <span className={`inline-flex items-center gap-1 ${weekDelta >= 0 ? "text-green" : "text-pink"}`}>
                {weekDelta >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                {Math.abs(weekDelta)}% vs last
              </span>
            )
          }
        >
          {data && data.last14.length > 0 && <Sparkline values={data.last14.map((d) => d.seconds)} width={96} height={36} />}
        </StatTile>
        {streak.gaming ? (
          <StatTile icon={<Flame className="h-[18px] w-[18px]" />} label="Play streak" value={streak.count} suffix={streak.count === 1 ? " day" : " days"} accent="#fbbf24" hint={data ? `Longest ${data.longestStreak} days` : ""} />
        ) : (
          <StatTile icon={<Coffee className="h-[18px] w-[18px]" />} label="Rest streak" value={streak.count} suffix={streak.count === 1 ? " day" : " days"} accent="#60a5fa" hint={data ? `Best ${data.longestStreak}d` : ""} />
        )}
        <StatTile icon={<LibraryIcon className="h-[18px] w-[18px]" />} label="Library" value={data?.gamesTotal ?? 0} accent="var(--accent-1)" hint={data ? `${data.gamesCompleted} done · ${data.gamesTracked} tracked` : ""} />
        <StatTile icon={<Clock className="h-[18px] w-[18px]" />} label="All-time" value={data ? data.totalActive / 3600 : 0} suffix="h" accent="#a78bfa" hint={data ? `${data.sessionCount} sessions` : ""} />
        <StatTile icon={<CalendarDays className="h-[18px] w-[18px]" />} label="This month" value={data ? data.monthActive / 3600 : 0} decimals={1} suffix="h" accent="#60a5fa" hint={data ? `${dur(data.monthRuntime)} runtime` : ""} />
        <StatTile icon={<Focus className="h-[18px] w-[18px]" />} label="Focus" value={data?.focusRatio ?? 0} suffix="%" accent="#34d399" hint="Active ÷ runtime" />
        <StatTile icon={<Layers className="h-[18px] w-[18px]" />} label="Games played" value={data?.uniqueGamesPlayed ?? 0} accent="#f472b6" hint={data ? `${data.gamesPlaying} playing now` : ""} />
      </div>

      {/* status pills */}
      {data && (
        <div className="flex flex-wrap gap-2">
          <Pill label="Playing" count={data.gamesPlaying} color="#34d399" />
          <Pill label="Backlog" count={data.gamesBacklog} color="#3b82f6" />
          <Pill label="On Hold" count={data.gamesOnHold} color="#f59e0b" />
          <Pill label="Completed" count={data.gamesCompleted} color="#7c5cff" />
          <Pill label="Dropped" count={data.gamesDropped} color="#f472b6" />
          <Pill label="Watched" count={data.gamesWatched} color="#22d3ee" />
        </div>
      )}

      {/* top games */}
      <Section title="Top games" subtitle="By active playtime">
        {data && data.topGames.length > 0 ? (
          <div className="space-y-0.5">
            {(() => {
              const maxActive = Math.max(1, ...data.topGames.map((x) => x.activeSeconds));
              const maxRuntime = Math.max(1, ...data.topGames.map((x) => x.runtimeSeconds));
              return data.topGames.slice(0, 8).map((g, i) => (
                <button key={g.id} onClick={() => openGame(g.id)} className="flex w-full items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left active:bg-white/[0.04]">
                  <span className="w-4 text-center text-[10px] font-800 text-ink-faint">{i + 1}</span>
                  <Art id={g.id} name={g.name} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} rounded="rounded-lg" className="h-8 w-8 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-700">{g.name}</div>
                    <div className="relative mt-1 h-1 w-full overflow-hidden rounded-full bg-white/[0.05]">
                      <div className="absolute inset-y-0 left-0 rounded-full bg-accent-sheen opacity-35" style={{ width: `${(g.runtimeSeconds / maxRuntime) * 100}%` }} />
                      <div className="absolute inset-y-0 left-0 rounded-full bg-green" style={{ width: `${(g.activeSeconds / maxActive) * 100}%` }} />
                    </div>
                  </div>
                  <span className="shrink-0 text-[10px] font-800 tabular-nums text-green">{dur(g.activeSeconds)}</span>
                </button>
              ));
            })()}
          </div>
        ) : (
          <Empty text={loading ? "Loading…" : "No playtime yet"} />
        )}
      </Section>

      {/* activity heatmap */}
      <Section title="Activity" subtitle="Active play over the last 6 months" right={data ? <span className="text-sm font-700 text-ink">{hours(data.totalActive, 0)}<span className="ml-1 text-xs font-500 text-ink-dim">h all-time</span></span> : undefined}>
        {heat ? <Heatmap data={heat} maxStep={18} /> : <Empty text="Loading…" />}
      </Section>

      {/* when you play + insights */}
      <Section title="When you play" subtitle="Active time by hour of day">
        <div className="flex flex-col items-center gap-4">
          {hourOfDay ? <PolarHours values={hourOfDay} /> : <Empty text="Loading…" />}
          {playInsights.length > 0 && (
            <div className="w-full space-y-1.5">
              {playInsights.map((it) => (
                <div key={it.label} className="flex items-baseline justify-between gap-3 rounded-xl border border-line bg-white/[0.02] px-3 py-2">
                  <span className="text-[11px] font-700 uppercase tracking-wide text-ink-dim">{it.label}</span>
                  <span className="text-right">
                    <span className="font-display text-sm font-800 tabular-nums text-ink">{it.value}</span>
                    {it.sub && <span className="ml-1.5 text-[10px] text-ink-faint">{it.sub}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>

      {/* your week */}
      <Section title="Your week" subtitle="Play distribution across weekdays">
        {heat ? <WeekdayBars values={weekday.values} labels={weekday.labels} /> : <Empty text="Loading…" />}
      </Section>

      {/* longest session */}
      {data?.longestSession && (
        <Section title="Longest session">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-display text-xl font-800 text-ink">{dur(data.longestSession.seconds)}</div>
              <button onClick={() => openGame(data.longestSession!.gameId)} className="text-sm text-ink-dim">
                <span className="font-700 text-accent-3">{data.longestSession.gameName}</span> · {relativeTime(data.longestSession.startUtc)}
              </button>
            </div>
            <div className="text-right text-xs text-ink-faint">Avg {dur(Math.round(data.avgSessionActive))} active</div>
          </div>
        </Section>
      )}

      {/* recent sessions */}
      <Section title="Recent sessions">
        {data && data.recentSessions.length > 0 ? (
          <div className="divide-y divide-line">
            {data.recentSessions.map((s) => (
              <button key={s.id} onClick={() => openGame(s.gameId)} className="flex w-full items-center gap-3 py-2.5 text-left">
                <Art id={s.gameId} name={s.gameName} cover={s.coverPath} icon={s.iconPath} accent={s.accentColor} rounded="rounded-lg" className="h-9 w-9 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-700">{s.gameName}</div>
                  <div className="text-xs text-ink-dim">{relativeTime(s.startUtc)} · {timeLabel(s.startUtc, false)}</div>
                </div>
                <div className="text-right">
                  <div className="flex items-center gap-1 text-sm font-800 tabular-nums"><Zap className="h-3.5 w-3.5 text-green" />{dur(s.activeSeconds)}</div>
                  <div className="flex items-center justify-end gap-1 text-[11px] text-ink-faint"><Clock className="h-3 w-3" />{dur(s.runtimeSeconds)}</div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <Empty text={loading ? "Loading…" : "No sessions recorded yet"} />
        )}
      </Section>

      {data && data.gamesPlaying > 1 && (
        <div className="flex items-center justify-center gap-1.5 text-xs font-700 text-green">
          <Gamepad2 className="h-3.5 w-3.5" /> {data.gamesPlaying} games running
        </div>
      )}
    </div>
  );
}

function NowArt({ now }: { now: TrackingState }) {
  const cover = now.isPlaying ? now.coverPath ?? now.iconPath : now.appCoverPath ?? now.appIconPath;
  const name = (now.isPlaying ? now.gameName : now.appName) ?? "?";
  const id = (now.isPlaying ? now.gameId : now.appName) ?? name;
  return <Art id={String(id)} name={name} cover={cover} rounded="rounded-xl" className="h-12 w-12 shrink-0" />;
}

function Section({ title, subtitle, right, children }: { title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-bg-900/40 p-3.5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="font-display text-base font-800">{title}</div>
          {subtitle && <div className="text-[11px] text-ink-dim">{subtitle}</div>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Pill({ label, count, color }: { label: string; count: number; color: string }) {
  if (count <= 0) return null;
  return (
    <span className="pill border bg-white/[0.03] text-xs font-700" style={{ borderColor: `color-mix(in srgb, ${color} 35%, transparent)` }}>
      <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      {count} {label.toLowerCase()}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="grid place-items-center py-6 text-sm text-ink-dim">{text}</div>;
}
