import { useMemo, useState } from "react";
import { Globe, AppWindow, ExternalLink } from "lucide-react";
import { Session } from "@/lib/api";
import { dur, dateLabel, timeLabel } from "@/lib/format";
import { useApp } from "@/store/app";
import { EmptyState } from "@/components/ui";

type Row = {
  key: string;
  title: string | null;
  url: string | null;
  host: string | null;
  startMs: number;
  endMs: number;
  durationSec: number;
  live: boolean;
};

function hostOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    const u = url.includes("://") ? url : `https://${url}`;
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Chronological browser/window activity for a game: each captured URL or window
 * title with exactly when it started, when it ended, and how long it lasted.
 * Built from the per-session `activitySpans` the tracker records.
 */
export function ActivityLog({ sessions, limit = 60 }: { sessions: Session[]; limit?: number }) {
  const use24 = useApp((s) => s.prefs.timeFormat === "24h");
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo<Row[]>(() => {
    const now = Date.now();
    const out: Row[] = [];
    for (const s of sessions) {
      for (const a of s.activitySpans ?? []) {
        if (!a.title && !a.url) continue;
        const startMs = new Date(a.startUtc).getTime();
        const live = !a.endUtc;
        const endMs = a.endUtc ? new Date(a.endUtc).getTime() : now;
        out.push({
          key: `${s.id}-${a.startUtc}-${a.url ?? a.title}`,
          title: a.title ?? null,
          url: a.url ?? null,
          host: hostOf(a.url),
          startMs,
          endMs,
          durationSec: Math.max(0, Math.round((endMs - startMs) / 1000)),
          live,
        });
      }
    }
    return out.sort((a, b) => b.startMs - a.startMs);
  }, [sessions]);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Globe className="h-6 w-6" />}
        title="No window activity yet"
        message="While you play, the foreground window title and any browser URL are recorded here with exact start and end times."
      />
    );
  }

  const shown = showAll ? rows : rows.slice(0, limit);

  return (
    <div>
      <div className="max-h-[460px] divide-y divide-line overflow-y-auto pr-1">
        {shown.map((r) => {
          const fmt = (ms: number) => timeLabel(new Date(ms).toISOString(), use24);
          return (
            <div key={r.key} className="flex items-start gap-3 py-2.5">
              <div className="w-24 shrink-0 text-xs text-ink-dim">
                {dateLabel(new Date(r.startMs).toISOString())}
                <div className="text-[11px] tabular-nums text-ink-faint">
                  {fmt(r.startMs)} → {r.live ? "now" : fmt(r.endMs)}
                </div>
              </div>
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line bg-white/[0.03] text-ink-dim">
                {r.host ? <Globe className="h-3.5 w-3.5" /> : <AppWindow className="h-3.5 w-3.5" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-700 text-ink-soft">{r.title ?? r.host}</div>
                {r.host && (
                  <a
                    href={r.url ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-1 truncate text-[11px] text-ink-faint transition hover:text-accent"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    <span className="truncate">{r.host}</span>
                  </a>
                )}
              </div>
              <div className="shrink-0 text-right text-xs font-800 tabular-nums text-ink">
                {r.live ? <span className="text-accent">live</span> : dur(r.durationSec)}
              </div>
            </div>
          );
        })}
      </div>
      {rows.length > limit && (
        <button onClick={() => setShowAll((v) => !v)} className="btn btn-ghost mt-3 h-8 w-full text-xs">
          {showAll ? "Show less" : `Show all ${rows.length} entries`}
        </button>
      )}
    </div>
  );
}
