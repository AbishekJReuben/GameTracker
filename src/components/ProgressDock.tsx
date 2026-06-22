import { useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Loader2, Check, AlertCircle, X } from "lucide-react";
import { useProgress, scheduleDismiss, type ProgressJob } from "@/store/progress";
import { cn } from "@/lib/cn";
import { dockItem } from "@/lib/motion";

function pct(job: ProgressJob) {
  if (job.total <= 0) return job.done > 0 ? 100 : 0;
  return Math.min(100, Math.round((job.done / job.total) * 100));
}

function JobRow({ job }: { job: ProgressJob }) {
  const dismiss = useProgress((s) => s.dismissJob);
  const p = pct(job);
  const done = job.status !== "running";

  useEffect(() => {
    if (done) scheduleDismiss(job.id);
  }, [done, job.id]);

  return (
    <motion.div
      layout
      variants={dockItem}
      initial="hidden"
      animate="show"
      exit="exit"
      className="shimmer-overlay flex items-center gap-3 rounded-xl border border-line bg-bg-850/95 px-3 py-2.5 shadow-float backdrop-blur-md"
    >
      <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl" aria-hidden>
        <span className="absolute inset-y-0 w-1/3 animate-shimmer-sweep bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      </span>
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.04]">
        {job.status === "running" ? (
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        ) : job.status === "done" ? (
          <motion.div initial={{ scale: 0.5 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 500, damping: 22 }}>
            <Check className="h-4 w-4 text-emerald-400" />
          </motion.div>
        ) : (
          <AlertCircle className="h-4 w-4 text-pink-400" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-600 text-ink">{job.label}</p>
          <span className="shrink-0 text-xs tabular-nums text-ink-dim">
            {job.total > 0 ? `${job.done}/${job.total}` : job.done > 0 ? `${job.done}…` : "…"}
            {job.total > 0 ? ` · ${p}%` : ""}
          </span>
        </div>
        {job.detail && <p className="truncate text-xs text-ink-faint">{job.detail}</p>}
        {job.error && <p className="truncate text-xs text-pink-300">{job.error}</p>}
        <div className="relative mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <motion.div
            className={cn("relative h-full rounded-full", job.status === "error" ? "bg-pink-400" : "bg-accent-sheen")}
            initial={{ width: 0 }}
            animate={{ width: `${job.status === "done" ? 100 : p}%` }}
            transition={{ type: "spring", stiffness: 120, damping: 20 }}
          />
          {job.status === "running" && (
            <span className="pointer-events-none absolute inset-0 animate-shimmer-sweep bg-gradient-to-r from-transparent via-white/25 to-transparent" />
          )}
        </div>
      </div>
      {done && (
        <motion.button
          onClick={() => dismiss(job.id)}
          className="btn btn-ghost h-7 w-7 shrink-0 p-0"
          aria-label="Dismiss"
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
        >
          <X className="h-3.5 w-3.5" />
        </motion.button>
      )}
    </motion.div>
  );
}

/** Persistent progress dock — survives route changes. */
export function ProgressDock() {
  const jobs = useProgress((s) => s.jobs);
  const visible = jobs.filter((j) => j.status === "running" || j.status === "done" || j.status === "error");
  if (visible.length === 0) return null;

  return (
    <motion.div
      className="pointer-events-none fixed bottom-4 right-4 z-[90] flex w-[min(100vw-2rem,22rem)] flex-col gap-2"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 280, damping: 26 }}
    >
      <AnimatePresence mode="popLayout">
        {visible.map((job) => (
          <div key={job.id} className="pointer-events-auto">
            <JobRow job={job} />
          </div>
        ))}
      </AnimatePresence>
    </motion.div>
  );
}
