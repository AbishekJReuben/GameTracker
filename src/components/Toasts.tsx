import { AnimatePresence, motion } from "motion/react";
import { Play, Square, Info, CheckCircle2, X } from "lucide-react";
import { useApp } from "@/store/app";
import { assetUrl } from "@/lib/api";
import { fadeSlideRight } from "@/lib/motion";

const ICONS = { play: Play, stop: Square, info: Info, success: CheckCircle2 } as const;
const ACCENT = { play: "#34d399", stop: "var(--accent-1)", info: "#3b82f6", success: "#34d399" } as const;

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-[340px] flex-col gap-2.5">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = ICONS[t.kind];
          const color = ACCENT[t.kind];
          const img = assetUrl(t.icon);
          return (
            <motion.div
              key={t.id}
              layout
              variants={fadeSlideRight}
              initial="hidden"
              animate="show"
              exit="exit"
              className="hud-panel shimmer-overlay pointer-events-auto flex items-center gap-3 overflow-hidden p-3 pr-2.5"
            >
              <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]" aria-hidden>
                <span className="absolute inset-y-0 w-2/5 animate-shimmer-sweep bg-gradient-to-r from-transparent via-white/[0.07] to-transparent" />
              </span>
              <motion.div
                className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl"
                style={{ background: `color-mix(in srgb, ${color} 18%, transparent)` }}
                initial={{ scale: 0.85, rotate: -8 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 420, damping: 24 }}
              >
                {img ? <img src={img} alt="" className="h-full w-full object-cover" /> : <Icon className="h-5 w-5" style={{ color }} />}
              </motion.div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-800 text-ink">{t.title}</div>
                {t.message && <div className="truncate text-xs text-ink-dim">{t.message}</div>}
              </div>
              <motion.button
                onClick={() => dismiss(t.id)}
                className="grid h-7 w-7 place-items-center rounded-lg text-ink-dim transition hover:bg-white/5 hover:text-ink"
                whileHover={{ scale: 1.08 }}
                whileTap={{ scale: 0.9 }}
              >
                <X className="h-4 w-4" />
              </motion.button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
