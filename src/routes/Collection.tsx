import { useMemo } from "react";
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
import { Trophy, Star, Gauge, Scale, TrendingUp, TrendingDown, Tag, History, Radar as RadarIcon, Sparkles, Clock, BookOpen, XCircle, Sparkle } from "lucide-react";
import { Page } from "@/components/Page";
import { Card, SectionTitle, EmptyState, Skeleton, statusLabel } from "@/components/ui";
import { RadialGauge, LevelBar } from "@/components/RadialGauge";
import { RadarChart } from "@/components/Charts";
import { Reveal } from "@/components/Reveal";
import { GameArt } from "@/components/GameArt";
import { GameScores } from "@/components/GameScores";
import { CoverMarquee } from "@/components/CoverMarquee";
import { MarqueeCard } from "@/components/MarqueeFX";
import { InsightsContent } from "./Insights";
import { useCatalog, useGames } from "@/lib/queries";
import { useMotionEnabled } from "@/store/app";
import { Game } from "@/lib/api";
import { dur, hours } from "@/lib/format";
import { aggregateSteamAchievements } from "@/lib/steamAchievements";
import { SteamAchievementBadge, SteamAchievementCollectionSection } from "@/components/SteamAchievements";

const AXIS = { stroke: "#454c66", fontSize: 11 };
const STATUS_COLORS: Record<string, string> = { playing: "#34d399", completed: "#7c5cff", backlog: "#3b82f6", dropped: "#f472b6", on_hold: "#f59e0b", watched: "#22d3ee" };

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

  const delta = useMemo(() => (data ? Math.round((data.avgMyScore - data.avgMetacritic) * 10) / 10 : 0), [data]);

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
        <MarqueeCard variant="bokeh" games={games ?? []}>
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
        </MarqueeCard>
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
          <MarqueeCard variant="pulse" games={games ?? []}>
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
          </MarqueeCard>

          <MarqueeCard variant="wave" games={games ?? []} className="lg:col-span-2">
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
          </MarqueeCard>
        </div>
        </Reveal>

        {data.perYear.length > 0 && (
          <Reveal delay={0.08}>
          <MarqueeCard variant="ticker" games={completed}>
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
          </MarqueeCard>
          </Reveal>
        )}

        <Reveal delay={0.09}>
          <RecentlyCompletedRail games={completed} />
        </Reveal>

        <Reveal delay={0.1}>
        <div className="grid gap-6 lg:grid-cols-2">
          <MarqueeCard variant="tilt3d" games={completed}>
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
          </MarqueeCard>

          <MarqueeCard variant="verticalReverse" games={completed}>
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
          </MarqueeCard>
        </div>
        </Reveal>

        <Reveal delay={0.12}>
        <div className="grid gap-6 lg:grid-cols-2">
          <MarqueeCard variant="duotone" games={completed}>
            <SectionTitle title="By era" subtitle="Release decade of games you finished" right={<History className="h-4 w-4 text-ink-dim" />} />
            {decades.length > 0 ? (
              <BarList items={decades.map((d) => ({ label: d.label, value: d.count }))} />
            ) : (
              <EmptyState title="No release years" />
            )}
          </MarqueeCard>
          <MarqueeCard variant="grayscale" games={completed}>
            <SectionTitle title="Top genres" subtitle="Your most-completed tags" right={<Tag className="h-4 w-4 text-ink-dim" />} />
            {tagCounts.length > 0 ? (
              <BarList items={tagCounts.map((t) => ({ label: t.tag, value: t.count }))} />
            ) : (
              <EmptyState title="No tags yet" message="Add tags to your games to see genre breakdowns." />
            )}
          </MarqueeCard>
        </div>
        </Reveal>

        <Reveal delay={0.14}>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <SectionTitle title="Genre footprint" subtitle="Where your finished games cluster" right={<RadarIcon className="h-4 w-4 text-ink-dim" />} />
            {genreRadar.length >= 3 ? (
              <RadarChart items={genreRadar} />
            ) : (
              <EmptyState title="Not enough tags" message="Tag at least 3 genres across your completed games." />
            )}
          </Card>
          <Card className="relative overflow-hidden">
            <SectionTitle title="Playtime vs score" subtitle="Bubble size = number of sessions" right={<Sparkles className="h-4 w-4 text-ink-dim" />} />
            <CollectionBubbleChart data={bubbleData} enabled={enabled} />
          </Card>
        </div>
        </Reveal>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <SectionTitle title="You loved these more" subtitle="Biggest positive gap vs critics" right={<TrendingUp className="h-4 w-4 text-green" />} />
            <DeltaList items={deltas.liked} positive />
          </Card>
          <Card>
            <SectionTitle title="Critics loved these more" subtitle="Where you were tougher" right={<TrendingDown className="h-4 w-4 text-pink" />} />
            <DeltaList items={deltas.critics} positive={false} />
          </Card>
        </div>

        <MarqueeCard variant="mosaic" games={completed}>
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
        </MarqueeCard>

        {hallOfFame.length > 0 && (
          <Card>
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
          </Card>
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
    <Card>
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
    </Card>
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
