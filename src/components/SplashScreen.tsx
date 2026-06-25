import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Gamepad2 } from "lucide-react";
import { MarqueeShader } from "./animations/MarqueeShader";
import { useMotionEnabled } from "@/store/app";

/**
 * A premium launch splash: a glowing app mark, the product name, and a thin
 * progress shimmer, shown for a couple of seconds the first time the app mounts
 * — then it fades up and out to reveal the main UI underneath. Shows only once
 * per app launch (a module flag survives route changes but not a reload).
 */
let splashShown = false;

const HOLD_MS = 2200;

export function SplashScreen() {
  const enabled = useMotionEnabled();
  const [visible, setVisible] = useState(!splashShown);

  useEffect(() => {
    if (splashShown) return;
    splashShown = true;
    const t = setTimeout(() => setVisible(false), HOLD_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="splash"
          className="fixed inset-0 z-[200] grid place-items-center overflow-hidden bg-bg-base"
          initial={false}
          exit={enabled ? { opacity: 0, scale: 1.04, filter: "blur(8px)" } : { opacity: 0 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Ambient gradient wash + drifting glow blobs */}
          <div className="pointer-events-none absolute inset-0 opacity-80">
            <div
              className="absolute -left-1/4 top-1/4 h-[60vh] w-[60vh] rounded-full opacity-40 blur-[120px]"
              style={{ background: "radial-gradient(closest-side, var(--accent-1), transparent)" }}
            />
            <div
              className="absolute -right-1/4 bottom-1/4 h-[55vh] w-[55vh] rounded-full opacity-35 blur-[120px]"
              style={{ background: "radial-gradient(closest-side, var(--accent-3), transparent)" }}
            />
          </div>
          {/* Procedural aurora light shader — the launch's signature flourish. */}
          <MarqueeShader kind="aurora" className="opacity-70" />
          <div className="pointer-events-none absolute inset-0 bg-grid-faint opacity-[0.06] [background-size:34px_34px]" />

          <div className="relative flex flex-col items-center gap-6">
            {/* Mark */}
            <motion.div
              className="relative grid h-24 w-24 place-items-center rounded-[28px] border border-white/10 bg-accent-sheen shadow-glow"
              initial={enabled ? { scale: 0.7, opacity: 0, rotate: -8 } : false}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 220, damping: 18 }}
            >
              <motion.span
                className="absolute inset-0 rounded-[28px]"
                style={{ boxShadow: "0 0 60px -10px var(--accent-2)" }}
                animate={enabled ? { opacity: [0.4, 0.9, 0.4] } : undefined}
                transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
              />
              <Gamepad2 className="h-12 w-12 text-white drop-shadow" />
            </motion.div>

            {/* Wordmark */}
            <motion.div
              className="text-center"
              initial={enabled ? { opacity: 0, y: 12 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.18, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            >
              <h1 className="font-display text-3xl font-900 tracking-tight text-ink glow-text">
                Game<span className="accent-text">Tracker</span>
              </h1>
              <p className="mt-1.5 text-[11px] font-700 uppercase tracking-[0.32em] text-ink-dim">
                Your play, beautifully tracked
              </p>
            </motion.div>

            {/* Progress shimmer */}
            <div className="relative h-1 w-40 overflow-hidden rounded-full bg-white/[0.06]">
              <motion.div
                className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-accent-sheen"
                initial={{ x: "-120%" }}
                animate={enabled ? { x: ["-120%", "240%"] } : { x: "60%" }}
                transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
