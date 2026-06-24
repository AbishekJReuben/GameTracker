import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { Calendar, Flame, Gamepad2, Trophy, Zap, Clock, Target, Sparkles } from "lucide-react";
import { SectionTitle, EmptyState, Skeleton, Segmented } from "@/components/ui";
import { Panel } from "@/components/Panel";
import { GameArt } from "@/components/GameArt";
import { StatTile } from "@/components/StatTile";
import { Reveal } from "@/components/Reveal";
import { useGames, useInsights } from "@/lib/queries";
import { useMotionEnabled } from "@/store/app";
import { dur, hours } from "@/lib/format";
import { EntryKind } from "@/lib/api";
import { AppWindow } from "lucide-react";
import { aggregateSteamAchievements } from "@/lib/steamAchievements";
import { SteamAchievementBadge, SteamAchievementInsightsBlock } from "@/components/SteamAchievements";

type MonthRow = { month: string | number; label: string; hours: number; seconds: number };

export function InsightsContent({ kind = "game" }: { kind?: EntryKind }) {
  const currentYear = new Date().getFullYear();
  const enabled = useMotionEnabled();
  const [year, setYear] = useState(currentYear);
  const years = useMemo(() => {
    const out: number[] = [];
    for (let y = currentYear; y >= currentYear - 5; y--) out.push(y);
    return out;
  }, [currentYear]);
  const { data, isLoading } = useInsights(year, kind);
  const { data: allGames } = useGames();

  const steamAchStats = useMemo(
    () => (kind === "game" ? aggregateSteamAchievements(allGames ?? []) : null),
    [allGames, kind]
  );
  const gameById = useMemo(() => new Map((allGames ?? []).map((g) => [g.id, g])), [allGames]);

  const monthly = useMemo(
    () => (data?.monthly ?? []).map((m) => ({ ...m, hours: Math.round((m.seconds / 3600) * 10) / 10 })),
    [data]
  );
  const maxMonth = Math.max(1, ...monthly.map((m) => m.hours));

  return (
    <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <motion.div layout={enabled} transition={{ type: "spring", stiffness: 380, damping: 28 }}>
            <Segmented
              value={year}
              onChange={setYear}
              options={years.map((y) => ({ value: y, label: String(y) }))}
            />
          </motion.div>
          <span className="text-sm text-ink-dim">Personal recap · local data only</span>
        </div>

        {isLoading || !data ? (
          <Skeleton className="h-48 w-full" />
        ) : data.sessionCount === 0 && data.completions === 0 ? (
          <EmptyState
            icon={<Sparkles className="h-6 w-6" />}
            title={`No activity in ${year}`}
            message={kind === "game" ? "Play tracked games or mark completions to build your yearly recap." : "Use tracked apps to build your yearly usage recap."}
          />
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={year}
              initial={enabled ? { opacity: 0, y: 12 } : false}
              animate={{ opacity: 1, y: 0 }}
              exit={enabled ? { opacity: 0, y: -8 } : undefined}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-6"
            >
            <div className={`grid grid-cols-2 gap-4 ${steamAchStats && steamAchStats.gamesTracked > 0 ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
              <StatTile
                icon={<Zap className="h-[18px] w-[18px]" />}
                label="Active time"
                value={data.activeSeconds / 3600}
                decimals={1}
                suffix="h"
                accent="#34d399"
                hint={`${dur(data.runtimeSeconds)} runtime`}
                delay={0}
              />
              <StatTile
                icon={kind === "game" ? <Gamepad2 className="h-[18px] w-[18px]" /> : <AppWindow className="h-[18px] w-[18px]" />}
                label={kind === "game" ? "Games played" : "Apps used"}
                value={data.uniqueGames}
                accent="var(--accent-1)"
                hint={`${data.sessionCount} sessions`}
                delay={0.06}
              />
              {kind === "game" ? (
              <StatTile
                icon={<Trophy className="h-[18px] w-[18px]" />}
                label="Completions"
                value={data.completions}
                accent="#fbbf24"
                hint={data.completions === 1 ? "game finished" : "games finished"}
                delay={0.12}
              />
              ) : (
              <StatTile
                icon={<Clock className="h-[18px] w-[18px]" />}
                label="Sessions"
                value={data.sessionCount}
                accent="#fbbf24"
                hint={data.uniqueGames > 0 ? `${dur(Math.round(data.activeSeconds / Math.max(1, data.sessionCount)))} avg each` : "logged this year"}
                delay={0.12}
              />
              )}
              <StatTile
                icon={<Flame className="h-[18px] w-[18px]" />}
                label="Peak streak"
                value={data.peakStreak}
                suffix={data.peakStreak === 1 ? " day" : " days"}
                accent="#fb923c"
                hint={`Best month: ${data.bestMonth}`}
                delay={0.18}
              />
              {steamAchStats && steamAchStats.gamesTracked > 0 && (
                <StatTile
                  icon={<Trophy className="h-[18px] w-[18px]" />}
                  label="Steam unlocked"
                  value={steamAchStats.totalUnlocked}
                  accent="#f59e0b"
                  hint={`${steamAchStats.avgPercent}% avg · ${steamAchStats.completedGames} at 100%`}
                  delay={0.24}
                />
              )}
            </div>

            <Reveal y={12}>
              <Panel panelKey={`insights.monthly.${kind}`} games={allGames ?? []} art={kind === "app" ? "icon" : "cover"}>
                <SectionTitle
                  title="Monthly activity"
                  subtitle={`Active hours per month in ${year}`}
                  right={
                    data.bestMonthSeconds > 0 && (
                      <span className="text-xs font-700 text-ink-soft">
                        Peak: {data.bestMonth} · {hours(data.bestMonthSeconds, 1)}h
                      </span>
                    )
                  }
                />
                <StaggeredMonthBars monthly={monthly} maxMonth={maxMonth} />
              </Panel>
            </Reveal>

            <div className="grid gap-6 lg:grid-cols-2">
              <Reveal y={12}>
                <Panel panelKey={`insights.top.${kind}`} games={allGames ?? []} art={kind === "app" ? "icon" : "cover"} className="h-full">
                  <SectionTitle title={kind === "game" ? "Top games" : "Top apps"} subtitle={`Most active in ${year}`} />
                  {data.topGames.length > 0 ? (
                    <div className="space-y-1">
                      {data.topGames.map((g, i) => (
                        <Link
                          key={g.id}
                          to={`/game/${g.id}`}
                          className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-white/[0.03]"
                        >
                          <span className="w-4 text-xs font-800 text-ink-faint">{i + 1}</span>
                          <GameArt id={g.id} name={g.name} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="h-9 w-9" rounded="rounded-lg" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-700">{g.name}</div>
                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-dim">
                              <span>{g.sessionCount} sessions</span>
                              {gameById.get(g.id) && <SteamAchievementBadge game={gameById.get(g.id)!} size="xs" />}
                            </div>
                          </div>
                          <span className="text-xs font-800 tabular-nums text-ink-soft">{dur(g.activeSeconds)}</span>
                        </Link>
                      ))}
                    </div>
                  ) : (
                    <EmptyState title={kind === "game" ? "No ranked games" : "No ranked apps"} />
                  )}
                </Panel>
              </Reveal>

              <Reveal y={12} delay={0.05}>
                <Panel panelKey={`insights.milestones.${kind}`} games={allGames ?? []} art={kind === "app" ? "icon" : "cover"} className="h-full">
                  <SectionTitle title="Milestones" subtitle="Highlights from your year" />
                  <div className="space-y-3">
                    <Milestone icon={<Calendar className="h-4 w-4" />} label="Busiest month" value={data.bestMonth} hint={data.bestMonthSeconds > 0 ? `${hours(data.bestMonthSeconds, 1)}h active` : "—"} delay={0} />
                    <Milestone icon={<Target className="h-4 w-4" />} label="Longest play streak" value={`${data.peakStreak} days`} hint="Consecutive days with play time" delay={0.05} />
                    <Milestone icon={<Clock className="h-4 w-4" />} label="Avg per session" value={data.sessionCount > 0 ? dur(Math.round(data.activeSeconds / data.sessionCount)) : "—"} hint="Active time divided by sessions" delay={0.1} />
                    {kind === "game" ? (
                      <>
                        <Milestone icon={<Trophy className="h-4 w-4" />} label="Completion rate" value={data.uniqueGames > 0 ? `${Math.round((data.completions / data.uniqueGames) * 100)}%` : "—"} hint={`${data.completions} finished of ${data.uniqueGames} played`} delay={0.15} />
                        {steamAchStats && steamAchStats.gamesTracked > 0 && (
                          <Milestone
                            icon={<Trophy className="h-4 w-4" />}
                            label="Steam achievements"
                            value={`${steamAchStats.totalUnlocked.toLocaleString()}`}
                            hint={`${steamAchStats.avgPercent}% avg across ${steamAchStats.gamesTracked} synced games`}
                            delay={0.2}
                          />
                        )}
                      </>
                    ) : (
                      <Milestone icon={<AppWindow className="h-4 w-4" />} label="Most used app" value={data.topGames[0]?.name ?? "—"} hint={data.topGames[0] ? `${dur(data.topGames[0].activeSeconds)} this year` : "No app usage yet"} delay={0.15} />
                    )}
                  </div>
                </Panel>
              </Reveal>
            </div>

            {kind === "game" && allGames && allGames.length > 0 && (
              <Reveal y={12} delay={0.08}>
                <SteamAchievementInsightsBlock games={allGames} />
              </Reveal>
            )}
            </motion.div>
          </AnimatePresence>
        )}
    </div>
  );
}

function Milestone({ icon, label, value, hint, delay = 0 }: { icon: React.ReactNode; label: string; value: string; hint: string; delay?: number }) {
  const enabled = useMotionEnabled();
  return (
    <motion.div
      className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.02] px-3 py-3"
      initial={enabled ? { opacity: 0, y: 10, rotateX: -8 } : false}
      animate={{ opacity: 1, y: 0, rotateX: 0 }}
      transition={{ delay, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      style={{ transformPerspective: 600 }}
    >
      <div className="grid h-9 w-9 place-items-center rounded-xl bg-white/[0.04] text-accent-3">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-700 uppercase tracking-wider text-ink-dim">{label}</div>
        <div className="font-display text-lg font-800 text-ink">{value}</div>
        <div className="text-[11px] text-ink-faint">{hint}</div>
      </div>
    </motion.div>
  );
}

function StaggeredMonthBars({ monthly, maxMonth }: { monthly: MonthRow[]; maxMonth: number }) {
  const enabled = useMotionEnabled();
  const max = Math.max(1, maxMonth);
  return (
    <div className="relative mt-2 flex h-[200px] items-end gap-2 px-1">
      {enabled && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-25" aria-hidden>
          <defs>
            <pattern id="ins-grid" width="18" height="18" patternUnits="userSpaceOnUse">
              <path d="M 18 0 L 0 0 0 18" fill="none" stroke="rgba(255,255,255,0.05)" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#ins-grid)" />
        </svg>
      )}
      {monthly.map((m, i) => {
        const peak = m.hours === maxMonth && m.hours > 0;
        return (
          <div key={m.month} className="relative flex flex-1 flex-col items-center justify-end gap-2">
            <span className="text-[10px] font-700 tabular-nums text-ink-soft">{m.hours > 0 ? `${m.hours}h` : ""}</span>
            <motion.div
              className="w-full rounded-t-md"
              style={{
                background: peak
                  ? "linear-gradient(180deg, var(--accent-1), var(--accent-3))"
                  : "color-mix(in srgb, var(--accent-1) 85%, transparent)",
                boxShadow: peak ? "0 0 16px -4px var(--accent-1)" : undefined,
              }}
              initial={enabled ? { height: 0, opacity: 0 } : false}
              animate={{ height: `${(m.hours / max) * 140 + 4}px`, opacity: 1 }}
              transition={{ delay: i * 0.055, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            />
            <span className={`text-[10px] ${peak ? "font-800 text-ink" : "text-ink-dim"}`}>{m.label}</span>
          </div>
        );
      })}
    </div>
  );
}
