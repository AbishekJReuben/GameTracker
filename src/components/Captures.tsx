import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, ChevronLeft, ChevronRight, Trash2, Camera } from "lucide-react";
import { api, assetUrl, Screenshot } from "@/lib/api";
import { keys } from "@/lib/queries";
import { dateLabel, timeLabel } from "@/lib/format";
import { useApp, useMotionEnabled } from "@/store/app";

/**
 * Grid of auto-captured in-game screenshots (newest first) with a lightbox,
 * per-shot capture time, and delete. Kept separate from curated Steam media.
 */
export function Captures({ shots, gameId, name }: { shots: Screenshot[]; gameId: string; name: string }) {
  const enabled = useMotionEnabled();
  const use24 = useApp((s) => s.prefs.timeFormat === "24h");
  const pushToast = useApp((s) => s.pushToast);
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);

  const del = useMutation({
    mutationFn: (id: string) => api.deleteScreenshot(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.screenshots(gameId) }),
    onError: (e) => pushToast({ kind: "info", title: "Couldn't delete screenshot", message: String(e) }),
  });

  const close = useCallback(() => setOpen(null), []);
  const step = useCallback(
    (dir: number) => setOpen((i) => (i === null ? i : (i + dir + shots.length) % shots.length)),
    [shots.length]
  );

  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, step]);

  if (shots.length === 0) return null;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
        {shots.map((shot, i) => {
          const src = assetUrl(shot.path);
          if (!src) return null;
          return (
            <motion.div
              key={shot.id}
              className="group relative aspect-video overflow-hidden rounded-xl border border-line bg-bg-900/60"
              initial={enabled ? { opacity: 0, y: 12 } : false}
              whileInView={enabled ? { opacity: 1, y: 0 } : undefined}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ delay: Math.min(i * 0.03, 0.3), duration: 0.4 }}
            >
              <button onClick={() => setOpen(i)} className="block h-full w-full">
                <img
                  src={src}
                  alt={`${name} capture ${i + 1}`}
                  className="h-full w-full object-cover transition duration-300 group-hover:brightness-110"
                  draggable={false}
                />
              </button>
              <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-6 text-[10px] font-700 text-white/90">
                {dateLabel(shot.capturedUtc)} · {timeLabel(shot.capturedUtc, use24)}
              </span>
              <button
                onClick={() => del.mutate(shot.id)}
                disabled={del.isPending}
                title="Delete screenshot"
                className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-lg bg-black/55 text-white/85 opacity-0 backdrop-blur transition hover:bg-rose-500/80 hover:text-white group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/10 transition group-hover:ring-white/25" />
            </motion.div>
          );
        })}
      </div>

      {createPortal(
        <AnimatePresence>
          {open !== null && shots[open] && (
            <motion.div
              className="fixed inset-0 z-[200] grid place-items-center bg-black/85 backdrop-blur-md"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={close}
            >
              <button onClick={close} className="absolute right-5 top-5 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20">
                <X className="h-5 w-5" />
              </button>
              {shots.length > 1 && (
                <>
                  <button onClick={(e) => { e.stopPropagation(); step(-1); }} className="absolute left-4 grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20">
                    <ChevronLeft className="h-6 w-6" />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); step(1); }} className="absolute right-4 grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20">
                    <ChevronRight className="h-6 w-6" />
                  </button>
                </>
              )}
              <motion.img
                key={shots[open].id}
                src={assetUrl(shots[open].path) ?? undefined}
                alt={`${name} capture ${open + 1}`}
                className="max-h-[88vh] max-w-[92vw] rounded-xl object-contain shadow-float"
                onClick={(e) => e.stopPropagation()}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                draggable={false}
              />
              <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/50 px-3 py-1 text-xs font-700 text-white/80">
                <Camera className="h-3.5 w-3.5" />
                {dateLabel(shots[open].capturedUtc)} · {timeLabel(shots[open].capturedUtc, use24)}
                <span className="text-white/40">·</span>
                {open + 1} / {shots.length}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
