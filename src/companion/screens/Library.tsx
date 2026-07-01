import { useEffect, useMemo, useState } from "react";
import { Search, Gamepad2, Play, X, Star, Clock, Loader2, Check } from "lucide-react";
import type { Game, GameStatus } from "@/lib/api";
import { dur, relativeTime, accentFor, initials } from "@/lib/format";
import { apiPost, loadMedia } from "../link";
import { useRemote } from "../useRemote";

type StatusFilter = "all" | GameStatus;
type Sort = "recent" | "name" | "playtime" | "score";

const STATUS_OPTS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "playing", label: "Playing" },
  { value: "backlog", label: "Backlog" },
  { value: "on_hold", label: "On Hold" },
  { value: "completed", label: "Completed" },
  { value: "dropped", label: "Dropped" },
];

const SORT_OPTS: { value: Sort; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
  { value: "playtime", label: "Playtime" },
  { value: "score", label: "Score" },
];

const STATUS_STYLE: Record<GameStatus, { label: string; color: string }> = {
  playing: { label: "Playing", color: "#34d399" },
  completed: { label: "Completed", color: "#a78bfa" },
  backlog: { label: "Backlog", color: "#64748b" },
  on_hold: { label: "On Hold", color: "#fbbf24" },
  dropped: { label: "Dropped", color: "#f87171" },
  watched: { label: "Watched", color: "#22d3ee" },
};

/** Cover art that resolves over either transport (cloud fetches bytes on demand). */
function Cover({ game, rounded = "rounded-xl", className }: { game: Game; rounded?: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    loadMedia(game.coverPath ?? game.iconPath).then((u) => alive && setSrc(u));
    return () => {
      alive = false;
    };
  }, [game.coverPath, game.iconPath]);
  const [a, b] = accentFor(game.id);
  return (
    <div className={`relative overflow-hidden ${rounded} ${className ?? ""}`} style={{ background: `linear-gradient(140deg, ${game.accentColor || a}, ${b})` }}>
      {src ? (
        <img src={src} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 grid place-items-center font-display text-2xl font-800 text-white/85">{initials(game.displayName)}</div>
      )}
    </div>
  );
}

export function LibraryScreen() {
  const { data: games, loading, error } = useRemote<Game[]>("/api/games", 15000);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [selected, setSelected] = useState<Game | null>(null);

  const onlyGames = useMemo(() => (games ?? []).filter((g) => g.kind !== "app"), [games]);

  const filtered = useMemo(() => {
    const list = onlyGames.filter((g) => {
      if (status !== "all" && g.status !== status) return false;
      if (q && !`${g.displayName} ${g.developer ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    const by: Record<Sort, (a: Game, b: Game) => number> = {
      name: (a, b) => a.displayName.localeCompare(b.displayName),
      playtime: (a, b) => b.totalRuntimeSeconds - a.totalRuntimeSeconds,
      score: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
      recent: (a, b) =>
        new Date(b.lastPlayedUtc ?? b.createdAt).getTime() - new Date(a.lastPlayedUtc ?? a.createdAt).getTime(),
    };
    return [...list].sort(by[sort]);
  }, [onlyGames, q, status, sort]);

  if (loading && !games) return <div className="grid h-full place-items-center text-sm text-ink-dim"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading library…</div>;
  if (error && !games) return <div className="m-4 rounded-xl border border-amber/40 bg-amber/10 p-3 text-sm text-amber">{error}</div>;

  return (
    <div className="flex h-full flex-col">
      {/* filters */}
      <div className="shrink-0 space-y-2.5 border-b border-line p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim" />
          <input
            className="w-full rounded-xl border border-line bg-white/[0.03] py-2.5 pl-9 pr-3 text-sm outline-none focus:border-accent-3"
            placeholder="Search games or studios…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>
        <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none]">
          {STATUS_OPTS.map((o) => (
            <button
              key={o.value}
              onClick={() => setStatus(o.value)}
              className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-700 transition ${
                status === o.value ? "bg-accent-3 text-white" : "bg-white/[0.04] text-ink-dim"
              }`}
            >
              {o.label}
            </button>
          ))}
          <div className="ml-auto shrink-0" />
          {SORT_OPTS.map((o) => (
            <button
              key={o.value}
              onClick={() => setSort(o.value)}
              className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-700 transition ${
                sort === o.value ? "bg-white/[0.12] text-white" : "bg-white/[0.04] text-ink-dim"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* grid */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {filtered.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-ink-dim">No games match your filters</div>
        ) : (
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
            {filtered.map((g) => {
              const s = STATUS_STYLE[g.status];
              return (
                <button key={g.id} onClick={() => setSelected(g)} className="group text-left">
                  <div className="relative aspect-[3/4] w-full">
                    <Cover game={g} className="h-full w-full ring-1 ring-white/[0.06] transition group-active:scale-[0.97]" />
                    <div className="absolute inset-x-0 bottom-0 rounded-b-xl bg-gradient-to-t from-black/80 to-transparent p-1.5 pt-5">
                      <div className="flex items-center gap-1 text-[10px] font-700 tabular-nums text-white/90">
                        <Clock className="h-2.5 w-2.5" /> {dur(g.totalRuntimeSeconds)}
                      </div>
                    </div>
                    <span className="absolute left-1 top-1 h-2 w-2 rounded-full ring-2 ring-black/40" style={{ background: s.color }} title={s.label} />
                  </div>
                  <div className="mt-1 truncate text-[11px] font-700 text-ink-soft">{g.displayName}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selected && <DetailSheet game={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function DetailSheet({ game, onClose }: { game: Game; onClose: () => void }) {
  const [g, setG] = useState(game);
  const [busy, setBusy] = useState<string | null>(null);
  const s = STATUS_STYLE[g.status];

  const setStatus = async (status: GameStatus) => {
    setBusy("status");
    try {
      await apiPost(`/api/games/${g.id}/status`, { status });
      setG({ ...g, status });
    } catch {
      /* ignore */
    } finally {
      setBusy(null);
    }
  };
  const launch = async () => {
    setBusy("launch");
    try {
      await apiPost(`/api/games/${g.id}/launch`);
    } catch {
      /* ignore */
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="max-h-[86%] overflow-y-auto rounded-t-3xl border-t border-line bg-bg-base p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/15" />
        <div className="flex gap-3">
          <Cover game={g} rounded="rounded-2xl" className="h-40 w-28 shrink-0 ring-1 ring-white/[0.08]" />
          <div className="min-w-0 flex-1">
            <div className="font-display text-lg font-800 leading-tight">{g.displayName}</div>
            {g.developer && <div className="mt-0.5 truncate text-sm text-ink-dim">{g.developer}</div>}
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-700" style={{ background: `color-mix(in srgb, ${s.color} 18%, transparent)`, color: s.color }}>
                {s.label}
              </span>
              {g.rating != null && (
                <span className="inline-flex items-center gap-1 rounded-lg bg-white/[0.05] px-2 py-1 font-700 text-amber">
                  <Star className="h-3 w-3 fill-amber" /> {g.rating}
                </span>
              )}
              {g.releaseYear && <span className="rounded-lg bg-white/[0.05] px-2 py-1 font-700 text-ink-dim">{g.releaseYear}</span>}
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-sm font-800 tabular-nums text-white">
              <Clock className="h-4 w-4 text-ink-dim" /> {dur(g.totalRuntimeSeconds)}
              {g.lastPlayedUtc && <span className="text-xs font-600 text-ink-faint">· {relativeTime(g.lastPlayedUtc)}</span>}
            </div>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-dim active:bg-white/[0.08]">
            <X className="h-5 w-5" />
          </button>
        </div>

        {g.exePaths.length > 0 && (
          <button onClick={launch} disabled={busy === "launch"} className="btn btn-primary mt-4 h-11 w-full">
            {busy === "launch" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Play className="h-5 w-5" />}
            Launch on PC
          </button>
        )}

        <div className="mt-4">
          <div className="mb-1.5 text-[11px] font-800 uppercase tracking-wider text-ink-dim">Status</div>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(STATUS_STYLE) as GameStatus[]).map((st) => (
              <button
                key={st}
                onClick={() => setStatus(st)}
                disabled={busy === "status"}
                className={`inline-flex items-center gap-1 rounded-xl border px-2.5 py-1.5 text-xs font-700 transition ${
                  g.status === st ? "border-accent-3 bg-accent-3/15 text-white" : "border-line bg-white/[0.03] text-ink-soft"
                }`}
              >
                {g.status === st && <Check className="h-3 w-3" />}
                {STATUS_STYLE[st].label}
              </button>
            ))}
          </div>
        </div>

        {g.notes && <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{g.notes}</p>}
        {g.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {g.tags.map((t) => (
              <span key={t} className="rounded-full border border-line bg-white/[0.03] px-2.5 py-1 text-[11px] text-ink-dim">{t}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
