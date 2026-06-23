import { useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useLocation, useOutlet } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { useMotionEnabled } from "@/store/app";

/**
 * Route transitions — each incoming screen is **masked in** with a `clip-path`
 * reveal, cycling through several designs so navigation feels fresh every time
 * (iris, diagonal tear, barn-door, blinds, top-down). The toned-down WebGL
 * `PageTransitionFX` overlay rides on top as a synced energy accent.
 *
 * Safety (carried over from the v1 "stuck invisible page" bug):
 *  - the reveal always animates **to a fully-revealing clip** (`inset(0)` /
 *    `circle(150%)`), so a page can never settle hidden;
 *  - exit is transform-only (no opacity), over an opaque full-bleed background;
 *  - `useOutlet` keyed by pathname with `mode="wait"` (one page at a time);
 *  - reduced-motion renders the outlet directly with zero animation surface.
 */

// Every reveal ends fully open. `initial` is the closed mask; `animate` opens it.
const REVEALS: { initial: { clipPath: string }; animate: { clipPath: string } }[] = [
  // Iris — circle grows from the centre.
  { initial: { clipPath: "circle(0% at 50% 50%)" }, animate: { clipPath: "circle(150% at 50% 50%)" } },
  // Diagonal tear sweeping left → right.
  {
    initial: { clipPath: "polygon(0% 0%, 0% 0%, -40% 100%, -40% 100%)" },
    animate: { clipPath: "polygon(0% 0%, 140% 0%, 100% 100%, -40% 100%)" },
  },
  // Barn-door — opens outward from a centre vertical seam.
  { initial: { clipPath: "inset(0% 50% 0% 50%)" }, animate: { clipPath: "inset(0% 0% 0% 0%)" } },
  // Blinds — opens outward from a centre horizontal seam.
  { initial: { clipPath: "inset(50% 0% 50% 0%)" }, animate: { clipPath: "inset(0% 0% 0% 0%)" } },
  // Top-down wipe.
  { initial: { clipPath: "inset(0% 0% 100% 0%)" }, animate: { clipPath: "inset(0% 0% 0% 0%)" } },
];

export function AnimatedOutlet() {
  const location = useLocation();
  const element = useOutlet();
  const enabled = useMotionEnabled();

  // Advance the reveal design on each real path change (stable across re-renders).
  const idxRef = useRef(0);
  const lastPathRef = useRef(location.pathname);
  if (lastPathRef.current !== location.pathname) {
    lastPathRef.current = location.pathname;
    idxRef.current = (idxRef.current + 1) % REVEALS.length;
  }
  const reveal = REVEALS[idxRef.current];

  if (!enabled) {
    return (
      <div className="absolute inset-0 flex h-full w-full flex-col overflow-hidden bg-bg-base">
        <ErrorBoundary resetKey={location.pathname}>{element}</ErrorBoundary>
      </div>
    );
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      {element && (
        <motion.div
          key={location.pathname}
          className="absolute inset-0 flex h-full w-full flex-col overflow-hidden bg-bg-base [will-change:clip-path,transform]"
          initial={{ ...reveal.initial, y: 10 }}
          animate={{
            ...reveal.animate,
            y: 0,
            transition: { duration: 0.62, ease: [0.22, 1, 0.36, 1] },
          }}
          exit={{ y: -12, scale: 0.99, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
        >
          <ErrorBoundary resetKey={location.pathname}>{element}</ErrorBoundary>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
