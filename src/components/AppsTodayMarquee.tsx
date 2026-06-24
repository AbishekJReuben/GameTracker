import { Link } from "react-router-dom";
import { AppWindow, ArrowUpRight } from "lucide-react";
import type { AppsOverview, Game } from "@/lib/api";
import { GameArt } from "./GameArt";
import { MarqueeFX } from "./MarqueeFX";
import { useMarqueeTier, useMotionEnabled } from "@/store/app";
import { dur } from "@/lib/format";

// True alpha mask (not an overlay) so the strip itself fades out at both edges.
const VIGNETTE = "linear-gradient(to right, transparent, #000 7%, #000 93%, transparent)";

/**
 * The dashboard "Apps today" card: a horizontally drifting, edge-masked reel of
 * the apps you've used (base marquee), layered over a slower **parallax** wall of
 * app icons (extra marquee — only when the pref is "full"). With marquee off it
 * degrades to a plain summary line. Static (no drift) when reduced-motion is on.
 */
export function AppsTodayMarquee({ overview, appGames = [] }: { overview: AppsOverview; appGames?: Game[] }) {
  const enabled = useMotionEnabled();
  const showReel = useMarqueeTier("base");
  const apps = overview.topApps.slice(0, 14);

  const header = (
    <div className="flex items-center justify-between gap-4 px-4 pt-3">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-sheen/20 text-accent-3">
          <AppWindow className="h-4 w-4" />
        </span>
        <div>
          <div className="text-sm font-700">Apps today</div>
          <div className="text-xs text-ink-dim">{dur(overview.todayActive)} active · separate from game stats</div>
        </div>
      </div>
      <span className="shrink-0 text-xs font-700 text-accent-3">
        {showReel ? "All apps" : overview.topApps[0]?.name ?? "All apps"} <ArrowUpRight className="inline h-3.5 w-3.5" />
      </span>
    </div>
  );

  // Marquee off → plain summary line (no reel, no parallax).
  if (!showReel || apps.length === 0) {
    return (
      <Link to="/apps" className="card relative block overflow-hidden border border-line bg-white/[0.03] pb-3 transition hover:bg-white/[0.05]">
        {header}
      </Link>
    );
  }

  // Duplicate so the -50% loop is seamless (only needed while animating).
  const strip = enabled ? [...apps, ...apps] : apps;

  return (
    <Link to="/apps" className="card group relative block overflow-hidden border border-line bg-white/[0.03] p-0 transition hover:bg-white/[0.05]">
      {/* Extra parallax wall of app icons behind everything (full pref only). */}
      <MarqueeFX variant="parallax" art="icon" games={appGames} opacity={0.14} />

      <div className="relative z-10">
        {header}
        <div className="relative mt-2.5 overflow-hidden pb-3" style={{ maskImage: VIGNETTE, WebkitMaskImage: VIGNETTE }}>
          <div
            className="flex w-max items-center gap-2.5 px-4"
            style={enabled ? { animation: "gt-marquee 38s linear infinite", willChange: "transform" } : undefined}
          >
            {strip.map((a, i) => (
              <div key={`${a.id}-${i}`} className="flex shrink-0 items-center gap-2 rounded-xl border border-line bg-bg-900/60 px-2.5 py-1.5">
                <GameArt id={a.id} name={a.name} cover={a.coverPath} icon={a.iconPath} accent={a.accentColor} className="h-7 w-7 shrink-0" rounded="rounded-lg" />
                <div className="min-w-0">
                  <div className="max-w-[140px] truncate text-xs font-700 text-ink-soft">{a.name}</div>
                  <div className="text-[10px] tabular-nums text-ink-faint">{dur(a.runtimeSeconds)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Link>
  );
}
