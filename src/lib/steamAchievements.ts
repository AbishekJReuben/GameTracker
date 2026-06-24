import type { Game, SteamAchievement } from "./api";

export function hasSteamAchievements(
  game: Pick<Game, "steamAchievementsTotal">
): boolean {
  return game.steamAchievementsTotal != null && game.steamAchievementsTotal > 0;
}

export function hasAchievementList(achievements: SteamAchievement[] | undefined | null): boolean {
  return (achievements?.length ?? 0) > 0;
}

export function steamAchievementPercent(
  game: Pick<Game, "steamAchievementsUnlocked" | "steamAchievementsTotal">
): number | null {
  if (!hasSteamAchievements(game)) return null;
  const total = game.steamAchievementsTotal!;
  const unlocked = game.steamAchievementsUnlocked ?? 0;
  return Math.round((unlocked / total) * 100);
}

export function steamAchievementFraction(game: Pick<Game, "steamAchievementsUnlocked" | "steamAchievementsTotal">): string | null {
  if (!hasSteamAchievements(game)) return null;
  return `${game.steamAchievementsUnlocked ?? 0}/${game.steamAchievementsTotal}`;
}

export function steamAchievementsUrl(steamAppId: number | null): string | null {
  if (!steamAppId) return null;
  return `https://steamcommunity.com/stats/${steamAppId}/achievements`;
}

export interface SteamAchievementStats {
  gamesTracked: number;
  totalUnlocked: number;
  totalPossible: number;
  completedGames: number;
  avgPercent: number;
}

export function aggregateSteamAchievements(games: Iterable<Game>): SteamAchievementStats {
  let gamesTracked = 0;
  let totalUnlocked = 0;
  let totalPossible = 0;
  let completedGames = 0;
  let percentSum = 0;

  for (const g of games) {
    if (!hasSteamAchievements(g)) continue;
    gamesTracked++;
    const unlocked = g.steamAchievementsUnlocked ?? 0;
    const total = g.steamAchievementsTotal!;
    totalUnlocked += unlocked;
    totalPossible += total;
    const pct = (unlocked / total) * 100;
    percentSum += pct;
    if (unlocked >= total) completedGames++;
  }

  return {
    gamesTracked,
    totalUnlocked,
    totalPossible,
    completedGames,
    avgPercent: gamesTracked > 0 ? Math.round(percentSum / gamesTracked) : 0,
  };
}

export interface CompletionBucket {
  label: string;
  count: number;
  tone: string;
}

/**
 * Bucket the user's achievement-tracked games by completion band — the data for
 * a "completion spread" chart. Bands are non-overlapping and ordered high→low.
 */
export function achievementCompletionBuckets(games: Iterable<Game>): {
  buckets: CompletionBucket[];
  tracked: number;
} {
  const bands: Array<{ label: string; min: number; max: number; tone: string }> = [
    { label: "Platinum", min: 100, max: 100, tone: "#fbbf24" },
    { label: "75–99%", min: 75, max: 99, tone: "#f59e0b" },
    { label: "50–74%", min: 50, max: 74, tone: "#a78bfa" },
    { label: "25–49%", min: 25, max: 49, tone: "#60a5fa" },
    { label: "1–24%", min: 1, max: 24, tone: "#38bdf8" },
    { label: "Untouched", min: 0, max: 0, tone: "#64748b" },
  ];
  const counts = new Array(bands.length).fill(0);
  let tracked = 0;
  for (const g of games) {
    if (!hasSteamAchievements(g)) continue;
    tracked++;
    const pct = steamAchievementPercent(g) ?? 0;
    const idx = bands.findIndex((b) => pct >= b.min && pct <= b.max);
    if (idx >= 0) counts[idx]++;
  }
  return {
    buckets: bands.map((b, i) => ({ label: b.label, count: counts[i], tone: b.tone })),
    tracked,
  };
}

export function topSteamAchievementGames(games: Game[], limit = 8): Game[] {
  return games
    .filter(hasSteamAchievements)
    .sort((a, b) => {
      const pa = steamAchievementPercent(a)!;
      const pb = steamAchievementPercent(b)!;
      if (pb !== pa) return pb - pa;
      return (b.steamAchievementsTotal ?? 0) - (a.steamAchievementsTotal ?? 0);
    })
    .slice(0, limit);
}

export interface GameAchievementInsights {
  unlocked: number;
  total: number;
  percent: number;
  hiddenUnlocked: number;
  hiddenLocked: number;
  lockedVisible: number;
  isPlatinum: boolean;
  recentUnlocks: SteamAchievement[];
  almostThere: SteamAchievement[];
  featuredUnlocked: SteamAchievement[];
}

export function computeGameAchievementInsights(
  achievements: SteamAchievement[]
): GameAchievementInsights | null {
  if (achievements.length === 0) return null;
  const unlocked = achievements.filter((a) => a.unlocked);
  const locked = achievements.filter((a) => !a.unlocked);
  const hiddenUnlocked = unlocked.filter((a) => a.hidden).length;
  const hiddenLocked = locked.filter((a) => a.hidden).length;
  const lockedVisible = locked.filter((a) => !a.hidden);
  const percent = Math.round((unlocked.length / achievements.length) * 100);

  const recentUnlocks = [...unlocked]
    .filter((a) => a.unlockTimeUtc)
    .sort((a, b) => (b.unlockTimeUtc ?? "").localeCompare(a.unlockTimeUtc ?? ""))
    .slice(0, 4);

  const almostThere =
    percent >= 75 && lockedVisible.length > 0 && lockedVisible.length <= 5
      ? lockedVisible.slice(0, 3)
      : lockedVisible.slice(0, 2);

  const featuredUnlocked = recentUnlocks.length > 0 ? recentUnlocks : unlocked.slice(0, 3);

  return {
    unlocked: unlocked.length,
    total: achievements.length,
    percent,
    hiddenUnlocked,
    hiddenLocked,
    lockedVisible: lockedVisible.length,
    isPlatinum: unlocked.length >= achievements.length,
    recentUnlocks,
    almostThere,
    featuredUnlocked,
  };
}
