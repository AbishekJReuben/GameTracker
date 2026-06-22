import { motion } from "motion/react";
import { useApp, useMotionEnabled } from "@/store/app";

/** Full-bleed living backdrop: drifting accent orbs, grid, vignette, scanlines. */
export function AnimatedBackground() {
  const fx = useApp((s) => s.prefs.background);
  const scan = useApp((s) => s.prefs.scanlines);
  const animate = useMotionEnabled();

  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-radial-fade" />
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
        </>
      )}
      <div className="absolute inset-0 bg-grid-faint opacity-40 [background-size:46px_46px]" />
      {scan && <div className="absolute inset-0 scanlines opacity-[0.35]" />}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,0.55))]" />
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
      style={{ background: color, opacity: 0.16 }}
      animate={animate ? { x: drift, y: driftY } : undefined}
      transition={animate ? { duration: dur, repeat: Infinity, ease: "easeInOut" } : undefined}
    />
  );
}
