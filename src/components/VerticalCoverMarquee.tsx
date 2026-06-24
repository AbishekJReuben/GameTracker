import { useMemo } from "react";
import type { Game } from "@/lib/api";
import { GameArt } from "./GameArt";
import { useMarqueeTier, useMotionEnabled } from "@/store/app";
import { cn } from "@/lib/cn";

/**
 * A slowly drifting *vertical* wall of game cover thumbnails — the portrait
 * twin of {@link CoverMarquee}. Covers fill the column width (so it adapts to
 * any narrow rail), the strip is duplicated for a seamless top-to-bottom loop,
 * and a top/bottom vignette blends it into the surrounding UI. Static (no
 * drift) when reduced-motion is on.
 */
export function VerticalCoverMarquee({
  games,
  className,
  max = 18,
  durationSec = 42,
  reverse = false,
}: {
  games: Game[];
  className?: string;
  max?: number;
  durationSec?: number;
  reverse?: boolean;
}) {
  const enabled = useMotionEnabled();
  const showMarquee = useMarqueeTier("base");

  // Cover art leads the wall (then completed/highly-rated), but games without a
  // cover still join via GameArt's gradient+initials poster so the rail is never
  // an empty gap — even before any covers have been fetched.
  const covers = useMemo(() => {
    return [...games.filter((g) => g.kind === "game")]
      .sort((a, b) => {
        const score = (g: Game) =>
          (g.coverPath ? 4000 : 0) +
          (g.steamAppId ? 1500 : 0) +
          (g.status === "completed" ? 1000 : 0) +
          (g.rating ?? 0);
        return score(b) - score(a);
      })
      .slice(0, max);
  }, [games, max]);

  if (!showMarquee || covers.length === 0) return null;
  // Duplicate so the -50% loop is seamless (only needed while animating).
  const strip = enabled ? [...covers, ...covers] : covers;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-line/60 bg-bg-900/70",
        className
      )}
      aria-label="Game cover showcase"
    >
      <div
        className="absolute inset-x-0 top-0 flex w-full flex-col items-center gap-2.5 px-2 py-2"
        style={
          enabled
            ? { animation: `gt-marquee-y ${durationSec}s linear infinite${reverse ? " reverse" : ""}`, willChange: "transform" }
            : undefined
        }
      >
        {strip.map((g, i) => (
          <div
            key={`${g.id}-${i}`}
            className="aspect-[3/4] w-full shrink-0 overflow-hidden rounded-xl border border-white/5 shadow-card"
          >
            <GameArt
              id={g.id}
              name={g.displayName}
              cover={g.coverPath}
              icon={g.iconPath}
              accent={g.accentColor}
              steamAppId={g.steamAppId}
              className="h-full w-full"
              rounded="rounded-xl"
            />
          </div>
        ))}
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-bg-base to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-bg-base to-transparent" />
    </div>
  );
}
