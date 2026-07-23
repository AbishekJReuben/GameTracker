import { useCallback, useEffect, useRef, useState } from "react";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "motion/react";
import { NotebookPen, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { clip } from "@/lib/clip";
import { useClipboard } from "@/store/clipboard";
import { ClipboardPanel } from "./ClipboardPanel";

const BUBBLE = 76;
const PANEL_W = 380;
const PANEL_H = 560;
const SIZE_KEY = "gt.clip.overlaySize";
const MIN_W = 300;
const MAX_W = 900;
const MIN_H = 360;
const MAX_H = 1200;
const clampW = (w: number) => Math.max(MIN_W, Math.min(Math.round(w), MAX_W));
const clampH = (h: number) => Math.max(MIN_H, Math.min(Math.round(h), MAX_H));
const SCREEN_GUTTER = 8;

/** Last user-chosen expanded size (logical px), clamped to something sane. */
function savedPanelSize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (raw) {
      const [w, h] = raw.split(",").map((n) => Math.round(Number(n)));
      if (Number.isFinite(w) && Number.isFinite(h)) return { w: clampW(w), h: clampH(h) };
    }
  } catch {
    /* ignore */
  }
  return { w: PANEL_W, h: PANEL_H };
}

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

/** In-window resize grips.
 *
 *  The overlay is `decorations: false`, so Windows gives it no non-client area —
 *  there is no OS border to drag and `setResizable(true)` alone is invisible to
 *  the user. These handles do the resize in the WebView instead: the top-left
 *  corner stays put (matching the expand morph's origin), so only the size
 *  changes and the window never needs repositioning. */
function ResizeGrips({ onCommit }: { onCommit: (w: number, h: number) => void }) {
  const st = useRef<{ sx: number; sy: number; w: number; h: number; edge: string } | null>(null);

  const begin = (edge: string) => async (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const win = getCurrentWindow();
    const [size, sf] = await Promise.all([win.innerSize(), win.scaleFactor()]);
    st.current = { sx: e.screenX, sy: e.screenY, w: size.width / sf, h: size.height / sf, edge };
  };

  const move = (e: React.PointerEvent) => {
    const s = st.current;
    if (!s) return;
    // screenX/Y are CSS pixels, the same unit as LogicalSize — no scaling needed.
    const w = s.edge.includes("e") ? clampW(s.w + (e.screenX - s.sx)) : clampW(s.w);
    const h = s.edge.includes("s") ? clampH(s.h + (e.screenY - s.sy)) : clampH(s.h);
    void getCurrentWindow().setSize(new LogicalSize(w, h));
  };

  const end = async (e: React.PointerEvent) => {
    if (!st.current) return;
    st.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    const win = getCurrentWindow();
    const [size, sf] = await Promise.all([win.innerSize(), win.scaleFactor()]);
    onCommit(Math.round(size.width / sf), Math.round(size.height / sf));
  };

  const grip = (edge: string, className: string, cursor: string) => (
    <div
      key={edge}
      onPointerDown={begin(edge)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      className={cn("absolute z-20", className)}
      style={{ cursor, touchAction: "none" }}
    />
  );

  return (
    <>
      {grip("e", "right-0 top-3 bottom-6 w-1.5", "ew-resize")}
      {grip("s", "bottom-0 left-3 right-6 h-1.5", "ns-resize")}
      {grip("se", "bottom-0 right-0 h-4 w-4", "nwse-resize")}
      {/* Corner tick — the only visible hint that the panel can be dragged bigger. */}
      <div className="pointer-events-none absolute bottom-1 right-1 z-10 h-2.5 w-2.5 rounded-br-[5px] border-b-2 border-r-2 border-white/25" />
    </>
  );
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

    // Live sync status pill in the header. The real WebSocket runs in the MAIN
    // window (ClipSyncEngine), which broadcasts its diagnostics over a Tauri event
    // — reading our own (never-started) clipSync here always said "Off". If no
    // broadcast has arrived in a while, fall back to "Connecting…".
    let lastStatusAt = 0;
    const applyStatus = (d: Record<string, unknown>) => {
      lastStatusAt = Date.now();
      let text = "Connecting…";
      let color = "var(--accent-3)";
      if (d.started !== "true") {
        text = "Off";
        color = "var(--ink-faint)";
      } else if (d.wsState === "open") {
        const deviceCount = Number(d.deviceCount ?? 0);
        text = `Synced${deviceCount > 0 ? ` · ${deviceCount} device${deviceCount === 1 ? "" : "s"}` : ""}`;
        color = "#34d399";
      } else if (d.lastError && d.lastError !== "(none)") {
        text = "Reconnecting…";
        color = "#fbbf24";
      }
      setStatus((prev) => (prev.text === text && prev.color === color ? prev : { text, color }));
    };
    const unStatus = listen<Record<string, unknown>>("clipboard://sync-status", (e) =>
      applyStatus(e.payload),
    );
    // Watchdog: if the main window's broadcast stops (app closing/reloading),
    // don't leave a stale "Synced" — degrade to Connecting after 6s of silence.
    const statusTimer = window.setInterval(() => {
      if (lastStatusAt && Date.now() - lastStatusAt > 6000) {
        setStatus({ text: "Connecting…", color: "var(--accent-3)" });
      }
    }, 2000);

    return () => {
      unItem.then((f) => f());
      unChanged.then((f) => f());
      unStatus.then((f) => f());
      window.clearInterval(statusTimer);
      if (root && prevRootBg !== "") root.style.background = prevRootBg;
    };
  }, []);

  // Smoothly tween the OS window size instead of snapping. A snap makes the
  // panel appear before the window has room (or leaves a big empty window as it
  // collapses); easing the actual window bounds is what sells the morph. Reads
  // the REAL current size first — the expanded panel is user-resizable now, so
  // the starting size can't be assumed.
  const animRef = useRef<number | null>(null);
  const animRunRef = useRef(0);
  const animResolveRef = useRef<(() => void) | null>(null);
  const tweenSize = useCallback(async (toW: number, toH: number, ms: number) => {
    const run = ++animRunRef.current;
    if (animRef.current != null) cancelAnimationFrame(animRef.current);
    animResolveRef.current?.();
    const win = getCurrentWindow();
    const [cur, sf] = await Promise.all([win.innerSize(), win.scaleFactor()]);
    const fromW = cur.width / sf;
    const fromH = cur.height / sf;
    return new Promise<void>((resolve) => {
      animResolveRef.current = resolve;
      const start = performance.now();
      const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic
      const finish = () => {
        if (run !== animRunRef.current) return;
        animRef.current = null;
        animResolveRef.current = null;
        resolve();
      };
      const step = async (now: number) => {
        if (run !== animRunRef.current) {
          resolve();
          return;
        }
        const t = Math.min(1, (now - start) / ms);
        const k = ease(t);
        const w = Math.round(fromW + (toW - fromW) * k);
        const h = Math.round(fromH + (toH - fromH) * k);
        // Keep one resize command in flight at a time. Flooding WebView2 with
        // un-awaited setSize calls lets late intermediate sizes win, leaving the
        // panel visibly half-open on Windows.
        await win.setSize(new LogicalSize(w, h)).catch(() => {});
        if (run !== animRunRef.current) {
          resolve();
          return;
        }
        if (t < 1) {
          animRef.current = requestAnimationFrame(step);
        } else {
          // Land on the exact target even when the final animation frame was
          // delayed or rounded.
          await win.setSize(new LogicalSize(toW, toH)).catch(() => {});
          finish();
        }
      };
      animRef.current = requestAnimationFrame(step);
    });
  }, []);

  /** Keep the expanded panel wholly inside the current monitor's work area.
   *  The bubble is allowed against an edge; a 380x560 panel anchored to that
   *  same point is not, or its right/bottom half opens off-screen. */
  const fitExpandedPanel = useCallback(async (wantedW: number, wantedH: number) => {
    const win = getCurrentWindow();
    const [monitor, pos, windowScale] = await Promise.all([
      currentMonitor(),
      win.outerPosition(),
      win.scaleFactor(),
    ]);
    if (!monitor) return { w: wantedW, h: wantedH };

    const scale = monitor.scaleFactor || windowScale;
    const area = monitor.workArea;
    const gutter = Math.round(SCREEN_GUTTER * scale);
    const maxW = Math.max(1, area.size.width - gutter * 2);
    const maxH = Math.max(1, area.size.height - gutter * 2);
    const w = Math.min(wantedW, Math.floor(maxW / scale));
    const h = Math.min(wantedH, Math.floor(maxH / scale));
    const widthPx = Math.round(w * scale);
    const heightPx = Math.round(h * scale);
    const x = Math.max(
      area.position.x + gutter,
      Math.min(pos.x, area.position.x + area.size.width - widthPx - gutter),
    );
    const y = Math.max(
      area.position.y + gutter,
      Math.min(pos.y, area.position.y + area.size.height - heightPx - gutter),
    );
    if (x !== pos.x || y !== pos.y) {
      await win.setPosition(new PhysicalPosition(x, y)).catch(() => {});
      void clip.overlaySetPos(x / scale, y / scale).catch(() => {});
    }
    return { w, h };
  }, []);

  // The bubble must never grow OS resize grips; only the expanded panel is
  // user-resizable (the window is created resizable — turn it off at mount).
  useEffect(() => {
    void getCurrentWindow().setResizable(false);
  }, []);

  const expand = useCallback(async () => {
    // Pull the latest from the DB the instant the panel opens — this is the
    // fallback for items that arrived while collapsed (the always-on listener
    // above also refreshes, but this guarantees a fresh view on open).
    void useClipboard.getState().refresh();
    const saved = savedPanelSize();
    const { w, h } = await fitExpandedPanel(saved.w, saved.h).catch(() => saved);
    setExpanded(true);
    const win = getCurrentWindow();
    await tweenSize(w, h, 260).catch(() => {});
    // Monitor queries or an animation frame can fail during display/DPI changes;
    // the interaction still has one non-negotiable outcome: a fully open panel.
    await win.setSize(new LogicalSize(w, h)).catch(() => {});
    await win.setResizable(true).catch(() => {});
  }, [fitExpandedPanel, tweenSize]);

  const collapse = useCallback(async () => {
    // Remember the size the user left the panel at (they can drag OS edges).
    try {
      const win = getCurrentWindow();
      const [cur, sf] = await Promise.all([win.innerSize(), win.scaleFactor()]);
      const w = Math.round(cur.width / sf);
      const h = Math.round(cur.height / sf);
      if (w > BUBBLE + 20 && h > BUBBLE + 20) localStorage.setItem(SIZE_KEY, `${w},${h}`);
      await win.setResizable(false).catch(() => {});
    } catch {
      /* ignore */
    }
    setExpanded(false);
    await tweenSize(BUBBLE, BUBBLE, 220);
  }, [tweenSize]);

  useEffect(() => () => {
    animRunRef.current++;
    if (animRef.current != null) cancelAnimationFrame(animRef.current);
    animResolveRef.current?.();
    animResolveRef.current = null;
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
            className="absolute inset-0 flex flex-col overflow-hidden rounded-[22px] border border-white/12 shadow-float"
            style={{
              // Translucent frosted fill (not see-through): a solid-ish dark base so
              // text stays readable over any window behind, plus a heavy blur.
              backgroundColor: "rgba(10,12,20,0.82)",
              backdropFilter: "blur(24px) saturate(140%)",
              WebkitBackdropFilter: "blur(24px) saturate(140%)",
              transformOrigin: "top left",
            }}
          >
            <div
              {...headerDrag}
              className="flex cursor-grab items-center gap-2 border-b border-white/[0.06] px-3.5 py-2.5 active:cursor-grabbing"
            >
              {/* Close (X) sits in the LEFT corner so it lands on the same spot as
                  the collapsed bubble — the user's finger is already there from
                  tapping to open, and the expand morph anchors to top-left. Keep
                  its pointer-down from initiating a header drag. */}
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={collapse}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-dim hover:bg-white/10 hover:text-ink"
                title="Collapse"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <NotebookPen className="h-4 w-4 shrink-0 text-accent-3" />
                <span className="text-sm font-700 text-ink">Notes</span>
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
            </div>
            <div className="min-h-0 flex-1 p-2.5">
              <ClipboardPanel compact sttEnabled={sttEnabled} draftKey="gt.clip.draft.overlay" />
            </div>
            <ResizeGrips
              onCommit={(w, h) => {
                try {
                  localStorage.setItem(SIZE_KEY, `${w},${h}`);
                } catch {
                  /* ignore */
                }
              }}
            />
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
            className="absolute left-0 top-0 grid h-[68px] w-[68px] cursor-grab place-items-center rounded-full border border-white/15 shadow-float active:cursor-grabbing"
            style={{
              margin: 4,
              transformOrigin: "top left",
              backgroundColor: "rgba(10,12,20,0.72)",
              backdropFilter: "blur(16px) saturate(140%)",
              WebkitBackdropFilter: "blur(16px) saturate(140%)",
              backgroundImage:
                "radial-gradient(120% 120% at 30% 20%, rgba(255,255,255,0.14), transparent 60%)",
            }}
            title="Notes — tap to open, drag to move"
          >
            <span
              className="grid h-10 w-10 place-items-center rounded-full text-white"
              style={{ backgroundImage: "linear-gradient(135deg,var(--accent-1),var(--accent-3))" }}
            >
              <NotebookPen className="h-5 w-5" />
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
