/**
 * Online GameDetail panels for the companion — mobile ports of the desktop
 * GameStatsPanel / SteamReviewsPanel / MetacriticReviewsPanel / TrailerPanel /
 * SoundtrackPanel / TwitchPanel. They fetch over the remote link via endpoints
 * added to the host router (`rtcHost.ts handleData`): live stats, Steam &
 * Metacritic reviews, and the top live Twitch stream. Trailer + soundtrack render
 * from fields already on the Game (Steam mp4, YouTube OST) with no extra fetch.
 */

import { useEffect, useRef, useState } from "react";
import {
  Users,
  Flame,
  Package,
  DollarSign,
  ThumbsUp,
  Clock3,
  RefreshCw,
  Loader2,
  ThumbsDown,
  Star,
  Film,
  Music2,
  Play,
  ExternalLink,
  MonitorPlay,
  Radio,
} from "lucide-react";
import type { Game, GameStats, CachedGameStats, SteamReview, MetacriticReview, TwitchLive } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { apiGet, apiPost, loadMedia } from "../link";

const LONG = 15000; // ms — these hit the network on the PC; give them room

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K` : n.toLocaleString();
const money = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}K` : `$${n.toFixed(0)}`);
const hoursLabel = (m: number) => (m / 60 >= 1 ? `${(m / 60).toFixed(m / 60 >= 10 ? 0 : 1)}h` : `${m}m`);

function Card({ title, subtitle, icon, right, children }: { title: string; subtitle?: string; icon?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-bg-900/40 p-3.5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {icon && <span className="text-ink-dim">{icon}</span>}
          <div>
            <div className="font-display text-sm font-800">{title}</div>
            {subtitle && <div className="text-[11px] text-ink-dim">{subtitle}</div>}
          </div>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

// ---- live stats -------------------------------------------------------------

export function LiveStatsPanel({ game }: { game: Game }) {
  const [stats, setStats] = useState<GameStats | null>(null);
  const [fetchedUtc, setFetchedUtc] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const pollRef = useRef<number | null>(null);

  const load = async () => {
    try {
      const c = await apiGet<CachedGameStats>(`/api/games/${game.id}/stats`);
      setStats(c.stats);
      setFetchedUtc(c.fetchedUtc);
      return c;
    } catch {
      return null;
    }
  };

  // Background refresh: trigger on the host, then re-poll the cache until it
  // changes (the desktop's game://stats event can't cross the data channel).
  const refresh = async () => {
    setUpdating(true);
    const before = fetchedUtc;
    try {
      await apiPost(`/api/games/${game.id}/stats/refresh`);
    } catch {
      setUpdating(false);
      return;
    }
    let tries = 0;
    const tick = async () => {
      tries++;
      const c = await load();
      if ((c && c.fetchedUtc !== before && c.stats) || tries >= 6) {
        setUpdating(false);
        return;
      }
      pollRef.current = window.setTimeout(tick, 2500);
    };
    pollRef.current = window.setTimeout(tick, 2500);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const c = await load();
      if (!alive) return;
      const age = c?.fetchedUtc ? Date.now() - new Date(c.fetchedUtc).getTime() : Infinity;
      if (!c?.stats || age > 6 * 60 * 60 * 1000) refresh();
    })();
    return () => {
      alive = false;
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id]);

  const hasAny =
    stats &&
    (stats.currentPlayers != null || stats.peakConcurrent != null || stats.ownersLabel != null || stats.totalReviews != null || stats.revenueEstimateUsd != null || stats.avgPlaytimeMinutes != null);

  return (
    <Card
      title="Live stats"
      subtitle="Players, sales & reviews"
      right={
        <button onClick={refresh} disabled={updating} className="btn btn-ghost h-8 text-xs">
          {updating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {updating ? "Updating" : "Refresh"}
        </button>
      }
    >
      {!hasAny ? (
        <p className="text-sm text-ink-dim">{updating ? "Fetching live stats…" : "Live sales & player stats are only available for games on Steam."}</p>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {stats!.currentPlayers != null && <Tile icon={<Users className="h-4 w-4" />} color="#34d399" label="Playing now" value={compact(stats!.currentPlayers)} sub="live on Steam" />}
          {stats!.peakConcurrent != null && <Tile icon={<Flame className="h-4 w-4" />} color="#fb923c" label="Peak 24h" value={compact(stats!.peakConcurrent)} est />}
          {stats!.ownersLabel && <Tile icon={<Package className="h-4 w-4" />} color="#22d3ee" label="Owners" value={stats!.ownersMax ? `~${compact(((stats!.ownersMin ?? 0) + stats!.ownersMax) / 2)}` : stats!.ownersLabel} sub={stats!.ownersLabel} est />}
          {stats!.revenueEstimateUsd != null && <Tile icon={<DollarSign className="h-4 w-4" />} color="#a3e635" label="Gross revenue" value={money(stats!.revenueEstimateUsd)} sub={stats!.priceUsd != null ? `at $${stats!.priceUsd.toFixed(2)}` : undefined} est />}
          {stats!.totalReviews != null && <Tile icon={<ThumbsUp className="h-4 w-4" />} color="#818cf8" label="Steam reviews" value={compact(stats!.totalReviews)} sub={stats!.positivePct != null ? `${stats!.positivePct}% positive` : stats!.reviewDesc ?? undefined} />}
          {stats!.avgPlaytimeMinutes != null && <Tile icon={<Clock3 className="h-4 w-4" />} color="#f472b6" label="Avg playtime" value={hoursLabel(stats!.avgPlaytimeMinutes)} sub={stats!.medianPlaytimeMinutes != null ? `${hoursLabel(stats!.medianPlaytimeMinutes)} median` : undefined} est />}
        </div>
      )}
      {fetchedUtc && <p className="mt-2 text-[10px] text-ink-faint">{updating ? "Updating…" : `Updated ${relativeTime(fetchedUtc)}`} · "est." are SteamSpy estimates.</p>}
    </Card>
  );
}

function Tile({ icon, label, value, sub, color, est }: { icon: React.ReactNode; label: string; value: string; sub?: string; color: string; est?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-white/[0.02] p-3">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>{icon}</span>
        <span className="text-[11px] font-700 text-ink-dim">{label}</span>
        {est && <span className="ml-auto rounded-full border border-line bg-white/[0.04] px-1.5 text-[9px] text-ink-faint">est</span>}
      </div>
      <div className="mt-2 font-display text-xl font-800 tabular-nums">{value}</div>
      {sub && <div className="truncate text-[10px] text-ink-faint">{sub}</div>}
    </div>
  );
}

// ---- Steam reviews ----------------------------------------------------------

export function SteamReviewsPanel({ appId, name }: { appId: number; name: string }) {
  const [list, setList] = useState<SteamReview[] | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<SteamReview[]>(`/api/steam/reviews?appId=${appId}`, LONG)
      .then((r) => alive && setList(r))
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [appId]);
  if (list && list.length === 0) return null;
  return (
    <Card title="Steam reviews" subtitle={`Recent player reviews for ${name}`} icon={<ThumbsUp className="h-3.5 w-3.5" />}>
      {!list ? (
        <div className="grid place-items-center py-4 text-ink-dim"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : (
        <div className="space-y-2.5">
          {list.slice(0, 10).map((r, i) => (
            <div key={i} className="rounded-xl border border-line bg-white/[0.02] p-3">
              <div className="mb-1 flex items-center gap-2 text-xs">
                <span className={`inline-flex items-center gap-1 font-700 ${r.votedUp ? "text-green" : "text-pink"}`}>
                  {r.votedUp ? <ThumbsUp className="h-3.5 w-3.5" /> : <ThumbsDown className="h-3.5 w-3.5" />}
                  {r.votedUp ? "Recommended" : "Not recommended"}
                </span>
                <span className="ml-auto text-ink-faint">{Math.round(r.playtimeForever / 60)}h played</span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft line-clamp-6">{r.text}</p>
              {(r.votesUp > 0 || r.votesFunny > 0) && (
                <div className="mt-1.5 flex gap-3 text-[10px] text-ink-faint">
                  {r.votesUp > 0 && <span>{r.votesUp} helpful</span>}
                  {r.votesFunny > 0 && <span>{r.votesFunny} funny</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---- Metacritic reviews -----------------------------------------------------

export function MetacriticReviewsPanel({ gameId, slug, name }: { gameId: string; slug?: string | null; name: string }) {
  const [list, setList] = useState<MetacriticReview[] | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<MetacriticReview[]>(`/api/games/${gameId}/metacritic${slug ? `?slug=${encodeURIComponent(slug)}` : ""}`, LONG)
      .then((r) => alive && setList(r))
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [gameId, slug]);
  if (list && list.length === 0) return null;
  const scoreColor = (s: number) => (s >= 75 ? "#34d399" : s >= 50 ? "#fbbf24" : "#f87171");
  return (
    <Card title="Metacritic" subtitle={`Critic reviews for ${name}`} icon={<Star className="h-3.5 w-3.5" />}>
      {!list ? (
        <div className="grid place-items-center py-4 text-ink-dim"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : (
        <div className="space-y-2.5">
          {list.slice(0, 10).map((r, i) => (
            <div key={i} className="rounded-xl border border-line bg-white/[0.02] p-3">
              <div className="mb-1 flex items-center gap-2">
                {r.score != null && <span className="grid h-7 min-w-7 place-items-center rounded-md px-1.5 text-xs font-800 text-black" style={{ background: scoreColor(r.score) }}>{r.score}</span>}
                <span className="truncate text-xs font-700 text-ink-soft">{r.author}</span>
                {r.date && <span className="ml-auto shrink-0 text-[10px] text-ink-faint">{r.date}</span>}
              </div>
              <p className="text-sm leading-relaxed text-ink-soft line-clamp-5">{r.text}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---- trailer ----------------------------------------------------------------

export function TrailerPanel({ game }: { game: Game }) {
  const [poster, setPoster] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const url = game.trailerUrl!;
  useEffect(() => {
    let alive = true;
    loadMedia(game.coverPath ?? game.iconPath).then((u) => alive && setPoster(u));
    return () => {
      alive = false;
    };
  }, [game.coverPath, game.iconPath]);
  if (failed) return null;
  const isWebm = /\.webm(\?|$)/i.test(url);
  const fallback = url.includes("movie_max") ? url.replace("movie_max", "movie480") : null;
  return (
    <Card title="Trailer" subtitle={game.displayName} icon={<Film className="h-3.5 w-3.5" />}>
      <div className="overflow-hidden rounded-2xl border border-line bg-black">
        <video className="aspect-video w-full" controls loop playsInline preload="metadata" poster={poster ?? undefined} onError={() => setFailed(true)}>
          <source src={url} type={isWebm ? "video/webm" : "video/mp4"} />
          {fallback && <source src={fallback} type="video/mp4" />}
        </video>
      </div>
    </Card>
  );
}

// ---- soundtrack -------------------------------------------------------------

export function SoundtrackPanel({ game }: { game: Game }) {
  const ids = game.themeTrackIds?.length ? game.themeTrackIds : game.themeYoutubeId ? [game.themeYoutubeId] : [];
  const titles = game.themeTrackTitles ?? {};
  const [active, setActive] = useState<string | null>(null);
  const [loadingOst, setLoadingOst] = useState(false);
  if (ids.length === 0) return null;
  const loadFull = async () => {
    setLoadingOst(true);
    try {
      await apiPost(`/api/games/${game.id}/ost`);
    } catch {
      /* ignore */
    }
    // The full list arrives on the next game poll; drop the spinner shortly after.
    setTimeout(() => setLoadingOst(false), 4000);
  };
  return (
    <Card
      title="Soundtrack"
      subtitle={`${ids.length} track${ids.length === 1 ? "" : "s"}`}
      icon={<Music2 className="h-3.5 w-3.5" />}
      right={
        ids.length <= 1 ? (
          <button onClick={loadFull} disabled={loadingOst} className="btn btn-ghost h-8 text-xs">
            {loadingOst ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Full OST
          </button>
        ) : undefined
      }
    >
      {active && (
        <div className="mb-3 overflow-hidden rounded-xl border border-line bg-black">
          <iframe key={active} src={`https://www.youtube.com/embed/${active}?autoplay=1`} title="OST" allow="autoplay; encrypted-media; fullscreen" allowFullScreen className="aspect-video w-full border-0" />
        </div>
      )}
      <div className="max-h-64 space-y-0.5 overflow-y-auto">
        {ids.slice(0, 100).map((vid, i) => (
          <button key={vid} onClick={() => setActive(vid)} className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm active:bg-white/[0.05] ${active === vid ? "bg-accent-3/15 text-white" : "text-ink-soft"}`}>
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/[0.06]">{active === vid ? <Radio className="h-3 w-3 text-accent-3" /> : <Play className="h-3 w-3" />}</span>
            <span className="w-5 shrink-0 text-center text-[10px] text-ink-faint">{i + 1}</span>
            <span className="truncate">{titles[vid] ?? `Track ${i + 1}`}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

// ---- Twitch -----------------------------------------------------------------

export function TwitchPanel({ game }: { game: Game }) {
  const [data, setData] = useState<TwitchLive | null | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setData(undefined);
    apiGet<TwitchLive | null>(`/api/twitch?name=${encodeURIComponent(game.displayName)}`, LONG)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [game.displayName, nonce]);

  const host = typeof window !== "undefined" ? window.location.hostname || "tauri.localhost" : "tauri.localhost";
  const channel = data?.channel ?? null;
  const src = channel ? `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${host}&parent=localhost&parent=tauri.localhost&muted=true&autoplay=true` : null;
  const dirUrl = data?.slug ? `https://www.twitch.tv/directory/category/${data.slug}` : `https://www.twitch.tv/search?term=${encodeURIComponent(game.displayName)}`;

  return (
    <Card
      title="Live on Twitch"
      icon={<MonitorPlay className="h-3.5 w-3.5 text-[#9146FF]" />}
      right={
        <button onClick={() => setNonce((n) => n + 1)} className="btn btn-ghost h-8 px-2" disabled={data === undefined}>
          {data === undefined ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
      }
    >
      <div className="relative aspect-video overflow-hidden rounded-2xl border border-line bg-black">
        {data === undefined ? (
          <div className="grid h-full place-items-center text-ink-dim"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : src ? (
          <>
            <iframe key={channel} src={src} title="Twitch" allowFullScreen allow="autoplay; fullscreen; encrypted-media; picture-in-picture" className="absolute inset-0 h-full w-full border-0" />
            {data?.channelName && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent p-2.5">
                <span className="truncate text-xs font-700 text-white">{data.channelName}</span>
                {data.viewers > 0 && <span className="shrink-0 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-800 text-white">{data.viewers.toLocaleString()} watching</span>}
              </div>
            )}
          </>
        ) : (
          <div className="grid h-full place-items-center p-6 text-center">
            <div>
              <MonitorPlay className="mx-auto mb-2 h-8 w-8 text-[#9146FF]" />
              <div className="text-sm font-700 text-ink-soft">{data ? `No one's live on ${data.game} right now` : "No live streams found"}</div>
              <a href={dirUrl} target="_blank" rel="noreferrer" className="btn btn-subtle mx-auto mt-3 inline-flex h-9"><ExternalLink className="h-4 w-4" /> Browse on Twitch</a>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
