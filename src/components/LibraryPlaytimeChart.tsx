import { Link } from "react-router-dom";
import { motion } from "motion/react";
import type { Game } from "@/lib/api";
import { dur } from "@/lib/format";
import { GameArt } from "./GameArt";
import { useMotionEnabled } from "@/store/app";

/** Compact horizontal bars — top library games by active playtime. */
export function LibraryPlaytimeChart({ games }: { games: Game[] }) {
  const enabled = useMotionEnabled();
  const rows = [...games]
    .filter((g) => g.kind !== "app")
    .sort((a, b) => b.totalActiveSeconds - a.totalActiveSeconds)
    .slice(0, 8);
  const max = Math.max(1, ...rows.map((g) => g.totalActiveSeconds));

  if (rows.length === 0) {
    return (
      <div className="flex h-full min-h-[120px] flex-col justify-center rounded-2xl border border-dashed border-line/70 bg-white/[0.02] px-4 py-3 text-center">
        <p className="text-xs font-700 text-ink-dim">Library playtime</p>
        <p className="mt-1 text-[11px] text-ink-faint">Add games to see a breakdown here</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-line/60 bg-white/[0.02] p-3">
      <div className="mb-2 shrink-0">
        <p className="text-[11px] font-800 uppercase tracking-wider text-ink-dim">Library playtime</p>
        <p className="text-[10px] text-ink-faint">Top titles by active hours</p>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
        {rows.map((g, i) => {
          const pct = (g.totalActiveSeconds / max) * 100;
          return (
            <Link
              key={g.id}
              to={`/game/${g.id}`}
              className="group flex items-center gap-2 rounded-lg px-1 py-1 transition hover:bg-white/[0.04]"
              title={g.displayName}
            >
              <GameArt
                id={g.id}
                name={g.displayName}
                cover={g.coverPath}
                icon={g.iconPath}
                accent={g.accentColor}
                className="h-7 w-7 shrink-0"
                rounded="rounded-md"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] font-700 text-ink-soft group-hover:text-ink">{g.displayName}</span>
                  <span className="shrink-0 text-[10px] font-800 tabular-nums text-green">{dur(g.totalActiveSeconds)}</span>
                </div>
                <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
                  <motion.div
                    className="absolute inset-y-0 left-0 rounded-full bg-accent-sheen"
                    initial={enabled ? { width: 0 } : false}
                    animate={{ width: `${Math.max(pct, 4)}%` }}
                    transition={{ duration: 0.65, delay: i * 0.04, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
