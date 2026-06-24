import type { Game, Session } from "@/lib/api";
import type { MarqueeFXVariant } from "@/components/MarqueeFX";
import { MARQUEE_VARIANTS } from "@/components/MarqueeFX";

export type PanelArtKind = "cover" | "icon";

export interface PanelArtContext {
  games?: Game[];
  game?: Game | null;
  sessions?: Session[];
  images?: string[];
  art?: PanelArtKind;
}

export interface PanelArtResult {
  games: Game[];
  images: string[];
  art: PanelArtKind;
}

function hashKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Stable variant per panel key — spreads across 30 techniques. */
export function panelVariant(panelKey: string): MarqueeFXVariant {
  return MARQUEE_VARIANTS[hashKey(panelKey) % MARQUEE_VARIANTS.length]!;
}

function sortLibrary(games: Game[]): Game[] {
  return [...games].sort((a, b) => {
    const score = (g: Game) =>
      (g.coverPath ? 4000 : 0) +
      (g.totalActiveSeconds ?? 0) +
      (g.steamAppId ? 500 : 0) +
      (g.rating ?? 0);
    return score(b) - score(a);
  });
}

function topPlayed(games: Game[], n = 22): Game[] {
  return [...games]
    .filter((g) => (g.totalActiveSeconds ?? 0) > 0 || g.coverPath)
    .sort((a, b) => (b.totalActiveSeconds ?? 0) - (a.totalActiveSeconds ?? 0))
    .slice(0, n);
}

function completedGames(games: Game[]): Game[] {
  return games.filter((g) => g.status === "completed");
}

function gameAsList(game?: Game | null): Game[] {
  return game ? [game] : [];
}

function screenshotsAsGames(game: Game): Game[] {
  if (!game.screenshots?.length) return [game];
  return game.screenshots.map((_, i) => ({
    ...game,
    id: `${game.id}-shot-${i}`,
  }));
}

/** Resolve context-relevant art for a panel. */
export function panelArt(panelKey: string, ctx: PanelArtContext): PanelArtResult {
  const library = sortLibrary(ctx.games ?? []);
  const fallback = library.length ? library : [];

  let games: Game[] = fallback;
  let images = ctx.images ?? [];
  let art: PanelArtKind = ctx.art ?? "cover";

  const key = panelKey.toLowerCase();

  if (key.startsWith("game-detail.stat") || key.startsWith("game-detail.stats")) {
    games = ctx.game ? screenshotsAsGames(ctx.game) : fallback;
    images = ctx.game?.screenshots ?? images;
  } else if (key.startsWith("game-detail")) {
    games = gameAsList(ctx.game).length ? gameAsList(ctx.game) : fallback;
    images = ctx.game?.screenshots ?? images;
  } else if (key.startsWith("dashboard.heatmap") || key.startsWith("dashboard.activity")) {
    games = topPlayed(library.filter((g) => g.kind !== "app"));
  } else if (key.startsWith("dashboard.hourly") || key.startsWith("dashboard.patterns")) {
    games = topPlayed(library);
  } else if (key.startsWith("dashboard.sparkline") || key.startsWith("dashboard.streak")) {
    games = topPlayed(library.filter((g) => g.kind === "game"));
  } else if (key.startsWith("dashboard.recent") || key.startsWith("dashboard.today")) {
    games = topPlayed(library);
  } else if (key.startsWith("dashboard.system")) {
    games = topPlayed(library);
  } else if (key.startsWith("dashboard")) {
    games = topPlayed(library);
  } else if (key.startsWith("timeline.insights") || key.startsWith("timeline.section")) {
    games = ctx.games?.length ? sortLibrary(ctx.games) : topPlayed(library);
  } else if (key.startsWith("timeline")) {
    games = topPlayed(library);
  } else if (key.startsWith("collection")) {
    games = completedGames(library).length ? completedGames(library) : topPlayed(library);
  } else if (key.startsWith("sessions")) {
    const ids = new Set((ctx.sessions ?? []).map((s) => s.gameId));
    games = library.filter((g) => ids.has(g.id));
    if (!games.length) games = topPlayed(library);
  } else if (key.startsWith("apps")) {
    games = library.filter((g) => g.kind === "app");
    art = "icon";
  } else if (key.startsWith("systems")) {
    games = topPlayed(library);
    art = "icon";
  } else if (key.startsWith("settings")) {
    games = fallback.slice(0, 22);
  } else if (key.startsWith("suggested")) {
    games = fallback.slice(0, 22);
  } else if (key.startsWith("tags")) {
    games = fallback;
  } else if (key.startsWith("insights")) {
    games = completedGames(library).length ? completedGames(library) : topPlayed(library);
  } else if (key.startsWith("library")) {
    games = library.filter((g) => g.kind === "game");
  }

  if (ctx.game && key.includes("screenshot")) {
    images = ctx.game.screenshots ?? images;
  }

  return { games: games.slice(0, 22), images, art };
}
