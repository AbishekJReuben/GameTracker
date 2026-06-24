import { useMemo, type CSSProperties, type ReactNode } from "react";
import { assetUrl, type Game } from "@/lib/api";
import { GameArt } from "./GameArt";
import { MarqueeShader } from "./animations/MarqueeShader";
import { Card } from "./ui";
import { useMarqueeTier, useMotionEnabled } from "@/store/app";
import { cn } from "@/lib/cn";

/**
 * The decorative "extra" marquee engine: a faded, vignette-masked backdrop that
 * sits behind a panel's content. One component, ~18 distinct visual techniques
 * (drift, parallax, 3D tilt, conveyor, duotone, Ken Burns, ticker, wave,
 * spotlight, mosaic, shader, …) so backdrops never feel repetitive. Each panel
 * passes category-relevant `games` (covers / app icons) and the variant chooses
 * how to present them. Self-hides unless the marquee pref is "full".
 */
export type MarqueeFXVariant =
  | "drift"
  | "driftReverse"
  | "vertical"
  | "verticalReverse"
  | "parallax"
  | "diagonal"
  | "tilt3d"
  | "conveyor"
  | "duotone"
  | "grayscale"
  | "bokeh"
  | "kenburns"
  | "ticker"
  | "wave"
  | "spotlight"
  | "mosaic"
  | "pulse"
  | "shader";

type ArtKind = "cover" | "icon";

const DEFAULT_OPACITY: Partial<Record<MarqueeFXVariant, number>> = {
  kenburns: 0.26,
  bokeh: 0.3,
  duotone: 0.22,
  grayscale: 0.2,
  spotlight: 0.22,
  ticker: 0.12,
  shader: 0.24,
};

function sortByArt(games: Game[]): Game[] {
  return [...games].sort((a, b) => {
    const score = (g: Game) => (g.coverPath ? 4000 : 0) + (g.steamAppId ? 1500 : 0) + (g.status === "completed" ? 800 : 0) + (g.rating ?? 0);
    return score(b) - score(a);
  });
}

function pickPhotos(games: Game[], max: number): string[] {
  const shots: string[] = [];
  for (const g of games) {
    for (const s of g.screenshots ?? []) {
      shots.push(s);
      if (shots.length >= max) return shots;
    }
  }
  if (shots.length >= 6) return shots;
  const covers = games.map((g) => assetUrl(g.coverPath)).filter((u): u is string => !!u);
  return shots.length ? shots : covers.slice(0, max);
}

/** Horizontal wall of cover/icon tiles, optionally drifting; supports per-tile style. */
function CoverTrack({
  games,
  durationSec,
  reverse = false,
  motionOn,
  art = "cover",
  drift = true,
  tileClassName,
  tileStyle,
  aspect = "aspect-[3/4]",
  gap = "gap-3",
}: {
  games: Game[];
  durationSec: number;
  reverse?: boolean;
  motionOn: boolean;
  art?: ArtKind;
  drift?: boolean;
  tileClassName?: string;
  tileStyle?: (i: number) => CSSProperties | undefined;
  aspect?: string;
  gap?: string;
}) {
  const animate = motionOn && drift;
  const strip = animate ? [...games, ...games] : games;
  return (
    <div className="absolute inset-0 flex items-center">
      <div
        className={cn("flex h-full w-max items-center px-3", gap)}
        style={animate ? { animation: `gt-marquee ${durationSec}s linear infinite${reverse ? " reverse" : ""}`, willChange: "transform" } : undefined}
      >
        {strip.map((g, i) => (
          <div
            key={`${g.id}-${i}`}
            className={cn(aspect, "h-full shrink-0 overflow-hidden rounded-lg border border-white/5 bg-bg-900/40 shadow-card", tileClassName)}
            style={tileStyle?.(i)}
          >
            <GameArt
              id={g.id}
              name={g.displayName}
              cover={g.coverPath}
              icon={g.iconPath}
              accent={g.accentColor}
              steamAppId={g.steamAppId}
              variant={art === "icon" ? "icon" : undefined}
              className="h-full w-full"
              rounded="rounded-lg"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Horizontal wall of landscape photos with an image filter (duotone/bokeh/…). */
function PhotoTrack({
  photos,
  durationSec,
  reverse = false,
  motionOn,
  imgClassName,
}: {
  photos: string[];
  durationSec: number;
  reverse?: boolean;
  motionOn: boolean;
  imgClassName?: string;
}) {
  const strip = motionOn ? [...photos, ...photos] : photos;
  return (
    <div className="absolute inset-0 flex items-center">
      <div
        className="flex h-full w-max items-center gap-3 px-3"
        style={motionOn ? { animation: `gt-marquee ${durationSec}s linear infinite${reverse ? " reverse" : ""}`, willChange: "transform" } : undefined}
      >
        {strip.map((src, i) => (
          <div key={`${i}-${src}`} className="aspect-video h-full shrink-0 overflow-hidden rounded-lg border border-white/5 bg-black/40">
            <img src={src} alt="" loading="lazy" draggable={false} className={cn("h-full w-full object-cover", imgClassName)} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A wall of narrow vertical-scrolling columns, alternating direction. */
function VerticalColumns({ games, motionOn, reverse = false }: { games: Game[]; motionOn: boolean; reverse?: boolean }) {
  const cols = 7;
  return (
    <div className="absolute inset-0 flex gap-3 px-2">
      {Array.from({ length: cols }).map((_, c) => {
        const rotated = [...games.slice(c * 2), ...games.slice(0, c * 2)];
        const strip = motionOn ? [...rotated, ...rotated] : rotated;
        const up = (c % 2 === 0) !== reverse;
        return (
          <div key={c} className="relative flex-1 overflow-hidden">
            <div
              className="absolute inset-x-0 top-0 flex w-full flex-col items-center gap-3"
              style={motionOn ? { animation: `gt-marquee-y ${30 + c * 4}s linear infinite${up ? " reverse" : ""}`, willChange: "transform" } : undefined}
            >
              {strip.map((g, i) => (
                <div key={`${g.id}-${i}`} className="aspect-[3/4] w-full shrink-0 overflow-hidden rounded-lg border border-white/5">
                  <GameArt id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} steamAppId={g.steamAppId} className="h-full w-full" rounded="rounded-lg" />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Two stacked rows of small tiles drifting opposite directions (mosaic). */
function MosaicRows({ games, motionOn }: { games: Game[]; motionOn: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col gap-2 py-2">
      <div className="relative flex-1 overflow-hidden">
        <CoverTrack games={games} durationSec={38} motionOn={motionOn} aspect="aspect-[3/4]" gap="gap-2" />
      </div>
      <div className="relative flex-1 overflow-hidden">
        <CoverTrack games={[...games].reverse()} durationSec={46} reverse motionOn={motionOn} aspect="aspect-[3/4]" gap="gap-2" />
      </div>
    </div>
  );
}

/** Scrolling text ticker of names — a different *form* of marquee. */
function TextTicker({ labels, motionOn }: { labels: string[]; motionOn: boolean }) {
  const strip = motionOn ? [...labels, ...labels] : labels;
  return (
    <div className="absolute inset-0 flex flex-col justify-center gap-4">
      {[0, 1].map((row) => (
        <div key={row} className="flex w-max items-center gap-8 whitespace-nowrap" style={motionOn ? { animation: `gt-marquee ${row ? 52 : 40}s linear infinite${row ? " reverse" : ""}`, willChange: "transform" } : undefined}>
          {strip.map((t, i) => (
            <span key={`${row}-${i}`} className="font-display text-3xl font-900 uppercase tracking-tight text-ink/70">
              {t}
              <span className="px-4 text-accent-3/60">✦</span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

export function MarqueeFX({
  variant,
  games = [],
  art = "cover",
  opacity,
  tier = "extra",
  className,
}: {
  variant: MarqueeFXVariant;
  games?: Game[];
  art?: ArtKind;
  opacity?: number;
  tier?: "base" | "extra";
  className?: string;
}) {
  const show = useMarqueeTier(tier);
  const motionOn = useMotionEnabled();

  const sorted = useMemo(() => sortByArt(games).slice(0, 22), [games]);
  const photos = useMemo(() => pickPhotos(sorted, 16), [sorted]);

  if (!show) return null;
  const hasCovers = sorted.length > 0;
  const hasPhotos = photos.length > 0;

  let content: ReactNode = null;
  switch (variant) {
    case "drift":
      content = hasCovers && <CoverTrack games={sorted} durationSec={70} motionOn={motionOn} art={art} />;
      break;
    case "driftReverse":
      content = hasCovers && <CoverTrack games={sorted} durationSec={64} reverse motionOn={motionOn} art={art} />;
      break;
    case "vertical":
      content = hasCovers && <VerticalColumns games={sorted} motionOn={motionOn} />;
      break;
    case "verticalReverse":
      content = hasCovers && <VerticalColumns games={sorted} motionOn={motionOn} reverse />;
      break;
    case "parallax":
      content = hasCovers && (
        <>
          {/* back layer: slower, scaled up, blurred for depth */}
          <div className="absolute inset-0 scale-110 opacity-60 blur-[2px]">
            <CoverTrack games={[...sorted].reverse()} durationSec={95} motionOn={motionOn} art={art} />
          </div>
          {/* front layer: faster, sharp */}
          <div className="absolute inset-0">
            <CoverTrack games={sorted} durationSec={48} motionOn={motionOn} art={art} />
          </div>
        </>
      );
      break;
    case "diagonal":
      content = hasCovers && (
        <div className="absolute inset-0 origin-center -rotate-[7deg] scale-[1.35]">
          <CoverTrack games={sorted} durationSec={66} motionOn={motionOn} art={art} />
        </div>
      );
      break;
    case "tilt3d":
      content = hasCovers && (
        <div className="absolute inset-0 [perspective:900px]">
          <div className="absolute inset-0 scale-[1.3] [transform:rotateY(-22deg)_rotateX(6deg)]">
            <CoverTrack games={sorted} durationSec={60} motionOn={motionOn} art={art} />
          </div>
        </div>
      );
      break;
    case "conveyor":
      content = hasCovers && (
        <div className="absolute inset-0 [perspective:700px]">
          <div className="absolute inset-0 origin-bottom scale-[1.5] [transform:rotateX(46deg)]">
            <CoverTrack games={sorted} durationSec={54} motionOn={motionOn} art={art} />
          </div>
        </div>
      );
      break;
    case "duotone":
      content = hasPhotos && (
        <>
          <PhotoTrack photos={photos} durationSec={62} motionOn={motionOn} imgClassName="grayscale contrast-125" />
          <div className="absolute inset-0 bg-accent-sheen mix-blend-color" />
        </>
      );
      break;
    case "grayscale":
      content = hasPhotos && (
        <>
          <PhotoTrack photos={photos} durationSec={58} reverse motionOn={motionOn} imgClassName="grayscale brightness-110" />
          <div className="absolute inset-0 bg-accent-sheen/25 mix-blend-overlay" />
        </>
      );
      break;
    case "bokeh":
      content = hasPhotos && <PhotoTrack photos={photos} durationSec={80} motionOn={motionOn} imgClassName="scale-125 blur-xl saturate-150" />;
      break;
    case "kenburns":
      content = hasPhotos && (
        <img
          src={photos[0]}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
          style={motionOn ? { animation: "gt-kenburns 26s ease-in-out infinite", willChange: "transform" } : { transform: "scale(1.12)" }}
        />
      );
      break;
    case "ticker":
      content = sorted.length > 0 && <TextTicker labels={sorted.map((g) => g.displayName)} motionOn={motionOn} />;
      break;
    case "wave":
      content = hasCovers && (
        <CoverTrack
          games={sorted}
          durationSec={68}
          motionOn={motionOn}
          art={art}
          tileStyle={(i) => (motionOn ? { animation: "gt-wave 3.2s ease-in-out infinite", animationDelay: `${(i % 8) * 0.18}s`, willChange: "transform" } : undefined)}
        />
      );
      break;
    case "spotlight":
      content = hasCovers && (
        <>
          <CoverTrack games={sorted} durationSec={70} drift={false} motionOn={motionOn} art={art} />
          <div
            className="absolute inset-y-[-20%] left-0 w-1/3"
            style={{
              background: "radial-gradient(closest-side, color-mix(in srgb, var(--accent-3) 55%, transparent), transparent 70%)",
              ...(motionOn ? { animation: "gt-spotlight 9s ease-in-out infinite alternate", willChange: "transform" } : {}),
            }}
          />
        </>
      );
      break;
    case "mosaic":
      content = hasCovers && <MosaicRows games={sorted} motionOn={motionOn} />;
      break;
    case "pulse":
      content = hasCovers && (
        <CoverTrack
          games={sorted}
          durationSec={88}
          motionOn={motionOn}
          art={art}
          tileStyle={(i) => (motionOn ? { animation: "glow-pulse 4.5s ease-in-out infinite", animationDelay: `${(i % 6) * 0.4}s` } : undefined)}
        />
      );
      break;
    case "shader":
      content = hasCovers && (
        <>
          <CoverTrack games={sorted} durationSec={90} motionOn={motionOn} art={art} />
          <MarqueeShader />
        </>
      );
      break;
  }

  if (!content) return null;

  return (
    <div className={cn("pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]", className)} aria-hidden>
      <div className="absolute inset-0" style={{ opacity: opacity ?? DEFAULT_OPACITY[variant] ?? 0.16 }}>
        {content}
      </div>
      {/* Vignette: fade art toward the panel body so foreground text stays crisp. */}
      <div className="absolute inset-0 bg-gradient-to-r from-bg-base via-bg-base/70 to-bg-base/40" />
      <div className="absolute inset-0 bg-gradient-to-t from-bg-base via-bg-base/35 to-bg-base/55" />
    </div>
  );
}

/** A {@link Card} with a {@link MarqueeFX} backdrop pre-wired and content lifted. */
export function MarqueeCard({
  variant,
  games,
  art,
  opacity,
  className,
  children,
  ...rest
}: {
  variant: MarqueeFXVariant;
  games?: Game[];
  art?: ArtKind;
  opacity?: number;
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <Card className={cn("relative", className)} {...rest}>
      <MarqueeFX variant={variant} games={games} art={art} opacity={opacity} />
      <div className="relative z-10">{children}</div>
    </Card>
  );
}
