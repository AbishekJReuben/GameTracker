import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { RadarIcon, Check, Loader2 } from "lucide-react";
import { Candidate, api } from "@/lib/api";
import { Modal } from "./Modal";
import { EmptyState } from "./ui";
import { useApp, useMotionEnabled } from "@/store/app";
import { useRefreshAll } from "@/lib/queries";
import { fadeSlide, makeStaggerContainer, staggerTransition } from "@/lib/motion";

export function DetectModal({
  open,
  onClose,
  mode = "game",
}: {
  open: boolean;
  onClose: () => void;
  mode?: "game" | "app";
}) {
  const isApp = mode === "app";
  const noun = isApp ? "app" : "game";
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const pushToast = useApp((s) => s.pushToast);
  const refresh = useRefreshAll();
  const enabled = useMotionEnabled();

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setPicked(new Set());
    (isApp ? api.detectApps() : api.detectGames())
      .then((c) => {
        setCandidates(c);
        setPicked(new Set(c.map((_, i) => i)));
      })
      .finally(() => setLoading(false));
  }, [open, isApp]);

  const toggle = (i: number) =>
    setPicked((s) => {
      const next = new Set(s);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  const addSelected = async () => {
    setSaving(true);
    try {
      const chosen = candidates.filter((_, i) => picked.has(i));
      const added = isApp ? await api.importDetectedApps(chosen) : await api.importDetected(chosen);
      refresh();
      pushToast({
        kind: "success",
        title: `Added ${added} ${noun}${added === 1 ? "" : "s"}`,
        message: "Ready to track",
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isApp ? "Detect running apps" : "Scan for games"} className="max-w-xl">
      <div className="p-5">
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-3 py-12 text-ink-dim"
            >
              <motion.div
                animate={enabled ? { rotate: 360 } : undefined}
                transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
              >
                <Loader2 className="h-6 w-6" />
              </motion.div>
              <p className="text-sm">
                {isApp
                  ? "Looking for running applications…"
                  : "Scanning Steam, launchers and running games…"}
              </p>
            </motion.div>
          ) : candidates.length === 0 ? (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <EmptyState
                icon={<RadarIcon className="h-6 w-6" />}
                title={isApp ? "No new apps found" : "No new games found"}
                message={
                  isApp
                    ? "We looked at your open application windows — nothing new to add. Open an app you want to track, then scan again."
                    : "We scanned your Steam libraries, Epic/GOG folders and running processes — nothing new to add."
                }
              />
            </motion.div>
          ) : (
            <motion.div key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <p className="mb-3 text-sm text-ink-dim">
                Found {candidates.length} {noun}
                {candidates.length === 1 ? "" : "s"} not in your library. Pick the ones to track.
              </p>
              <motion.div
                className="max-h-[46vh] space-y-1.5 overflow-y-auto pr-1"
                variants={enabled ? makeStaggerContainer(0.04) : undefined}
                initial={enabled ? "hidden" : false}
                animate="show"
              >
                {candidates.map((c, i) => {
                  const on = picked.has(i);
                  return (
                    <motion.button
                      key={`${c.name}-${i}`}
                      custom={i}
                      variants={enabled ? fadeSlide : undefined}
                      initial={enabled ? "hidden" : false}
                      animate="show"
                      transition={staggerTransition(i, 0.035, 0.45)}
                      whileTap={enabled ? { scale: 0.98 } : undefined}
                      onClick={() => toggle(i)}
                      className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                        on ? "border-accent/50 bg-[color-mix(in_srgb,var(--accent-1)_8%,transparent)]" : "border-line bg-white/[0.02] hover:bg-white/[0.04]"
                      }`}
                    >
                      <motion.span
                        className={`grid h-5 w-5 place-items-center rounded-md border ${
                          on ? "border-transparent bg-accent text-white" : "border-line"
                        }`}
                        animate={on && enabled ? { scale: [1, 1.15, 1] } : { scale: 1 }}
                        transition={{ duration: 0.25 }}
                      >
                        <AnimatePresence>
                          {on && (
                            <motion.span
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                            >
                              <Check className="h-3.5 w-3.5" />
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </motion.span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-700">{c.name}</div>
                        <div className="truncate text-[11px] text-ink-faint">{c.installFolder ?? c.exePath}</div>
                      </div>
                      <span className="pill bg-white/[0.05] text-ink-dim">{c.source}</span>
                    </motion.button>
                  );
                })}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
        <button onClick={onClose} className="btn btn-ghost">
          Cancel
        </button>
        <motion.button
          onClick={addSelected}
          disabled={saving || picked.size === 0}
          className="btn btn-primary"
          whileTap={enabled ? { scale: 0.97 } : undefined}
        >
          {saving ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Adding…
            </span>
          ) : (
            <>Add {picked.size} {noun}{picked.size === 1 ? "" : "s"}</>
          )}
        </motion.button>
      </div>
    </Modal>
  );
}
