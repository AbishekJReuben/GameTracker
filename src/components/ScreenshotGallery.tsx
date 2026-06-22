import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { assetUrl } from "@/lib/api";
import { useMotionEnabled } from "@/store/app";

/** Responsive screenshot grid with a full-screen lightbox (keyboard + arrows). */
export function ScreenshotGallery({ urls, name }: { urls: string[]; name: string }) {
  const enabled = useMotionEnabled();
  const [open, setOpen] = useState<number | null>(null);
  const shots = urls.map((u) => assetUrl(u)).filter((u): u is string => !!u);

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
        {shots.map((src, i) => (
          <motion.button
            key={src}
            onClick={() => setOpen(i)}
            className="group relative aspect-video overflow-hidden rounded-xl border border-line bg-bg-900/60"
            initial={enabled ? { opacity: 0, y: 12 } : false}
            whileInView={enabled ? { opacity: 1, y: 0 } : undefined}
            viewport={{ once: true, margin: "-40px" }}
            transition={{ delay: Math.min(i * 0.03, 0.3), duration: 0.4 }}
            whileHover={enabled ? { scale: 1.02 } : undefined}
          >
            <img
              src={src}
              alt={`${name} screenshot ${i + 1}`}
              className="h-full w-full object-cover transition duration-300 group-hover:brightness-110"
              draggable={false}
            />
            <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/10 transition group-hover:ring-white/25" />
          </motion.button>
        ))}
      </div>

      {createPortal(
        <AnimatePresence>
          {open !== null && (
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
                  <button
                    onClick={(e) => { e.stopPropagation(); step(-1); }}
                    className="absolute left-4 grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
                  >
                    <ChevronLeft className="h-6 w-6" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); step(1); }}
                    className="absolute right-4 grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
                  >
                    <ChevronRight className="h-6 w-6" />
                  </button>
                </>
              )}
              <motion.img
                key={shots[open]}
                src={shots[open]}
                alt={`${name} screenshot ${open + 1}`}
                className="max-h-[88vh] max-w-[92vw] rounded-xl object-contain shadow-float"
                onClick={(e) => e.stopPropagation()}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                draggable={false}
              />
              <div className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs font-700 text-white/80">
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
