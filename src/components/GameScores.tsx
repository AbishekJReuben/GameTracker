import { motion } from "motion/react";
import { Star } from "lucide-react";
import { cn } from "@/lib/cn";
import { useMotionEnabled } from "@/store/app";

export type ScoreGame = { rating: number | null; metacritic: number | null };

export function hasAnyScore(g: ScoreGame) {
  return g.rating != null || g.metacritic != null;
}

export function scoreTooltip(g: ScoreGame) {
  const parts: string[] = [];
  if (g.rating != null) parts.push(`My score: ${g.rating}`);
  if (g.metacritic != null) parts.push(`Metacritic: ${g.metacritic}`);
  return parts.join(" · ");
}

type Variant = "badge" | "micro" | "inline" | "list";

export function GameScores({
  game,
  variant = "inline",
  className,
  index = 0,
}: {
  game: ScoreGame;
  variant?: Variant;
  className?: string;
  /** Grid position — staggers the badge's shimmer sweep so a wall of cards
   *  ripples instead of flashing in unison. */
  index?: number;
}) {
  const { rating, metacritic } = game;
  const hasMine = rating != null;
  const hasMeta = metacritic != null;

  if (!hasMine && !hasMeta) {
    return variant === "list" ? <span className={cn("text-ink-dim", className)}>—</span> : null;
  }

  if (variant === "list") {
    return (
      <span className={cn("flex flex-col items-end gap-0.5 text-right tabular-nums", className)}>
        {hasMine && (
          <span className="inline-flex items-center gap-0.5 text-sm font-800 text-amber">
            <Star className="h-3 w-3 fill-amber text-amber" />
            {rating}
          </span>
        )}
        {hasMeta && <span className="text-[11px] font-700 text-emerald-400">MC {metacritic}</span>}
      </span>
    );
  }

  if (variant === "micro") {
    return (
      <span
        className={cn("absolute right-1 top-1 flex flex-col items-end gap-px rounded bg-black/55 px-1 py-0.5 text-[8px] font-800 leading-tight text-white backdrop-blur", className)}
        title={scoreTooltip(game)}
      >
        {hasMine && <span className="text-amber">★{rating}</span>}
        {hasMeta && <span className="text-emerald-300">M{metacritic}</span>}
      </span>
    );
  }

  if (variant === "badge") {
    return <ScoreBadge rating={rating} metacritic={metacritic} hasMine={hasMine} hasMeta={hasMeta} game={game} className={className} index={index} />;
  }

  // inline
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-0.5", className)} title={scoreTooltip(game)}>
      {hasMine && (
        <span className="inline-flex items-center gap-0.5 text-amber">
          <Star className="h-3 w-3 fill-amber text-amber" />
          <span className="font-700 tabular-nums">{rating}</span>
        </span>
      )}
      {hasMeta && (
        <span className="inline-flex items-center gap-0.5 text-emerald-400">
          <span className="text-[10px] font-800 uppercase tracking-wide opacity-80">MC</span>
          <span className="font-700 tabular-nums">{metacritic}</span>
        </span>
      )}
    </span>
  );
}

// Shimmer cycle = sweep duration + the idle gap before it repeats. The initial
// delay is spread across this whole period so neighbouring cards are out of
// phase and the sweeps ripple across the grid rather than firing together.
const SHIMMER_DURATION = 1.8;
const SHIMMER_GAP = 4;
const SHIMMER_PERIOD = SHIMMER_DURATION + SHIMMER_GAP;

function ScoreBadge({
  rating,
  metacritic,
  hasMine,
  hasMeta,
  game,
  className,
  index = 0,
}: {
  rating: number | null;
  metacritic: number | null;
  hasMine: boolean;
  hasMeta: boolean;
  game: ScoreGame;
  className?: string;
  index?: number;
}) {
  const enabled = useMotionEnabled();
  const shimmerDelay = 0.3 + ((index * 0.22) % SHIMMER_PERIOD);
  return (
    <motion.div
      className={cn("absolute right-2.5 top-2.5 flex flex-col items-end gap-0.5 overflow-hidden rounded-xl bg-black/45 px-2 py-1 text-[10px] font-800 text-white backdrop-blur-md", className)}
      title={scoreTooltip(game)}
      initial={enabled ? { scale: 0.85, opacity: 0 } : false}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 24 }}
    >
      {enabled && (
        <motion.span
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent"
          initial={{ x: "-120%" }}
          animate={{ x: "220%" }}
          transition={{ duration: SHIMMER_DURATION, delay: shimmerDelay, ease: "easeInOut", repeat: Infinity, repeatDelay: SHIMMER_GAP }}
        />
      )}
      {hasMine && (
        <span className="relative inline-flex items-center gap-0.5 text-amber">
          <Star className="h-2.5 w-2.5 fill-amber text-amber" />
          {rating}
        </span>
      )}
      {hasMeta && <span className="relative text-emerald-300">MC {metacritic}</span>}
    </motion.div>
  );
}
