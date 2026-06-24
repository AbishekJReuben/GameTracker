import { motion } from "motion/react";
import { Loader2 } from "lucide-react";
import { ReactNode, useId } from "react";
import { cn } from "@/lib/cn";

export function Card({
  className,
  children,
  ...rest
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("card p-5", className)} {...rest}>
      {children}
    </div>
  );
}

/** Glass panel with an animated gradient hairline frame + corner ticks. */
export function HudPanel({
  className,
  children,
  glow = false,
  ...rest
}: { className?: string; children: ReactNode; glow?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("hud-panel p-5", glow && "shadow-glow", className)} {...rest}>
      <Corner className="left-2 top-2" />
      <Corner className="right-2 top-2 rotate-90" />
      <Corner className="bottom-2 left-2 -rotate-90" />
      <Corner className="bottom-2 right-2 rotate-180" />
      {children}
    </div>
  );
}

function Corner({ className }: { className?: string }) {
  return (
    <span
      className={cn("pointer-events-none absolute h-3 w-3 opacity-50", className)}
      style={{
        borderTop: "1.5px solid color-mix(in srgb, var(--accent-1) 70%, transparent)",
        borderLeft: "1.5px solid color-mix(in srgb, var(--accent-1) 70%, transparent)",
      }}
    />
  );
}

export function SectionTitle({
  title,
  subtitle,
  right,
  sheen = false,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  /** Subtle scan/sheen across the title bar — use on dashboard hero sections. */
  sheen?: boolean;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="relative flex items-center gap-2 overflow-hidden font-display text-lg font-700 tracking-tight text-ink">
          <motion.span
            className="h-3.5 w-1 shrink-0 rounded-full bg-accent-sheen"
            initial={sheen ? { scaleY: 0 } : false}
            animate={{ scaleY: 1 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          />
          <span className="relative truncate">{title}</span>
          {sheen && (
            <motion.span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-4 right-0 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent"
              initial={{ x: "-100%" }}
              animate={{ x: "200%" }}
              transition={{ duration: 2.8, repeat: Infinity, repeatDelay: 3.2, ease: "easeInOut" }}
            />
          )}
        </h2>
        {subtitle && <p className="mt-0.5 text-sm text-ink-dim">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function Badge({
  children,
  color = "rgba(255,255,255,0.5)",
  className,
}: {
  children: ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <span
      className={cn("pill", className)}
      style={{
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        color: `color-mix(in srgb, ${color} 85%, white)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

const STATUS_COLORS: Record<string, string> = {
  playing: "#34d399",
  completed: "#7c5cff",
  backlog: "#3b82f6",
  dropped: "#f472b6",
  on_hold: "#f59e0b",
  watched: "#22d3ee",
};

const STATUS_LABELS: Record<string, string> = {
  on_hold: "On Hold",
  watched: "Watched",
};

export function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "#94a3b8";
  return (
    <Badge color={color} className="capitalize">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      {statusLabel(status)}
    </Badge>
  );
}

export function statusColor(status: string) {
  return STATUS_COLORS[status] ?? "#94a3b8";
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin text-ink-dim", className)} />;
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  size?: "sm" | "md";
}) {
  const id = useId();
  return (
    <div className="inline-flex rounded-xl border border-line bg-bg-900/60 p-1 backdrop-blur">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative rounded-lg font-700 transition",
              size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs",
              active ? "text-white" : "text-ink-dim hover:text-ink"
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-lg bg-accent-sheen opacity-90 shadow-[0_4px_18px_-6px_var(--accent-1)]"
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
              />
            )}
            <span className="relative z-10">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-center gap-3 text-sm text-ink-soft">
      <span
        className={cn(
          "relative h-6 w-11 rounded-full border transition-colors",
          checked ? "border-transparent" : "border-line bg-white/10"
        )}
        style={checked ? { backgroundImage: "linear-gradient(120deg,var(--accent-1),var(--accent-3))" } : undefined}
      >
        <motion.span
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow"
          animate={{ left: checked ? 22 : 2 }}
          transition={{ type: "spring", stiffness: 500, damping: 34 }}
        />
      </span>
      {label && <span>{label}</span>}
    </button>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line px-6 py-16 text-center">
      {icon && (
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-white/[0.04] text-accent-3">
          {icon}
        </div>
      )}
      <h3 className="font-display text-base font-700 text-ink">{title}</h3>
      {message && <p className="mt-1 max-w-sm text-sm text-ink-dim">{message}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-xl bg-white/[0.04]", className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/[0.07] to-transparent" />
    </div>
  );
}
