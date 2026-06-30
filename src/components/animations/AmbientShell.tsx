import { motion } from "motion/react";
import { useApp, useMotionEnabled, useReduceEffects } from "@/store/app";
import { useDocumentVisible } from "@/lib/useVisible";
import { FloatingParticles } from "./FloatingParticles";

/** Full-bleed living backdrop: orbs, grid, noise, particles, vignette, optional scanlines. */
export function AmbientShell() {
  const reduce = useReduceEffects();
  const visible = useDocumentVisible();
  const fx = useApp((s) => s.prefs.background) && !reduce;
  const scan = useApp((s) => s.prefs.scanlines) && !reduce;
  // Pause drift when the window is hidden — animating blurred orbs behind blurred
  // panels is the main background-jank source, and it's wasted while backgrounded.
  const animate = useMotionEnabled() && !reduce && visible;

  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-radial-fade" />
      <div className="absolute inset-0 bg-ambient-mesh opacity-80" />

      {fx && (
        <>
          <Orb
            className="-left-40 top-[-12%] h-[460px] w-[460px]"
            color="var(--accent-1)"
            animate={animate}
            drift={[0, 40, -20, 0]}
            driftY={[0, 30, 10, 0]}
            dur={18}
          />
          <Orb
            className="right-[-12%] top-[14%] h-[420px] w-[420px]"
            color="var(--accent-3)"
            animate={animate}
            drift={[0, -30, 20, 0]}
            driftY={[0, 24, -16, 0]}
            dur={22}
          />
          <Orb
            className="bottom-[-18%] left-[30%] h-[420px] w-[420px]"
            color="var(--accent-2)"
            animate={animate}
            drift={[0, 24, -24, 0]}
            driftY={[0, -20, 16, 0]}
            dur={26}
          />
          <FloatingParticles count={20} />
        </>
      )}

      <div className="absolute inset-0 bg-grid-faint opacity-40 [background-size:46px_46px]" />
      <div className="absolute inset-0 bg-noise opacity-[0.035]" />
      {scan && (
        <div className="absolute inset-0 scanlines opacity-[0.28]">
          <div className="absolute inset-0 animate-scan bg-gradient-to-b from-transparent via-white/[0.04] to-transparent opacity-60" />
        </div>
      )}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_52%,rgba(0,0,0,0.58))]" />
    </div>
  );
}

function Orb({
  className,
  color,
  animate,
  drift,
  driftY,
  dur,
}: {
  className: string;
  color: string;
  animate: boolean;
  drift: number[];
  driftY: number[];
  dur: number;
}) {
  return (
    <motion.div
      className={`absolute rounded-full blur-[130px] ${className}`}
      style={{ background: color, opacity: 0.16, willChange: "transform" }}
      // Drift only (translate is GPU-composited). We deliberately avoid animating
      // `scale` here: rescaling a 130px-blurred layer forces a full re-raster of
      // the blur every frame, which was a constant source of background jank.
      animate={animate ? { x: drift, y: driftY } : undefined}
      transition={animate ? { duration: dur, repeat: Infinity, ease: "easeInOut" } : undefined}
    />
  );
}
