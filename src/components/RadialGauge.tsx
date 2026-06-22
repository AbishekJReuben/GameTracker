import { motion } from "motion/react";
import { ReactNode, useId } from "react";
import { useMotionEnabled } from "@/store/app";

/** Circular progress meter (game HUD style) with an animated sweep + glow. */
export function RadialGauge({
  value,
  max = 100,
  size = 120,
  thickness = 10,
  from = "var(--accent-1)",
  to = "var(--accent-3)",
  label,
  sublabel,
  children,
}: {
  value: number;
  max?: number;
  size?: number;
  thickness?: number;
  from?: string;
  to?: string;
  label?: ReactNode;
  sublabel?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId().replace(/:/g, "");
  const enabled = useMotionEnabled();
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, max ? value / max : 0));
  const offset = c * (1 - pct);

  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id={`g-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={thickness} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#g-${id})`}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: enabled ? c : offset }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
          style={{ filter: `drop-shadow(0 0 6px color-mix(in srgb, ${from} 60%, transparent))` }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        {children ?? (
          <div>
            {label && <div className="font-display text-2xl font-800 tabular-nums leading-none">{label}</div>}
            {sublabel && <div className="mt-1 text-[10px] uppercase tracking-wider text-ink-dim">{sublabel}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Segmented XP / progress bar. */
export function LevelBar({
  value,
  max = 100,
  className,
  color = "var(--accent-1)",
  delay = 0,
}: {
  value: number;
  max?: number;
  className?: string;
  color?: string;
  delay?: number;
}) {
  const pct = Math.max(0, Math.min(100, max ? (value / max) * 100 : 0));
  return (
    <div className={`relative h-2 overflow-hidden rounded-full bg-white/[0.06] ${className ?? ""}`}>
      <motion.div
        className="h-full rounded-full"
        style={{
          background: `linear-gradient(90deg, color-mix(in srgb, ${color} 70%, #0b0d16), ${color})`,
          boxShadow: `0 0 12px -2px ${color}`,
        }}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.8, delay, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  );
}
