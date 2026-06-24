import { useMemo, useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  Search,
  Plus,
  Radar,
  FileSpreadsheet,
  Sparkles,
  Loader2,
  LayoutGrid,
  List,
  Grid3x3,
  GalleryHorizontalEnd,
  Clapperboard,
  GripVertical,
  Tag,
  ChevronDown,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Page } from "@/components/Page";
import { GameCard } from "@/components/GameCard";
import { GameList, GameCompact, GameAlbum, GameTheatre, GameReorder } from "@/components/LibraryViews";
import { DetectModal } from "@/components/DetectModal";
import { Segmented, EmptyState, Skeleton, Toggle } from "@/components/ui";
import { MarqueeFX } from "@/components/MarqueeFX";
import { useGames, useRefreshAll } from "@/lib/queries";
import { useApp, useMotionEnabled } from "@/store/app";
import { viewSwap } from "@/lib/motion";
import { useProgress } from "@/store/progress";
import { runEnrichAll, runCsvImport } from "@/lib/bulkTasks";
import type { LibraryView } from "@/store/app";
import { cn } from "@/lib/cn";
import { api, Game, GameStatus } from "@/lib/api";

const VIEWS: { value: LibraryView; icon: typeof LayoutGrid; label: string }[] = [
  { value: "grid", icon: LayoutGrid, label: "Grid" },
  { value: "list", icon: List, label: "List" },
  { value: "compact", icon: Grid3x3, label: "Compact" },
  { value: "album", icon: GalleryHorizontalEnd, label: "Album" },
  { value: "theatre", icon: Clapperboard, label: "Theatre" },
];

function ViewSwitcher({ value, onChange }: { value: LibraryView; onChange: (v: LibraryView) => void }) {
  return (
    <div className="inline-flex rounded-xl border border-line bg-bg-900/60 p-1 backdrop-blur">
      {VIEWS.map((v) => {
        const active = v.value === value;
        return (
          <button
            key={v.value}
            onClick={() => onChange(v.value)}
            title={`${v.label} view`}
            className={cn(
              "grid h-8 w-8 place-items-center rounded-lg transition",
              active ? "bg-accent-sheen text-white shadow-[0_4px_14px_-6px_var(--accent-1)]" : "text-ink-dim hover:text-ink"
            )}
          >
            <v.icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}

type StatusFilter = "all" | GameStatus;
type Sort = "recent" | "name" | "playtime" | "score" | "manual";

const STATUS_OPTS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "playing", label: "Playing" },
  { value: "backlog", label: "Backlog" },
  { value: "on_hold", label: "On Hold" },
  { value: "completed", label: "Completed" },
  { value: "dropped", label: "Dropped" },
  { value: "watched", label: "Watched" },
];

const SORT_OPTS: { value: Sort; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
  { value: "playtime", label: "Playtime" },
  { value: "score", label: "Score" },
  { value: "manual", label: "Manual" },
];

/** Completed-date sort key (newest first); null when no completion date. */
function completedMs(g: Game): number | null {
  if (!g.completedYear) return null;
  const month = (g.completedMonth ?? 12) - 1;
  const day = g.completedDay ?? 28;
  return new Date(g.completedYear, month, day).getTime();
}

export default function LibraryPage() {
  const location = useLocation();
  const { data: games, isLoading } = useGames();
  const openGameModal = useApp((s) => s.openGameModal);
  const pushToast = useApp((s) => s.pushToast);
  const refresh = useRefreshAll();
  const view = useApp((s) => s.prefs.libraryView);
  const setPref = useApp((s) => s.setPref);
  const manualOrder = useApp((s) => s.prefs.manualOrder);
  const motionOn = useMotionEnabled();
  const liveGameId = useApp((s) => (s.tracking?.isPlaying ? s.tracking.gameId : null));
  const coverJob = useProgress((s) => s.getJob("covers"));
  const infoJob = useProgress((s) => s.getJob("game-info"));
  const hltbJob = useProgress((s) => s.getJob("hltb"));
  const csvJob = useProgress((s) => s.getJob("csv-import"));
  const anyBusy = useProgress((s) => s.isAnyBusy());
  const [q, setQ] = useState("");
  // Filters/sort/toggles are remembered across sessions (search text stays transient).
  const filters = useApp((s) => s.prefs.libraryFilters);
  const status = filters.status;
  const sort = filters.sort;
  const trackedOnly = filters.trackedOnly;
  const tag = filters.tag;
  const tagsOpen = filters.tagsOpen;
  const patchFilters = (p: Partial<typeof filters>) =>
    setPref("libraryFilters", { ...useApp.getState().prefs.libraryFilters, ...p });
  const setStatus = (v: StatusFilter) => patchFilters({ status: v });
  const setSort = (v: Sort) => patchFilters({ sort: v });
  const setTrackedOnly = (v: boolean) => patchFilters({ trackedOnly: v });
  const setTag = (v: (string | null) | ((cur: string | null) => string | null)) =>
    patchFilters({ tag: typeof v === "function" ? v(useApp.getState().prefs.libraryFilters.tag) : v });
  const setTagsOpen = (v: boolean | ((o: boolean) => boolean)) =>
    patchFilters({ tagsOpen: typeof v === "function" ? v(useApp.getState().prefs.libraryFilters.tagsOpen) : v });
  const [detectOpen, setDetectOpen] = useState(false);

  useEffect(() => {
    const fromNav = (location.state as { tag?: string } | null)?.tag;
    if (fromNav) {
      setTag(fromNav);
      setTagsOpen(true);
    }
  }, [location.state]);

  // Library is games-only; apps live on their own page.
  const onlyGames = useMemo(() => (games ?? []).filter((g) => g.kind !== "app"), [games]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    onlyGames.forEach((g) => g.tags.forEach((t) => set.add(t)));
    return [...set].sort();
  }, [onlyGames]);

  const filtered = useMemo(() => {
    if (!games) return [];
    let list = onlyGames.filter((g) => {
      if (status !== "all" && g.status !== status) return false;
      if (trackedOnly && !g.isTracked) return false;
      if (tag && !g.tags.includes(tag)) return false;
      if (q && !`${g.displayName} ${g.developer ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    // Manual sort: honour the user's saved drag order verbatim (no live-game
    // float). Unranked games fall to the end, stably by name.
    if (sort === "manual") {
      const pos = new Map(manualOrder.map((id, i) => [id, i] as const));
      const at = (g: Game) => pos.get(g.id) ?? Number.MAX_SAFE_INTEGER;
      return [...list].sort((a, b) => at(a) - at(b) || a.displayName.localeCompare(b.displayName));
    }
    const by: Record<Sort, (a: Game, b: Game) => number> = {
      name: (a, b) => a.displayName.localeCompare(b.displayName),
      playtime: (a, b) => b.totalRuntimeSeconds - a.totalRuntimeSeconds,
      score: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
      recent: (a, b) => {
        const ca = completedMs(a);
        const cb = completedMs(b);
        if (ca != null && cb != null) return cb - ca;
        if (ca != null) return -1;
        if (cb != null) return 1;
        return new Date(b.lastPlayedUtc ?? b.createdAt).getTime() - new Date(a.lastPlayedUtc ?? a.createdAt).getTime();
      },
      manual: () => 0,
    };
    // The game running right now floats to the very top, then anything marked
    // "playing", then everything else ordered by the chosen sort.
    const rank = (g: Game) => (liveGameId && g.id === liveGameId ? 0 : g.status === "playing" ? 1 : 2);
    return [...list].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return by[sort](a, b);
    });
  }, [games, onlyGames, q, status, sort, trackedOnly, tag, liveGameId, manualOrder]);

  // Local working copy for drag reordering — keeps drags buttery (no global
  // re-sort per swap); the saved order is persisted shortly after you let go.
  const [manualList, setManualList] = useState<Game[]>([]);
  useEffect(() => {
    if (sort === "manual") setManualList(filtered);
  }, [sort, filtered]);
  useEffect(() => {
    if (sort !== "manual" || manualList.length === 0) return;
    const t = setTimeout(() => {
      const ids = manualList.map((g) => g.id);
      const shown = new Set(ids);
      const prev = useApp.getState().prefs.manualOrder;
      const rest = prev.filter((id) => !shown.has(id));
      const known = new Set([...ids, ...rest]);
      const others = onlyGames.filter((g) => !known.has(g.id)).map((g) => g.id);
      const next = [...ids, ...rest, ...others];
      const unchanged = next.length === prev.length && next.every((id, i) => id === prev[i]);
      if (!unchanged) setPref("manualOrder", next);
    }, 450);
    return () => clearTimeout(t);
  }, [manualList, sort, onlyGames, setPref]);

  const importCsv = async () => {
    const path = (await api.defaultCsvPath()) ?? (await open({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] }));
    if (typeof path !== "string") return;
    try {
      await runCsvImport(path, refresh, pushToast);
    } catch {
      pushToast({ kind: "info", title: "CSV import failed" });
    }
  };

  const fetchAll = () => runEnrichAll(onlyGames, refresh, pushToast);

  const jobLabel = (job: typeof coverJob, fallback: string) =>
    job ? (job.total > 0 ? `${job.done}/${job.total}` : `${job.done}…`) : fallback;

  // One "Get data" button drives all three enrichment passes; reflect whichever is running.
  const enrichJob = coverJob ?? infoJob ?? hltbJob;
  const enrichLabel = coverJob
    ? `Covers ${jobLabel(coverJob, "")}`
    : infoJob
    ? `Info ${jobLabel(infoJob, "")}`
    : hltbJob
    ? `HLTB ${jobLabel(hltbJob, "")}`
    : "Get data";

  return (
    <Page
      title="Library"
      subtitle={games ? `${onlyGames.length} games` : "Your games"}
      actions={
        <>
          <button onClick={fetchAll} disabled={anyBusy} className="btn btn-ghost h-10" title="Fetch covers, info (Steam) & HowLongToBeat for your whole library">
            {enrichJob ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {enrichLabel}
          </button>
          <button onClick={importCsv} disabled={anyBusy} className="btn btn-ghost h-10" title="Import CSV">
            {csvJob ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
            {jobLabel(csvJob, "Import")}
          </button>
          <button onClick={() => setDetectOpen(true)} className="btn btn-ghost h-10">
            <Radar className="h-4 w-4" /> Scan
          </button>
          <button onClick={() => openGameModal({ mode: "track" })} className="btn btn-primary h-10">
            <Plus className="h-4 w-4" /> Add
          </button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim" />
          <input className="input pl-9" placeholder="Search games or studios…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented value={status} onChange={setStatus} options={STATUS_OPTS} />
        <Segmented value={sort} onChange={setSort} options={SORT_OPTS} />
        <Toggle checked={trackedOnly} onChange={setTrackedOnly} label="Tracked only" />
        <ViewSwitcher value={view} onChange={(v) => setPref("libraryView", v)} />
      </div>

      {allTags.length > 0 && (
        <div className="mb-5">
          <button
            type="button"
            onClick={() => setTagsOpen((o) => !o)}
            className="relative flex w-full items-center gap-2 overflow-hidden rounded-xl border border-line bg-white/[0.02] px-3 py-2 text-left transition hover:bg-white/[0.04]"
          >
            <MarqueeFX variant="driftReverse" games={onlyGames} opacity={0.12} />
            <Tag className="relative z-10 h-4 w-4 shrink-0 text-ink-dim" />
            <span className="relative z-10 text-sm font-700 text-ink-soft">Tags</span>
            <span className="relative z-10 text-xs font-600 tabular-nums text-ink-dim">({allTags.length})</span>
            {tag && (
              <span className="relative z-10 pill border border-line bg-accent-sheen text-white">{tag}</span>
            )}
            <ChevronDown className={cn("relative z-10 ml-auto h-4 w-4 shrink-0 text-ink-dim transition", tagsOpen && "rotate-180")} />
          </button>
          {tagsOpen && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-line border-t-0 rounded-t-none bg-white/[0.01] px-3 py-2.5">
              <button onClick={() => setTag(null)} className={`pill border border-line transition ${tag === null ? "bg-accent-sheen text-white" : "bg-white/[0.03] text-ink-dim hover:text-ink"}`}>
                All tags
              </button>
              {allTags.map((t) => (
                <button
                  key={t}
                  onClick={() => setTag((cur) => (cur === t ? null : t))}
                  className={`pill border border-line transition ${tag === t ? "bg-accent-sheen text-white" : "bg-white/[0.03] text-ink-soft hover:text-ink"}`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 min-[2200px]:grid-cols-8">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[3/4]" />
          ))}
        </div>
      ) : filtered.length > 0 && sort === "manual" ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-white/[0.02] px-3 py-2 text-xs font-600 text-ink-dim">
            <GripVertical className="h-4 w-4 shrink-0 text-ink-dim" />
            Drag the handle to set your own order — it's saved automatically. Clear search & filters first to reorder the whole library.
          </div>
          <GameReorder games={manualList.length ? manualList : filtered} onReorder={setManualList} />
        </div>
      ) : filtered.length > 0 ? (
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            variants={motionOn ? viewSwap : undefined}
            initial={motionOn ? "hidden" : false}
            animate="show"
            exit={motionOn ? "exit" : undefined}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {view === "list" ? (
              <GameList games={filtered} />
            ) : view === "compact" ? (
              <GameCompact games={filtered} />
            ) : view === "album" ? (
              <GameAlbum games={filtered} />
            ) : view === "theatre" ? (
              <GameTheatre games={filtered} />
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 min-[2200px]:grid-cols-8">
                {filtered.map((g, i) => (
                  <GameCard key={g.id} game={g} index={i} />
                ))}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      ) : games && games.length === 0 ? (
        <EmptyState
          icon={<Plus className="h-6 w-6" />}
          title="Your library is empty"
          message="Add a game, drop an .exe anywhere, scan your PC, or import your completed-games CSV to get started."
          action={
            <div className="flex gap-2">
              <button onClick={() => openGameModal({ mode: "track" })} className="btn btn-primary">
                <Plus className="h-4 w-4" /> Add a game
              </button>
              <button onClick={() => setDetectOpen(true)} className="btn btn-ghost">
                <Radar className="h-4 w-4" /> Scan PC
              </button>
            </div>
          }
        />
      ) : (
        <EmptyState title="No games match your filters" />
      )}

      <DetectModal open={detectOpen} onClose={() => setDetectOpen(false)} />
    </Page>
  );
}
