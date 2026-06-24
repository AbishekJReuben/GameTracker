import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Zap, Flame, CalendarDays, Library as LibraryIcon, Plus, TrendingUp, TrendingDown, ArrowUpRight, Clock, Target, Focus, Layers, Gamepad2, Sparkles, AppWindow } from "lucide-react";
import { Page } from "@/components/Page";
import { NowPlaying } from "@/components/NowPlaying";
import { StatTile } from "@/components/StatTile";
import { Heatmap } from "@/components/Heatmap";
import { LibraryPlaytimeChart } from "@/components/LibraryPlaytimeChart";
import { Sparkline } from "@/components/Sparkline";
import { GameArt } from "@/components/GameArt";
import { Timeline } from "@/components/Timeline";
import { PolarHours, WeekdayBars } from "@/components/Charts";
import { Card, SectionTitle, EmptyState, Skeleton } from "@/components/ui";
import { useDashboard, useAppsOverview, useHeatmap, useHourOfDay, useSessions, useSettings, useGames } from "@/lib/queries";
import type { Dashboard as DashboardData } from "@/lib/api";
import { useApp, useMotionEnabled } from "@/store/app";
import { dur, hours, relativeTime, timeLabel, accentFor } from "@/lib/format";
import { motion } from "motion/react";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const } },
};

export default function Dashboard() {
  const { data, isLoading } = useDashboard();
  const { data: games } = useGames();
  const { data: appsOverview } = useAppsOverview();
  const { data: settings } = useSettings();
  const { data: heat } = useHeatmap(182);
  const todayFrom = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);
  const { data: todaySessions } = useSessions({ fromUtc: todayFrom });
  const { data: hourOfDay } = useHourOfDay();
  const openGameModal = useApp((s) => s.openGameModal);
  const use24 = useApp((s) => s.prefs.timeFormat === "24h");
  const weekStart = useApp((s) => s.prefs.weekStart);
  const widgets = useApp((s) => s.prefs.widgets);
  // Subscribe to just the live game count, not the whole tracking object: the
  // tracker re-emits state every 2s with growing second-counters, and this heavy
  // charts page has no reason to re-render unless the running-game count changes.
  const activeCount = useApp((s) => s.tracking?.activeCount ?? 0);
  const motionOn = useMotionEnabled();

  const dailyGoalMin = parseInt(settings?.daily_goal_minutes ?? "0", 10) || 0;
  const goalProgress = dailyGoalMin > 0 && data ? Math.min(100, (data.todayActive / (dailyGoalMin * 60)) * 100) : 0;

  const weekday = useMemo(() => {
    const sums = Array(7).fill(0);
    (heat ?? []).forEach((d) => {
      const [y, m, dd] = d.date.split("-").map(Number);
      sums[new Date(y, m - 1, dd).getDay()] += d.seconds;
    });
    const order = weekStart === "mon" ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
    return { values: order.map((i) => sums[i]), labels: order.map((i) => WEEKDAY_LABELS[i]) };
  }, [heat, weekStart]);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 5) return "Burning the midnight oil";
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  const weekDelta = useMemo(() => {
    if (!data) return 0;
    const prev = data.weekActivePrev;
    if (prev <= 0) return data.weekActive > 0 ? 100 : 0;
    return Math.round(((data.weekActive - prev) / prev) * 100);
  }, [data]);

  return (
    <Page
      title={greeting}
      subtitle={new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
      actions={
        <div className="flex items-center gap-2">
          <Link to="/collection" className="btn btn-ghost h-10">
            <Sparkles className="h-4 w-4" /> Insights
          </Link>
          <button onClick={() => openGameModal({ mode: "track" })} className="btn btn-primary h-10">
            <Plus className="h-4 w-4" /> Add game
          </button>
        </div>
      }
    >
      <motion.div
        className="space-y-6"
        variants={motionOn ? stagger : undefined}
        initial={motionOn ? "hidden" : false}
        animate={motionOn ? "visible" : undefined}
      >
        <NowPlaying />

        {appsOverview && appsOverview.todayActive > 0 && (
          <Link to="/apps" className="card flex items-center justify-between gap-4 border border-line bg-white/[0.03] px-4 py-3 transition hover:bg-white/[0.05]">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-sheen/20 text-accent-3">
                <AppWindow className="h-4 w-4" />
              </span>
              <div>
                <div className="text-sm font-700">Apps today</div>
                <div className="text-xs text-ink-dim">{dur(appsOverview.todayActive)} active · separate from game stats</div>
              </div>
            </div>
            <div className="text-right text-sm font-800 text-ink-soft">
              {appsOverview.topApps[0]?.name ?? "—"}
              <ArrowUpRight className="ml-1 inline h-4 w-4 text-ink-dim" />
            </div>
          </Link>
        )}

        <motion.div className="grid gap-4 lg:grid-cols-[1fr_minmax(240px,300px)] lg:items-stretch" variants={motionOn ? stagger : undefined}>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 lg:grid-rows-2">
            <StatTile icon={<Zap className="h-[18px] w-[18px]" />} label="Today" value={data ? data.todayActive / 3600 : 0} decimals={1} suffix="h" accent="#34d399" delay={0.02} hint={data ? `${dur(data.todayRuntime)} runtime` : ""} />
            <StatTile
              icon={<CalendarDays className="h-[18px] w-[18px]" />}
              label="This week"
              value={data ? data.weekActive / 3600 : 0}
              decimals={1}
              suffix="h"
              accent="#22d3ee"
              delay={0.06}
              hint={
                data && (
                  <span className={`inline-flex items-center gap-1 ${weekDelta >= 0 ? "text-green" : "text-pink"}`}>
                    {weekDelta >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                    {Math.abs(weekDelta)}% vs last week
                  </span>
                )
              }
            >
              {data && data.last14.length > 0 && <Sparkline values={data.last14.map((d) => d.seconds)} width={96} height={40} />}
            </StatTile>
            <StatTile icon={<Flame className="h-[18px] w-[18px]" />} label="Streak" value={data?.currentStreak ?? 0} suffix={data?.currentStreak === 1 ? " day" : " days"} accent="#fbbf24" delay={0.1} hint={data ? `Longest ${data.longestStreak} days` : ""} />
            <StatTile icon={<LibraryIcon className="h-[18px] w-[18px]" />} label="Library" value={data?.gamesTotal ?? 0} accent="var(--accent-1)" delay={0.14} hint={data ? `${data.gamesCompleted} completed · ${data.gamesTracked} tracked` : ""} />
            <StatTile icon={<Clock className="h-[18px] w-[18px]" />} label="All-time" value={data ? data.totalActive / 3600 : 0} decimals={0} suffix="h" accent="#a78bfa" delay={0.02} hint={data ? `${data.sessionCount} sessions` : ""} />
            <StatTile icon={<CalendarDays className="h-[18px] w-[18px]" />} label="This month" value={data ? data.monthActive / 3600 : 0} decimals={1} suffix="h" accent="#60a5fa" delay={0.06} hint={data ? `${dur(data.monthRuntime)} runtime` : ""} />
            <StatTile icon={<Focus className="h-[18px] w-[18px]" />} label="Focus ratio" value={data?.focusRatio ?? 0} decimals={0} suffix="%" accent="#34d399" delay={0.1} hint="Active ÷ runtime all-time" />
            <StatTile icon={<Layers className="h-[18px] w-[18px]" />} label="Games played" value={data?.uniqueGamesPlayed ?? 0} accent="#f472b6" delay={0.14} hint={data ? `${data.gamesPlaying} playing now` : ""} />
          </div>

          <Card className="flex h-full min-h-0 flex-col p-4">
            <SectionTitle sheen title="Top games" subtitle="By active playtime" />
            <TopGamesList data={data} isLoading={isLoading} className="mt-2 min-h-0 flex-1" />
          </Card>
        </motion.div>

        {widgets.goal && dailyGoalMin > 0 && data && (
          <motion.div variants={motionOn ? fadeUp : undefined}>
            <Card className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-green/15 text-green">
                    <Target className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-sm font-700">Daily goal</div>
                    <div className="text-xs text-ink-dim">
                      {dur(data.todayActive)} of {dailyGoalMin >= 60 ? `${Math.floor(dailyGoalMin / 60)}h ${dailyGoalMin % 60}m` : `${dailyGoalMin}m`} active
                    </div>
                  </div>
                </div>
                <span className="font-display text-2xl font-800 tabular-nums text-ink">{Math.round(goalProgress)}%</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.06]">
                <motion.div
                  className="h-full rounded-full bg-accent-sheen"
                  initial={{ width: 0 }}
                  animate={{ width: `${goalProgress}%` }}
                  transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>
            </Card>
          </motion.div>
        )}

        {data && (
          <motion.div className="flex flex-wrap gap-2" variants={motionOn ? stagger : undefined}>
            <StatusPill label="Playing" count={data.gamesPlaying} color="#34d399" to="/library" />
            <StatusPill label="Backlog" count={data.gamesBacklog} color="#3b82f6" to="/library" />
            <StatusPill label="On Hold" count={data.gamesOnHold} color="#f59e0b" to="/library" />
            <StatusPill label="Completed" count={data.gamesCompleted} color="#7c5cff" to="/collection" />
            <StatusPill label="Dropped" count={data.gamesDropped} color="#f472b6" to="/library" />
            <StatusPill label="Watched" count={data.gamesWatched} color="#22d3ee" to="/library" />
            {activeCount > 1 && (
              <motion.span
                variants={motionOn ? fadeUp : undefined}
                className="pill border border-green/30 bg-green/10 text-xs font-700 text-green"
              >
                <Gamepad2 className="mr-1 inline h-3.5 w-3.5" />
                {activeCount} games running
              </motion.span>
            )}
          </motion.div>
        )}

        {/* Today's timeline strip — the Gantt, everywhere. */}
        <motion.div variants={motionOn ? fadeUp : undefined}>
          <Card>
            <SectionTitle
              sheen
              title="Today's timeline"
              subtitle="Your sessions across the day"
              right={
                <Link to="/timeline" className="text-xs font-700 text-accent-3 hover:underline">
                  Full timeline <ArrowUpRight className="inline h-3.5 w-3.5" />
                </Link>
              }
            />
            {todaySessions ? (
              <Timeline
                sessions={todaySessions}
                range="24h"
                compact
                maxLanes={8}
                colorFor={(s) =>
                  s.kind === "app" ? "#22d3ee" : s.accentColor || accentFor(s.gameId)[0]
                }
              />
            ) : (
              <Skeleton className="h-28 w-full" />
            )}
            {todaySessions && todaySessions.some((s) => s.kind === "app") && (
              <p className="mt-2 text-[10px] text-ink-faint">
                <span className="mr-3 inline-flex items-center gap-1.5">
                  <span className="inline-block h-2 w-4 rounded bg-accent-3" /> Apps
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2 w-4 rounded bg-green" /> Games
                </span>
              </p>
            )}
          </Card>
        </motion.div>

        <motion.div variants={motionOn ? fadeUp : undefined}>
          {widgets.heatmap && (
            <Card className="h-full">
              <SectionTitle
                sheen
                title="Activity"
                subtitle="Active play over the last 6 months"
                right={
                  <span className="text-sm font-700 text-ink">
                    {data ? hours(data.totalActive, 0) : 0}
                    <span className="ml-1 text-xs font-500 text-ink-dim">h all-time</span>
                  </span>
                }
              />
              <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_minmax(200px,280px)] lg:items-stretch">
                <div className="min-w-0">
                  {heat ? <Heatmap data={heat} /> : <Skeleton className="h-28 w-full" />}
                </div>
                <LibraryPlaytimeChart games={games ?? []} />
              </div>
            </Card>
          )}
        </motion.div>

        {widgets.patterns && (
        <motion.div className="grid gap-6 lg:grid-cols-2" variants={motionOn ? stagger : undefined}>
          <motion.div variants={motionOn ? fadeUp : undefined}>
            <Card className="h-full">
              <SectionTitle sheen title="When you play" subtitle="Active time by hour of day" />
              {hourOfDay ? <PolarHours values={hourOfDay} use24={use24} /> : <Skeleton className="mx-auto h-[240px] w-[240px] rounded-full" />}
            </Card>
          </motion.div>
          <motion.div variants={motionOn ? fadeUp : undefined}>
            <Card className="h-full">
              <SectionTitle sheen title="Your week" subtitle="Play distribution across weekdays" />
              {heat ? <WeekdayBars values={weekday.values} labels={weekday.labels} /> : <Skeleton className="h-[180px] w-full" />}
            </Card>
          </motion.div>
        </motion.div>
        )}

        {data?.longestSession && (
          <motion.div variants={motionOn ? fadeUp : undefined}>
            <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <div className="text-[11px] font-700 uppercase tracking-wider text-ink-dim">Longest session</div>
                <div className="mt-1 font-display text-xl font-800 text-ink">{dur(data.longestSession.seconds)}</div>
                <div className="text-sm text-ink-dim">
                  <Link to={`/game/${data.longestSession.gameId}`} className="font-700 text-accent-3 hover:underline">
                    {data.longestSession.gameName}
                  </Link>
                  {" · "}
                  {relativeTime(data.longestSession.startUtc)}
                </div>
              </div>
              <div className="text-right text-xs text-ink-faint">Avg session: {dur(Math.round(data.avgSessionActive))} active</div>
            </Card>
          </motion.div>
        )}

        <motion.div variants={motionOn ? fadeUp : undefined}>
          <Card>
            <SectionTitle
              sheen
              title="Recent sessions"
              right={
                <Link to="/sessions" className="text-xs font-700 text-accent-3 hover:underline">
                  View all <ArrowUpRight className="inline h-3.5 w-3.5" />
                </Link>
              }
            />
            {data && data.recentSessions.length > 0 ? (
              <div className="divide-y divide-line">
                {data.recentSessions.map((s) => (
                  <Link key={s.id} to={`/game/${s.gameId}`} className="flex items-center gap-3 py-2.5 transition hover:opacity-90">
                    <GameArt id={s.gameId} name={s.gameName} cover={s.coverPath} icon={s.iconPath} accent={s.accentColor} className="h-9 w-9" rounded="rounded-lg" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-700">{s.gameName}</div>
                      <div className="text-xs text-ink-dim">
                        {relativeTime(s.startUtc)} · {timeLabel(s.startUtc, use24)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="flex items-center gap-1 text-sm font-800 tabular-nums">
                        <Zap className="h-3.5 w-3.5 text-green" />
                        {dur(s.activeSeconds)}
                      </div>
                      <div className="flex items-center justify-end gap-1 text-[11px] text-ink-faint">
                        <Clock className="h-3 w-3" />
                        {dur(s.runtimeSeconds)}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState title="No sessions recorded yet" />
            )}
          </Card>
        </motion.div>
      </motion.div>
    </Page>
  );
}

function TopGamesList({
  data,
  isLoading,
  className = "",
}: {
  data: DashboardData | undefined;
  isLoading: boolean;
  className?: string;
}) {
  if (isLoading) {
    return (
      <div className={`space-y-3 ${className}`}>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    );
  }

  if (!data?.topGames.length) {
    return (
      <EmptyState
        title="No playtime yet"
        message="Add a game and start playing — your top titles will appear here."
      />
    );
  }

  const maxActive = Math.max(1, ...data.topGames.map((x) => x.activeSeconds));
  const maxRuntime = Math.max(1, ...data.topGames.map((x) => x.runtimeSeconds));

  return (
    <div className={`space-y-0.5 overflow-auto ${className}`}>
      {data.topGames.slice(0, 6).map((g, i) => (
        <Link
          key={g.id}
          to={`/game/${g.id}`}
          className="group relative flex items-center gap-2.5 rounded-xl px-1.5 py-1.5 transition hover:bg-white/[0.03]"
        >
          <span className="w-4 text-center text-[10px] font-800 text-ink-faint">{i + 1}</span>
          <GameArt id={g.id} name={g.name} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="h-8 w-8" rounded="rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-700">{g.name}</div>
            <div className="relative mt-1 h-1 w-full overflow-hidden rounded-full bg-white/[0.05]">
              <motion.div
                className="absolute inset-y-0 left-0 rounded-full bg-accent-sheen opacity-35"
                initial={{ width: 0 }}
                animate={{ width: `${(g.runtimeSeconds / maxRuntime) * 100}%` }}
                transition={{ duration: 0.7, delay: i * 0.05 }}
              />
              <motion.div
                className="absolute inset-y-0 left-0 rounded-full bg-green"
                initial={{ width: 0 }}
                animate={{ width: `${(g.activeSeconds / maxActive) * 100}%` }}
                transition={{ duration: 0.7, delay: i * 0.05 + 0.04 }}
              />
            </div>
          </div>
          <span className="shrink-0 text-[10px] font-800 tabular-nums text-green">{dur(g.activeSeconds)}</span>
        </Link>
      ))}
    </div>
  );
}

function StatusPill({ label, count, color, to }: { label: string; count: number; color: string; to: string }) {
  const motionOn = useMotionEnabled();
  if (count <= 0) return null;
  return (
    <motion.div variants={motionOn ? fadeUp : undefined}>
      <Link
        to={to}
        className="pill border border-line bg-white/[0.03] text-xs font-700 transition hover:bg-white/[0.06]"
        style={{ borderColor: `color-mix(in srgb, ${color} 35%, transparent)` }}
      >
        <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: color }} />
        {count} {label.toLowerCase()}
      </Link>
    </motion.div>
  );
}
