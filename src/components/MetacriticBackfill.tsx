import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Award, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { useApp } from "@/store/app";
import { useRefreshAll } from "@/lib/queries";

/** Settings row: backfill Metacritic scores for every game that has none. */
export function MetacriticBackfill() {
  const pushToast = useApp((s) => s.pushToast);
  const refreshAll = useRefreshAll();
  const [job, setJob] = useState<{ done: number; total: number; name?: string } | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    const unProg = listen<{ done: number; total: number; name?: string }>("metacritic://progress", (e) =>
      setJob({ done: e.payload.done, total: e.payload.total, name: e.payload.name })
    );
    const unDone = listen<{ count: number; updated: number }>("metacritic://done", (e) => {
      setJob(null);
      refreshAll();
      pushToast({
        kind: "success",
        title: "Metacritic scores updated",
        message: `${e.payload.updated} of ${e.payload.count} games got a score`,
      });
    });
    return () => {
      unProg.then((f) => f());
      unDone.then((f) => f());
    };
  }, [pushToast, refreshAll]);

  const run = async () => {
    try {
      const total = await api.backfillMetacritic();
      if (total === 0) {
        pushToast({ kind: "info", title: "All games already have a Metacritic score" });
        return;
      }
      setJob({ done: 0, total });
      pushToast({ kind: "info", title: "Fetching Metacritic scores", message: `${total} games — runs in the background` });
    } catch (e) {
      pushToast({ kind: "info", title: "Turn on Online metadata first", message: String(e) });
    }
  };

  return (
    <div className="flex items-center gap-4 rounded-xl px-2 py-3 transition hover:bg-white/[0.02]">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-ink-soft">
        <Award className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-700">Metacritic scores</div>
        <div className="text-xs text-ink-dim">
          Auto-fetched when you add a game. Backfill any title that's still missing one.
        </div>
        {job && (
          <div className="mt-2">
            <div className="h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${(job.done / Math.max(1, job.total)) * 100}%` }}
              />
            </div>
            <div className="mt-1 text-[11px] text-ink-faint">
              {job.name ? `${job.name}… ` : ""}
              {job.done}/{job.total}
            </div>
          </div>
        )}
      </div>
      <div className="shrink-0">
        <button onClick={run} disabled={!!job} className="btn btn-subtle h-9 disabled:opacity-60">
          {job ? <Loader2 className="h-4 w-4 animate-spin" /> : <Award className="h-4 w-4" />}
          {job ? `${job.done}/${job.total}` : "Backfill"}
        </button>
      </div>
    </div>
  );
}
