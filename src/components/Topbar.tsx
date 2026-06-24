import { ReactNode } from "react";
import { motion } from "motion/react";
import { Pause, Play } from "lucide-react";
import { api } from "@/lib/api";
import { useApp, useMotionEnabled } from "@/store/app";
import { useSettings } from "@/lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/cn";
import { topbarTitle } from "@/lib/motion";

export function Topbar({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  // Only the paused flag is needed here; subscribing to the whole tracking
  // object would re-render the always-mounted Topbar every 2s for nothing.
  const trackingPaused = useApp((s) => s.tracking?.paused ?? false);
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const paused = settings?.tracking_paused === "true" || trackingPaused;
  const motionOn = useMotionEnabled();

  const togglePause = async () => {
    await api.setPaused(!paused);
    qc.invalidateQueries({ queryKey: ["settings"] });
  };

  return (
    <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-line bg-bg-base/85 px-6 py-4 backdrop-blur-xl lg:px-8 2xl:px-12">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent opacity-60" />
      <motion.div
        className="min-w-0"
        variants={topbarTitle}
        initial={motionOn ? "hidden" : false}
        animate={motionOn ? "show" : undefined}
        key={title}
      >
        {title && (
          <h1 className="truncate font-display text-[22px] font-800 tracking-tight text-ink">{title}</h1>
        )}
        {subtitle && <p className="truncate text-[13px] text-ink-dim">{subtitle}</p>}
      </motion.div>
      <div className="flex items-center gap-2.5">
        {actions}
        <motion.button
          onClick={togglePause}
          className={cn(
            "btn btn-ghost h-10 transition-shadow duration-200",
            paused && "border-amber/40 text-amber hover:text-amber"
          )}
          title={paused ? "Resume tracking" : "Pause tracking"}
          whileHover={motionOn ? { scale: 1.03, boxShadow: "0 0 20px -4px color-mix(in srgb, var(--accent-1) 45%, transparent)" } : undefined}
          whileTap={motionOn ? { scale: 0.97 } : undefined}
        >
          {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          {paused ? "Resume" : "Pause"}
        </motion.button>
      </div>
    </header>
  );
}
