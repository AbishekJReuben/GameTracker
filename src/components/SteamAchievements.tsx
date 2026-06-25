import { Link } from "react-router-dom";
import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { ExternalLink, Loader2, Lock, RefreshCw, Trophy } from "lucide-react";
import { Game, SteamAchievement } from "@/lib/api";
import {
  achievementCompletionBuckets,
  aggregateSteamAchievements,
  computeGameAchievementInsights,
  hasAchievementList,
  hasSteamAchievements,
  steamAchievementFraction,
  steamAchievementPercent,
  steamAchievementsUrl,
  topSteamAchievementGames,
  type GameAchievementInsights,
} from "@/lib/steamAchievements";
import { relativeTime } from "@/lib/format";
import { useMotionEnabled } from "@/store/app";
import { EmptyState, SectionTitle, Segmented, Skeleton } from "./ui";
import { MarqueeCard } from "./MarqueeFX";
import { GameArt } from "./GameArt";
import { cn } from "@/lib/cn";
import { useSteamAchievements, useSteamAchievementsOverview } from "@/lib/queries";
import { dateLabel } from "@/lib/format";
import { AchievementHighlight } from "@/lib/api";
import { Eye, EyeOff, Sparkles, Target } from "lucide-react";

export function SteamAchievementBadge({
  game,
  className,
  size = "sm",
}: {
  game: Pick<Game, "steamAchievementsUnlocked" | "steamAchievementsTotal">;
  className?: string;
  size?: "sm" | "xs";
}) {
  const fraction = steamAchievementFraction(game);
  const pct = steamAchievementPercent(game);
  if (!fraction || pct == null) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-amber/25 bg-amber/10 font-700 text-amber",
        size === "xs" ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10px]",
        className
      )}
      title={`Steam achievements ${pct}%`}
    >
      <Trophy className={size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3"} />
      {fraction}
    </span>
  );
}

export function SteamAchievementProgress({
  game,
  className,
  showLabel = true,
}: {
  game: Pick<Game, "steamAchievementsUnlocked" | "steamAchievementsTotal">;
  className?: string;
  showLabel?: boolean;
}) {
  const pct = steamAchievementPercent(game);
  const fraction = steamAchievementFraction(game);
  if (pct == null || !fraction) return null;

  return (
    <div className={cn("space-y-2", className)}>
      {showLabel && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 font-700 text-ink-soft">
            <Trophy className="h-3.5 w-3.5 text-amber" />
            Steam achievements
          </span>
          <span className="font-800 tabular-nums text-amber">
            {fraction} · {pct}%
          </span>
        </div>
      )}
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-amber/80 to-amber"
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          style={{ boxShadow: pct >= 100 ? "0 0 12px -2px #fbbf24" : undefined }}
        />
      </div>
    </div>
  );
}

export function SteamAchievementDetailPanel({ game }: { game: Game }) {
  const [filter, setFilter] = useState<"all" | "unlocked" | "locked">("all");
  const { data, isLoading, isFetching, reload } = useSteamAchievements(
    game.steamAppId ? game.id : undefined
  );

  const achievements = data ?? [];
  const insights = useMemo(() => computeGameAchievementInsights(achievements), [achievements]);
  const unlocked = achievements.filter((a) => a.unlocked);
  const locked = achievements.filter((a) => !a.unlocked);

  const shown = useMemo(() => {
    if (filter === "unlocked") return unlocked;
    if (filter === "locked") return locked;
    return achievements;
  }, [achievements, filter, locked, unlocked]);

  const url = steamAchievementsUrl(game.steamAppId);

  if (!game.steamAppId || isLoading || !hasAchievementList(achievements)) {
    return null;
  }

  return (
    <MarqueeCard variant="drift" games={[game]} opacity={0.1} className="mb-6">
      <SectionTitle
        title="Steam achievements"
        subtitle={
          insights
            ? `${insights.unlocked}/${insights.total} unlocked · ${insights.percent}%`
            : "From Steam"
        }
        right={
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-ghost h-8 px-2"
              disabled={isFetching}
              onClick={() => reload()}
              title="Refresh from Steam"
            >
              {isFetching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </button>
            <Trophy className="h-4 w-4 text-amber" />
          </div>
        }
      />

      {insights && (
        <div className="mt-4 space-y-4">
          <GameAchievementStats insights={insights} syncedUtc={game.steamAchievementsSyncedUtc} />
          <AchievementHighlightsSection
            insights={insights}
            achievements={achievements}
            mode="game"
          />
          <SteamAchievementProgress
            game={{
              steamAchievementsUnlocked: insights.unlocked,
              steamAchievementsTotal: insights.total,
            }}
            showLabel={false}
          />
          <Segmented
            value={filter}
            onChange={setFilter}
            size="sm"
            options={[
              { value: "all", label: `All (${achievements.length})` },
              { value: "unlocked", label: `Unlocked (${unlocked.length})` },
              { value: "locked", label: `Locked (${locked.length})` },
            ]}
          />
        </div>
      )}

      <div className="mt-4 max-h-[300px] space-y-2 overflow-y-auto pr-1">
        {shown.map((a) => (
          <AchievementRow key={a.apiName} achievement={a} />
        ))}
      </div>

      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="btn btn-ghost mt-4 h-9 w-fit text-xs"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View on Steam
        </a>
      )}
    </MarqueeCard>
  );
}

function GameAchievementStats({
  insights,
  syncedUtc,
}: {
  insights: GameAchievementInsights;
  syncedUtc: string | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <AchStat
        label="Completion"
        value={`${insights.percent}%`}
        hint={syncedUtc ? `Synced ${relativeTime(syncedUtc)}` : undefined}
      />
      <AchStat
        label="Hidden found"
        value={String(insights.hiddenUnlocked)}
        hint={insights.hiddenLocked > 0 ? `${insights.hiddenLocked} still hidden` : "all secrets found"}
      />
      <AchStat label="Remaining" value={String(insights.total - insights.unlocked)} hint="left to unlock" />
      <AchStat
        label="Status"
        value={insights.isPlatinum ? "Platinum" : insights.percent >= 75 ? "Close" : "In progress"}
        hint={insights.isPlatinum ? "100% complete" : `${insights.lockedVisible} visible left`}
      />
    </div>
  );
}

function AchievementHighlightsSection({
  insights,
  highlights,
  mode,
}: {
  insights?: GameAchievementInsights;
  achievements?: SteamAchievement[];
  highlights?: AchievementHighlight[];
  mode: "game" | "library";
}) {
  const items = useMemo(() => {
    if (mode === "library" && highlights?.length) {
      return highlights.slice(0, 6);
    }
    if (!insights) return [];
    const out: Array<SteamAchievement | AchievementHighlight> = [];
    for (const a of insights.recentUnlocks) {
      if (out.length >= 3) break;
      out.push(a);
    }
    for (const a of insights.almostThere) {
      if (out.length >= 5) break;
      if (!out.some((x) => "apiName" in x && x.apiName === a.apiName)) out.push(a);
    }
    return out;
  }, [highlights, insights, mode]);

  if (items.length === 0) return null;

  const title = mode === "library" ? "Recent & notable" : "Highlights";
  const subtitle =
    mode === "library"
      ? "Latest unlocks and hidden achievements across your library"
      : insights?.recentUnlocks.length
        ? "Recently unlocked and almost there"
        : "Achievements to go after next";

  return (
    <div>
      <div className="mb-2 text-[11px] font-700 uppercase tracking-wider text-ink-dim">{title}</div>
      <p className="mb-3 text-xs text-ink-faint">{subtitle}</p>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
        {items.map((item) =>
          "gameId" in item ? (
            <LibraryHighlightCard key={`${item.gameId}-${item.apiName}`} highlight={item} />
          ) : (
            <GameHighlightCard key={item.apiName} achievement={item} />
          )
        )}
      </div>
    </div>
  );
}

function GameHighlightCard({ achievement: a }: { achievement: SteamAchievement }) {
  return (
    <div
      className={cn(
        "flex w-[168px] shrink-0 flex-col rounded-xl border p-2.5",
        a.unlocked ? "border-amber/25 bg-amber/[0.07]" : "border-line bg-white/[0.02]"
      )}
    >
      <div className="flex items-start gap-2">
        <AchievementIcon achievement={a} size="md" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[11px] font-800 leading-tight text-ink">{a.displayName}</div>
          {!a.unlocked && (
            <span className="mt-1 inline-flex items-center gap-0.5 text-[9px] font-700 uppercase text-ink-dim">
              <Target className="h-2.5 w-2.5" /> Next up
            </span>
          )}
        </div>
      </div>
      {a.unlocked && a.unlockTimeUtc && (
        <div className="mt-2 text-[10px] text-ink-faint">{dateLabel(a.unlockTimeUtc)}</div>
      )}
    </div>
  );
}

function LibraryHighlightCard({ highlight: h }: { highlight: AchievementHighlight }) {
  return (
    <Link
      to={`/game/${h.gameId}`}
      className={cn(
        "flex w-[188px] shrink-0 flex-col rounded-xl border p-2.5 transition hover:-translate-y-0.5 hover:border-line-strong",
        h.unlocked ? "border-amber/25 bg-amber/[0.07]" : "border-line bg-white/[0.02]"
      )}
    >
      <div className="mb-1 truncate text-[10px] font-700 text-ink-dim">{h.gameName}</div>
      <div className="flex items-start gap-2">
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-black/30">
          {h.iconUrl ? (
            <img src={h.iconUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="grid h-full w-full place-items-center">
              <Trophy className="h-4 w-4 text-amber" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[11px] font-800 leading-tight text-ink">{h.displayName}</div>
          <span className="mt-1 inline-flex items-center gap-0.5 text-[9px] font-700 uppercase text-ink-dim">
            {h.kind === "hidden" ? (
              <>
                <EyeOff className="h-2.5 w-2.5" /> Hidden
              </>
            ) : (
              <>
                <Sparkles className="h-2.5 w-2.5" /> Recent
              </>
            )}
          </span>
        </div>
      </div>
      {h.unlockTimeUtc && (
        <div className="mt-2 text-[10px] text-ink-faint">{dateLabel(h.unlockTimeUtc)}</div>
      )}
    </Link>
  );
}

function AchievementIcon({
  achievement: a,
  size = "sm",
}: {
  achievement: Pick<SteamAchievement, "iconUrl" | "unlocked" | "displayName">;
  size?: "sm" | "md";
}) {
  const dim = size === "md" ? "h-10 w-10" : "h-12 w-12";
  return (
    <div className={cn("relative shrink-0 overflow-hidden rounded-lg bg-black/30", dim)}>
      {a.iconUrl ? (
        <img src={a.iconUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="grid h-full w-full place-items-center text-ink-dim">
          <Trophy className="h-5 w-5" />
        </div>
      )}
      {!a.unlocked && (
        <div className="absolute inset-0 grid place-items-center bg-black/45">
          <Lock className="h-4 w-4 text-white/80" />
        </div>
      )}
    </div>
  );
}

function AchievementRow({ achievement: a }: { achievement: SteamAchievement }) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border px-3 py-2.5",
        a.unlocked ? "border-amber/20 bg-amber/[0.06]" : "border-line bg-white/[0.02] opacity-80"
      )}
    >
      <AchievementIcon achievement={a} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("text-sm font-700", a.unlocked ? "text-ink" : "text-ink-soft")}>
            {a.displayName}
          </span>
          {a.hidden && !a.unlocked && (
            <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-700 uppercase tracking-wide text-ink-dim">
              Hidden
            </span>
          )}
          {a.hidden && a.unlocked && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-violet/15 px-1.5 py-0.5 text-[10px] font-700 uppercase text-violet-300">
              <Eye className="h-2.5 w-2.5" /> Secret
            </span>
          )}
        </div>
        {a.description && (
          <p className="mt-0.5 text-xs leading-relaxed text-ink-dim">{a.description}</p>
        )}
        {a.unlocked && a.unlockTimeUtc && (
          <p className="mt-1 text-[11px] text-ink-faint">Unlocked {dateLabel(a.unlockTimeUtc)}</p>
        )}
      </div>
    </div>
  );
}

export function SteamAchievementCard({ game }: { game: Game }) {
  if (!hasSteamAchievements(game)) return null;
  const url = steamAchievementsUrl(game.steamAppId);
  const pct = steamAchievementPercent(game)!;

  return (
    <MarqueeCard variant="drift" games={[game]} opacity={0.1}>
      <SectionTitle
        title="Steam achievements"
        subtitle={
          game.steamAchievementsSyncedUtc
            ? `Synced ${relativeTime(game.steamAchievementsSyncedUtc)}`
            : "From your last Steam sync"
        }
        right={<Trophy className="h-4 w-4 text-amber" />}
      />
      <div className="mt-4 space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="font-display text-4xl font-900 tabular-nums text-amber">{pct}%</div>
            <div className="mt-1 text-sm text-ink-dim">
              <span className="font-700 text-ink-soft">{steamAchievementFraction(game)}</span> unlocked
            </div>
          </div>
          {pct >= 100 && (
            <span className="rounded-full border border-amber/30 bg-amber/15 px-3 py-1 text-xs font-800 uppercase tracking-wider text-amber">
              Platinum
            </span>
          )}
        </div>
        <SteamAchievementProgress game={game} showLabel={false} />
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost h-9 w-fit text-xs"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            View on Steam
          </a>
        )}
      </div>
    </MarqueeCard>
  );
}

export function SteamAchievementCollectionSection({ games }: { games: Game[] }) {
  const { data: overview, isLoading } = useSteamAchievementsOverview();
  const fallback = useMemo(() => aggregateSteamAchievements(games), [games]);
  const leaders = topSteamAchievementGames(games, 10);
  const enabled = useMotionEnabled();

  const gamesTracked = overview?.gamesTracked ?? fallback.gamesTracked;
  if (gamesTracked === 0 && !isLoading) return null;

  return (
    <MarqueeCard variant="drift" games={leaders.length ? leaders : games} opacity={0.1}>
      <SectionTitle
        title="Steam achievements"
        subtitle={
          overview
            ? `${overview.totalUnlocked.toLocaleString()} unlocked · ${overview.recentUnlocks30d} in the last 30 days`
            : `${gamesTracked} games with synced progress`
        }
        right={<Trophy className="h-4 w-4 text-amber" />}
      />
      {isLoading && !overview ? (
        <Skeleton className="mt-4 h-32 w-full" />
      ) : (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-4">
            <AchStat
              label="Unlocked"
              value={String(overview?.totalUnlocked ?? fallback.totalUnlocked)}
              hint={`of ${overview?.totalPossible ?? fallback.totalPossible} total`}
            />
            <AchStat
              label="Avg completion"
              value={`${overview?.avgPercent ?? fallback.avgPercent}%`}
              hint="across synced games"
            />
            <AchStat
              label="Hidden found"
              value={String(overview?.hiddenUnlocked ?? 0)}
              hint={overview ? `${overview.hiddenRemaining} still hidden` : "secret achievements"}
            />
            <AchStat
              label="Platinum"
              value={String(overview?.completedGames ?? fallback.completedGames)}
              hint="games at 100%"
            />
          </div>
          <AchievementGraphs
            unlocked={overview?.totalUnlocked ?? fallback.totalUnlocked}
            total={overview?.totalPossible ?? fallback.totalPossible}
            avgPercent={overview?.avgPercent ?? fallback.avgPercent}
            games={games}
          />
          {overview && overview.highlights.length > 0 && (
            <div className="mt-6">
              <AchievementHighlightsSection highlights={overview.highlights} mode="library" />
            </div>
          )}
        </>
      )}
      {leaders.length > 0 && (
        <div className="mt-6 space-y-1">
          <div className="mb-2 text-[11px] font-700 uppercase tracking-wider text-ink-dim">Highest completion</div>
          {leaders.map((g, i) => (
            <Link
              key={g.id}
              to={`/game/${g.id}`}
              className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-white/[0.03]"
            >
              <span className="w-4 text-xs font-800 text-ink-faint">{i + 1}</span>
              <GameArt
                id={g.id}
                name={g.displayName}
                cover={g.coverPath}
                icon={g.iconPath}
                accent={g.accentColor}
                className="h-9 w-9"
                rounded="rounded-lg"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-700">{g.displayName}</div>
                <SteamAchievementProgress game={g} showLabel={false} className="mt-1.5 max-w-xs" />
              </div>
              <span className="text-sm font-800 tabular-nums text-amber">{steamAchievementPercent(g)}%</span>
            </Link>
          ))}
        </div>
      )}
      {enabled && (overview?.completedGames ?? fallback.completedGames) > 0 && (
        <p className="mt-4 text-xs text-ink-faint">
          Sync achievements from Settings → Steam sync to keep this list current.
        </p>
      )}
    </MarqueeCard>
  );
}

export function SteamAchievementInsightsBlock({ games }: { games: Game[] }) {
  const { data: overview } = useSteamAchievementsOverview();
  const fallback = useMemo(() => aggregateSteamAchievements(games), [games]);
  const leaders = topSteamAchievementGames(
    games.filter((g) => g.totalRuntimeSeconds > 0),
    5
  );

  const gamesTracked = overview?.gamesTracked ?? fallback.gamesTracked;
  if (gamesTracked === 0) return null;

  return (
    <MarqueeCard variant="drift" games={leaders.length ? leaders : games} opacity={0.1}>
      <SectionTitle
        title="Steam achievements"
        subtitle={
          overview
            ? `${overview.recentUnlocks30d} unlocks this month · ${overview.hiddenUnlocked} secrets found`
            : `${fallback.totalUnlocked.toLocaleString()} unlocked across your library`
        }
        right={<Trophy className="h-4 w-4 text-amber" />}
      />
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <AchStat label="Synced games" value={String(gamesTracked)} />
        <AchStat label="Avg %" value={`${overview?.avgPercent ?? fallback.avgPercent}%`} />
        <AchStat
          label="Platinum"
          value={String(overview?.completedGames ?? fallback.completedGames)}
          hint="100% complete"
        />
        <AchStat label="This month" value={String(overview?.recentUnlocks30d ?? 0)} hint="recent unlocks" />
      </div>
      {overview && overview.highlights.length > 0 && (
        <div className="mt-5">
          <AchievementHighlightsSection highlights={overview.highlights.slice(0, 5)} mode="library" />
        </div>
      )}
      {leaders.length > 0 && (
        <div className="mt-5 space-y-2">
          {leaders.map((g) => (
            <Link
              key={g.id}
              to={`/game/${g.id}`}
              className="flex items-center gap-3 rounded-lg px-1 py-1 transition hover:bg-white/[0.03]"
            >
              <GameArt
                id={g.id}
                name={g.displayName}
                cover={g.coverPath}
                icon={g.iconPath}
                accent={g.accentColor}
                className="h-8 w-8"
                rounded="rounded-md"
              />
              <span className="min-w-0 flex-1 truncate text-sm font-600">{g.displayName}</span>
              <SteamAchievementBadge game={g} />
            </Link>
          ))}
        </div>
      )}
    </MarqueeCard>
  );
}

/** Overall completion radial + per-game completion-spread bands for the library. */
function AchievementGraphs({
  unlocked,
  total,
  avgPercent,
  games,
}: {
  unlocked: number;
  total: number;
  avgPercent: number;
  games: Game[];
}) {
  const { buckets, tracked } = useMemo(() => achievementCompletionBuckets(games), [games]);
  const overallPct = total > 0 ? Math.round((unlocked / total) * 100) : 0;
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div className="mt-6 grid gap-6 rounded-2xl border border-line bg-white/[0.015] p-4 md:grid-cols-[auto_1fr] md:items-center">
      <div className="flex items-center gap-4">
        <CompletionRing percent={overallPct} />
        <div>
          <div className="font-display text-2xl font-900 tabular-nums text-amber">{unlocked.toLocaleString()}</div>
          <div className="text-xs text-ink-dim">of {total.toLocaleString()} unlocked</div>
          <div className="mt-1 text-[11px] text-ink-faint">{avgPercent}% avg across {tracked} games</div>
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="mb-1 text-[11px] font-700 uppercase tracking-wider text-ink-dim">Completion spread</div>
        {buckets.map((b) => (
          <div key={b.label} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-[11px] font-600 text-ink-soft">{b.label}</span>
            <div className="relative h-3 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
              <motion.div
                className="h-full rounded-full"
                style={{ background: b.tone, boxShadow: `0 0 10px -2px ${b.tone}` }}
                initial={{ width: 0 }}
                whileInView={{ width: `${(b.count / maxCount) * 100}%` }}
                viewport={{ once: true, margin: "-30px" }}
                transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
            <span className="w-7 shrink-0 text-right text-xs font-800 tabular-nums text-ink">{b.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompletionRing({ percent }: { percent: number }) {
  const r = 34;
  const circ = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, percent));
  const offset = circ * (1 - clamped / 100);
  return (
    <div className="relative h-[88px] w-[88px] shrink-0">
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
        <circle cx="40" cy="40" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="7" />
        <motion.circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke="#fbbf24"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circ}
          initial={{ strokeDashoffset: circ }}
          whileInView={{ strokeDashoffset: offset }}
          viewport={{ once: true }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          style={{ filter: "drop-shadow(0 0 6px rgba(251,191,36,0.5))" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <span className="font-display text-lg font-900 tabular-nums text-amber">{percent}%</span>
      </div>
    </div>
  );
}

function AchStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-white/[0.02] px-3 py-2.5">
      <div className="text-[10px] font-700 uppercase tracking-wider text-ink-dim">{label}</div>
      <div className="font-display text-xl font-800 tabular-nums text-ink">{value}</div>
      {hint && <div className="text-[10px] text-ink-faint">{hint}</div>}
    </div>
  );
}

export function SteamAchievementEmptyHint() {
  return (
    <EmptyState
      icon={<Trophy className="h-6 w-6" />}
      title="No Steam achievements yet"
      message="Sign in with Steam and run an achievement sync in Settings to see progress here."
    />
  );
}
