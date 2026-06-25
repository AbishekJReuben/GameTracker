import type { Game } from "@/lib/api";

export const JUKEBOX_MAX = 1000;

export interface JukeboxTrack {
  gameId: string;
  gameName: string;
  coverPath: string | null;
  iconPath: string | null;
  accentColor: string | null;
  vid: string;
  label: string;
}

export function youtubeId(url?: string | null): string | null {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/);
  if (m) return m[1];
  return /^[\w-]{11}$/.test(url) ? url : null;
}

/** All playable YouTube ids for a game — OST mix uses every stored track, main theme first. */
export function gameYoutubeTracks(g: Game, ostMix: boolean): string[] {
  const fromDb = g.themeTrackIds?.filter((id) => /^[\w-]{11}$/.test(id)) ?? [];
  const main = g.themeYoutubeId && /^[\w-]{11}$/.test(g.themeYoutubeId) ? g.themeYoutubeId : null;

  if (ostMix) {
    const ids = [...fromDb];
    if (main) {
      const i = ids.indexOf(main);
      if (i > 0) {
        ids.splice(i, 1);
        ids.unshift(main);
      } else if (i < 0) {
        ids.unshift(main);
      }
    }
    if (ids.length > 0) return ids;
  }

  if (main) return [main];
  return fromDb;
}

/** Prefer the stored YouTube title; fall back to generic game-based labels. */
export function trackLabel(g: Game, vid: string, index: number, total: number): string {
  const real = g.themeTrackTitles?.[vid]?.trim();
  if (real) return real;
  if (total > 1) {
    return index === 0 ? `${g.displayName} · main theme` : `${g.displayName} · track ${index + 1}`;
  }
  return g.displayName;
}

export function buildGameTrackList(g: Game): JukeboxTrack[] {
  const ids = gameYoutubeTracks(g, true);
  return ids.map((vid, i) => ({
    gameId: g.id,
    gameName: g.displayName,
    coverPath: g.coverPath,
    iconPath: g.iconPath,
    accentColor: g.accentColor,
    vid,
    label: trackLabel(g, vid, i, ids.length),
  }));
}

export function gameToJukeboxTrack(g: Game, vid: string, label: string): JukeboxTrack {
  return {
    gameId: g.id,
    gameName: g.displayName,
    coverPath: g.coverPath,
    iconPath: g.iconPath,
    accentColor: g.accentColor,
    vid,
    label,
  };
}

/** Max video ids YouTube's anonymous `watch_videos` temporary playlist accepts. */
export const WATCH_VIDEOS_MAX = 50;

/**
 * An anonymous, no-login YouTube playlist URL built from a queue. YouTube caps
 * `watch_videos` at 50 ids and the resulting list is temporary — good enough to
 * "open my mix in YouTube". Returns null if there are no tracks.
 */
export function buildWatchVideosUrl(tracks: JukeboxTrack[]): string | null {
  const ids = Array.from(new Set(tracks.map((t) => t.vid))).slice(0, WATCH_VIDEOS_MAX);
  if (!ids.length) return null;
  return `https://www.youtube.com/watch_videos?video_ids=${ids.join(",")}`;
}

/** Canonical URL for a real YouTube playlist id. */
export function playlistUrl(listId: string): string {
  return `https://www.youtube.com/playlist?list=${listId}`;
}

export type JukeboxSource = "all" | "top" | "completed";
export type JukeboxContent = "ost" | "themes" | "trailers";
export type JukeboxOrder = "played" | "name" | "rating" | "random";

function shuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed || 1;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function buildJukeboxQueue(
  games: Game[],
  source: JukeboxSource,
  content: JukeboxContent,
  order: JukeboxOrder,
  limit: number,
  seed: number
): JukeboxTrack[] {
  let pool = games.filter((g) => g.kind === "game");
  if (source === "completed") pool = pool.filter((g) => g.status === "completed");
  if (source === "top") pool = pool.filter((g) => g.totalActiveSeconds > 0);

  const ostMix = content === "ost";
  let list: JukeboxTrack[] = [];
  for (const g of pool) {
    if (content === "trailers") {
      const vid = youtubeId(g.trailerUrl);
      if (vid) list.push(gameToJukeboxTrack(g, vid, `${g.displayName} trailer`));
      continue;
    }
    const ids = gameYoutubeTracks(g, ostMix);
    ids.forEach((vid, ti) => {
      list.push(gameToJukeboxTrack(g, vid, trackLabel(g, vid, ti, ids.length)));
    });
  }

  if (order === "name") list.sort((a, b) => a.gameName.localeCompare(b.gameName));
  else if (order === "rating") {
    const rating = (id: string) => games.find((g) => g.id === id)?.rating ?? 0;
    list.sort((a, b) => rating(b.gameId) - rating(a.gameId));
  } else if (order === "random") list = shuffle(list, seed);
  else {
    const seconds = (id: string) => games.find((g) => g.id === id)?.totalActiveSeconds ?? 0;
    list.sort((a, b) => seconds(b.gameId) - seconds(a.gameId));
  }

  const seen = new Set<string>();
  const out: JukeboxTrack[] = [];
  for (const t of list) {
    const key = `${t.gameId}:${t.vid}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out.slice(0, Math.min(limit, JUKEBOX_MAX));
}
