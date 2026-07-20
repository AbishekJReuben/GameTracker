import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "motion/react";
import { Clipboard, X } from "lucide-react";
import { clip } from "@/lib/clip";
import { clipSync } from "@/lib/clipboardSync";
import { useClipboard } from "@/store/clipboard";
import { ClipboardPanel } from "./ClipboardPanel";

const BUBBLE = 76;
const PANEL_W = 380;
const PANEL_H = 560;

/** Pointer-driven window drag that also reports a tap (no movement). Distinguishes
 *  a click-to-open from a drag-to-move, and persists the final position. */
function useWindowDrag(onTap?: () => void) {
  const st = useRef<{ ox: number; oy: number; sf: number; moved: boolean; sx: number; sy: number } | null>(
    null,
  );

  const onPointerDown = useCallback(async (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const win = getCurrentWindow();
    const [pos, sf] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
    st.current = {
      ox: e.screenX * sf - pos.x,
      oy: e.screenY * sf - pos.y,
      sf,
      moved: false,
      sx: e.screenX,
      sy: e.screenY,
    };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const s = st.current;
    if (!s) return;
    if (!s.moved && Math.hypot(e.screenX - s.sx, e.screenY - s.sy) > 3) s.moved = true;
    if (!s.moved) return;
    const nx = Math.round(e.screenX * s.sf - s.ox);
    const ny = Math.round(e.screenY * s.sf - s.oy);
    getCurrentWindow().setPosition(new PhysicalPosition(nx, ny));
  }, []);

  const onPointerUp = useCallback(
    async (e: React.PointerEvent) => {
      const s = st.current;
      st.current = null;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      if (!s) return;
      if (!s.moved) {
        onTap?.();
        return;
      }
      const pos = await getCurrentWindow().outerPosition();
      clip.overlaySetPos(pos.x / s.sf, pos.y / s.sf).catch(() => {});
    },
    [onTap],
  );

  return { onPointerDown, onPointerMove, onPointerUp };
}

export default function ClipboardOverlay() {
  const [expanded, setExpanded] = useState(false);
  const [sttEnabled, setSttEnabled] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [status, setStatus] = useState<{ text: string; color: string }>({
    text: "Connecting…",
    color: "var(--accent-3)",
  });

  // The overlay window is transparent — clear any global page background.
  // #root carries an opaque #06070d from index.html / index.css, which would
  // paint a solid dark square behind the transparent bubble. Restore on unmount
  // (though this route is dedicated to the overlay, so it never unmounts in practice).
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    const prevRootBg = root?.style.background ?? "";
    if (root) root.style.background = "transparent";
    invoke<Record<string, string>>("get_settings")
      .then((s) => setSttEnabled(s.clipboard_stt_enabled === "true"))
      .catch(() => {});

    // PULSE on any new item, AND keep the store fresh so the panel shows live
    // updates the moment it's expanded (the panel itself only mounts expanded,
    // so without this always-on listener it would miss events while collapsed).
    const triggerPulse = () => {
      setPulse(true);
      setTimeout(() => setPulse(false), 1400);
    };
    const refresh = () => {
      triggerPulse();
      void useClipboard.getState().refresh();
    };
    const unItem = listen("clipboard://item", refresh);
    const unChanged = listen("clipboard://changed", refresh);

    // Live sync status pill in the header. Polls the sync engine's diagnostics
    // (cheap object read) so the user sees Connecting / Synced / relay-error
    // without opening Settings. 2s cadence — fast enough to feel live, slow
    // enough not to thrash React on a hidden overlay.
    const statusTick = () => {
      const d = clipSync.diagnostics();
      let text = "Connecting…";
      let color = "var(--accent-3)";
      if (d.started !== "true") {
        text = "Off";
        color = "var(--ink-faint)";
      } else if (d.wsState === "open") {
        const items = useClipboard.getState().items;
        const deviceCount = new Set(items.map((i) => i.deviceId)).size;
        text = `Synced${deviceCount > 0 ? ` · ${deviceCount} device${deviceCount === 1 ? "" : "s"}` : ""}`;
        color = "#34d399";
      } else if (d.lastError && d.lastError !== "(none)") {
        text = "Reconnecting…";
        color = "#fbbf24";
      }
      setStatus((prev) => (prev.text === text && prev.color === color ? prev : { text, color }));
    };
    statusTick();
    const statusTimer = window.setInterval(statusTick, 2000);

    return () => {
      unItem.then((f) => f());
      unChanged.then((f) => f());
      window.clearInterval(statusTimer);
      if (root && prevRootBg !== "") root.style.background = prevRootBg;
    };
  }, []);

  // Smoothly tween the OS window size instead of snapping. A snap makes the
  // panel appear before the window has room (or leaves a big empty window as it
  // collapses); easing the actual window bounds is what sells the morph.
  const animRef = useRef<number | null>(null);
  const tweenSize = useCallback((toW: number, toH: number, ms: number) => {
    return new Promise<void>((resolve) => {
      if (animRef.current != null) cancelAnimationFrame(animRef.current);
      const win = getCurrentWindow();
      const start = performance.now();
      const fromW = BUBBLE + (PANEL_W - BUBBLE) * (toW === BUBBLE ? 1 : 0);
      const fromH = BUBBLE + (PANEL_H - BUBBLE) * (toH === BUBBLE ? 1 : 0);
      const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ms);
        const k = ease(t);
        const w = Math.round(fromW + (toW - fromW) * k);
        const h = Math.round(fromH + (toH - fromH) * k);
        void win.setSize(new LogicalSize(w, h));
        if (t < 1) {
          animRef.current = requestAnimationFrame(step);
        } else {
          animRef.current = null;
          resolve();
        }
      };
      animRef.current = requestAnimationFrame(step);
    });
  }, []);

  const expand = useCallback(async () => {
    // Pull the latest from the DB the instant the panel opens — this is the
    // fallback for items that arrived while collapsed (the always-on listener
    // above also refreshes, but this guarantees a fresh view on open).
    void useClipboard.getState().refresh();
    setExpanded(true);
    await tweenSize(PANEL_W, PANEL_H, 260);
  }, [tweenSize]);

  const collapse = useCallback(async () => {
    setExpanded(false);
    await tweenSize(BUBBLE, BUBBLE, 220);
  }, [tweenSize]);

  useEffect(() => () => {
    if (animRef.current != null) cancelAnimationFrame(animRef.current);
  }, []);

  const bubbleDrag = useWindowDrag(expand);
  const headerDrag = useWindowDrag();

  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent">
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="panel"
            initial={{ opacity: 0, scale: 0.86 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.82, transition: { duration: 0.16, ease: "easeIn" } }}
            transition={{ type: "spring", stiffness: 300, damping: 26, opacity: { duration: 0.2 } }}
            className="glass absolute inset-0 flex flex-col overflow-hidden rounded-[22px] border border-white/12 shadow-float"
            style={{ backdropFilter: "blur(20px)", transformOrigin: "top left" }}
          >
            <div
              {...headerDrag}
              className="flex cursor-grab items-center justify-between gap-2 border-b border-white/[0.06] px-3.5 py-2.5 active:cursor-grabbing"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Clipboard className="h-4 w-4 shrink-0 text-accent-3" />
                <span className="text-sm font-700 text-ink">Clipboard</span>
                <span
                  className="flex items-center gap-1 text-[10px] font-600"
                  style={{ color: status.color }}
                  title="Live sync status — shows whether this PC is connected to the relay"
                >
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{
                      background: status.color,
                      boxShadow: `0 0 6px ${status.color}`,
                    }}
                  />
                  {status.text}
                </span>
              </div>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={collapse}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-dim hover:bg-white/10 hover:text-ink"
                title="Collapse"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 p-2.5">
              <ClipboardPanel compact sttEnabled={sttEnabled} />
            </div>
          </motion.div>
        ) : (
          <motion.button
            key="bubble"
            {...bubbleDrag}
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{
              scale: pulse ? [1, 1.12, 1] : 1,
              opacity: 1,
            }}
            exit={{ scale: 0.5, opacity: 0, transition: { duration: 0.14, ease: "easeIn" } }}
            transition={{ type: "spring", stiffness: 380, damping: 22 }}
            className="glass absolute left-0 top-0 grid h-[68px] w-[68px] cursor-grab place-items-center rounded-full border border-white/15 shadow-float active:cursor-grabbing"
            style={{
              margin: 4,
              transformOrigin: "top left",
              backdropFilter: "blur(16px)",
              backgroundImage:
                "radial-gradient(120% 120% at 30% 20%, rgba(255,255,255,0.12), transparent 60%)",
            }}
            title="Clipboard — tap to open, drag to move"
          >
            <span
              className="grid h-10 w-10 place-items-center rounded-full text-white"
              style={{ backgroundImage: "linear-gradient(135deg,var(--accent-1),var(--accent-3))" }}
            >
              <Clipboard className="h-5 w-5" />
            </span>
            <AnimatePresence>
              {pulse && (
                <motion.span
                  initial={{ scale: 1, opacity: 0.5 }}
                  animate={{ scale: 1.8, opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 1.2 }}
                  className="absolute inset-0 rounded-full border border-accent-3"
                />
              )}
            </AnimatePresence>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
