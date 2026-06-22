import { useEffect, useState } from "react";
import { Users, Flame, Package, DollarSign, ThumbsUp, Clock3, RefreshCw, Loader2 } from "lucide-react";
import { api, GameStats } from "@/lib/api";
import { SectionTitle, Skeleton } from "@/components/ui";

type Props = { gameId: string; gameName: string };

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .fetchGameStats(gameId)
      .then((s) => setStats(s))
      .catch((e) => setError(String(e)))
      .finally(() => {
        setLoading(false);
        setLoaded(true);
      });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  const hasAny =
    stats &&
    (stats.currentPlayers != null ||
      stats.peakConcurrent != null ||
      stats.ownersLabel != null ||
      stats.totalReviews != null ||
      stats.revenueEstimateUsd != null ||
      stats.avgPlaytimeMinutes != null);

  return (
    <div>
      <SectionTitle
        title="Live stats"
        subtitle="Players, sales & reviews"
        right={
          <button onClick={load} disabled={loading} className="btn btn-ghost h-8 text-xs" title="Refresh live stats">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        }
      />

      {loading && !loaded ? (
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : error ? (
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
          <p className="mt-3 text-[11px] text-ink-faint">
            "est." figures are SteamSpy estimates; revenue is a rough gross (owners × price) before Steam's cut, refunds and discounts.
          </p>
        </>
      )}
    </div>
  );
}
