import { NavLink, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { LayoutDashboard, Library, CalendarRange, Trophy, Settings, Gamepad2, Tag, Compass, AppWindow, Cpu, Headphones, Smartphone } from "lucide-react";
import { cn } from "@/lib/cn";
import { useRemoteOnly } from "@/lib/queries";
import { routeAllowed } from "@/lib/setupMode";
import { useApp, useMotionEnabled } from "@/store/app";
import { dur } from "@/lib/format";
import { springNav } from "@/lib/motion";
import { LottieIdle } from "@/components/animations";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/library", label: "Library", icon: Library, matchGame: true },
  { to: "/apps", label: "Apps", icon: AppWindow },
  { to: "/system", label: "System", icon: Cpu },
  { to: "/timeline", label: "Timeline", icon: CalendarRange },
  { to: "/music", label: "Music", icon: Headphones },
  { to: "/remote", label: "Remote", icon: Smartphone },
  { to: "/collection", label: "Collection", icon: Trophy },
  { to: "/suggested", label: "Suggested", icon: Compass },
  { to: "/tags", label: "Tags", icon: Tag },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const location = useLocation();
  const tracking = useApp((s) => s.tracking);
  const live = tracking?.isPlaying && !tracking?.paused;
  const motionOn = useMotionEnabled();
  const showSuggested = useApp((s) => s.prefs.showSuggested);
  // Remote-only mode strips nav down to Remote + Settings; otherwise the only
  // gated item is Suggested, which is opt-in (default off).
  const remoteOnly = useRemoteOnly();
  const nav = NAV.filter((item) =>
    remoteOnly ? routeAllowed(item.to, true) : item.to !== "/suggested" || showSuggested
  );

  return (
    <aside className="z-10 flex w-[244px] shrink-0 flex-col gap-2 border-r border-line bg-bg-900/50 px-3 pb-4 pt-2 backdrop-blur-xl">
      <div className="mb-3 flex items-center gap-2.5 px-2 pt-1">
        <div className="relative grid h-10 w-10 place-items-center rounded-xl bg-accent-sheen shadow-glow">
          <Gamepad2 className="relative z-10 h-5 w-5 text-white" />
          <LottieIdle
            src="/lottie/idle-sparkle.json"
            className="absolute -inset-2 h-14 w-14"
            opacity={0.45}
            speed={0.65}
          />
          {motionOn && (
            <span className="pointer-events-none absolute inset-0 rounded-xl animate-glow-pulse bg-accent-sheen opacity-30" />
          )}
          <span className="absolute inset-0 rounded-xl ring-1 ring-inset ring-white/20" />
        </div>
        <div className="leading-tight">
          <div className="font-display text-[18px] font-800 tracking-tight accent-text">Tracker</div>
          <div className="text-[10px] font-700 uppercase tracking-[0.22em] text-ink-dim">
            {remoteOnly ? "remote control" : "play & app analytics"}
          </div>
        </div>
      </div>

      <nav className="flex flex-col gap-1">
        {nav.map((item) => {
          const active = item.end
            ? location.pathname === item.to
            : item.matchGame
              ? location.pathname.startsWith(item.to) || location.pathname.startsWith("/game/")
              : location.pathname.startsWith(item.to);
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={cn(
                "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-700 transition-colors duration-200",
                active ? "text-white" : "text-ink-dim hover:text-ink"
              )}
            >
              {active && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute inset-0 rounded-xl border border-line bg-white/[0.06] nav-glow"
                  transition={springNav}
                />
              )}
              {active && (
                <motion.span
                  layoutId="nav-bar"
                  className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-accent-sheen"
                  transition={springNav}
                  style={{ boxShadow: "0 0 14px var(--accent-1)" }}
                />
              )}
              <motion.span
                className="relative z-10 grid place-items-center"
                animate={
                  motionOn && active
                    ? { scale: [1, 1.08, 1], rotate: [0, -4, 4, 0] }
                    : undefined
                }
                transition={
                  motionOn && active
                    ? { duration: 4.5, repeat: Infinity, ease: "easeInOut" }
                    : undefined
                }
                whileHover={motionOn ? { scale: 1.12 } : undefined}
              >
                <item.icon
                  className={cn(
                    "h-[18px] w-[18px] transition-colors duration-200",
                    active ? "text-accent-3" : "text-ink-dim group-hover:text-ink-soft"
                  )}
                />
              </motion.span>
              <span className="relative z-10">{item.label}</span>
              {!active && (
                <span className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-hover:nav-glow" />
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* The live-tracking HUD is a tracker surface — remote-only mode hides it
          along with the tabs it summarizes. */}
      <div className={cn("mt-auto", remoteOnly && "hidden")}>
        <div className="hud-panel p-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              {live && <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-green/70" />}
              <span
                className={cn(
                  "relative inline-flex h-2.5 w-2.5 rounded-full",
                  live ? "bg-green" : tracking?.paused ? "bg-amber" : "bg-ink-faint"
                )}
                style={live ? { boxShadow: "0 0 10px #34d399" } : undefined}
              />
            </span>
            <span className="text-[11px] font-800 uppercase tracking-wider text-ink-soft">
              {tracking?.paused ? "Paused" : live ? "Tracking" : "Idle"}
            </span>
          </div>
          <div className="mt-1.5 truncate text-[13px] font-700 text-ink">
            {live ? tracking?.gameName : "Nothing playing"}
          </div>
          <div className="text-[11px] text-ink-dim">{dur(tracking?.todayActiveSeconds ?? 0)} active today</div>
        </div>
      </div>
    </aside>
  );
}
