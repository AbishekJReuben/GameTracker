import type { ReactNode } from "react";
import type { Game } from "@/lib/api";
import { useMarqueeTier } from "@/store/app";
import { Card } from "./ui";
import { CoverMarquee } from "./CoverMarquee";
import { ImageMarquee } from "./ImageMarquee";
import { cn } from "@/lib/cn";

export type PanelArtVariant = "covers" | "screenshots" | "screenshots-reverse";

/**
 * A faded, vignette-masked drift of related artwork (covers or screenshots) that
 * sits *behind* a full-length panel's content. Different `variant`s give each
 * panel a distinct look (portrait cover wall vs. landscape screenshot reel,
 * drifting either direction). Purely decorative — `pointer-events-none` and
 * `aria-hidden`, dimmed and scrimmed so foreground text stays crisp.
 */
export function PanelArtBackdrop({
  variant = "covers",
  games = [],
  images = [],
  className,
}: {
  variant?: PanelArtVariant;
  games?: Game[];
  images?: string[];
  className?: string;
}) {
  const show = useMarqueeTier("base");
  if (!show) return null;
  const art =
    variant === "covers" ? (
      <CoverMarquee
        games={games}
        fade={false}
        durationSec={75}
        className="absolute inset-0 rounded-none border-0 bg-transparent shadow-none"
      />
    ) : (
      <ImageMarquee
        images={images}
        fade={false}
        reverse={variant === "screenshots-reverse"}
        durationSec={62}
        className="absolute inset-0 rounded-none border-0 bg-transparent shadow-none"
      />
    );

  // Nothing to show? Render nothing (callers can always include it safely).
  if (variant === "covers" ? games.length === 0 : images.length === 0) return null;

  return (
    <div
      className={cn("pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]", className)}
      aria-hidden
    >
      <div className="absolute inset-0 opacity-[0.16]">{art}</div>
      {/* Vignette: fade the art out toward the panel body so text reads cleanly. */}
      <div className="absolute inset-0 bg-gradient-to-r from-bg-base via-bg-base/72 to-bg-base/35" />
      <div className="absolute inset-0 bg-gradient-to-t from-bg-base via-bg-base/35 to-bg-base/55" />
    </div>
  );
}

/**
 * Convenience: a {@link Card} with a {@link PanelArtBackdrop} already wired in
 * and the body lifted above it. Drop-in replacement for `<Card>` on the wide
 * dashboard panels.
 */
export function ArtCard({
  variant,
  games,
  images,
  className,
  children,
  ...rest
}: {
  variant?: PanelArtVariant;
  games?: Game[];
  images?: string[];
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <Card className={cn("relative", className)} {...rest}>
      <PanelArtBackdrop variant={variant} games={games} images={images} />
      <div className="relative z-10">{children}</div>
    </Card>
  );
}
