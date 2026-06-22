import { ReactNode } from "react";
import { motion } from "motion/react";
import { AnimatedNumber } from "./AnimatedNumber";
import { useMotionEnabled } from "@/store/app";
import { cn } from "@/lib/cn";

export function StatTile({
  icon,
  label,
  value,
  decimals = 0,
  suffix,
  hint,
  accent = "var(--accent-1)",
  delay = 0,
  children,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  decimals?: number;
  suffix?: string;
  hint?: ReactNode;
  accent?: string;
  delay?: number;
  children?: ReactNode;
}) {
  const enabled = useMotionEnabled();
  return (
    <motion.div
      layout
      initial={enabled ? { opacity: 0, y: 14, scale: 0.97 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      whileHover={enabled ? { y: -4, transition: { type: "spring", stiffness: 400, damping: 22 } } : undefined}
      tabIndex={0}
      className="hud-panel group relative overflow-hidden p-4 outline-none focus-visible:ring-2 focus-visible:ring-accent-1/40"
    >
      {enabled && (
        <motion.div
          className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden
        >
          <motion.div
            className="absolute inset-[-1px] rounded-[inherit]"
            style={{
              background: `linear-gradient(105deg, transparent 30%, color-mix(in srgb, ${accent} 70%, white) 50%, transparent 70%)`,
              backgroundSize: "220% 100%",
            }}
            animate={{ backgroundPosition: ["120% 0%", "-20% 0%"] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "linear", repeatDelay: 0.8 }}
          />
          <div className="absolute inset-[1px] rounded-[inherit] bg-bg-850/95" />
        </motion.div>
      )}

      <div
        className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full opacity-25 blur-2xl transition-opacity group-hover:opacity-50"
        style={{ background: accent }}
      />
      <div className="relative flex items-center gap-2.5">
        <motion.div
          className="grid h-9 w-9 place-items-center rounded-xl"
          style={{
            background: `color-mix(in srgb, ${accent} 16%, transparent)`,
            color: accent,
            boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} 35%, transparent)`,
          }}
          whileHover={enabled ? { scale: 1.12, rotate: -6, y: -1 } : undefined}
          transition={{ type: "spring", stiffness: 480, damping: 14 }}
        >
          {icon}
        </motion.div>
        <span className="text-[11px] font-700 uppercase tracking-[0.14em] text-ink-dim">{label}</span>
      </div>
      <div className="relative mt-3 flex items-end justify-between">
        <div className={cn("font-display text-[28px] font-800 leading-none tabular-nums")}>
          <AnimatedNumber value={value} decimals={decimals} suffix={suffix} />
        </div>
        {children}
      </div>
      {hint && <div className="relative mt-2 text-xs text-ink-dim">{hint}</div>}
    </motion.div>
  );
}
