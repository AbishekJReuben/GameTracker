import { ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

export function Modal({
  open,
  onClose,
  children,
  title,
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  // Portal to <body> so `position: fixed` resolves against the viewport. Route
  // pages animate `filter: blur()` (fadeBlurUp), which makes the page content a
  // containing block for fixed descendants — without the portal the modal would
  // center inside the (tall) scrolled page instead of the screen.
  const overlay = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40 grid place-items-center p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: "spring", stiffness: 360, damping: 30 }}
            className={cn("hud-panel relative z-10 max-h-[88vh] w-full max-w-lg overflow-y-auto p-0", className)}
          >
            {title && (
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-bg-850/90 px-5 py-4 backdrop-blur-xl">
                <h3 className="font-display text-base font-700">{title}</h3>
                <button
                  onClick={onClose}
                  className="grid h-8 w-8 place-items-center rounded-lg text-ink-dim transition hover:bg-white/5 hover:text-ink"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return typeof document !== "undefined" ? createPortal(overlay, document.body) : overlay;
}
