import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Users, Flame, Package, DollarSign, ThumbsUp, Clock3, RefreshCw, Loader2 } from "lucide-react";
import { api, GameStats } from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { relativeTime } from "@/lib/format";
import { SectionTitle, Skeleton } from "@/components/ui";

type Props = { gameId: string; gameName: string };

// Cached stats older than this trigger a silent background refresh on open.
const STALE_MS = 6 * 60 * 60 * 1000;

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function hoursLabel(minutes: number): string {
  const h = minutes / 60;
  return h >= 1 ? `${h.toFixed(h >= 10 ? 0 : 1)}h` : `${minutes}m`;
}

function Tile({
  icon,
  label,
  value,
  sub,
  color,
  estimated,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  color: string;
  estimated?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-line bg-white/[0.02] p-4">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
          {icon}
        </span>
        <span className="text-xs font-700 text-ink-dim">{label}</span>
        {estimated && <span className="pill ml-auto border border-line bg-white/[0.04] text-[10px] text-ink-faint">est.</span>}
      </div>
      <div className="mt-3 font-display text-2xl font-800 tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}

export function GameStatsPanel({ gameId, gameName }: Props) {
  const [stats, setStats] = useState<GameStats | null>(null);
  const [fetchedUtc, setFetchedUtc] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setUpdating(true);
    setError(null);
    api.refreshGameStats(gameId).catch((e) => {
      setError(String(e));
      setUpdating(false);
    });
  };

  // Load the cached stats instantly (sub-ms DB read — no network, no hang), then
  // silently refresh in the background only when stale or never fetched.
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setStats(null);
    setFetchedUtc(null);
    setError(null);
    setUpdating(false);
    api
      .getGameStats(gameId)
      .then((c) => {
        if (cancelled) return;
        setStats(c.stats);
        setFetchedUtc(c.fetchedUtc);
        const age = c.fetchedUtc ? Date.now() - new Date(c.fetchedUtc).getTime() : Infinity;
        if (!c.stats || age > STALE_MS) refresh();
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  // Background refreshes arrive as a `game://stats` event from the backend.
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    let active = true;
    listen<{ id: string; stats: GameStats | null; fetchedUtc: string | null }>("game://stats", (e) => {
      if (e.payload.id !== gameId) return;
      setStats(e.payload.stats);
      setFetchedUtc(e.payload.fetchedUtc);
      setUpdating(false);
    }).then((f) => {
      if (active) un = f;
      else f();
    });
    return () => {
      active = false;
      un?.();
    };
  }, [gameId]);

  const hasAny =
    stats &&
    (stats.currentPlayers != null ||
      stats.peakConcurrent != null ||
      stats.ownersLabel != null ||
      stats.totalReviews != null ||
      stats.revenueEstimateUsd != null ||
      stats.avgPlaytimeMinutes != null);

  // Only block with skeletons when there's nothing cached yet to show.
  const showSkeleton = !hasAny && !error && (updating || !loaded);

  return (
    <div>
      <SectionTitle
        title="Live stats"
        subtitle="Players, sales & reviews"
        right={
          <button onClick={refresh} disabled={updating} className="btn btn-ghost h-8 text-xs" title="Refresh live stats">
            {updating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {updating ? "Updating" : "Refresh"}
          </button>
        }
      />

      {showSkeleton ? (
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : error && !hasAny ? (
        <p className="pt-2 text-sm text-ink-dim">Could not load live stats for {gameName}.</p>
      ) : !hasAny ? (
        <p className="pt-2 text-sm text-ink-dim">Live sales & player stats are only available for games on Steam.</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
            {stats!.currentPlayers != null && (
              <Tile icon={<Users className="h-4 w-4" />} color="#34d399" label="Playing now" value={compact(stats!.currentPlayers)} sub="live on Steam" />
            )}
            {stats!.peakConcurrent != null && (
              <Tile icon={<Flame className="h-4 w-4" />} color="#fb923c" label="Peak concurrent" value={compact(stats!.peakConcurrent)} sub="yesterday" estimated />
            )}
            {stats!.ownersLabel && (
              <Tile icon={<Package className="h-4 w-4" />} color="#22d3ee" label="Owners" value={stats!.ownersMax ? `~${compact(((stats!.ownersMin ?? 0) + stats!.ownersMax) / 2)}` : stats!.ownersLabel} sub={stats!.ownersLabel} estimated />
            )}
            {stats!.revenueEstimateUsd != null && (
              <Tile icon={<DollarSign className="h-4 w-4" />} color="#a3e635" label="Gross revenue" value={money(stats!.revenueEstimateUsd)} sub={stats!.priceUsd != null ? `at $${stats!.priceUsd.toFixed(2)}` : undefined} estimated />
            )}
            {stats!.totalReviews != null && (
              <Tile
                icon={<ThumbsUp className="h-4 w-4" />}
                color="#818cf8"
                label="Steam reviews"
                value={compact(stats!.totalReviews)}
                sub={stats!.positivePct != null ? `${stats!.positivePct}% positive${stats!.reviewDesc ? ` · ${stats!.reviewDesc}` : ""}` : stats!.reviewDesc ?? undefined}
              />
            )}
            {stats!.avgPlaytimeMinutes != null && (
              <Tile icon={<Clock3 className="h-4 w-4" />} color="#f472b6" label="Avg playtime" value={hoursLabel(stats!.avgPlaytimeMinutes)} sub={stats!.medianPlaytimeMinutes != null ? `${hoursLabel(stats!.medianPlaytimeMinutes)} median` : undefined} estimated />
            )}
          </div>
          <p className="mt-3 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-faint">
            <span>
              "est." figures are SteamSpy estimates; revenue is a rough gross (owners × price) before Steam's cut, refunds and discounts.
            </span>
            {fetchedUtc && (
              <span className="text-ink-faint/80">
                · {updating ? "Updating…" : `Updated ${relativeTime(fetchedUtc)}`}
              </span>
            )}
          </p>
        </>
      )}
    </div>
  );
}
