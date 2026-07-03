/**
 * Companion Collections — a mobile port of the desktop Collection route: your
 * completed-games hall of fame + analytics. Data over the remote link
 * (`/api/catalog`, `/api/games`); charts via recharts + the desktop's pure gauge/
 * radar components (which only depend on the harmless motion selector).
 */

import { useMemo } from "react";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  BarChart,
  Bar,
  Legend,
} from "recharts";
import { Trophy, Star, Gauge, Scale, Clock, Sparkle, BookOpen, XCircle, History, Tag, TrendingUp, TrendingDown, CalendarRange, Hourglass, Rabbit, Turtle, Radar as RadarIcon } from "lucide-react";
import type { CatalogAnalytics, Game } from "@/lib/api";
import { dur, hours } from "@/lib/format";
import { RadialGauge, LevelBar } from "@/components/RadialGauge";
import { RadarChart } from "@/components/Charts";
import { useRemote } from "../useRemote";
import { Art, openGame } from "../ui";
import { MarqueePoolProvider, SectionBackdrop } from "../Marquee";

const STATUS_COLORS: Record<string, string> = { playing: "#34d399", completed: "#7c5cff", backlog: "#3b82f6", dropped: "#f472b6", on_hold: "#f59e0b", watched: "#22d3ee" };
const STATUS_LABEL: Record<string, string> = { playing: "Playing", completed: "Completed", backlog: "Backlog", dropped: "Dropped", on_hold: "On Hold", watched: "Watched" };
const MONTH_ABBR = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const AXIS = { stroke: "#454c66", fontSize: 10 };

export function CollectionsScreen() {
  const { data, loading } = useRemote<CatalogAnalytics>("/api/catalog", 60000);
  const { data: games } = useRemote<Game[]>("/api/games", 30000);
  const curYear = new Date().getFullYear();

  const completed = useMemo(() => (games ?? []).filter((g) => g.kind === "game" && g.status === "completed"), [games]);

  const scoreHist = useMemo(() => {
    const buckets = [
      { label: "50s", lo: 50, hi: 60 },
      { label: "60s", lo: 60, hi: 70 },
      { label: "70s", lo: 70, hi: 80 },
      { label: "80s", lo: 80, hi: 90 },
      { label: "90+", lo: 90, hi: 101 },
    ];
    return buckets.map((b) => ({ ...b, count: completed.filter((g) => g.rating != null && g.rating >= b.lo && g.rating < b.hi).length }));
  }, [completed]);

  const cumulative = useMemo(() => {
    const byYear = new Map<number, number>();
    for (const g of completed) if (g.completedYear) byYear.set(g.completedYear, (byYear.get(g.completedYear) ?? 0) + 1);
    const years = [...byYear.keys()].sort((a, b) => a - b);
    let run = 0;
    return years.map((y) => ((run += byYear.get(y) ?? 0), { year: y, total: run }));
  }, [completed]);

  const decades = useMemo(() => {
    const m = new Map<number, number>();
    for (const g of completed) if (g.releaseYear) m.set(Math.floor(g.releaseYear / 10) * 10, (m.get(Math.floor(g.releaseYear / 10) * 10) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([d, count]) => ({ label: `${d}s`, value: count }));
  }, [completed]);

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of completed) g.tags.forEach((t) => m.set(t, (m.get(t) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag, count]) => ({ label: tag, value: count }));
  }, [completed]);
  const genreRadar = useMemo(() => tagCounts.slice(0, 6).map((t) => ({ label: t.label, value: t.value })), [tagCounts]);

  const hallOfFame = useMemo(() => [...completed].filter((g) => g.rating != null).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).slice(0, 12), [completed]);
  const recent = useMemo(() => {
    const key = (g: Game) => (g.completedYear ?? 0) * 10000 + (g.completedMonth ?? 0) * 100 + (g.completedDay ?? 0);
    return [...completed].filter((g) => g.coverPath || g.iconPath).sort((a, b) => key(b) - key(a)).slice(0, 18);
  }, [completed]);

  const yearProgress = useMemo(() => {
    const start = new Date(curYear, 0, 1).getTime();
    const end = new Date(curYear + 1, 0, 1).getTime();
    const pct = Math.min(100, ((Date.now() - start) / (end - start)) * 100);
    const totalDays = Math.round((end - start) / 86_400_000);
    const dayOfYear = Math.min(totalDays, Math.floor((Date.now() - start) / 86_400_000) + 1);
    return { pct, dayOfYear, totalDays, daysLeft: Math.max(0, totalDays - dayOfYear) };
  }, [curYear]);

  const velocity = useMemo(() => {
    const months = MONTH_ABBR.map((label, m) => ({ m, label, cur: 0, prev: 0 }));
    for (const g of completed) {
      if (!g.completedYear) continue;
      const mi = Math.max(0, Math.min(11, (g.completedMonth ?? 1) - 1));
      if (g.completedYear === curYear) months[mi].cur += 1;
      else if (g.completedYear === curYear - 1) months[mi].prev += 1;
    }
    const curTotal = months.reduce((a, x) => a + x.cur, 0);
    return { months, curTotal, pace: curTotal / Math.max(1, new Date().getMonth() + 1) };
  }, [completed, curYear]);

  const yoy = useMemo(() => {
    const agg = (year: number) => {
      const list = completed.filter((g) => g.completedYear === year);
      const rated = list.filter((g) => g.rating != null);
      return {
        count: list.length,
        hours: list.reduce((a, g) => a + g.totalRuntimeSeconds, 0) / 3600,
        avg: rated.length ? rated.reduce((a, g) => a + (g.rating ?? 0), 0) / rated.length : 0,
        perfect: list.filter((g) => (g.rating ?? 0) >= 95).length,
      };
    };
    return { cur: agg(curYear), prev: agg(curYear - 1) };
  }, [completed, curYear]);

  const hltb = useMemo(() => {
    const rows = completed
      .map((g) => {
        const est = (g.hltbMainMinutes ?? g.timeToBeatMinutes ?? 0) * 60;
        const yours = g.totalRuntimeSeconds;
        if (est <= 0 || yours <= 600) return null;
        return { g, est, yours, deltaPct: ((yours - est) / est) * 100 };
      })
      .filter((r): r is { g: Game; est: number; yours: number; deltaPct: number } => !!r);
    const avgDelta = rows.length ? rows.reduce((a, r) => a + r.deltaPct, 0) / rows.length : 0;
    const byDelta = [...rows].sort((a, b) => a.deltaPct - b.deltaPct);
    return { count: rows.length, avgDelta, faster: byDelta.filter((r) => r.deltaPct < -2).slice(0, 4), slower: byDelta.filter((r) => r.deltaPct > 2).reverse().slice(0, 4) };
  }, [completed]);

  const deltas = useMemo(() => {
    const withBoth = completed.filter((g) => g.rating != null && g.metacritic != null).map((g) => ({ g, d: (g.rating ?? 0) - (g.metacritic ?? 0) }));
    const sorted = [...withBoth].sort((a, b) => b.d - a.d);
    return { liked: sorted.slice(0, 4), critics: sorted.slice(-4).reverse() };
  }, [completed]);

  const achStats = useMemo(() => {
    const tracked = (games ?? []).filter((g) => g.steamAchievementsTotal != null && g.steamAchievementsTotal > 0);
    const unlocked = tracked.reduce((a, g) => a + (g.steamAchievementsUnlocked ?? 0), 0);
    const total = tracked.reduce((a, g) => a + (g.steamAchievementsTotal ?? 0), 0);
    const platinum = tracked.filter((g) => (g.steamAchievementsUnlocked ?? 0) >= (g.steamAchievementsTotal ?? 1)).length;
    return { games: tracked.length, unlocked, total, platinum, pct: total > 0 ? Math.round((unlocked / total) * 100) : 0 };
  }, [games]);

  const appHours = useMemo(() => (games ?? []).filter((g) => g.kind === "app" && g.totalActiveSeconds > 0).map((g) => ({ g, seconds: g.totalActiveSeconds })).sort((a, b) => b.seconds - a.seconds), [games]);
  const gameHours = useMemo(() => (games ?? []).filter((g) => g.kind === "game" && g.totalRuntimeSeconds > 0).map((g) => ({ g, seconds: g.totalRuntimeSeconds })).sort((a, b) => b.seconds - a.seconds), [games]);

  if (loading && !data) return <Center>Loading collection…</Center>;
  if (!data || data.totalCompleted === 0) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <Trophy className="mx-auto mb-3 h-8 w-8 text-ink-dim" />
          <div className="font-display text-lg font-800">No completed games yet</div>
          <p className="mt-1 text-sm text-ink-dim">Mark games completed or import your CSV to build your collection.</p>
        </div>
      </div>
    );
  }

  const statusPie = data.statusCounts.filter(([, v]) => v > 0).map(([name, value]) => ({ name, value }));
  const delta = Math.round((data.avgMyScore - data.avgMetacritic) * 10) / 10;
  const maxHist = Math.max(1, ...scoreHist.map((b) => b.count));

  return (
    <MarqueePoolProvider games={games ?? []}>
    <div className="space-y-4 p-4">
      {/* hero cover wall */}
      <div className="relative h-[168px] overflow-hidden rounded-3xl border border-line bg-bg-900/70">
        <div className="absolute inset-0 grid grid-cols-6 gap-0.5 opacity-40">
          {(games ?? []).filter((g) => g.coverPath || g.iconPath).slice(0, 24).map((g) => (
            <Art key={g.id} id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} rounded="rounded-none" className="h-full w-full" />
          ))}
        </div>
        <div className="absolute inset-0 bg-gradient-to-t from-bg-base via-bg-base/70 to-bg-base/40" />
        <div className="relative flex h-full flex-col justify-center px-5">
          <div className="flex items-center gap-2 text-[11px] font-800 uppercase tracking-[0.2em] text-accent-3"><Trophy className="h-4 w-4" /> Collection</div>
          <h2 className="mt-1 font-display text-2xl font-900 text-ink">Your hall of games</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip icon={<Trophy className="h-3 w-3" />} value={String(data.totalCompleted)} label="completed" />
            <Chip icon={<Star className="h-3 w-3" />} value={data.avgMyScore.toFixed(1)} label="avg" />
            <Chip icon={<Clock className="h-3 w-3" />} value={`${hours(data.totalPlaytimeSeconds, 1)}h`} label="played" />
            {data.perfectScores > 0 && <Chip icon={<Sparkle className="h-3 w-3" />} value={String(data.perfectScores)} label="perfect" />}
          </div>
        </div>
      </div>

      {/* gauges */}
      <div className="grid grid-cols-2 gap-3 rounded-2xl border border-line bg-bg-900/40 p-4">
        <GaugeStat icon={<Trophy className="h-4 w-4" />} label="Completed" value={data.totalCompleted} max={Math.max(20, data.totalCompleted)} text={String(data.totalCompleted)} from="var(--accent-1)" to="var(--accent-3)" />
        <GaugeStat icon={<Star className="h-4 w-4" />} label="Avg score" value={data.avgMyScore} max={100} text={data.avgMyScore.toFixed(1)} from="#fbbf24" to="#fb923c" />
        <GaugeStat icon={<Gauge className="h-4 w-4" />} label="Metacritic" value={data.avgMetacritic} max={100} text={data.avgMetacritic.toFixed(1)} from="#34d399" to="#22d3ee" />
        <div className="flex flex-col items-center justify-center gap-1 text-center">
          <Scale className="h-5 w-5 text-accent-3" />
          <div className="font-display text-2xl font-800 tabular-nums">{Math.abs(delta).toFixed(1)}</div>
          <div className="text-[10px] uppercase tracking-wider text-ink-dim">pts {delta >= 0 ? "kinder" : "harsher"}</div>
        </div>
      </div>

      {/* mini stats */}
      <div className="grid grid-cols-2 gap-2.5">
        <Mini icon={<Clock className="h-4 w-4" />} label="Playtime" value={`${hours(data.totalPlaytimeSeconds, 1)}h`} hint="on completed" />
        <Mini icon={<Sparkle className="h-4 w-4" />} label="Perfect" value={String(data.perfectScores)} hint="rated 95+" />
        <Mini icon={<BookOpen className="h-4 w-4" />} label="Backlog" value={String(data.backlogCount)} hint="waiting" />
        <Mini icon={<XCircle className="h-4 w-4" />} label="Dropped" value={String(data.droppedCount)} hint="didn't finish" />
        <Mini icon={<Star className="h-4 w-4" />} label="Scored" value={`${data.scoredCount}/${data.totalCompleted}`} hint="with rating" />
        {data.avgTimeToBeatMinutes > 0 && <Mini icon={<History className="h-4 w-4" />} label="Avg HLTB" value={`${Math.round(data.avgTimeToBeatMinutes / 60)}h`} hint="time to beat" />}
      </div>

      {/* status pie */}
      <Section title="Library status" subtitle="Where your games stand">
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie data={statusPie} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={3} strokeWidth={0}>
              {statusPie.map((s) => <Cell key={s.name} fill={STATUS_COLORS[s.name] ?? "#94a3b8"} />)}
            </Pie>
            <Tooltip content={<TT />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="mt-1 flex flex-wrap justify-center gap-2.5 text-xs">
          {statusPie.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5 text-ink-soft"><span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[s.name] }} />{STATUS_LABEL[s.name] ?? s.name} <span className="font-800 text-ink">{s.value}</span></span>
          ))}
        </div>
      </Section>

      {/* journey */}
      {cumulative.length > 1 && (
        <Section title="Your journey" subtitle="Cumulative completed over time">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={cumulative} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent-1)" stopOpacity={0.55} /><stop offset="100%" stopColor="var(--accent-3)" stopOpacity={0.02} /></linearGradient></defs>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="year" {...AXIS} tickLine={false} axisLine={false} />
              <YAxis {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip content={<TT />} />
              <Area type="monotone" dataKey="total" name="Completed" stroke="var(--accent-1)" strokeWidth={2.5} fill="url(#cg)" />
            </AreaChart>
          </ResponsiveContainer>
        </Section>
      )}

      {/* score distribution */}
      <Section title="Score distribution" subtitle="How generous is your scoring?">
        <div className="flex h-[170px] items-end gap-3 px-1">
          {scoreHist.map((b) => (
            <div key={b.label} className="flex flex-1 flex-col items-center justify-end gap-2">
              <span className="text-xs font-800 tabular-nums text-ink-soft">{b.count}</span>
              <div className="w-full rounded-t-lg bg-accent-sheen" style={{ height: `${(b.count / maxHist) * 130 + 4}px`, boxShadow: "0 0 18px -6px var(--accent-1)" }} />
              <span className="text-[11px] text-ink-dim">{b.label}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* completions per year */}
      {data.perYear.length > 0 && (
        <Section title="Completions per year" subtitle="Count & avg score by finish year">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.perYear} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="year" {...AXIS} tickLine={false} axisLine={false} />
              <YAxis yAxisId="l" {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis yAxisId="r" orientation="right" domain={[0, 100]} {...AXIS} tickLine={false} axisLine={false} />
              <Tooltip content={<TT />} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar yAxisId="l" dataKey="count" name="Completed" fill="var(--accent-1)" radius={[5, 5, 0, 0]} />
              <Bar yAxisId="r" dataKey="avgScore" name="Avg score" fill="#fbbf24" radius={[5, 5, 0, 0]} opacity={0.85} />
            </BarChart>
          </ResponsiveContainer>
        </Section>
      )}

      {/* era + genres */}
      <div className="grid gap-4 sm:grid-cols-2">
        {decades.length > 0 && <Section title="By era" subtitle="Release decade" icon={<History className="h-3.5 w-3.5" />}><BarList items={decades} /></Section>}
        {tagCounts.length > 0 && <Section title="Top genres" subtitle="Most-completed tags" icon={<Tag className="h-3.5 w-3.5" />}><BarList items={tagCounts} /></Section>}
      </div>

      {genreRadar.length >= 3 && (
        <Section title="Genre footprint" subtitle="Where your finished games cluster" icon={<RadarIcon className="h-3.5 w-3.5" />}>
          <div className="grid place-items-center"><RadarChart items={genreRadar} /></div>
        </Section>
      )}

      {/* year pulse */}
      <Section title={`${curYear} in focus`} subtitle="Year progress & completion pace" icon={<CalendarRange className="h-3.5 w-3.5" />}>
        <div className="flex items-center gap-4">
          <YearRing pct={yearProgress.pct} />
          <div>
            <div className="font-display text-2xl font-900 tabular-nums">{yearProgress.pct.toFixed(0)}%</div>
            <div className="text-xs text-ink-dim">of {curYear} gone</div>
            <div className="mt-1 text-[11px] text-ink-faint">Day {yearProgress.dayOfYear} · {yearProgress.daysLeft} days left</div>
          </div>
        </div>
        <div className="mt-3">
          <div className="mb-1.5 flex justify-between text-[10px] font-700 uppercase tracking-wider text-ink-dim">
            <span>Completions / month</span>
            <span className="normal-case tracking-normal text-ink-faint"><span className="font-800 text-ink-soft">{velocity.curTotal}</span> · {velocity.pace.toFixed(1)}/mo</span>
          </div>
          <div className="flex h-[90px] items-end gap-1">
            {velocity.months.map((m, i) => {
              const maxBar = Math.max(1, ...velocity.months.flatMap((x) => [x.cur, x.prev]));
              return (
                <div key={i} className="flex flex-1 flex-col items-center gap-1">
                  <div className="relative flex w-full items-end justify-center" style={{ height: 80 }}>
                    {m.prev > 0 && <div className="absolute bottom-0 w-full rounded-t bg-white/[0.07]" style={{ height: Math.max(4, (m.prev / maxBar) * 80) }} />}
                    <div className="relative w-[68%] rounded-t bg-accent-sheen" style={{ height: m.cur > 0 ? Math.max(6, (m.cur / maxBar) * 80) : 0 }} />
                  </div>
                  <span className="text-[8px] font-700 text-ink-faint">{m.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </Section>

      {/* year over year */}
      {(yoy.cur.count > 0 || yoy.prev.count > 0) && (
        <Section title="Year over year" subtitle={`${curYear} vs ${curYear - 1}`} icon={<TrendingUp className="h-3.5 w-3.5" />}>
          <div className="grid grid-cols-2 gap-2.5">
            {([
              { label: "Completed", cur: yoy.cur.count, prev: yoy.prev.count, fmt: (n: number) => String(Math.round(n)), pts: false },
              { label: "Hours", cur: yoy.cur.hours, prev: yoy.prev.hours, fmt: (n: number) => `${n.toFixed(0)}h`, pts: false },
              { label: "Avg score", cur: yoy.cur.avg, prev: yoy.prev.avg, fmt: (n: number) => (n ? n.toFixed(1) : "—"), pts: true },
              { label: "Perfect", cur: yoy.cur.perfect, prev: yoy.prev.perfect, fmt: (n: number) => String(Math.round(n)), pts: false },
            ]).map((m) => {
              const diff = m.cur - m.prev;
              const up = diff >= 0;
              const color = up ? "#34d399" : "#f472b6";
              const pct = m.pts ? diff : m.prev > 0 ? (diff / m.prev) * 100 : m.cur > 0 ? 100 : 0;
              return (
                <div key={m.label} className="rounded-2xl border border-line bg-white/[0.02] p-3">
                  <div className="text-[10px] font-700 uppercase tracking-wider text-ink-dim">{m.label}</div>
                  <div className="mt-1 font-display text-xl font-800 tabular-nums">{m.fmt(m.cur)}</div>
                  <div className="mt-1 flex items-center justify-between gap-1">
                    <span className="text-[10px] text-ink-faint">{curYear - 1}: {m.fmt(m.prev)}</span>
                    {m.cur !== m.prev && (m.cur !== 0 || m.prev !== 0) && (
                      <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-800" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
                        {up ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}{m.pts ? `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}` : `${diff >= 0 ? "+" : ""}${Math.round(pct)}%`}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* HLTB verdict */}
      {hltb.count > 0 && (
        <Section title="You vs HowLongToBeat" subtitle={`Your playtime vs estimates · ${hltb.count} games`} icon={<Hourglass className="h-3.5 w-3.5" />}>
          <div className="flex items-center gap-3 rounded-2xl border border-line bg-white/[0.015] p-3">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl" style={{ background: `color-mix(in srgb, ${hltb.avgDelta < 0 ? "#34d399" : "#f59e0b"} 16%, transparent)`, color: hltb.avgDelta < 0 ? "#34d399" : "#f59e0b" }}>
              {hltb.avgDelta < 0 ? <Rabbit className="h-6 w-6" /> : <Turtle className="h-6 w-6" />}
            </div>
            <div>
              <div className="font-display text-xl font-900 tabular-nums">{Math.abs(hltb.avgDelta).toFixed(0)}% {hltb.avgDelta < 0 ? "faster" : "slower"}</div>
              <div className="text-xs text-ink-dim">than the typical main story.</div>
            </div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <HltbList title="Speedran" rows={hltb.faster} positive />
            <HltbList title="Savored" rows={hltb.slower} positive={false} />
          </div>
        </Section>
      )}

      {/* recently completed */}
      {recent.length > 0 && (
        <Section title="Recently completed" subtitle="Newest finishes first">
          <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
            {recent.map((g) => (
              <button key={g.id} onClick={() => openGame(g.id)} className="w-[104px] shrink-0 text-left">
                <div className="relative aspect-[3/4]">
                  <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="h-full w-full ring-1 ring-white/[0.06]" />
                  {g.rating != null && <span className="absolute right-1 top-1 inline-flex items-center gap-0.5 rounded-md bg-black/55 px-1 text-[9px] font-800 text-amber"><Star className="h-2.5 w-2.5 fill-amber" />{g.rating}</span>}
                </div>
                <div className="mt-1 truncate text-[11px] font-700 text-ink-soft">{g.displayName}</div>
                {g.completedYear && <div className="text-[10px] text-ink-faint">{g.completedYear}</div>}
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* hall of fame */}
      {hallOfFame.length > 0 && (
        <Section title="Hall of fame" subtitle="Your highest-rated completions">
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
            {hallOfFame.map((g, i) => (
              <button key={g.id} onClick={() => openGame(g.id)} className="relative text-left">
                <div className="relative aspect-[3/4]">
                  <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="h-full w-full ring-1 ring-white/[0.06]" />
                  <div className="absolute inset-0 rounded-xl bg-gradient-to-t from-black/80 to-transparent" />
                  {g.rating != null && <span className="absolute right-1 top-1 rounded-md bg-black/55 px-1 text-[9px] font-800 text-amber">{g.rating}</span>}
                  {i === 0 && <div className="absolute left-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-amber text-[9px] font-900 text-black">1</div>}
                  <div className="absolute inset-x-0 bottom-0 truncate p-1 text-[10px] font-700 text-white">{g.displayName}</div>
                </div>
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* score deltas vs critics */}
      {(deltas.liked.length > 0 || deltas.critics.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Section title="You loved these more" subtitle="Biggest gap over critics" icon={<TrendingUp className="h-3.5 w-3.5 text-green" />}><DeltaList items={deltas.liked} positive /></Section>
          <Section title="Critics loved these more" subtitle="Where you were tougher" icon={<TrendingDown className="h-3.5 w-3.5 text-pink" />}><DeltaList items={deltas.critics} positive={false} /></Section>
        </div>
      )}

      {/* achievements */}
      {achStats.games > 0 && (
        <Section title="Achievements" subtitle={`${achStats.games} games tracked`} icon={<Trophy className="h-3.5 w-3.5" />}>
          <div className="grid grid-cols-3 gap-2.5">
            <Mini icon={<Trophy className="h-4 w-4" />} label="Unlocked" value={achStats.unlocked.toLocaleString()} hint={`of ${achStats.total.toLocaleString()}`} />
            <Mini icon={<Gauge className="h-4 w-4" />} label="Avg" value={`${achStats.pct}%`} hint="completion" />
            <Mini icon={<Star className="h-4 w-4" />} label="Platinum" value={String(achStats.platinum)} hint="100% games" />
          </div>
        </Section>
      )}

      {/* hours treemaps */}
      {appHours.length > 0 && <Section title="App active hours" subtitle="Where your focused app time goes"><Treemap items={appHours} art="icon" /></Section>}
      {gameHours.length > 0 && <Section title="Game total hours" subtitle="Runtime across every game"><Treemap items={gameHours} art="cover" /></Section>}

      {/* top studios */}
      {data.topStudios.length > 0 && (
        <Section title="Top studios" subtitle="Most-completed developers">
          <div className="space-y-2">
            {data.topStudios.map((s, i) => {
              const max = data.topStudios[0].count || 1;
              return (
                <div key={s.studio} className="flex items-center gap-2.5">
                  <span className="w-4 text-xs font-800 text-ink-faint">{i + 1}</span>
                  <span className="w-28 shrink-0 truncate text-sm font-700">{s.studio}</span>
                  <LevelBar value={s.count} max={max} className="flex-1" delay={i * 0.05} />
                  <span className="w-6 text-right text-sm font-800 tabular-nums">{s.count}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </div>
    </MarqueePoolProvider>
  );
}

function Section({ title, subtitle, icon, children }: { title: string; subtitle?: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-line bg-bg-900/40 p-3.5">
      <SectionBackdrop prefix="collection" title={title} />
      <div className="relative z-10">
        <div className="mb-3 flex items-center gap-2">
          {icon && <span className="text-ink-dim">{icon}</span>}
          <div>
            <div className="font-display text-sm font-800">{title}</div>
            {subtitle && <div className="text-[11px] text-ink-dim">{subtitle}</div>}
          </div>
        </div>
        {children}
      </div>
    </section>
  );
}

function GaugeStat({ icon, label, value, max, text, from, to }: { icon: React.ReactNode; label: string; value: number; max: number; text: string; from: string; to: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <RadialGauge value={value} max={max} size={92} from={from} to={to}>
        <div className="font-display text-xl font-800 tabular-nums leading-none">{text}</div>
      </RadialGauge>
      <div className="flex items-center gap-1 text-[10px] font-700 uppercase tracking-wider text-ink-dim">{icon}{label}</div>
    </div>
  );
}

function Mini({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-line bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-ink-dim">{icon}<span className="text-[10px] font-700 uppercase tracking-wider">{label}</span></div>
      <div className="mt-1 font-display text-lg font-800 tabular-nums text-ink">{value}</div>
      <div className="text-[10px] text-ink-faint">{hint}</div>
    </div>
  );
}

function BarList({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={it.label} className="flex items-center gap-2.5">
          <span className="w-16 shrink-0 truncate text-xs font-700 text-ink-soft">{it.label}</span>
          <LevelBar value={it.value} max={max} className="flex-1" delay={i * 0.05} />
          <span className="w-6 text-right text-xs font-800 tabular-nums">{it.value}</span>
        </div>
      ))}
    </div>
  );
}

function HltbList({ title, rows, positive }: { title: string; rows: { g: Game; est: number; yours: number; deltaPct: number }[]; positive: boolean }) {
  if (rows.length === 0) return null;
  const color = positive ? "#34d399" : "#f472b6";
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">{title}</div>
      <div className="space-y-1">
        {rows.map(({ g, est, yours, deltaPct }) => (
          <button key={g.id} onClick={() => openGame(g.id)} className="flex w-full items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left active:bg-white/[0.03]">
            <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} rounded="rounded-lg" className="h-8 w-8 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-700">{g.displayName}</div>
              <div className="text-[10px] text-ink-dim">You {dur(yours)} · HLTB {dur(est)}</div>
            </div>
            <span className="shrink-0 rounded-lg px-1.5 py-0.5 text-xs font-800 tabular-nums" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>{deltaPct >= 0 ? "+" : ""}{deltaPct.toFixed(0)}%</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DeltaList({ items, positive }: { items: { g: Game; d: number }[]; positive: boolean }) {
  if (items.length === 0) return <p className="text-sm text-ink-dim">Not enough scored games</p>;
  const color = positive ? "#34d399" : "#f472b6";
  return (
    <div className="space-y-1">
      {items.map(({ g, d }) => (
        <button key={g.id} onClick={() => openGame(g.id)} className="flex w-full items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left active:bg-white/[0.03]">
          <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} rounded="rounded-lg" className="h-8 w-8 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-700">{g.displayName}</div>
            <div className="text-[10px] text-ink-dim">You {g.rating} · Critics {g.metacritic}</div>
          </div>
          <span className="shrink-0 rounded-lg px-1.5 py-0.5 text-xs font-800 tabular-nums" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>{d >= 0 ? "+" : ""}{d}</span>
        </button>
      ))}
    </div>
  );
}

type Rect = { x: number; y: number; w: number; h: number };
/** Squarified treemap (Bruls–Huizing–van Wijk) over a 100×100 box. */
function squarify(values: number[], width: number, height: number): Rect[] {
  const n = values.length;
  const rects: Rect[] = new Array(n);
  if (n === 0) return rects;
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const scale = (width * height) / total;
  const areas = values.map((v) => v * scale);
  let x = 0, y = 0, w = width, h = height, i = 0;
  let row: number[] = [];
  const worst = (idxs: number[], side: number) => {
    let sum = 0, max = -Infinity, min = Infinity;
    for (const k of idxs) {
      sum += areas[k];
      if (areas[k] > max) max = areas[k];
      if (areas[k] < min) min = areas[k];
    }
    const s2 = sum * sum, l2 = side * side || 1;
    return Math.max((l2 * max) / (s2 || 1), s2 / (l2 * (min || 1)));
  };
  const layout = () => {
    const sum = row.reduce((a, k) => a + areas[k], 0) || 1;
    if (w >= h) {
      const colW = sum / h;
      let yy = y;
      for (const k of row) { const rh = (areas[k] / sum) * h; rects[k] = { x, y: yy, w: colW, h: rh }; yy += rh; }
      x += colW; w -= colW;
    } else {
      const rowH = sum / w;
      let xx = x;
      for (const k of row) { const rw = (areas[k] / sum) * w; rects[k] = { x: xx, y, w: rw, h: rowH }; xx += rw; }
      y += rowH; h -= rowH;
    }
    row = [];
  };
  while (i < n) {
    const side = Math.min(w, h) || 1;
    if (row.length === 0) { row.push(i++); continue; }
    if (worst([...row, i], side) <= worst(row, side)) row.push(i++);
    else layout();
  }
  if (row.length) layout();
  return rects;
}

function Treemap({ items, art }: { items: { g: Game; seconds: number }[]; art: "cover" | "icon" }) {
  const source = items.slice(0, 40);
  const rects = useMemo(() => squarify(source.map((it) => it.seconds), 100, 100), [source]);
  const totalH = source.reduce((a, it) => a + it.seconds, 0) / 3600;
  return (
    <>
      <div className="relative aspect-square w-full overflow-hidden rounded-2xl border border-line bg-bg-900/60">
        {source.map((it, i) => {
          const r = rects[i];
          if (!r) return null;
          const hrs = it.seconds / 3600;
          const big = r.w > 16 && r.h > 13;
          return (
            <button key={it.g.id} onClick={() => openGame(it.g.id)} className="group absolute p-[2px]" style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }} title={`${it.g.displayName} · ${hrs.toFixed(1)}h`}>
              <div className="relative h-full w-full overflow-hidden rounded-md ring-1 ring-inset ring-black/40">
                <Art id={it.g.id} name={it.g.displayName} cover={it.g.coverPath} icon={it.g.iconPath} accent={it.g.accentColor} variant={art} rounded="rounded-md" className="absolute inset-0 h-full w-full" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-black/5" />
                {big && (
                  <div className="absolute inset-x-0 bottom-0 p-1 text-left">
                    <div className="truncate text-[10px] font-800 leading-tight text-white drop-shadow">{it.g.displayName}</div>
                    <div className="text-[9px] font-700 tabular-nums text-white/85">{hrs.toFixed(1)}h</div>
                  </div>
                )}
              </div>
            </button>
          );
        })}
        <div className="pointer-events-none absolute right-2 top-2 rounded-lg bg-black/55 px-2 py-1 text-right backdrop-blur">
          <div className="font-display text-sm font-800 tabular-nums text-white">{totalH.toFixed(totalH >= 100 ? 0 : 1)}h</div>
          <div className="text-[8px] font-700 uppercase tracking-wider text-white/60">total</div>
        </div>
      </div>
      <p className="mt-1.5 text-[10px] text-ink-faint">Tiles sized by hours · tap for details</p>
    </>
  );
}

function YearRing({ pct }: { pct: number }) {
  const r = 28;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return (
    <div className="relative h-[76px] w-[76px] shrink-0">
      <svg viewBox="0 0 76 76" className="h-full w-full -rotate-90">
        <defs><linearGradient id="yr" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="var(--accent-1)" /><stop offset="100%" stopColor="var(--accent-3)" /></linearGradient></defs>
        <circle cx="38" cy="38" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="7" />
        <circle cx="38" cy="38" r={r} fill="none" stroke="url(#yr)" strokeWidth="7" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={offset} />
      </svg>
      <div className="absolute inset-0 grid place-items-center"><CalendarRange className="h-5 w-5 text-accent-3" /></div>
    </div>
  );
}

function Chip({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line bg-black/45 px-2.5 py-1 backdrop-blur-md">
      <span className="text-accent-3">{icon}</span>
      <span className="font-800 tabular-nums text-ink">{value}</span>
      <span className="text-[9px] font-700 uppercase tracking-wider text-ink-dim">{label}</span>
    </span>
  );
}

function TT({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-line bg-bg-800/95 px-3 py-2 text-xs shadow-float backdrop-blur">
      {label != null && <div className="mb-1 font-800">{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2 capitalize text-ink-soft"><span className="h-2 w-2 rounded-full" style={{ background: p.color || p.fill || p.payload?.fill }} />{p.name}: <span className="font-800 text-ink">{p.value}</span></div>
      ))}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center text-sm text-ink-dim">{children}</div>;
}
