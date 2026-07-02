/**
 * Companion Library — a mobile port of the desktop Library. Cover grid with search,
 * status/kind/tag filters and sort, backed by the remote link. Tapping a game opens
 * the full GameDetail overlay (see ../screens/GameDetail via `openGame`).
 */

import { useMemo, useState } from "react";
import { Search, Clock, Loader2, Star, Tag } from "lucide-react";
import type { Game, GameStatus } from "@/lib/api";
import { dur } from "@/lib/format";
import { useRemote } from "../useRemote";
import { Art, STATUS_STYLE, STATUS_ORDER, openGame } from "../ui";

type StatusFilter = "all" | GameStatus;
type Sort = "recent" | "name" | "playtime" | "score";
type Kind = "games" | "apps";

const STATUS_OPTS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  ...STATUS_ORDER.map((s) => ({ value: s, label: STATUS_STYLE[s].label })),
];
const SORT_OPTS: { value: Sort; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
  { value: "playtime", label: "Playtime" },
  { value: "score", label: "Score" },
];

export function LibraryScreen() {
  const { data: games, loading, error } = useRemote<Game[]>("/api/games", 15000);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("games");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [tag, setTag] = useState<string | null>(null);

  const pool = useMemo(() => (games ?? []).filter((g) => (kind === "apps" ? g.kind === "app" : g.kind !== "app")), [games, kind]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    pool.forEach((g) => g.tags.forEach((t) => set.add(t)));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [pool]);

  const filtered = useMemo(() => {
    const list = pool.filter((g) => {
      if (kind === "games" && status !== "all" && g.status !== status) return false;
      if (tag && !g.tags.includes(tag)) return false;
      if (q && !`${g.displayName} ${g.developer ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    const by: Record<Sort, (a: Game, b: Game) => number> = {
      name: (a, b) => a.displayName.localeCompare(b.displayName),
      playtime: (a, b) => b.totalRuntimeSeconds - a.totalRuntimeSeconds,
      score: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
      recent: (a, b) => new Date(b.lastPlayedUtc ?? b.createdAt).getTime() - new Date(a.lastPlayedUtc ?? a.createdAt).getTime(),
    };
    return [...list].sort(by[sort]);
  }, [pool, kind, q, status, sort, tag]);

  if (loading && !games) return <div className="grid h-full place-items-center text-sm text-ink-dim"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading library…</div>;
  if (error && !games) return <div className="m-4 rounded-xl border border-amber/40 bg-amber/10 p-3 text-sm text-amber">{error}</div>;

  return (
    <div className="flex h-full flex-col">
      {/* filters */}
      <div className="shrink-0 space-y-2.5 border-b border-line p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
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
          <div className="flex shrink-0 rounded-xl bg-white/[0.05] p-0.5">
            {(["games", "apps"] as Kind[]).map((k) => (
              <button key={k} onClick={() => { setKind(k); setTag(null); }} className={`rounded-lg px-2.5 py-1.5 text-xs font-700 capitalize ${kind === k ? "bg-accent-3 text-white" : "text-ink-dim"}`}>{k}</button>
            ))}
          </div>
        </div>

        {kind === "games" && (
          <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none]">
            {STATUS_OPTS.map((o) => (
              <button key={o.value} onClick={() => setStatus(o.value)} className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-700 transition ${status === o.value ? "bg-accent-3 text-white" : "bg-white/[0.04] text-ink-dim"}`}>{o.label}</button>
            ))}
            <div className="ml-auto shrink-0" />
            {SORT_OPTS.map((o) => (
              <button key={o.value} onClick={() => setSort(o.value)} className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-700 transition ${sort === o.value ? "bg-white/[0.12] text-white" : "bg-white/[0.04] text-ink-dim"}`}>{o.label}</button>
            ))}
          </div>
        )}

        {allTags.length > 0 && (
          <div className="-mx-3 flex items-center gap-1.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none]">
            <Tag className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            {tag && (
              <button onClick={() => setTag(null)} className="shrink-0 rounded-full bg-accent-3 px-2.5 py-1 text-[11px] font-700 text-white">{tag} ✕</button>
            )}
            {allTags.filter((t) => t !== tag).slice(0, 40).map((t) => (
              <button key={t} onClick={() => setTag(t)} className="shrink-0 rounded-full border border-line bg-white/[0.03] px-2.5 py-1 text-[11px] font-700 text-ink-dim">{t}</button>
            ))}
          </div>
        )}
      </div>

      {/* grid */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {filtered.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-ink-dim">No {kind} match your filters</div>
        ) : (
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
            {filtered.map((g) => {
              const s = STATUS_STYLE[g.status];
              return (
                <button key={g.id} onClick={() => openGame(g.id)} className="group text-left">
                  <div className="relative aspect-[3/4] w-full">
                    <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="h-full w-full ring-1 ring-white/[0.06] transition group-active:scale-[0.97]" />
                    <div className="absolute inset-x-0 bottom-0 rounded-b-xl bg-gradient-to-t from-black/80 to-transparent p-1.5 pt-5">
                      <div className="flex items-center gap-1 text-[10px] font-700 tabular-nums text-white/90"><Clock className="h-2.5 w-2.5" /> {dur(g.totalRuntimeSeconds)}</div>
                    </div>
                    {g.kind !== "app" && <span className="absolute left-1 top-1 h-2 w-2 rounded-full ring-2 ring-black/40" style={{ background: s.color }} title={s.label} />}
                    {g.rating != null && (
                      <span className="absolute right-1 top-1 inline-flex items-center gap-0.5 rounded-md bg-black/55 px-1 py-0.5 text-[9px] font-800 text-amber backdrop-blur"><Star className="h-2.5 w-2.5 fill-amber" />{g.rating}</span>
                    )}
                  </div>
                  <div className="mt-1 truncate text-[11px] font-700 text-ink-soft">{g.displayName}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
