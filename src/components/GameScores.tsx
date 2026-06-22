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
}: {
  game: ScoreGame;
  variant?: Variant;
  className?: string;
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
    return <ScoreBadge rating={rating} metacritic={metacritic} hasMine={hasMine} hasMeta={hasMeta} game={game} className={className} />;
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

function ScoreBadge({
  rating,
  metacritic,
  hasMine,
  hasMeta,
  game,
  className,
}: {
  rating: number | null;
  metacritic: number | null;
  hasMine: boolean;
  hasMeta: boolean;
  game: ScoreGame;
  className?: string;
}) {
  const enabled = useMotionEnabled();
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
          transition={{ duration: 1.8, delay: 0.4, ease: "easeInOut", repeat: Infinity, repeatDelay: 4 }}
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
