import { ReactNode } from "react";
import { motion } from "motion/react";
import { useMotionEnabled } from "@/store/app";

/**
 * Deterministic entrance animation that ALWAYS resolves to a visible element.
 *
 * Anti-bug guarantees (the v1 "stuck at opacity 0" regression):
 *  - never uses `whileInView` (IntersectionObserver-in-scroll-container is the classic culprit)
 *  - `initial`+`animate` are paired and fire on mount, so opacity always reaches 1
 *  - when the user disables motion, we render a plain div at full opacity (no motion at all)
 */
export function Reveal({
  children,
  className,
  y = 12,
  x = 0,
  scale = 1,
  delay = 0,
  duration = 0.45,
}: {
  children: ReactNode;
  className?: string;
  y?: number;
  x?: number;
  scale?: number;
  delay?: number;
  duration?: number;
}) {
  const enabled = useMotionEnabled();

  if (!enabled) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, x, y, scale }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      transition={{ duration, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
