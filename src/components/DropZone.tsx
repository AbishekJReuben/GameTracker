import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Download } from "lucide-react";
import { api } from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { useApp, useMotionEnabled } from "@/store/app";
import { useRefreshAll } from "@/lib/queries";
import { springBouncy } from "@/lib/motion";

/** Global drag-and-drop: drop an exe or folder anywhere to add a game. */
export function DropZone() {
  const [over, setOver] = useState(false);
  const pushToast = useApp((s) => s.pushToast);
  const setDroppedPath = useApp((s) => s.setDroppedPath);
  const refresh = useRefreshAll();
  const enabled = useMotionEnabled();

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setOver(true);
        } else if (p.type === "leave") {
          setOver(false);
        } else if (p.type === "drop") {
          setOver(false);
          const paths = p.paths ?? [];
          if (paths.length === 0) return;
          // If the add-game modal is open, route the dropped path into its form
          // fields instead of adding immediately — lets the user review first.
          if (useApp.getState().gameModal.open) {
            setDroppedPath(paths[0]);
            return;
          }
          let added = 0;
          for (const path of paths) {
            try {
              await api.addFromPath(path);
              added++;
            } catch {
              /* ignore non-game drops */
            }
          }
          if (added > 0) {
            refresh();
            pushToast({ kind: "success", title: `Added ${added} game${added > 1 ? "s" : ""}`, message: "Dropped in and ready to track" });
          }
        }
      })
      .then((f) => (unlisten = f));
    return () => unlisten?.();
  }, [pushToast, refresh, setDroppedPath]);

  return (
    <AnimatePresence>
      {over && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="pointer-events-none fixed inset-0 z-[60] grid place-items-center bg-bg-base/75 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={springBouncy}
            className="relative flex flex-col items-center gap-4 rounded-3xl px-16 py-12"
          >
            {/* Animated dashed border */}
            <motion.div
              className="pointer-events-none absolute inset-0 rounded-3xl"
              style={{
                background: `repeating-linear-gradient(90deg, color-mix(in srgb, var(--accent-1) 70%, transparent) 0 12px, transparent 12px 20px) top/100% 2px no-repeat,
                  repeating-linear-gradient(180deg, color-mix(in srgb, var(--accent-1) 70%, transparent) 0 12px, transparent 12px 20px) right/2px 100% no-repeat,
                  repeating-linear-gradient(270deg, color-mix(in srgb, var(--accent-1) 70%, transparent) 0 12px, transparent 12px 20px) bottom/100% 2px no-repeat,
                  repeating-linear-gradient(0deg, color-mix(in srgb, var(--accent-1) 70%, transparent) 0 12px, transparent 12px 20px) left/2px 100% no-repeat`,
              }}
              animate={enabled ? { opacity: [0.5, 1, 0.5] } : undefined}
              transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
              className="absolute inset-2 rounded-[22px] border-2 border-dashed"
              style={{ borderColor: "color-mix(in srgb, var(--accent-1) 45%, transparent)" }}
              animate={enabled ? { borderColor: ["color-mix(in srgb, var(--accent-1) 35%, transparent)", "color-mix(in srgb, var(--accent-3) 65%, transparent)", "color-mix(in srgb, var(--accent-1) 35%, transparent)"] } : undefined}
              transition={{ duration: 2, repeat: Infinity }}
            />

            <motion.div
              className="grid h-16 w-16 place-items-center rounded-2xl bg-accent-sheen shadow-glow"
              animate={enabled ? { y: [0, -8, 0], scale: [1, 1.06, 1] } : undefined}
              transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
            >
              <Download className="h-8 w-8 text-white" />
            </motion.div>
            <div className="text-center">
              <div className="font-display text-xl font-800">Drop to add</div>
              <div className="text-sm text-ink-dim">Release an .exe or game folder to track it</div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
