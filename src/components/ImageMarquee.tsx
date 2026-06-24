import { useMemo } from "react";
import { assetUrl } from "@/lib/api";
import { useMarqueeTier, useMotionEnabled } from "@/store/app";
import { cn } from "@/lib/cn";

/**
 * A slowly drifting strip of landscape images (game screenshots / posters),
 * mirroring the CoverMarquee. The strip is duplicated for a seamless loop and
 * driven by a pure-CSS animation (so it animates on first mount, unlike a JS
 * percentage-transform). Static when reduced-motion is on.
 */
export function ImageMarquee({
  images,
  className,
  durationSec = 48,
  reverse = false,
  fade = true,
}: {
  images: string[];
  className?: string;
  durationSec?: number;
  reverse?: boolean;
  fade?: boolean;
}) {
  const enabled = useMotionEnabled();
  const showMarquee = useMarqueeTier("base");
  const shots = useMemo(
    () => images.map((u) => assetUrl(u)).filter((u): u is string => !!u).slice(0, 16),
    [images]
  );
  if (!showMarquee || shots.length === 0) return null;
  // Duplicate so the -50% loop is seamless (only needed while animating).
  const strip = enabled ? [...shots, ...shots] : shots;

  return (
    <div
      className={cn("relative overflow-hidden rounded-2xl border border-line/60 bg-bg-900/70", className)}
      aria-label="Screenshot showcase"
    >
      <div className="absolute inset-0 flex items-center">
        <div
          className="flex h-full w-max items-center gap-3 px-2 py-2"
          style={
            enabled
              ? { animation: `gt-marquee ${durationSec}s linear infinite${reverse ? " reverse" : ""}`, willChange: "transform" }
              : undefined
          }
        >
          {strip.map((src, i) => (
            <div
              key={`${i}-${src}`}
              className="aspect-video h-full shrink-0 overflow-hidden rounded-xl border border-white/5 bg-black/40 shadow-card"
            >
              <img src={src} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
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
