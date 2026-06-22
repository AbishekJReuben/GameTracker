import { useMemo } from "react";
import { motion } from "motion/react";
import { useMotionEnabled } from "@/store/app";

type Particle = {
  id: number;
  x: number;
  y: number;
  size: number;
  dur: number;
  delay: number;
  opacity: number;
};

function seed(count: number): Particle[] {
  return Array.from({ length: count }, (_, id) => ({
    id,
    x: ((id * 47) % 100) + (id % 3) * 0.7,
    y: ((id * 83) % 100) + (id % 5) * 0.4,
    size: 1 + (id % 3),
    dur: 8 + (id % 7) * 2,
    delay: (id % 9) * 0.6,
    opacity: 0.12 + (id % 4) * 0.06,
  }));
}

/** Lightweight CSS-driven floating specks — no canvas. */
export function FloatingParticles({ count = 18 }: { count?: number }) {
  const animate = useMotionEnabled();
  const particles = useMemo(() => seed(count), [count]);

  if (!animate) return null;

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      {particles.map((p) => (
        <motion.span
          key={p.id}
          className="absolute rounded-full bg-accent-3"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.size,
            height: p.size,
            opacity: p.opacity,
            boxShadow: `0 0 ${p.size * 4}px color-mix(in srgb, var(--accent-3) 55%, transparent)`,
          }}
          animate={{
            y: [0, -18, 6, 0],
            x: [0, 6, -4, 0],
            opacity: [p.opacity, p.opacity * 1.6, p.opacity * 0.7, p.opacity],
          }}
          transition={{
            duration: p.dur,
            repeat: Infinity,
            ease: "easeInOut",
            delay: p.delay,
          }}
        />
      ))}
    </div>
  );
}
