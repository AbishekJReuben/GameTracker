import { AnimatePresence, motion } from "motion/react";
import { useLocation, useOutlet } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { useMotionEnabled } from "@/store/app";

/**
 * Route transitions — deliberately **transform-only, never opacity**.
 *
 * v1 shipped a bug where pages got stuck at opacity 0 (invisible). The fix kept here:
 *  - no opacity on enter/exit (only translate), so a page can never be left invisible
 *  - `useOutlet` (not <Outlet/>), keyed by pathname, `mode="wait"` (one page at a time)
 *  - opaque full-bleed background so the exiting page never bleeds through
 *  - when motion is disabled, render the outlet directly (zero animation surface)
 */
export function AnimatedOutlet() {
  const location = useLocation();
  const element = useOutlet();
  const enabled = useMotionEnabled();

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
          className="absolute inset-0 flex h-full w-full flex-col overflow-hidden bg-bg-base"
          initial={{ y: 12 }}
          animate={{ y: 0 }}
          exit={{ y: -10 }}
          transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
        >
          <ErrorBoundary resetKey={location.pathname}>{element}</ErrorBoundary>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
