import { useMemo } from "react";
import type { Game } from "@/lib/api";
import { assetUrl } from "@/lib/api";
import { GameArt } from "./GameArt";
import { useMarqueeTier, useMotionEnabled } from "@/store/app";
import { cn } from "@/lib/cn";

type WallItem =
  | { kind: "cover"; game: Game }
  | { kind: "shot"; src: string };

/**
 * A slowly drifting *vertical* wall of game imagery — the portrait twin of
 * {@link CoverMarquee}. It mixes portrait **posters** (cover art, with GameArt's
 * gradient+initials fallback so the rail is never empty) and, when available,
 * **screenshots** cropped to portrait — interleaved so the column feels alive
 * and varied. The strip is duplicated for a seamless top-to-bottom loop with a
 * top/bottom vignette; static (no drift) when reduced-motion is on.
 */
export function VerticalCoverMarquee({
  games,
  screenshots = [],
  className,
  max = 18,
  durationSec = 42,
  reverse = false,
}: {
  games: Game[];
  /** Optional landscape screenshots to interleave between the posters. */
  screenshots?: string[];
  className?: string;
  max?: number;
  durationSec?: number;
  reverse?: boolean;
}) {
  const enabled = useMotionEnabled();
  const showMarquee = useMarqueeTier("base");

  // Cover art leads (then completed/highly-rated). Screenshots are woven in
  // every few tiles so the wall alternates posters and in-game shots.
  const items = useMemo<WallItem[]>(() => {
    const covers = [...games.filter((g) => g.kind === "game")]
      .sort((a, b) => {
        const score = (g: Game) =>
          (g.coverPath ? 4000 : 0) +
          (g.steamAppId ? 1500 : 0) +
          (g.status === "completed" ? 1000 : 0) +
          (g.rating ?? 0);
        return score(b) - score(a);
      })
      .slice(0, max);
    const shots = screenshots
      .map((u) => assetUrl(u))
      .filter((u): u is string => !!u)
      .slice(0, Math.ceil(max / 3));

    const out: WallItem[] = [];
    let si = 0;
    covers.forEach((game, i) => {
      out.push({ kind: "cover", game });
      // Slot a screenshot after every third poster.
      if ((i + 1) % 3 === 0 && si < shots.length) out.push({ kind: "shot", src: shots[si++] });
    });
    while (si < shots.length) out.push({ kind: "shot", src: shots[si++] });
    return out.slice(0, max);
  }, [games, screenshots, max]);

  if (!showMarquee || items.length === 0) return null;
  // Duplicate so the -50% loop is seamless (only needed while animating).
  const strip = enabled ? [...items, ...items] : items;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-line/60 bg-bg-900/70",
        className
      )}
      aria-label="Game showcase"
    >
      <div
        className="absolute inset-x-0 top-0 flex w-full flex-col items-center gap-2.5 px-2 py-2"
        style={
          enabled
            ? { animation: `gt-marquee-y ${durationSec}s linear infinite${reverse ? " reverse" : ""}`, willChange: "transform" }
            : undefined
        }
      >
        {strip.map((it, i) => (
          <div
            key={it.kind === "cover" ? `${it.game.id}-${i}` : `shot-${i}`}
            className="aspect-[3/4] w-full shrink-0 overflow-hidden rounded-xl border border-white/5 shadow-card"
          >
            {it.kind === "cover" ? (
              <GameArt
                id={it.game.id}
                name={it.game.displayName}
                cover={it.game.coverPath}
                icon={it.game.iconPath}
                accent={it.game.accentColor}
                steamAppId={it.game.steamAppId}
                className="h-full w-full"
                rounded="rounded-xl"
              />
            ) : (
              <img src={it.src} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
            )}
          </div>
        ))}
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-bg-base to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-bg-base to-transparent" />
    </div>
  );
}
