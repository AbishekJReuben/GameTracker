import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  Legend,
} from "recharts";
import { motion } from "motion/react";
import { Trophy, Star, Gauge, Scale, TrendingUp, TrendingDown, Tag, History, Radar as RadarIcon, Sparkles, Clock, BookOpen, XCircle, Sparkle, Gamepad2, Eye, EyeOff, CalendarRange, Hourglass, Rabbit, Turtle } from "lucide-react";
import { Page } from "@/components/Page";
import { SectionTitle, EmptyState, Skeleton, statusLabel } from "@/components/ui";
import { Panel } from "@/components/Panel";
import { MusicGamingPanel } from "@/components/MusicWidgets";
import { RadialGauge, LevelBar } from "@/components/RadialGauge";
import { RadarChart } from "@/components/Charts";
import { Reveal } from "@/components/Reveal";
import { GameArt } from "@/components/GameArt";
import { GameScores } from "@/components/GameScores";
import { CoverMarquee } from "@/components/CoverMarquee";
import { InsightsContent } from "./Insights";
import { useCatalog, useGames } from "@/lib/queries";
import { useMotionEnabled } from "@/store/app";
import { Game } from "@/lib/api";
import { dur, hours } from "@/lib/format";
import { aggregateSteamAchievements } from "@/lib/steamAchievements";
import { SteamAchievementBadge, SteamAchievementCollectionSection } from "@/components/SteamAchievements";

const AXIS = { stroke: "#454c66", fontSize: 11 };
const STATUS_COLORS: Record<string, string> = { playing: "#34d399", completed: "#7c5cff", backlog: "#3b82f6", dropped: "#f472b6", on_hold: "#f59e0b", watched: "#22d3ee" };
const MONTH_ABBR = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

export default function CollectionPage() {
  const { data, isLoading } = useCatalog();
  const { data: games } = useGames();
  const enabled = useMotionEnabled();

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
    return years.map((y) => {
      run += byYear.get(y) ?? 0;
      return { year: y, total: run };
    });
  }, [completed]);

  const decades = useMemo(() => {
    const m = new Map<number, number>();
    for (const g of completed) if (g.releaseYear) {
      const d = Math.floor(g.releaseYear / 10) * 10;
      m.set(d, (m.get(d) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([d, count]) => ({ label: `${d}s`, count }));
  }, [completed]);

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of completed) g.tags.forEach((t) => m.set(t, (m.get(t) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag, count]) => ({ tag, count }));
  }, [completed]);

  const genreRadar = useMemo(() => tagCounts.slice(0, 6).map((t) => ({ label: t.tag, value: t.count })), [tagCounts]);

  const bubbleData = useMemo(
    () =>
      (games ?? [])
        .filter((g) => g.totalRuntimeSeconds > 0 && g.rating != null)
        .map((g) => ({
          name: g.displayName,
          hours: Math.round((g.totalRuntimeSeconds / 3600) * 10) / 10,
          score: g.rating!,
          sessions: g.sessionCount,
          color: g.accentColor || STATUS_COLORS[g.status] || "#7c5cff",
        })),
    [games]
  );

  const deltas = useMemo(() => {
    const withBoth = completed.filter((g) => g.rating != null && g.metacritic != null).map((g) => ({ g, d: (g.rating ?? 0) - (g.metacritic ?? 0) }));
    const sorted = [...withBoth].sort((a, b) => b.d - a.d);
    return { liked: sorted.slice(0, 4), critics: sorted.slice(-4).reverse() };
  }, [completed]);

  const hallOfFame = useMemo(() => [...completed].filter((g) => g.rating != null).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).slice(0, 8), [completed]);

  const steamAchStats = useMemo(() => aggregateSteamAchievements(games ?? []), [games]);

  // Square treemaps: every app (by active time) and every game (by runtime),
  // each tile sized to its hours and backed by its own art. Sorted big→small.
  const appHourItems = useMemo(
    () =>
      (games ?? [])
        .filter((g) => g.kind === "app" && g.totalActiveSeconds > 0)
        .map((g) => ({ g, seconds: g.totalActiveSeconds }))
        .sort((a, b) => b.seconds - a.seconds),
    [games]
  );
  const gameHourItems = useMemo(
    () =>
      (games ?? [])
        .filter((g) => g.kind === "game" && g.totalRuntimeSeconds > 0)
        .map((g) => ({ g, seconds: g.totalRuntimeSeconds }))
        .sort((a, b) => b.seconds - a.seconds),
    [games]
  );

  const delta = useMemo(() => (data ? Math.round((data.avgMyScore - data.avgMetacritic) * 10) / 10 : 0), [data]);

  const curYear = new Date().getFullYear();

  // #5 — how much of the current year has elapsed.
  const yearProgress = useMemo(() => {
    const start = new Date(curYear, 0, 1).getTime();
    const end = new Date(curYear + 1, 0, 1).getTime();
    const pct = Math.min(100, ((Date.now() - start) / (end - start)) * 100);
    const totalDays = Math.round((end - start) / 86_400_000);
    const dayOfYear = Math.min(totalDays, Math.floor((Date.now() - start) / 86_400_000) + 1);
    return { pct, dayOfYear, totalDays, daysLeft: Math.max(0, totalDays - dayOfYear) };
  }, [curYear]);

  // #4 — completions per month, this year vs last (drives the velocity chart).
  const velocity = useMemo(() => {
    const months = MONTH_ABBR.map((label, m) => ({ m, label, cur: 0, prev: 0 }));
    for (const g of completed) {
      if (!g.completedYear) continue;
      // Many CSV imports only have a completion year — default to January so
      // they still appear on the chart instead of being silently dropped.
      const mi = Math.max(0, Math.min(11, (g.completedMonth ?? 1) - 1));
      if (g.completedYear === curYear) months[mi].cur += 1;
      else if (g.completedYear === curYear - 1) months[mi].prev += 1;
    }
    const curTotal = months.reduce((a, x) => a + x.cur, 0);
    const elapsedMonths = Math.max(1, new Date().getMonth() + 1);
    return { months, curTotal, pace: curTotal / elapsedMonths };
  }, [completed, curYear]);

  // #3 — year-over-year comparison of completions, playtime, scores.
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

  // #8 — your tracked playtime vs HowLongToBeat estimates.
  const hltb = useMemo(() => {
    const rows = completed
      .map((g) => {
        const estMin = g.hltbMainMinutes ?? g.timeToBeatMinutes ?? 0;
        const est = estMin * 60;
        const yours = g.totalRuntimeSeconds;
        if (est <= 0 || yours <= 600) return null; // need an estimate + real playtime
        return { g, est, yours, deltaPct: ((yours - est) / est) * 100 };
      })
      .filter((r): r is { g: Game; est: number; yours: number; deltaPct: number } => !!r);
    const avgDelta = rows.length ? rows.reduce((a, r) => a + r.deltaPct, 0) / rows.length : 0;
    const byDelta = [...rows].sort((a, b) => a.deltaPct - b.deltaPct);
    return {
      rows,
      count: rows.length,
      avgDelta,
      faster: byDelta.filter((r) => r.deltaPct < -2).slice(0, 4),
      slower: byDelta.filter((r) => r.deltaPct > 2).reverse().slice(0, 4),
    };
  }, [completed]);

  if (isLoading || !data) {
    return (
      <Page title="Collection">
        <Skeleton className="h-40 w-full" />
      </Page>
    );
  }

  if (data.totalCompleted === 0) {
    return (
      <Page title="Collection" subtitle="Your completed games hall of fame">
        <EmptyState icon={<Trophy className="h-6 w-6" />} title="No completed games yet" message="Mark games as completed, or import your games CSV to build your collection and unlock these insights." />
      </Page>
    );
  }

  const scatter = data.scorePoints.map((p) => ({ ...p, z: 1 }));
  const statusPie = data.statusCounts.filter(([, value]) => value > 0).map(([name, value]) => ({ name, value }));
  const maxHist = Math.max(1, ...scoreHist.map((b) => b.count));

  return (
    <Page title="Collection" subtitle={`${data.totalCompleted} games completed`}>
      <div className="space-y-6">
        {/* Cover-wall hero — gives the screen imagery before the stat panels. */}
        <Reveal>
          <CollectionHero
            games={games ?? []}
            totalCompleted={data.totalCompleted}
            avgMyScore={data.avgMyScore}
            playtimeSeconds={data.totalPlaytimeSeconds}
            perfectScores={data.perfectScores}
            scoredCount={data.scoredCount}
          />
        </Reveal>

        {/* Gauges */}
        <Reveal>
        <Panel panelKey="collection.gauges" games={games ?? []}>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <GaugeStat icon={<Trophy className="h-4 w-4" />} label="Completed" value={data.totalCompleted} max={Math.max(20, data.totalCompleted)} text={String(data.totalCompleted)} from="var(--accent-1)" to="var(--accent-3)" />
            <GaugeStat icon={<Star className="h-4 w-4" />} label="Avg my score" value={data.avgMyScore} max={100} text={data.avgMyScore.toFixed(1)} from="#fbbf24" to="#fb923c" />
            <GaugeStat icon={<Gauge className="h-4 w-4" />} label="Avg metacritic" value={data.avgMetacritic} max={100} text={data.avgMetacritic.toFixed(1)} from="#34d399" to="#22d3ee" />
            <div className="flex flex-col items-center justify-center gap-2 text-center">
              <Scale className="h-5 w-5 text-accent-3" />
              <div className="font-display text-3xl font-800 tabular-nums">{Math.abs(delta).toFixed(1)}</div>
              <div className="text-[11px] uppercase tracking-wider text-ink-dim">pts {delta >= 0 ? "kinder than critics" : "harsher than critics"}</div>
            </div>
          </div>
        </Panel>
        </Reveal>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
          <MiniStat icon={<Clock className="h-4 w-4" />} label="Playtime" value={hours(data.totalPlaytimeSeconds, 1) + "h"} hint="on completed games" delay={0} />
          <MiniStat icon={<Sparkle className="h-4 w-4" />} label="Perfect scores" value={String(data.perfectScores)} hint="rated 95+" delay={0.04} />
          <MiniStat icon={<BookOpen className="h-4 w-4" />} label="Backlog" value={String(data.backlogCount)} hint="waiting to play" delay={0.08} />
          <MiniStat icon={<XCircle className="h-4 w-4" />} label="Dropped" value={String(data.droppedCount)} hint="didn't finish" delay={0.12} />
          <MiniStat icon={<Star className="h-4 w-4" />} label="Scored" value={`${data.scoredCount}/${data.totalCompleted}`} hint="with your rating" delay={0.16} />
          {data.avgTimeToBeatMinutes > 0 && (
            <MiniStat icon={<History className="h-4 w-4" />} label="Avg HLTB" value={`${Math.round(data.avgTimeToBeatMinutes / 60)}h`} hint="time to beat est." delay={0.2} />
          )}
          {steamAchStats.gamesTracked > 0 && (
            <MiniStat
              icon={<Trophy className="h-4 w-4" />}
              label="Achievements"
              value={`${steamAchStats.totalUnlocked.toLocaleString()}`}
              hint={`${steamAchStats.avgPercent}% avg · ${steamAchStats.completedGames} platinum`}
              delay={0.24}
            />
          )}
        </div>

        <Reveal delay={0.05}>
        <div className="grid gap-6 lg:grid-cols-3">
          <Panel panelKey="collection.status" games={games ?? []}>
            <SectionTitle title="Library status" subtitle="Where your games stand" />
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={statusPie} dataKey="value" nameKey="name" innerRadius={56} outerRadius={86} paddingAngle={3} strokeWidth={0} isAnimationActive animationDuration={800}>
                  {statusPie.map((s) => (
                    <Cell key={s.name} fill={STATUS_COLORS[s.name] ?? "#94a3b8"} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="mt-2 flex flex-wrap justify-center gap-3 text-xs">
              {statusPie.map((s) => (
                <span key={s.name} className="flex items-center gap-1.5 capitalize text-ink-soft">
                  <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[s.name] }} />
                  {statusLabel(s.name)} <span className="font-800 text-ink">{s.value}</span>
                </span>
              ))}
            </div>
          </Panel>

          <Panel panelKey="collection.journey" games={games ?? []} className="lg:col-span-2">
            <SectionTitle title="Your journey" subtitle="Cumulative games completed over time" />
            {cumulative.length > 1 ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={cumulative} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent-1)" stopOpacity={0.55} />
                      <stop offset="100%" stopColor="var(--accent-3)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <XAxis dataKey="year" {...AXIS} tickLine={false} axisLine={false} />
                  <YAxis {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: "rgba(255,255,255,0.15)" }} />
                  <Area type="monotone" dataKey="total" name="Completed" stroke="var(--accent-1)" strokeWidth={2.5} fill="url(#cumGrad)" isAnimationActive animationDuration={900} animationEasing="ease-out" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState title="Not enough history" message="Add completed years across multiple years to chart your journey." />
            )}
          </Panel>
        </div>
        </Reveal>

        {(appHourItems.length > 0 || gameHourItems.length > 0) && (
          <Reveal delay={0.06}>
            <div className="grid gap-6 lg:grid-cols-2">
              <TreemapPanel
                panelKey="collection.app-hours"
                games={games ?? []}
                title="App active hours"
                subtitle="Where your focused app time goes"
                icon={<Clock className="h-4 w-4 text-accent-3" />}
                items={appHourItems}
                art="icon"
                emptyMessage="Track some apps to see their active-hours breakdown."
              />
              <TreemapPanel
                panelKey="collection.game-hours"
                games={games ?? []}
                title="Game total hours"
                subtitle="Total runtime across every game you've played"
                icon={<Gamepad2 className="h-4 w-4 text-accent-1" />}
                items={gameHourItems}
                art="cover"
                emptyMessage="Play tracked games to see their total-hours breakdown."
              />
            </div>
          </Reveal>
        )}

        <Reveal delay={0.07}>
          <YearPulsePanel
            games={games ?? []}
            year={curYear}
            progress={yearProgress}
            velocity={velocity}
          />
        </Reveal>

        {(yoy.cur.count > 0 || yoy.prev.count > 0) && (
          <Reveal delay={0.08}>
            <YearOverYearPanel games={games ?? []} year={curYear} yoy={yoy} />
          </Reveal>
        )}

        {hltb.count > 0 && (
          <Reveal delay={0.09}>
            <HltbVerdictPanel games={games ?? []} hltb={hltb} />
          </Reveal>
        )}

        {data.perYear.length > 0 && (
          <Reveal delay={0.08}>
          <Panel panelKey="collection.per-year" games={completed}>
            <SectionTitle title="Completions per year" subtitle="Count and average scores by finish year" />
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={data.perYear} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="year" {...AXIS} tickLine={false} axisLine={false} />
                <YAxis yAxisId="left" {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis yAxisId="right" orientation="right" domain={[0, 100]} {...AXIS} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="left" dataKey="count" name="Completed" fill="var(--accent-1)" radius={[6, 6, 0, 0]} isAnimationActive animationDuration={700} animationEasing="ease-out" />
                <Bar yAxisId="right" dataKey="avgScore" name="Avg my score" fill="#fbbf24" radius={[6, 6, 0, 0]} opacity={0.85} isAnimationActive animationBegin={200} animationDuration={700} animationEasing="ease-out" />
              </BarChart>
            </ResponsiveContainer>
          </Panel>
          </Reveal>
        )}

        <Reveal delay={0.09}>
          <RecentlyCompletedRail games={completed} />
        </Reveal>

        <Reveal delay={0.1}>
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel panelKey="collection.score-dist" games={completed}>
            <SectionTitle title="Score distribution" subtitle="How generous is your scoring?" />
            <div className="flex h-[200px] items-end gap-3 px-2">
              {scoreHist.map((b, i) => (
                <div key={b.label} className="flex flex-1 flex-col items-center justify-end gap-2">
                  <span className="text-xs font-800 tabular-nums text-ink-soft">{b.count}</span>
                  <motion.div
                    className="w-full rounded-t-lg bg-accent-sheen"
                    initial={{ height: 0 }}
                    animate={{ height: `${(b.count / maxHist) * 150 + 4}px` }}
                    transition={{ delay: i * 0.06, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                    style={{ boxShadow: "0 0 18px -6px var(--accent-1)" }}
                  />
                  <span className="text-[11px] text-ink-dim">{b.label}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel panelKey="collection.scatter" games={completed}>
            <SectionTitle title="My score vs Metacritic" subtitle="Above the line = you liked it more" />
            <ResponsiveContainer width="100%" height={220}>
              <ScatterChart margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" />
                <XAxis type="number" dataKey="metacritic" name="Metacritic" domain={[40, 100]} {...AXIS} tickLine={false} axisLine={false} />
                <YAxis type="number" dataKey="my" name="My score" domain={[40, 100]} {...AXIS} tickLine={false} axisLine={false} />
                <ZAxis type="number" dataKey="z" range={[50, 50]} />
                <ReferenceLine segment={[{ x: 40, y: 40 }, { x: 100, y: 100 }]} stroke="rgba(255,255,255,0.18)" strokeDasharray="4 4" />
                <Tooltip
                  content={({ active, payload }: any) =>
                    active && payload?.length ? (
                      <div className="rounded-xl border border-line bg-bg-800/95 px-3 py-2 text-xs shadow-float">
                        <div className="font-800">{payload[0].payload.name}</div>
                        <div className="text-ink-soft">You {payload[0].payload.my} · Critics {payload[0].payload.metacritic}</div>
                      </div>
                    ) : null
                  }
                  cursor={{ strokeDasharray: "3 3" }}
                />
                <Scatter data={scatter} fill="var(--accent-3)" fillOpacity={0.8} isAnimationActive={false} shape={(props) => <PopScatterDot {...props} enabled={enabled} />} />
              </ScatterChart>
            </ResponsiveContainer>
          </Panel>
        </div>
        </Reveal>

        <Reveal delay={0.12}>
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel panelKey="collection.era" games={completed}>
            <SectionTitle title="By era" subtitle="Release decade of games you finished" right={<History className="h-4 w-4 text-ink-dim" />} />
            {decades.length > 0 ? (
              <BarList items={decades.map((d) => ({ label: d.label, value: d.count }))} />
            ) : (
              <EmptyState title="No release years" />
            )}
          </Panel>
          <Panel panelKey="collection.genres" games={completed}>
            <SectionTitle title="Top genres" subtitle="Your most-completed tags" right={<Tag className="h-4 w-4 text-ink-dim" />} />
            {tagCounts.length > 0 ? (
              <BarList items={tagCounts.map((t) => ({ label: t.tag, value: t.count }))} />
            ) : (
              <EmptyState title="No tags yet" message="Add tags to your games to see genre breakdowns." />
            )}
          </Panel>
        </div>
        </Reveal>

        <Reveal delay={0.12}>
          <MusicGamingPanel />
        </Reveal>

        <Reveal delay={0.14}>
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel panelKey="collection.genre" games={games ?? []}>
            <SectionTitle title="Genre footprint" subtitle="Where your finished games cluster" right={<RadarIcon className="h-4 w-4 text-ink-dim" />} />
            {genreRadar.length >= 3 ? (
              <RadarChart items={genreRadar} />
            ) : (
              <EmptyState title="Not enough tags" message="Tag at least 3 genres across your completed games." />
            )}
          </Panel>
          <Panel panelKey="collection.bubble" games={games ?? []} className="relative overflow-hidden">
            <SectionTitle title="Playtime vs score" subtitle="Bubble size = number of sessions" right={<Sparkles className="h-4 w-4 text-ink-dim" />} />
            <CollectionBubbleChart data={bubbleData} enabled={enabled} />
          </Panel>
        </div>
        </Reveal>

        <div className="grid gap-6 lg:grid-cols-2">
          <Panel panelKey="collection.liked" games={games ?? []}>
            <SectionTitle title="You loved these more" subtitle="Biggest positive gap vs critics" right={<TrendingUp className="h-4 w-4 text-green" />} />
            <DeltaList items={deltas.liked} positive />
          </Panel>
          <Panel panelKey="collection.critics" games={games ?? []}>
            <SectionTitle title="Critics loved these more" subtitle="Where you were tougher" right={<TrendingDown className="h-4 w-4 text-pink" />} />
            <DeltaList items={deltas.critics} positive={false} />
          </Panel>
        </div>

        <Panel panelKey="collection.studios" games={completed}>
          <SectionTitle title="Top studios" subtitle="Most-completed developers" />
          {data.topStudios.length > 0 ? (
            <div className="space-y-2">
              {data.topStudios.map((s, i) => {
                const max = data.topStudios[0].count || 1;
                return (
                  <div key={s.studio} className="flex items-center gap-3">
                    <span className="w-4 text-xs font-800 text-ink-faint">{i + 1}</span>
                    <span className="w-44 shrink-0 truncate text-sm font-700">{s.studio}</span>
                    <LevelBar value={s.count} max={max} className="flex-1" delay={i * 0.05} />
                    <span className="w-8 text-right text-sm font-800 tabular-nums">{s.count}</span>
                    {s.avgScore > 0 && <span className="w-16 text-right text-xs text-ink-dim">avg {s.avgScore.toFixed(0)}</span>}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState title="No studio data" />
          )}
        </Panel>

        {hallOfFame.length > 0 && (
          <Panel panelKey="collection.hall" games={games ?? []}>
            <SectionTitle title="Hall of fame" subtitle="Your highest-rated completions" />
            <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
              {hallOfFame.map((g, i) => (
                <Link key={g.id} to={`/game/${g.id}`} className="group relative">
                  <div className="relative aspect-[3/4] overflow-hidden rounded-xl border border-line transition group-hover:-translate-y-1 group-hover:shadow-float">
                    <GameArt id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} steamAppId={g.steamAppId} className="absolute inset-0 h-full w-full" rounded="rounded-xl" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                    <div className="absolute right-1.5 top-1.5">
                      <GameScores game={g} variant="badge" index={i} className="static rounded-full px-1.5 py-0.5 text-[9px]" />
                    </div>
                    {i === 0 && <div className="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-amber text-[10px] font-900 text-black">1</div>}
                    <div className="absolute left-1.5 bottom-8">
                      <SteamAchievementBadge game={g} size="xs" />
                    </div>
                    <div className="absolute inset-x-0 bottom-0 truncate p-1.5 text-[10px] font-700 text-white">{g.displayName}</div>
                  </div>
                </Link>
              ))}
            </div>
          </Panel>
        )}

        {steamAchStats.gamesTracked > 0 && (
          <Reveal delay={0.15}>
            <SteamAchievementCollectionSection games={games ?? []} />
          </Reveal>
        )}

        <div className="pt-2">
          <SectionTitle title="Your year in games" subtitle="Wrapped recap, milestones & monthly activity" />
          <div className="mt-4">
            <InsightsContent kind="game" />
          </div>
        </div>
      </div>
    </Page>
  );
}

function CollectionHero({
  games,
  totalCompleted,
  avgMyScore,
  playtimeSeconds,
  perfectScores,
  scoredCount,
}: {
  games: Game[];
  totalCompleted: number;
  avgMyScore: number;
  playtimeSeconds: number;
  perfectScores: number;
  scoredCount: number;
}) {
  return (
    <div className="relative h-[200px] overflow-hidden rounded-3xl border border-line bg-bg-900/70 shadow-card">
      {/* Drifting cover wall (shared marquee) */}
      <CoverMarquee
        games={games}
        fade={false}
        className="absolute inset-0 rounded-3xl border-0 bg-transparent shadow-none"
      />

      {/* Scrims so the foreground text stays readable over the art */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-bg-base via-bg-base/65 to-bg-base/85" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg-base via-transparent to-bg-base/30" />

      {/* Foreground: title + headline stat chips */}
      <div className="relative flex h-full flex-col justify-center px-6">
        <div className="flex items-center gap-2 text-[11px] font-800 uppercase tracking-[0.22em] text-accent-3">
          <Trophy className="h-4 w-4" /> Collection
        </div>
        <h2 className="mt-1 font-display text-[26px] font-900 leading-tight text-ink glow-text">
          Your hall of games
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <HeroChip icon={<Trophy className="h-3.5 w-3.5" />} value={String(totalCompleted)} label="completed" />
          <HeroChip icon={<Star className="h-3.5 w-3.5" />} value={avgMyScore.toFixed(1)} label="avg score" />
          <HeroChip icon={<Clock className="h-3.5 w-3.5" />} value={`${hours(playtimeSeconds, 1)}h`} label="played" />
          {perfectScores > 0 && (
            <HeroChip icon={<Sparkle className="h-3.5 w-3.5" />} value={String(perfectScores)} label="perfect" />
          )}
          <HeroChip icon={<BookOpen className="h-3.5 w-3.5" />} value={`${scoredCount}/${totalCompleted}`} label="scored" />
        </div>
      </div>
    </div>
  );
}

function RecentlyCompletedRail({ games }: { games: Game[] }) {
  // Newest finishes first, by completion date (year/month/day).
  const recent = useMemo(() => {
    const key = (g: Game) =>
      (g.completedYear ?? 0) * 10000 + (g.completedMonth ?? 0) * 100 + (g.completedDay ?? 0);
    return [...games]
      .filter((g) => g.coverPath || g.iconPath)
      .sort((a, b) => key(b) - key(a))
      .slice(0, 18);
  }, [games]);

  if (recent.length === 0) return null;

  return (
    <Panel panelKey="collection.recent" games={games}>
      <SectionTitle
        title="Recently completed"
        subtitle="Your latest finishes, newest first"
        right={<Sparkles className="h-4 w-4 text-ink-dim" />}
      />
      <div className="-mx-1 mt-1 flex gap-3 overflow-x-auto px-1 pb-2 [scrollbar-width:thin]">
        {recent.map((g, i) => (
          <Link
            key={g.id}
            to={`/game/${g.id}`}
            className="group relative w-[116px] shrink-0"
            style={{ scrollSnapAlign: "start" }}
          >
            <div className="relative aspect-[3/4] overflow-hidden rounded-xl border border-line transition duration-300 group-hover:-translate-y-1 group-hover:border-line-strong group-hover:shadow-float">
              <GameArt
                id={g.id}
                name={g.displayName}
                cover={g.coverPath}
                icon={g.iconPath}
                accent={g.accentColor} steamAppId={g.steamAppId}
                className="absolute inset-0 h-full w-full"
                rounded="rounded-xl"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
              <div className="absolute right-1.5 top-1.5">
                <GameScores game={g} variant="badge" index={i} className="static rounded-full px-1.5 py-0.5 text-[9px]" />
              </div>
              <div className="absolute left-1.5 bottom-10">
                <SteamAchievementBadge game={g} size="xs" />
              </div>
              <div className="absolute inset-x-0 bottom-0 p-2">
                <div className="truncate text-[11px] font-800 text-white">{g.displayName}</div>
                {g.completedYear && <div className="text-[10px] font-600 text-white/60">{g.completedYear}</div>}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </Panel>
  );
}

function HeroChip({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-black/45 px-3 py-1 backdrop-blur-md">
      <span className="text-accent-3">{icon}</span>
      <span className="font-800 tabular-nums text-ink">{value}</span>
      <span className="text-[10px] font-700 uppercase tracking-wider text-ink-dim">{label}</span>
    </span>
  );
}

function GaugeStat({ icon, label, value, max, text, from, to }: { icon: React.ReactNode; label: string; value: number; max: number; text: string; from: string; to: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <RadialGauge value={value} max={max} size={108} from={from} to={to}>
        <div className="text-center">
          <div className="font-display text-2xl font-800 tabular-nums leading-none">{text}</div>
        </div>
      </RadialGauge>
      <div className="flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">
        {icon}
        {label}
      </div>
    </div>
  );
}

function MiniStat({ icon, label, value, hint, delay = 0 }: { icon: React.ReactNode; label: string; value: string; hint: string; delay?: number }) {
  const enabled = useMotionEnabled();
  return (
    <motion.div
      className="rounded-xl border border-line bg-white/[0.02] px-3 py-3"
      initial={enabled ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex items-center gap-2 text-ink-dim">{icon}<span className="text-[10px] font-700 uppercase tracking-wider">{label}</span></div>
      <div className="mt-1 font-display text-xl font-800 tabular-nums text-ink">{value}</div>
      <div className="text-[10px] text-ink-faint">{hint}</div>
    </motion.div>
  );
}

function BarList({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="space-y-2.5">
      {items.map((it, i) => (
        <div key={it.label} className="flex items-center gap-3">
          <span className="w-20 shrink-0 truncate text-sm font-700 text-ink-soft">{it.label}</span>
          <LevelBar value={it.value} max={max} className="flex-1" delay={i * 0.05} />
          <span className="w-7 text-right text-sm font-800 tabular-nums">{it.value}</span>
        </div>
      ))}
    </div>
  );
}

function DeltaList({ items, positive }: { items: { g: Game; d: number }[]; positive: boolean }) {
  if (items.length === 0) return <EmptyState title="Not enough scored games" />;
  const color = positive ? "#34d399" : "#f472b6";
  return (
    <div className="space-y-1">
      {items.map(({ g, d }) => (
        <Link key={g.id} to={`/game/${g.id}`} className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-white/[0.03]">
          <GameArt id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} steamAppId={g.steamAppId} className="h-9 w-9" rounded="rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-700">{g.displayName}</div>
            <div className="text-[11px] text-ink-dim">You {g.rating} · Critics {g.metacritic}</div>
          </div>
          <span className="rounded-lg px-2 py-1 text-sm font-800 tabular-nums" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
            {d >= 0 ? "+" : ""}
            {d}
          </span>
        </Link>
      ))}
    </div>
  );
}

interface TreeItem {
  g: Game;
  seconds: number;
}
interface TreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PIE_COLORS = ["#7c5cff", "#22d3ee", "#34d399", "#f472b6", "#fbbf24", "#60a5fa", "#a78bfa", "#fb923c", "#f87171", "#2dd4bf", "#c084fc", "#facc15"];

/**
 * Squarified treemap (Bruls–Huizing–van Wijk) over a width×height box. Returns
 * one rectangle per value, in input order, with tiles kept close to square so
 * even the long tail stays tappable. Values must be > 0 and pre-sorted big→small.
 */
function squarify(values: number[], width: number, height: number): TreeRect[] {
  const n = values.length;
  const rects: TreeRect[] = new Array(n);
  if (n === 0) return rects;
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const scale = (width * height) / total;
  const areas = values.map((v) => v * scale);

  let x = 0, y = 0, w = width, h = height;
  let i = 0;
  let row: number[] = [];

  const worst = (idxs: number[], side: number) => {
    let sum = 0, max = -Infinity, min = Infinity;
    for (const k of idxs) {
      const a = areas[k];
      sum += a;
      if (a > max) max = a;
      if (a < min) min = a;
    }
    const s2 = sum * sum;
    const l2 = side * side || 1;
    return Math.max((l2 * max) / (s2 || 1), s2 / (l2 * (min || 1)));
  };

  const layout = () => {
    const sum = row.reduce((a, k) => a + areas[k], 0) || 1;
    if (w >= h) {
      const colW = sum / h;
      let yy = y;
      for (const k of row) {
        const rh = (areas[k] / sum) * h;
        rects[k] = { x, y: yy, w: colW, h: rh };
        yy += rh;
      }
      x += colW;
      w -= colW;
    } else {
      const rowH = sum / w;
      let xx = x;
      for (const k of row) {
        const rw = (areas[k] / sum) * w;
        rects[k] = { x: xx, y, w: rw, h: rowH };
        xx += rw;
      }
      y += rowH;
      h -= rowH;
    }
    row = [];
  };

  while (i < n) {
    const side = Math.min(w, h) || 1;
    if (row.length === 0) {
      row.push(i++);
      continue;
    }
    if (worst([...row, i], side) <= worst(row, side)) row.push(i++);
    else layout();
  }
  if (row.length) layout();
  return rects;
}

function TreemapPanel({
  panelKey,
  games,
  title,
  subtitle,
  icon,
  items,
  art,
  emptyMessage,
}: {
  panelKey: string;
  games: Game[];
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  items: TreeItem[];
  art: "cover" | "icon";
  emptyMessage: string;
}) {
  // One title can dwarf the rest — toggle out any of the top 5 individually so
  // the treemap re-packs and smaller tiles get room.
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const canHide = items.length > 6;
  const top5 = items.slice(0, 5);
  const source = items.filter((it) => !excluded.has(it.g.id));
  const toggleExcluded = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const rects = useMemo(() => squarify(source.map((it) => it.seconds), 100, 100), [source]);
  const totalH = source.reduce((a, it) => a + it.seconds, 0) / 3600;

  return (
    <Panel panelKey={panelKey} games={games}>
      <SectionTitle title={title} subtitle={subtitle} right={icon} />
      {items.length === 0 ? (
        <EmptyState title="No hours yet" message={emptyMessage} />
      ) : (
        <>
          {canHide && (
            <div className="mt-1 flex w-full flex-wrap items-center gap-1.5 rounded-xl border border-line bg-white/[0.02] px-2.5 py-2">
              <span className="mr-1 inline-flex items-center gap-1 text-[10px] font-800 uppercase tracking-wider text-ink-dim">
                <Eye className="h-3 w-3" />
                Top 5
              </span>
              {top5.map((it, i) => {
                const out = excluded.has(it.g.id);
                return (
                  <button
                    key={it.g.id}
                    type="button"
                    onClick={() => toggleExcluded(it.g.id)}
                    title={out ? `Show ${it.g.displayName} in the treemap` : `Hide ${it.g.displayName} from the treemap`}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-700 tabular-nums transition focus-ring ${
                      out ? "border-line/60 text-ink-faint line-through opacity-60" : "border-line text-ink-soft hover:border-accent/40"
                    }`}
                  >
                    {out ? <EyeOff className="h-2.5 w-2.5 shrink-0" /> : <Eye className="h-2.5 w-2.5 shrink-0 opacity-50" />}
                    <span className="h-2 w-2 rounded-full" style={{ background: it.g.accentColor || PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="max-w-[92px] truncate">{it.g.displayName}</span>
                    {(it.seconds / 3600).toFixed(1)}h
                  </button>
                );
              })}
              {excluded.size > 0 && (
                <button
                  type="button"
                  onClick={() => setExcluded(new Set())}
                  className="ml-auto text-[10px] font-700 text-accent-3 hover:underline"
                >
                  Show all
                </button>
              )}
            </div>
          )}

          {/* The square treemap — every tile is a game/app, sized by hours. */}
          <div className="relative mt-3 aspect-square w-full overflow-hidden rounded-2xl border border-line bg-bg-900/60">
            {source.map((it, i) => (
              <TreemapTile key={it.g.id} item={it} rect={rects[i]} art={art} />
            ))}
            <div className="pointer-events-none absolute right-2 top-2 rounded-lg bg-black/55 px-2 py-1 text-right backdrop-blur">
              <div className="font-display text-sm font-800 tabular-nums text-white">{totalH.toFixed(totalH >= 100 ? 0 : 1)}h</div>
              <div className="text-[9px] font-700 uppercase tracking-wider text-white/60">{excluded.size > 0 ? "visible" : "total"}</div>
            </div>
          </div>
          <p className="mt-2 text-[10px] text-ink-faint">Tiles sized by hours · hover any tile for its name & time</p>
        </>
      )}
    </Panel>
  );
}

function TreemapTile({ item, rect, art }: { item: TreeItem; rect: TreeRect | undefined; art: "cover" | "icon" }) {
  if (!rect) return null;
  const { g, seconds } = item;
  const hours = seconds / 3600;
  const big = rect.w > 16 && rect.h > 13; // enough room for name + hours
  const med = rect.w > 9 && rect.h > 7;
  return (
    <div
      className="group absolute p-[2px]"
      style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.w}%`, height: `${rect.h}%` }}
      title={`${g.displayName} · ${hours.toFixed(1)}h`}
    >
      <Link
        to={`/game/${g.id}`}
        className="relative block h-full w-full overflow-hidden rounded-md ring-1 ring-inset ring-black/40 transition duration-200 hover:z-20 hover:ring-2 hover:ring-white/70"
      >
        <GameArt
          id={g.id}
          name={g.displayName}
          cover={g.coverPath}
          icon={g.iconPath}
          accent={g.accentColor}
          steamAppId={g.steamAppId}
          variant={art === "icon" ? "icon" : undefined}
          className="absolute inset-0 h-full w-full"
          rounded="rounded-md"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-black/5" />
        <div className={`absolute inset-x-0 bottom-0 p-1.5 transition-opacity duration-200 ${big ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
          <div className="truncate text-[11px] font-800 leading-tight text-white drop-shadow">{g.displayName}</div>
          <div className="text-[10px] font-700 tabular-nums text-white/85">{hours.toFixed(1)}h</div>
        </div>
        {!big && med && (
          <div className="absolute left-1 top-1 rounded bg-black/55 px-1 py-0.5 text-[9px] font-800 tabular-nums text-white opacity-0 transition-opacity group-hover:opacity-100">
            {hours.toFixed(1)}h
          </div>
        )}
      </Link>
    </div>
  );
}

// ---- This-year analytics (#3 YoY, #4 velocity, #5 year progress) ----

interface YearProgress {
  pct: number;
  dayOfYear: number;
  totalDays: number;
  daysLeft: number;
}
interface VelocityData {
  months: { m: number; label: string; cur: number; prev: number }[];
  curTotal: number;
  pace: number;
}

function YearRing({ pct }: { pct: number }) {
  const r = 30;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return (
    <div className="relative h-[84px] w-[84px] shrink-0">
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
        <defs>
          <linearGradient id="yearRing" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent-1)" />
            <stop offset="100%" stopColor="var(--accent-3)" />
          </linearGradient>
        </defs>
        <circle cx="40" cy="40" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="7" />
        <motion.circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke="url(#yearRing)"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circ}
          initial={{ strokeDashoffset: circ }}
          whileInView={{ strokeDashoffset: offset }}
          viewport={{ once: true }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
          style={{ filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--accent-1) 60%, transparent))" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <CalendarRange className="h-5 w-5 text-accent-3" />
      </div>
    </div>
  );
}

function YearPulsePanel({ games, year, progress, velocity }: { games: Game[]; year: number; progress: YearProgress; velocity: VelocityData }) {
  const enabled = useMotionEnabled();
  const maxBar = Math.max(1, ...velocity.months.flatMap((m) => [m.cur, m.prev]));
  const chartH = 100;
  return (
    <Panel panelKey="collection.year-pulse" games={games}>
      <SectionTitle title={`${year} in focus`} subtitle="How far through the year — and your completion pace" right={<CalendarRange className="h-4 w-4 text-ink-dim" />} />
      <div className="mt-2 grid gap-5 lg:grid-cols-[minmax(0,250px)_1fr] lg:items-center">
        <div className="flex items-center gap-4">
          <YearRing pct={progress.pct} />
          <div>
            <div className="font-display text-3xl font-900 tabular-nums leading-none">{progress.pct.toFixed(0)}%</div>
            <div className="mt-1 text-xs text-ink-dim">of {year} gone</div>
            <div className="mt-2 text-[11px] text-ink-faint">
              Day {progress.dayOfYear} · <span className="text-ink-soft">{progress.daysLeft}</span> days left
            </div>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between text-[11px] font-700 uppercase tracking-wider text-ink-dim">
            <span>Completions per month</span>
            <span className="normal-case tracking-normal text-ink-faint">
              <span className="font-800 text-ink-soft">{velocity.curTotal}</span> this year · {velocity.pace.toFixed(1)}/mo pace
            </span>
          </div>
          <div className="flex h-[120px] items-end gap-1.5">
            {velocity.months.map((m, i) => {
              const curH = m.cur > 0 ? Math.max(6, Math.round((m.cur / maxBar) * chartH)) : 0;
              const prevH = m.prev > 0 ? Math.max(4, Math.round((m.prev / maxBar) * chartH)) : 0;
              return (
                <div key={i} className="flex flex-1 flex-col items-center gap-1">
                  <div className="relative flex w-full items-end justify-center" style={{ height: chartH }}>
                    {prevH > 0 && (
                      <div
                        className="absolute bottom-0 w-full rounded-t bg-white/[0.07]"
                        style={{ height: prevH }}
                        title={`${year - 1}: ${m.prev}`}
                      />
                    )}
                    {enabled ? (
                      <motion.div
                        className="relative w-[68%] rounded-t bg-accent-sheen"
                        initial={false}
                        animate={{ height: curH }}
                        transition={{ delay: i * 0.03, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                        style={{ boxShadow: m.cur > 0 ? "0 0 14px -4px var(--accent-1)" : undefined }}
                        title={`${year}: ${m.cur}`}
                      />
                    ) : (
                      <div
                        className="relative w-[68%] rounded-t bg-accent-sheen"
                        style={{ height: curH, boxShadow: m.cur > 0 ? "0 0 14px -4px var(--accent-1)" : undefined }}
                        title={`${year}: ${m.cur}`}
                      />
                    )}
                  </div>
                  <span className="text-[9px] font-700 text-ink-faint">{m.label}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex gap-4 text-[10px] text-ink-dim">
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent-sheen" /> {year}</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-white/20" /> {year - 1}</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}

interface YoYAgg {
  count: number;
  hours: number;
  avg: number;
  perfect: number;
}

function YearOverYearPanel({ games, year, yoy }: { games: Game[]; year: number; yoy: { cur: YoYAgg; prev: YoYAgg } }) {
  const metrics: { label: string; cur: number; prev: number; fmt: (n: number) => string; points?: boolean }[] = [
    { label: "Completed", cur: yoy.cur.count, prev: yoy.prev.count, fmt: (n) => String(Math.round(n)) },
    { label: "Hours played", cur: yoy.cur.hours, prev: yoy.prev.hours, fmt: (n) => `${n.toFixed(0)}h` },
    { label: "Avg score", cur: yoy.cur.avg, prev: yoy.prev.avg, fmt: (n) => (n ? n.toFixed(1) : "—"), points: true },
    { label: "Perfect (95+)", cur: yoy.cur.perfect, prev: yoy.prev.perfect, fmt: (n) => String(Math.round(n)) },
  ];
  return (
    <Panel panelKey="collection.yoy" games={games}>
      <SectionTitle title="Year over year" subtitle={`${year} vs ${year - 1}`} right={<TrendingUp className="h-4 w-4 text-ink-dim" />} />
      <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
        {metrics.map((m) => {
          const diff = m.cur - m.prev;
          const pct = m.points ? diff : m.prev > 0 ? (diff / m.prev) * 100 : m.cur > 0 ? 100 : 0;
          const up = diff >= 0;
          const color = up ? "#34d399" : "#f472b6";
          const show = !(m.cur === 0 && m.prev === 0);
          return (
            <div key={m.label} className="rounded-2xl border border-line bg-white/[0.02] p-3">
              <div className="text-[10px] font-700 uppercase tracking-wider text-ink-dim">{m.label}</div>
              <div className="mt-1 font-display text-2xl font-800 tabular-nums text-ink">{m.fmt(m.cur)}</div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[10px] text-ink-faint">{year - 1}: {m.fmt(m.prev)}</span>
                {show && (m.cur !== m.prev) && (
                  <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-800 tabular-nums" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
                    {up ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                    {m.points ? `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}` : `${diff >= 0 ? "+" : ""}${Math.round(pct)}%`}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

interface HltbRow {
  g: Game;
  est: number;
  yours: number;
  deltaPct: number;
}

function HltbVerdictPanel({ games, hltb }: { games: Game[]; hltb: { count: number; avgDelta: number; faster: HltbRow[]; slower: HltbRow[] } }) {
  const faster = hltb.avgDelta < 0;
  return (
    <Panel panelKey="collection.hltb" games={games}>
      <SectionTitle title="You vs HowLongToBeat" subtitle={`Your playtime against community estimates · ${hltb.count} games`} right={<Hourglass className="h-4 w-4 text-ink-dim" />} />
      <div className="mt-2 flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-white/[0.015] p-4">
        <div
          className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl"
          style={{ background: `color-mix(in srgb, ${faster ? "#34d399" : "#f59e0b"} 16%, transparent)`, color: faster ? "#34d399" : "#f59e0b" }}
        >
          {faster ? <Rabbit className="h-7 w-7" /> : <Turtle className="h-7 w-7" />}
        </div>
        <div className="min-w-0">
          <div className="font-display text-2xl font-900 tabular-nums text-ink">
            {Math.abs(hltb.avgDelta).toFixed(0)}% {faster ? "faster" : "slower"}
          </div>
          <div className="text-sm text-ink-dim">
            On average you finish {faster ? "quicker than" : "slower than"} the typical HowLongToBeat main story.
          </div>
        </div>
      </div>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <HltbList title="Speedran" subtitle="Finished well under estimate" rows={hltb.faster} positive />
        <HltbList title="Savored" subtitle="Took your time over the estimate" rows={hltb.slower} positive={false} />
      </div>
    </Panel>
  );
}

function HltbList({ title, subtitle, rows, positive }: { title: string; subtitle: string; rows: HltbRow[]; positive: boolean }) {
  const color = positive ? "#34d399" : "#f472b6";
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="mb-0.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">{title}</div>
      <p className="mb-3 text-xs text-ink-faint">{subtitle}</p>
      <div className="space-y-1">
        {rows.map(({ g, est, yours, deltaPct }) => (
          <Link key={g.id} to={`/game/${g.id}`} className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-white/[0.03]">
            <GameArt id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} steamAppId={g.steamAppId} className="h-9 w-9" rounded="rounded-lg" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-700">{g.displayName}</div>
              <div className="text-[11px] text-ink-dim">You {dur(yours)} · HLTB {dur(est)}</div>
            </div>
            <span className="shrink-0 rounded-lg px-2 py-1 text-sm font-800 tabular-nums" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
              {deltaPct >= 0 ? "+" : ""}
              {deltaPct.toFixed(0)}%
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-line bg-bg-800/95 px-3 py-2 text-xs shadow-float backdrop-blur">
      {label != null && <div className="mb-1 font-800">{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2 capitalize text-ink-soft">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color || p.fill || p.payload?.fill }} />
          {p.name}: <span className="font-800 text-ink">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

function PopScatterDot({ cx, cy, fill, index, enabled }: { cx?: number; cy?: number; fill?: string; index?: number; enabled: boolean }) {
  if (cx == null || cy == null) return null;
  return (
    <motion.circle
      cx={cx}
      cy={cy}
      r={5}
      fill={fill}
      fillOpacity={0.85}
      initial={enabled ? { scale: 0, opacity: 0 } : false}
      animate={{ scale: 1, opacity: 0.85 }}
      transition={{ delay: (index ?? 0) * 0.035, type: "spring", stiffness: 320, damping: 20 }}
      style={{ transformOrigin: `${cx}px ${cy}px`, transformBox: "fill-box" }}
    />
  );
}

function CollectionBubbleChart({
  data,
  enabled,
}: {
  data: { name: string; hours: number; score: number; sessions: number; color: string }[];
  enabled: boolean;
}) {
  const points = useMemo(() => data.map((d) => ({ ...d, z: Math.max(1, d.sessions) })), [data]);
  if (points.length === 0) return <div className="grid h-[220px] place-items-center text-sm text-ink-dim">No tracked & scored games yet</div>;
  return (
    <div className="relative">
      {enabled && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-30" aria-hidden>
          <defs>
            <pattern id="coll-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.04)" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#coll-grid)" />
        </svg>
      )}
      <ResponsiveContainer width="100%" height={240}>
        <ScatterChart margin={{ top: 10, right: 16, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.04)" />
          <XAxis type="number" dataKey="hours" name="Hours" stroke="#454c66" fontSize={11} tickLine={false} axisLine={false} unit="h" />
          <YAxis type="number" dataKey="score" name="Score" domain={[40, 100]} stroke="#454c66" fontSize={11} tickLine={false} axisLine={false} />
          <ZAxis type="number" dataKey="z" range={[60, 480]} name="Sessions" />
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            content={({ active, payload }: any) =>
              active && payload?.length ? (
                <div className="rounded-xl border border-line bg-bg-800/95 px-3 py-2 text-xs shadow-float backdrop-blur">
                  <div className="font-800">{payload[0].payload.name}</div>
                  <div className="text-ink-soft">
                    {payload[0].payload.hours}h · score {payload[0].payload.score} · {payload[0].payload.sessions} sessions
                  </div>
                </div>
              ) : null
            }
          />
          <Scatter data={points} isAnimationActive={false} shape={(props) => <BubbleDot {...props} enabled={enabled} />}>
            {points.map((p, i) => (
              <Cell key={i} fill={p.color} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

function BubbleDot({ cx, cy, fill, payload, index, enabled }: { cx?: number; cy?: number; fill?: string; payload?: { z?: number }; index?: number; enabled: boolean }) {
  if (cx == null || cy == null) return null;
  const r = Math.sqrt((payload?.z ?? 1) / Math.PI) * 2.2;
  return (
    <motion.circle
      cx={cx}
      cy={cy}
      r={r}
      fill={fill}
      fillOpacity={0.65}
      initial={enabled ? { scale: 0, opacity: 0 } : false}
      animate={{ scale: 1, opacity: 0.65 }}
      transition={{ delay: (index ?? 0) * 0.05, type: "spring", stiffness: 260, damping: 18 }}
      style={{ transformOrigin: `${cx}px ${cy}px`, transformBox: "fill-box" }}
    />
  );
}
