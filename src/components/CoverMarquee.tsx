import { useMemo } from "react";
import type { Game } from "@/lib/api";
import { GameArt } from "./GameArt";
import { useMotionEnabled } from "@/store/app";
import { cn } from "@/lib/cn";

/**
 * A slowly drifting wall of game cover thumbnails — the "scrolling game header"
 * used on the Collection hero and the dashboard. Covers fill the container
 * height (so it adapts to any panel), the strip is duplicated for a seamless
 * loop, and edge fades blend it into the surrounding UI. Static (no drift) when
 * reduced-motion is on.
 */
export function CoverMarquee({
  games,
  className,
  max = 24,
  durationSec = 55,
  fade = true,
  dimmed = false,
}: {
  games: Game[];
  className?: string;
  max?: number;
  durationSec?: number;
  /** Render left/right edge fades. Turn off when the caller applies its own scrims. */
  fade?: boolean;
  dimmed?: boolean;
}) {
  const enabled = useMotionEnabled();

  // Best/most-finished games lead the wall, then anything else with art.
  const covers = useMemo(() => {
    const withCover = games.filter((g) => g.kind === "game" && g.coverPath);
    return [...withCover]
      .sort((a, b) => {
        const sa = (a.status === "completed" ? 1000 : 0) + (a.rating ?? 0);
        const sb = (b.status === "completed" ? 1000 : 0) + (b.rating ?? 0);
        return sb - sa;
      })
      .slice(0, max);
  }, [games, max]);

  if (covers.length === 0) return null;
  // Duplicate so the -50% loop is seamless (only needed while animating).
  const strip = enabled ? [...covers, ...covers] : covers;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-line/60 bg-bg-900/70 transition-opacity",
        dimmed && "opacity-40",
        className
      )}
      aria-label="Game cover showcase"
    >
      <div className="absolute inset-0 flex items-center">
        <div
          className="flex h-full w-max items-center gap-2.5 px-2 py-2"
          style={enabled ? { animation: `gt-marquee ${durationSec}s linear infinite`, willChange: "transform" } : undefined}
        >
          {strip.map((g, i) => (
            <div
              key={`${g.id}-${i}`}
              className="aspect-[3/4] h-full shrink-0 overflow-hidden rounded-xl border border-white/5 shadow-card"
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
      </div>

      {fade && (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-bg-base to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-bg-base to-transparent" />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg-base/40 via-transparent to-transparent" />
        </>
      )}
    </div>
  );
}
