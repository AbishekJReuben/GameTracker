/**
 * Companion (phone) port of the desktop decorative marquee system
 * (`components/MarqueeFX.tsx` + `components/CoverMarquee.tsx` + `components/Panel.tsx`).
 *
 * The desktop versions render `GameArt`, which resolves cover art through the
 * Tauri asset protocol — unavailable in the phone app. This module reproduces the
 * same ~30 backdrop techniques and the same per-panel deterministic variant/art
 * selection, but draws through the companion `Art` / `LoadedImg` loaders (which
 * fetch bytes over the remote link). Unlike desktop it uses NO WebGL: the phone
 * WebView's live-context budget is tiny, so the desktop `MarqueeShader` overlay is
 * replaced by a CSS `CssSheen` for the "shader"/"lightfield" variants.
 *
 * Keyframes (`gt-marquee`, `gt-marquee-y`, `gt-orbit`, …) live in the shared
 * `index.css` the companion already imports, so the animations match desktop.
 */

import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from "react";
import type { Game, Session } from "@/lib/api";
import {
  MOVING_VARIANTS,
  FX_VARIANTS,
  type MarqueeFXVariant,
} from "@/components/MarqueeFX";
import { panelArt, panelVariant, type PanelArtContext } from "@/lib/panelMarquees";
import { useMarqueeTier, useMotionEnabled } from "@/store/app";
import { cn } from "@/lib/cn";
import { Art, LoadedImg } from "./ui";

export type { MarqueeFXVariant };
export { MOVING_VARIANTS, FX_VARIANTS };

type ArtKind = "cover" | "icon";

/**
 * A cheap, CSS-only decorative sheen used where the desktop overlays the WebGL
 * `MarqueeShader`. The phone's WebView has a very small live-WebGL-context budget
 * (each shader panel = one GL context), and stacking several across the section
 * backdrops + the page-transition canvas blanked the whole webview — so the
 * companion deliberately uses NO WebGL for backdrops. This gradient wash keeps the
 * "shader"/"lightfield" variants visually distinct without a GL context.
 */
function CssSheen() {
  return (
    <>
      <div className="absolute inset-0 bg-[radial-gradient(120%_120%_at_20%_0%,color-mix(in_srgb,var(--accent-3)_45%,transparent),transparent_60%)] mix-blend-soft-light" />
      <div className="absolute inset-0 bg-[radial-gradient(120%_120%_at_100%_100%,color-mix(in_srgb,var(--accent-1)_40%,transparent),transparent_55%)] mix-blend-screen opacity-70" />
    </>
  );
}

const DEFAULT_OPACITY: Partial<Record<MarqueeFXVariant, number>> = {
  kenburns: 0.26,
  zoom: 0.24,
  bokeh: 0.3,
  duotone: 0.22,
  grayscale: 0.2,
  spotlight: 0.22,
  ticker: 0.12,
  shader: 0.24,
  filmstrip: 0.18,
  frost: 0.2,
  icons: 0.14,
  crossfade: 0.18,
  breathe: 0.16,
  float: 0.16,
  glow: 0.24,
  lightfield: 0.24,
  tiltpan: 0.16,
};

function sortByArt(games: Game[]): Game[] {
  return [...games].sort((a, b) => {
    const score = (g: Game) =>
      (g.coverPath ? 4000 : 0) + (g.steamAppId ? 1500 : 0) + (g.status === "completed" ? 800 : 0) + (g.rating ?? 0);
    return score(b) - score(a);
  });
}

/** Pick local screenshot/cover paths for the photo-based techniques (resolved by
 *  `LoadedImg` over the link). Returns local paths, not URLs. */
function pickPhotoPaths(games: Game[], max: number): string[] {
  const shots: string[] = [];
  for (const g of games) {
    for (const s of g.screenshots ?? []) {
      shots.push(s);
      if (shots.length >= max) return shots;
    }
  }
  if (shots.length >= 6) return shots;
  const covers = games.map((g) => g.coverPath).filter((u): u is string => !!u);
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
            <Art
              id={g.id}
              name={g.displayName}
              cover={g.coverPath}
              icon={g.iconPath}
              accent={g.accentColor}
              variant={art === "icon" ? "icon" : "cover"}
              className="h-full w-full"
              rounded="rounded-lg"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Horizontal wall of landscape photos (local paths via LoadedImg) with a filter. */
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
            <LoadedImg path={src} className={cn("h-full w-full object-cover", imgClassName)} />
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
                  <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="h-full w-full" rounded="rounded-lg" />
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

/** Three narrow vertical columns — distinct from the 7-column `vertical` variant. */
function TripleColumns({ games, motionOn, reverse = false }: { games: Game[]; motionOn: boolean; reverse?: boolean }) {
  return (
    <div className="absolute inset-0 flex gap-4 px-3">
      {Array.from({ length: 3 }).map((_, c) => {
        const rotated = [...games.slice(c * 3), ...games.slice(0, c * 3)];
        const strip = motionOn ? [...rotated, ...rotated] : rotated;
        const up = (c % 2 === 0) !== reverse;
        return (
          <div key={c} className="relative flex-1 overflow-hidden">
            <div
              className="absolute inset-x-0 top-0 flex w-full flex-col items-center gap-4"
              style={motionOn ? { animation: `gt-marquee-y ${36 + c * 6}s linear infinite${up ? " reverse" : ""}`, willChange: "transform" } : undefined}
            >
              {strip.map((g, i) => (
                <div key={`${g.id}-${i}`} className="aspect-[3/4] w-full shrink-0 overflow-hidden rounded-lg border border-white/5">
                  <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="h-full w-full" rounded="rounded-lg" />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Honeycomb-style offset grid of covers. */
function HexGrid({ games, motionOn }: { games: Game[]; motionOn: boolean }) {
  const strip = motionOn ? [...games, ...games] : games;
  return (
    <div className="absolute inset-0 flex items-center overflow-hidden">
      <div
        className="flex w-max flex-wrap gap-2 px-3"
        style={motionOn ? { animation: "gt-marquee 72s linear infinite", willChange: "transform", width: "max(200%, 100%)" } : undefined}
      >
        {strip.map((g, i) => (
          <div key={`${g.id}-${i}`} className="aspect-[3/4] h-24 shrink-0 overflow-hidden rounded-lg border border-white/5 sm:h-28" style={{ marginTop: i % 2 === 0 ? 0 : 18 }}>
            <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="h-full w-full" rounded="rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Slow orbital ring of cover tiles. */
function OrbitRing({ games, motionOn }: { games: Game[]; motionOn: boolean }) {
  const ring = games.slice(0, 10);
  return (
    <div className="absolute inset-0 grid place-items-center">
      <div className="relative h-[140%] w-[140%]" style={motionOn ? { animation: "gt-orbit 48s linear infinite", willChange: "transform" } : undefined}>
        {ring.map((g, i) => {
          const angle = (i / ring.length) * 360;
          return (
            <div
              key={g.id}
              className="absolute left-1/2 top-1/2 aspect-[3/4] w-16 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-white/5"
              style={{ transform: `rotate(${angle}deg) translateY(-42%) rotate(-${angle}deg)` }}
            >
              <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="h-full w-full" rounded="rounded-lg" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Polaroid-style tilted frames. */
function PolaroidWall({ games, motionOn }: { games: Game[]; motionOn: boolean }) {
  const strip = motionOn ? [...games, ...games] : games;
  return (
    <div className="absolute inset-0 flex items-center">
      <div className="flex w-max items-center gap-4 px-4" style={motionOn ? { animation: "gt-marquee 58s linear infinite", willChange: "transform" } : undefined}>
        {strip.map((g, i) => (
          <div key={`${g.id}-${i}`} className="shrink-0 rounded-sm border border-white/10 bg-white/[0.04] p-1.5 shadow-card" style={{ transform: `rotate(${(i % 5) - 2}deg)` }}>
            <div className="aspect-[3/4] w-20 overflow-hidden sm:w-24">
              <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="h-full w-full" rounded="rounded-sm" />
            </div>
          </div>
        ))}
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

/** A static grid of covers (no scroll); each tile can carry an in-place animation. */
function StaticGrid({
  games,
  motionOn,
  tileStyle,
  art = "cover",
}: {
  games: Game[];
  motionOn: boolean;
  tileStyle?: (i: number) => CSSProperties | undefined;
  art?: ArtKind;
}) {
  const tiles = games.slice(0, 18);
  return (
    <div className="absolute inset-0 grid grid-cols-5 gap-2 p-2 sm:grid-cols-7">
      {tiles.map((g, i) => (
        <div key={`${g.id}-${i}`} className="aspect-[3/4] overflow-hidden rounded-lg border border-white/5" style={motionOn ? tileStyle?.(i) : undefined}>
          <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} variant={art === "icon" ? "icon" : "cover"} className="h-full w-full" rounded="rounded-lg" />
        </div>
      ))}
    </div>
  );
}

/** A few large blurred covers with a slow pulsing accent glow — fully static. */
function GlowWall({ games, motionOn }: { games: Game[]; motionOn: boolean }) {
  const picks = games.slice(0, 4);
  return (
    <div className="absolute inset-0 flex">
      {picks.map((g, i) => (
        <div key={g.id} className="relative flex-1 overflow-hidden">
          <div className="absolute inset-0 scale-110 blur-[3px]">
            <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="h-full w-full" rounded="rounded-none" />
          </div>
          <div className="absolute inset-0 bg-accent-sheen/25 mix-blend-soft-light" style={motionOn ? { animation: "glow-pulse 5s ease-in-out infinite", animationDelay: `${i * 0.6}s` } : undefined} />
        </div>
      ))}
    </div>
  );
}

/**
 * The companion decorative backdrop engine — mirrors desktop `MarqueeFX`. A faded,
 * vignette-masked wall of covers/icons/photos behind a panel's content, chosen per
 * `variant`. Self-hides unless the marquee pref allows the given tier.
 */
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
  const photos = useMemo(() => pickPhotoPaths(sorted, 16), [sorted]);

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
          <div className="absolute inset-0 scale-110 opacity-60 blur-[2px]">
            <CoverTrack games={[...sorted].reverse()} durationSec={95} motionOn={motionOn} art={art} />
          </div>
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
        <div className="absolute inset-0" style={motionOn ? { animation: "gt-kenburns 26s ease-in-out infinite", willChange: "transform" } : { transform: "scale(1.12)" }}>
          <LoadedImg path={photos[0]} className="absolute inset-0 h-full w-full object-cover" />
        </div>
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
          <CssSheen />
        </>
      );
      break;
    case "filmstrip":
      content = hasPhotos && <PhotoTrack photos={photos} durationSec={55} motionOn={motionOn} imgClassName="brightness-90 contrast-105" />;
      break;
    case "hexgrid":
      content = hasCovers && <HexGrid games={sorted} motionOn={motionOn} />;
      break;
    case "orbit":
      content = hasCovers && <OrbitRing games={sorted} motionOn={motionOn} />;
      break;
    case "zoom":
      content = hasCovers && sorted[0] && (
        <div className="absolute inset-0 overflow-hidden" style={motionOn ? { animation: "gt-kenburns 24s ease-in-out infinite", willChange: "transform" } : { transform: "scale(1.1)" }}>
          <Art id={sorted[0].id} name={sorted[0].displayName} cover={sorted[0].coverPath} icon={sorted[0].iconPath} accent={sorted[0].accentColor} className="h-full w-full" rounded="rounded-none" />
        </div>
      );
      break;
    case "stagger":
      content = hasCovers && (
        <div className="absolute inset-0 flex gap-2 px-2">
          {[0, 1, 2].map((col) => (
            <div key={col} className="relative flex-1 overflow-hidden" style={{ marginTop: col * 12 }}>
              <CoverTrack games={[...sorted].slice(col)} durationSec={50 + col * 8} reverse={col % 2 === 1} motionOn={motionOn} art={art} aspect="aspect-[2/3]" gap="gap-2" />
            </div>
          ))}
        </div>
      );
      break;
    case "ribbon":
      content = hasCovers && (
        <div className="absolute inset-0 origin-center rotate-[12deg] scale-125">
          <CoverTrack games={sorted} durationSec={44} motionOn={motionOn} art="icon" aspect="aspect-square" gap="gap-2" />
        </div>
      );
      break;
    case "polaroid":
      content = hasCovers && <PolaroidWall games={sorted} motionOn={motionOn} />;
      break;
    case "split":
      content = hasCovers && (
        <div className="absolute inset-0 flex flex-col gap-1 py-1">
          <div className="relative flex-1 overflow-hidden opacity-80">
            <CoverTrack games={sorted} durationSec={42} motionOn={motionOn} art={art} aspect="aspect-video" gap="gap-2" />
          </div>
          <div className="relative flex-1 overflow-hidden">
            <CoverTrack games={[...sorted].reverse()} durationSec={50} reverse motionOn={motionOn} art={art} aspect="aspect-video" gap="gap-2" />
          </div>
        </div>
      );
      break;
    case "frost":
      content = hasPhotos && (
        <>
          <PhotoTrack photos={photos} durationSec={64} motionOn={motionOn} imgClassName="scale-110 blur-md brightness-75" />
          <div className="absolute inset-0 bg-bg-base/30 backdrop-blur-[1px]" />
        </>
      );
      break;
    case "accent":
      content = hasCovers && (
        <>
          <CoverTrack games={sorted} durationSec={60} motionOn={motionOn} art={art} />
          <div className="absolute inset-0 bg-accent-sheen/20 mix-blend-soft-light" />
        </>
      );
      break;
    case "columns":
      content = hasCovers && <TripleColumns games={sorted} motionOn={motionOn} />;
      break;
    case "icons":
      content = hasCovers && <CoverTrack games={sorted} durationSec={52} motionOn={motionOn} art="icon" aspect="aspect-square" gap="gap-2" tileClassName="rounded-xl" />;
      break;
    case "crossfade":
      content = hasCovers && (
        <StaticGrid games={sorted} motionOn={motionOn} art={art} tileStyle={(i) => ({ animation: "gt-twinkle 4.5s ease-in-out infinite", animationDelay: `${(i % 9) * 0.25}s`, willChange: "opacity" })} />
      );
      break;
    case "breathe":
      content = hasCovers && (
        <StaticGrid games={sorted} motionOn={motionOn} art={art} tileStyle={(i) => ({ animation: "gt-breathe 5.5s ease-in-out infinite", animationDelay: `${(i % 7) * 0.3}s`, transformOrigin: "center", willChange: "transform" })} />
      );
      break;
    case "float":
      content = hasCovers && (
        <StaticGrid games={sorted} motionOn={motionOn} art={art} tileStyle={(i) => ({ animation: "gt-float 6s ease-in-out infinite", animationDelay: `${(i % 5) * 0.4}s`, willChange: "transform" })} />
      );
      break;
    case "glow":
      content = hasCovers && <GlowWall games={sorted} motionOn={motionOn} />;
      break;
    case "lightfield":
      content = hasCovers && (
        <>
          <StaticGrid games={sorted} motionOn={false} art={art} />
          <CssSheen />
        </>
      );
      break;
    case "tiltpan":
      content = hasCovers && (
        <div className="absolute inset-0 [perspective:1000px]">
          <div className="absolute inset-0 scale-[1.15]" style={motionOn ? { animation: "gt-tilt 14s ease-in-out infinite", transformStyle: "preserve-3d", willChange: "transform" } : undefined}>
            <StaticGrid games={sorted} motionOn={false} art={art} />
          </div>
        </div>
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

/**
 * The companion "scrolling game header": a slowly drifting wall of cover art.
 * Mirrors desktop `CoverMarquee` but draws through the companion `Art` loader.
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
  fade?: boolean;
  dimmed?: boolean;
}) {
  const enabled = useMotionEnabled();
  const showMarquee = useMarqueeTier("base");

  const covers = useMemo(() => {
    return [...games.filter((g) => g.kind === "game")]
      .sort((a, b) => {
        const score = (g: Game) => (g.coverPath ? 4000 : 0) + (g.steamAppId ? 1500 : 0) + (g.status === "completed" ? 1000 : 0) + (g.rating ?? 0);
        return score(b) - score(a);
      })
      .slice(0, max);
  }, [games, max]);

  if (!showMarquee || covers.length === 0) return null;
  const strip = enabled ? [...covers, ...covers] : covers;

  return (
    <div className={cn("relative overflow-hidden rounded-2xl border border-line/60 bg-bg-900/70 transition-opacity", dimmed && "opacity-40", className)} aria-label="Game cover showcase">
      <div className="absolute inset-0 flex items-center">
        <div className="flex h-full w-max items-center gap-2.5 px-2 py-2" style={enabled ? { animation: `gt-marquee ${durationSec}s linear infinite`, willChange: "transform" } : undefined}>
          {strip.map((g, i) => (
            <div key={`${g.id}-${i}`} className="aspect-[3/4] h-full shrink-0 overflow-hidden rounded-xl border border-white/5 shadow-card">
              <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="h-full w-full" rounded="rounded-xl" />
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

// ---- Section backdrops via context ---------------------------------------
// So a screen can opt every one of its local `Section`/`Card` panels into a
// marquee backdrop with a single provider at the root (no per-call-site edits):
// the screen supplies the art pool once, and each panel renders a deterministic
// backdrop derived from its own title (mirrors how the desktop threads `panelKey`
// + a games pool through every `<Panel>`).

interface MarqueePoolValue {
  games: Game[];
  game?: Game | null;
}
const MarqueePoolContext = createContext<MarqueePoolValue>({ games: [] });

/** Supplies the art pool (and, for GameDetail, the focused game) to `SectionBackdrop`. */
export function MarqueePoolProvider({
  games,
  game,
  children,
}: {
  games: Game[];
  game?: Game | null;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ games, game }), [games, game]);
  return <MarqueePoolContext.Provider value={value}>{children}</MarqueePoolContext.Provider>;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Drop into a `relative overflow-hidden` panel to give it the same
 * context-relevant, deterministic marquee backdrop the desktop `<Panel>` renders.
 * `prefix` selects the art context (e.g. "dashboard", "collection", "game-detail");
 * `title` makes the variant stable + distinct per panel. Reads the pool from the
 * nearest `MarqueePoolProvider`; renders nothing when the pool is empty or the
 * marquee pref is off.
 */
export function SectionBackdrop({ prefix, title, art }: { prefix: string; title: string; art?: ArtKind }) {
  const { games, game } = useContext(MarqueePoolContext);
  const pkey = `${prefix}.${slug(title)}`;
  const resolved = panelArt(pkey, { games, game, art });
  const pool = resolved.games.length ? resolved.games : games;
  if (!pool.length) return null;
  return <MarqueeFX variant={panelVariant(pkey)} games={pool} art={resolved.art} tier="base" opacity={0.12} />;
}

/**
 * Companion `Panel`: a section with a deterministic, context-relevant marquee
 * backdrop (mirrors desktop `components/Panel.tsx`). Pass `panelKey` for the same
 * per-panel variant + art selection the desktop uses, or override with `variant`.
 */
export function Panel({
  panelKey,
  games,
  game,
  sessions,
  images,
  art,
  variant,
  glow = false,
  className,
  children,
  ...rest
}: {
  panelKey: string;
  games?: Game[];
  game?: Game | null;
  sessions?: Session[];
  images?: string[];
  art?: ArtKind;
  variant?: MarqueeFXVariant;
  glow?: boolean;
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const ctx: PanelArtContext = { games, game, sessions, images, art };
  const resolved = panelArt(panelKey, ctx);
  const fxVariant = variant ?? panelVariant(panelKey);
  const pool = resolved.games.length ? resolved.games : games ?? [];

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-line bg-bg-900/40",
        glow && "shadow-glow",
        className,
      )}
      {...rest}
    >
      {pool.length > 0 && <MarqueeFX variant={fxVariant} games={pool} art={resolved.art} tier="base" opacity={0.14} />}
      <div className="relative z-10">{children}</div>
    </div>
  );
}
