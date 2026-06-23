import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { Star } from "lucide-react";
import type { Game } from "@/lib/api";
import { GameArt } from "./GameArt";
import { useMotionEnabled } from "@/store/app";

/** A game's headline score — the personal rating wins, else the critic score.
 *  Both are stored on the same 0–100 scale. */
function scoreOf(g: Game): { value: number; mine: boolean } | null {
  if (g.rating != null) return { value: g.rating, mine: true };
  if (g.metacritic != null) return { value: g.metacritic, mine: false };
  return null;
}

/** Compact horizontal bars — top library games ranked by score. */
export function LibraryPlaytimeChart({ games }: { games: Game[] }) {
  const enabled = useMotionEnabled();
  const rows = games
    .filter((g) => g.kind !== "app")
    .map((g) => ({ g, score: scoreOf(g) }))
    .filter((r): r is { g: Game; score: { value: number; mine: boolean } } => r.score != null)
    .sort((a, b) => b.score.value - a.score.value)
    .slice(0, 8);

  if (rows.length === 0) {
    return (
      <div className="flex h-full min-h-[120px] flex-col justify-center rounded-2xl border border-dashed border-line/70 bg-white/[0.02] px-4 py-3 text-center">
        <p className="text-xs font-700 text-ink-dim">Top rated</p>
        <p className="mt-1 text-[11px] text-ink-faint">Score your games to see a ranking here</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-line/60 bg-white/[0.02] p-3">
      <div className="mb-2 shrink-0">
        <p className="text-[11px] font-800 uppercase tracking-wider text-ink-dim">Top rated</p>
        <p className="text-[10px] text-ink-faint">Highest scored titles in your library</p>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
        {rows.map(({ g, score }, i) => {
          const pct = Math.min(100, Math.max(score.value, 4));
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
                  <span
                    className={`inline-flex shrink-0 items-center gap-0.5 text-[10px] font-800 tabular-nums ${
                      score.mine ? "text-amber" : "text-emerald-400"
                    }`}
                  >
                    {score.mine ? (
                      <Star className="h-2.5 w-2.5 fill-amber text-amber" />
                    ) : (
                      <span className="text-[8px] uppercase opacity-80">MC</span>
                    )}
                    {score.value}
                  </span>
                </div>
                <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
                  <motion.div
                    className="absolute inset-y-0 left-0 rounded-full bg-accent-sheen"
                    initial={enabled ? { width: 0 } : false}
                    animate={{ width: `${pct}%` }}
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
