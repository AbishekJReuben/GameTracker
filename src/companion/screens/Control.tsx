import { useEffect, useMemo, useRef, useState } from "react";
import {
  MousePointer2,
  Hand,
  Pointer,
  ChevronUp,
  ChevronDown,
  CornerDownLeft,
  Delete,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Keyboard,
  Loader2,
  X,
  RotateCcw,
  LogOut,
  Gauge,
  Command,
  Maximize2,
  Minimize2,
  Camera,
  MousePointerClick,
  Grip,
  Volume2,
  Volume1,
  VolumeX,
  PlayCircle,
  SkipForward,
  SkipBack,
  Wifi,
  Monitor,
  Menu,
  BarChart3,
  Library as LibraryIcon,
  Headphones,
  Send,
} from "lucide-react";
import type { QualitySettings, RemoteLink } from "../links";
import { apiGet } from "../link";
import type { RemoteMonitor } from "@/lib/api";

// ---------- tuning constants ----------
const TAP_MS = 260; // max press time still counted as a tap
const TAP_SLOP = 12; // max finger travel (px) still counted as a tap
const DOUBLE_MS = 320; // window to chain a double-tap (→ double click / drag)
const LONGPRESS_MS = 550; // hold to fire a right-click
const SCROLL_STEP = 20; // finger px per wheel notch
const MAX_ZOOM = 6;
const FOLLOW_MARGIN = 72; // keep the cursor this far from the viewport edge when zoomed

type Mode = "trackpad" | "touch";
type Mod = "ctrl" | "alt" | "shift" | "win";
type KbMode = "direct" | "buffered";
type NavTab = "stats" | "library" | "music" | "control";

type QualityPreset = { id: string; label: string; hint: string; q: QualitySettings };

const PRESETS: QualityPreset[] = [
  { id: "fluid", label: "Fluid", hint: "720p / 60fps", q: { maxW: 1280, quality: 45, fps: 60 } },
  { id: "smooth", label: "Smooth", hint: "900p / 40fps", q: { maxW: 1600, quality: 50, fps: 40 } },
  { id: "balanced", label: "Balanced", hint: "1080p / 30fps", q: { maxW: 1600, quality: 60, fps: 30 } },
  { id: "hd", label: "HD", hint: "1080p / crisp", q: { maxW: 1920, quality: 72, fps: 30 } },
  { id: "ultra", label: "Ultra", hint: "1440p / sharp", q: { maxW: 2560, quality: 82, fps: 30 } },
  { id: "max", label: "Max 4K", hint: "2160p / heaviest", q: { maxW: 3840, quality: 90, fps: 30 } },
];

// ---------- geometry helpers ----------
type Layout = { cw: number; ch: number; dispW: number; dispH: number; offX: number; offY: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Container size + the object-contain image box within it (at zoom 1). */
function measure(el: HTMLElement | null, natW: number, natH: number): Layout | null {
  if (!el || !natW || !natH) return null;
  const r = el.getBoundingClientRect();
  const cw = r.width;
  const ch = r.height;
  const ratio = natW / natH;
  let dispW = cw;
  let dispH = cw / ratio;
  if (dispH > ch) {
    dispH = ch;
    dispW = ch * ratio;
  }
  return { cw, ch, dispW, dispH, offX: (cw - dispW) / 2, offY: (ch - dispH) / 2 };
}

/** Clamp pan so the scaled image never reveals empty space beyond its edges. */
function clampPan(l: Layout, zoom: number, panX: number, panY: number) {
  const maxX = Math.max(0, (l.dispW * zoom - l.cw) / 2);
  const maxY = Math.max(0, (l.dispH * zoom - l.ch) / 2);
  return { x: clamp(panX, -maxX, maxX), y: clamp(panY, -maxY, maxY) };
}

/** Normalized image coords (0..1) for a screen point, undoing pan+zoom. */
function screenToNorm(l: Layout, left: number, top: number, zoom: number, panX: number, panY: number, cx: number, cy: number) {
  const px = l.cw / 2 + (cx - left - l.cw / 2 - panX) / zoom;
  const py = l.ch / 2 + (cy - top - l.ch / 2 - panY) / zoom;
  return { x: clamp((px - l.offX) / l.dispW, 0, 1), y: clamp((py - l.offY) / l.dispH, 0, 1) };
}

/** Container-relative pixel position of a normalized cursor, applying pan+zoom. */
function normToScreen(l: Layout, zoom: number, panX: number, panY: number, nx: number, ny: number) {
  const px = l.offX + nx * l.dispW;
  const py = l.offY + ny * l.dispH;
  return { x: l.cw / 2 + (px - l.cw / 2) * zoom + panX, y: l.ch / 2 + (py - l.ch / 2) * zoom + panY };
}

// ---------- component ----------
export function ControlScreen({
  link,
  onNavigate,
  onDisconnect,
}: {
  link: RemoteLink;
  onNavigate?: (tab: NavTab) => void;
  onDisconnect?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const kbdRef = useRef<HTMLInputElement | null>(null);

  const [connected, setConnected] = useState(false);
  const [hasStream, setHasStream] = useState(false);
  const [mode, setMode] = useState<Mode>("trackpad");
  const [dockOpen, setDockOpen] = useState(true);
  const [dockTab, setDockTab] = useState<"mouse" | "keys" | "shortcuts" | "quality">("mouse");
  const [immersive, setImmersive] = useState(false);
  const [kbdOpen, setKbdOpen] = useState(false);
  const [kbMode, setKbMode] = useState<KbMode>("direct");
  const [pcTextField, setPcTextField] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [sensitivity, setSensitivity] = useState(1.6);
  const [dragLock, setDragLock] = useState(false);
  const [mods, setMods] = useState<Set<Mod>>(new Set());
  const autoKbdRef = useRef(false); // guards the once-per-focus auto keyboard pop

  // View transform: refs drive the hot gesture path, state mirrors it for render.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cursor, setCursor] = useState({ x: 0.5, y: 0.5 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const cursorRef = useRef({ x: 0.5, y: 0.5 });
  const layoutRef = useRef<Layout | null>(null);
  const natRef = useRef({ w: 0, h: 0 });

  // Quality + live stats.
  const [presetId, setPresetId] = useState("balanced");
  const [custom, setCustom] = useState<QualitySettings>(PRESETS[2].q);
  const [showStats, setShowStats] = useState(false);
  const [fps, setFps] = useState(0);
  const [res, setRes] = useState("");
  const frameTimes = useRef<number[]>([]);

  // Multi-monitor.
  const [monitors, setMonitors] = useState<RemoteMonitor[]>([]);
  const [monitorIdx, setMonitorIdx] = useState(0);

  const activeQuality = useMemo<QualitySettings>(
    () => (presetId === "custom" ? custom : PRESETS.find((p) => p.id === presetId)?.q ?? PRESETS[2].q),
    [presetId, custom],
  );

  // Composite one delta wire-frame (see capture.rs `TileEncoder::encode`) onto the
  // canvas: only the changed tiles are present, so we draw them over the retained
  // previous image. A keyframe carries new dimensions → (re)size the canvas.
  const drawFrame = (buf: Uint8Array) => {
    if (buf.length < 12 || buf[0] !== 0x47 || buf[1] !== 0x54) return; // "GT"
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const w = dv.getUint16(4, true);
    const h = dv.getUint16(6, true);
    const count = dv.getUint16(10, true);
    const canvas = canvasRef.current;
    if (!canvas || !w || !h) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      natRef.current = { w, h };
      setRes(`${w}×${h}`);
      const l = measure(viewportRef.current, w, h);
      if (l) layoutRef.current = l;
      ctxRef.current = canvas.getContext("2d");
    }
    if (!ctxRef.current) ctxRef.current = canvas.getContext("2d");
    const ctx = ctxRef.current;
    if (!ctx) return;
    let off = 12;
    for (let i = 0; i < count && off + 12 <= buf.length; i++) {
      const tx = dv.getUint16(off, true);
      const ty = dv.getUint16(off + 2, true);
      const len = dv.getUint32(off + 8, true);
      off += 12;
      const jpg = buf.slice(off, off + len); // copy: buf may be reused before decode resolves
      off += len;
      createImageBitmap(new Blob([jpg], { type: "image/jpeg" }))
        .then((bmp) => {
          ctx.drawImage(bmp, tx, ty);
          bmp.close?.();
        })
        .catch(() => {});
    }
  };

  // ----- frame + status lifecycle -----
  useEffect(() => {
    link.onStatus(setConnected);
    // Cloud: the screen arrives as a hardware-decoded WebRTC video track.
    link.onStream((stream) => {
      const v = videoRef.current;
      if (!v) return;
      v.srcObject = stream;
      setHasStream(true);
      v.play?.().catch(() => {});
    });
    // Host events: auto-pop the keyboard once when a PC text field gains focus.
    link.onEvent((e) => {
      if (e.event === "focus") handleFocusEvent(!!(e as { textField?: boolean }).textField);
    });
    // LAN fallback: JPEG tile frames drawn to the canvas.
    link.onFrame((buf) => {
      drawFrame(buf);
      const now = performance.now();
      const t = frameTimes.current;
      t.push(now);
      while (t.length && now - t[0] > 1000) t.shift();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  // Auto-open the on-screen keyboard exactly once per PC focus gain; show a chip.
  const handleFocusEvent = (textField: boolean) => {
    setPcTextField(textField);
    if (textField) {
      if (!autoKbdRef.current) {
        autoKbdRef.current = true;
        kbdRef.current?.focus();
      }
    } else {
      autoKbdRef.current = false;
    }
  };

  // Video natural size drives the gesture/cursor geometry (mirrors the canvas path).
  const onVideoSized = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    natRef.current = { w: v.videoWidth, h: v.videoHeight };
    setRes(`${v.videoWidth}×${v.videoHeight}`);
    const l = measure(viewportRef.current, v.videoWidth, v.videoHeight);
    if (l) layoutRef.current = l;
  };

  // True fps off the video pipeline via requestVideoFrameCallback (cloud path).
  useEffect(() => {
    const v = videoRef.current as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    }) | null;
    if (!v || !hasStream || !v.requestVideoFrameCallback) return;
    let handle = 0;
    const onVF = () => {
      const now = performance.now();
      const t = frameTimes.current;
      t.push(now);
      while (t.length && now - t[0] > 1000) t.shift();
      handle = v.requestVideoFrameCallback!(onVF);
    };
    handle = v.requestVideoFrameCallback(onVF);
    return () => v.cancelVideoFrameCallback?.(handle);
  }, [hasStream]);

  // Load the monitor list once connected (for the display switcher).
  useEffect(() => {
    if (!connected) return;
    apiGet<RemoteMonitor[]>("/api/monitors")
      .then((m) => setMonitors(m || []))
      .catch(() => {});
  }, [connected]);

  const selectMonitor = (i: number) => {
    setMonitorIdx(i);
    link.send({ type: "monitor", index: i });
    resetView();
  };

  // Push quality to the desktop whenever it changes.
  useEffect(() => {
    link.setQuality(activeQuality);
  }, [link, activeQuality]);

  // Sample fps once a second for the stats overlay.
  useEffect(() => {
    const id = window.setInterval(() => setFps(frameTimes.current.length), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Keep layout measurement fresh on resize / orientation change.
  useEffect(() => {
    const remeasure = () => {
      const l = measure(viewportRef.current, natRef.current.w, natRef.current.h);
      if (l) layoutRef.current = l;
    };
    remeasure();
    window.addEventListener("resize", remeasure);
    window.addEventListener("orientationchange", remeasure);
    return () => {
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("orientationchange", remeasure);
    };
  }, []);

  // ----- coalesced pointer-move sending (one per animation frame) -----
  const rafId = useRef<number | null>(null);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const flush = () => {
    rafId.current = null;
    const m = pendingMove.current;
    if (m) {
      pendingMove.current = null;
      link.send({ type: "move", x: m.x, y: m.y });
    }
  };
  const queueMove = (x: number, y: number) => {
    pendingMove.current = { x, y };
    if (rafId.current == null) rafId.current = requestAnimationFrame(flush);
  };

  // ----- transform commit helpers -----
  const commitView = () => {
    setZoom(zoomRef.current);
    setPan({ ...panRef.current });
    setCursor({ ...cursorRef.current });
  };

  const setCursorPos = (nx: number, ny: number) => {
    cursorRef.current = { x: clamp(nx, 0, 1), y: clamp(ny, 0, 1) };
    // Edge pan-follow (zoomed in): keep the cursor comfortably inside the viewport.
    const l = layoutRef.current;
    if (l && zoomRef.current > 1.01) {
      const s = normToScreen(l, zoomRef.current, panRef.current.x, panRef.current.y, cursorRef.current.x, cursorRef.current.y);
      let px = panRef.current.x;
      let py = panRef.current.y;
      if (s.x < FOLLOW_MARGIN) px += FOLLOW_MARGIN - s.x;
      else if (s.x > l.cw - FOLLOW_MARGIN) px -= s.x - (l.cw - FOLLOW_MARGIN);
      if (s.y < FOLLOW_MARGIN) py += FOLLOW_MARGIN - s.y;
      else if (s.y > l.ch - FOLLOW_MARGIN) py -= s.y - (l.ch - FOLLOW_MARGIN);
      panRef.current = clampPan(l, zoomRef.current, px, py);
    }
    commitView();
    queueMove(cursorRef.current.x, cursorRef.current.y);
  };

  const applyZoom = (nextZoom: number, focalX: number, focalY: number) => {
    const l = layoutRef.current;
    if (!l) return;
    const z0 = zoomRef.current;
    const z1 = clamp(nextZoom, 1, MAX_ZOOM);
    // Keep the focal point fixed under the fingers while scaling.
    const fpx = l.cw / 2 + (focalX - l.cw / 2 - panRef.current.x) / z0;
    const fpy = l.ch / 2 + (focalY - l.ch / 2 - panRef.current.y) / z0;
    const px = focalX - l.cw / 2 - (fpx - l.cw / 2) * z1;
    const py = focalY - l.ch / 2 - (fpy - l.ch / 2) * z1;
    zoomRef.current = z1;
    panRef.current = clampPan(l, z1, px, py);
    commitView();
  };

  const resetView = () => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    commitView();
  };

  // ----- gesture state -----
  type P = { x: number; y: number; sx: number; sy: number };
  const pts = useRef<Map<number, P>>(new Map());
  const gesture = useRef<"none" | "cursor" | "touchdrag" | "two" | "dragging">("none");
  const twoMode = useRef<"undecided" | "pinch" | "scroll">("undecided");
  const twoStart = useRef({ dist: 0, midX: 0, midY: 0, zoom: 1 });
  const prevMid = useRef<{ x: number; y: number } | null>(null);
  const scrollAcc = useRef({ x: 0, y: 0 });
  const downT = useRef(0);
  const maxMove = useRef(0);
  const downCount = useRef(0);
  const lastTapUp = useRef(0);
  const armedDrag = useRef(false);
  const touchPressed = useRef(false);
  const longTimer = useRef<number | null>(null);

  const clearLong = () => {
    if (longTimer.current != null) {
      window.clearTimeout(longTimer.current);
      longTimer.current = null;
    }
  };
  const rect = () => viewportRef.current!.getBoundingClientRect();

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const now = performance.now();
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });

    if (pts.current.size === 1) {
      downT.current = now;
      maxMove.current = 0;
      downCount.current = 1;
      touchPressed.current = false;
      armedDrag.current = false;
      gesture.current = mode === "touch" ? "touchdrag" : "cursor";

      if (mode === "touch") {
        const l = layoutRef.current;
        const r = rect();
        if (l) {
          const n = screenToNorm(l, r.left, r.top, zoomRef.current, panRef.current.x, panRef.current.y, e.clientX, e.clientY);
          queueMove(n.x, n.y);
        }
      } else if (dragLock) {
        link.send({ type: "down", button: "left" });
        gesture.current = "dragging";
      } else {
        armedDrag.current = now - lastTapUp.current < DOUBLE_MS; // double-tap-drag
      }

      // Long-press → right click (unless we're already committed to a drag).
      clearLong();
      if (gesture.current !== "dragging" && !armedDrag.current) {
        longTimer.current = window.setTimeout(() => {
          if (pts.current.size === 1 && maxMove.current < TAP_SLOP) {
            gesture.current = "none"; // consume the gesture; no click on release
            link.send({ type: "click", button: "right" });
            navigator.vibrate?.(15);
          }
        }, LONGPRESS_MS);
      }
    } else if (pts.current.size === 2) {
      clearLong();
      downCount.current = 2;
      gesture.current = "two";
      twoMode.current = "undecided";
      scrollAcc.current = { x: 0, y: 0 };
      const [a, b] = [...pts.current.values()];
      prevMid.current = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      twoStart.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: prevMid.current.x, midY: prevMid.current.y, zoom: zoomRef.current };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pts.current.get(e.pointerId);
    if (!p) return;
    const prevX = p.x;
    const prevY = p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    const travel = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
    if (travel > maxMove.current) maxMove.current = travel;

    if (gesture.current === "two" && pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if (twoMode.current === "undecided") {
        const dd = Math.abs(dist - twoStart.current.dist);
        const dm = Math.hypot(midX - twoStart.current.midX, midY - twoStart.current.midY);
        if (dd > 14 && dd >= dm) twoMode.current = "pinch";
        else if (dm > 14) twoMode.current = "scroll";
      }
      if (twoMode.current === "pinch") {
        const r = rect();
        applyZoom(twoStart.current.zoom * (dist / (twoStart.current.dist || 1)), midX - r.left, midY - r.top);
      } else if (twoMode.current === "scroll") {
        scrollAcc.current.y += midY - (prevMid.current?.y ?? midY);
        scrollAcc.current.x += midX - (prevMid.current?.x ?? midX);
        while (Math.abs(scrollAcc.current.y) >= SCROLL_STEP) {
          const dir = scrollAcc.current.y > 0 ? 1 : -1;
          link.send({ type: "scroll", dy: -dir }); // natural: content follows fingers
          scrollAcc.current.y -= dir * SCROLL_STEP;
        }
        while (Math.abs(scrollAcc.current.x) >= SCROLL_STEP) {
          const dir = scrollAcc.current.x > 0 ? 1 : -1;
          link.send({ type: "scroll", dx: -dir, dy: 0 });
          scrollAcc.current.x -= dir * SCROLL_STEP;
        }
      }
      prevMid.current = { x: midX, y: midY };
      return;
    }

    if (pts.current.size !== 1) return;
    if (travel > TAP_SLOP) clearLong();

    if (mode === "touch") {
      const l = layoutRef.current;
      const r = rect();
      if (l) {
        const n = screenToNorm(l, r.left, r.top, zoomRef.current, panRef.current.x, panRef.current.y, e.clientX, e.clientY);
        queueMove(n.x, n.y);
        if (travel > TAP_SLOP && !touchPressed.current) {
          link.send({ type: "down", button: "left" });
          touchPressed.current = true;
        }
      }
      return;
    }

    // Trackpad: relative cursor movement.
    if (armedDrag.current && gesture.current !== "dragging" && travel > TAP_SLOP) {
      gesture.current = "dragging";
      link.send({ type: "down", button: "left" });
    }
    const l = layoutRef.current;
    if (!l) return;
    const speed = sensitivity / (l.dispW * zoomRef.current);
    setCursorPos(cursorRef.current.x + (e.clientX - prevX) * speed, cursorRef.current.y + (e.clientY - prevY) * speed);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    clearLong();
    const now = performance.now();

    if (pts.current.size === 0) {
      const g = gesture.current;
      const wasTap = maxMove.current < TAP_SLOP && now - downT.current < TAP_MS;

      if (mode === "touch") {
        if (touchPressed.current) link.send({ type: "up", button: "left" });
        else if (wasTap && downCount.current === 1) link.send({ type: "click", button: "left" });
        if (downCount.current === 2 && wasTap && twoMode.current === "undecided") link.send({ type: "click", button: "right" });
      } else if (g === "dragging") {
        link.send({ type: "up", button: "left" });
      } else if (g === "two") {
        if (twoMode.current === "undecided" && wasTap && downCount.current === 2) link.send({ type: "click", button: "right" });
      } else if (g === "cursor" && wasTap && downCount.current === 1) {
        link.send({ type: "click", button: "left" });
        lastTapUp.current = now; // enables double-tap-drag & native double-click
      }

      gesture.current = "none";
      twoMode.current = "undecided";
      prevMid.current = null;
      armedDrag.current = false;
      touchPressed.current = false;
      downCount.current = 0;
    } else if (pts.current.size === 1) {
      // Dropped to one finger — reset its origin so the pointer doesn't jump.
      const [rem] = [...pts.current.values()];
      rem.sx = rem.x;
      rem.sy = rem.y;
      gesture.current = mode === "touch" ? "touchdrag" : "cursor";
      twoMode.current = "undecided";
      prevMid.current = null;
    }
  };

  // ----- keyboard -----
  const releaseMods = () => {
    if (mods.size === 0) return;
    mods.forEach((m) => link.send({ type: "keyup", name: m }));
    setMods(new Set());
  };
  const toggleMod = (m: Mod) => {
    setMods((prev) => {
      const next = new Set(prev);
      if (next.has(m)) {
        next.delete(m);
        link.send({ type: "keyup", name: m });
      } else {
        next.add(m);
        link.send({ type: "keydown", name: m });
      }
      return next;
    });
  };
  /** Fire a named key wrapped in any sticky modifiers, then release them. */
  const tapKey = (name: string) => {
    link.send({ type: "key", name });
    releaseMods();
  };

  // Android soft keyboards report keyCode 229 / "Unidentified" on keydown, so we
  // can't read typed characters from key events. Instead the hidden field
  // accumulates and we diff its value on every `input` -- reliably capturing
  // typing, autocomplete, emoji and backspace across every IME. `keydown` is used
  // only for navigation keys (and to swallow Enter so it never reaches the PC).
  const prevVal = useRef("");
  const composing = useRef(false);

  const resetField = () => {
    const el = kbdRef.current;
    if (!el) return;
    el.value = "";
    prevVal.current = "";
  };

  /** Send whatever changed in the field since the last input (direct mode). */
  const flushDiff = () => {
    const el = kbdRef.current;
    if (!el) return;
    const val = el.value;
    const prev = prevVal.current;
    if (val === prev) return;
    let i = 0;
    const min = Math.min(val.length, prev.length);
    while (i < min && val[i] === prev[i]) i++;
    const removed = prev.length - i;
    const added = val.slice(i);
    for (let k = 0; k < removed; k++) link.send({ type: "key", name: "backspace" });
    if (added) {
      if (mods.size > 0 && added.length === 1) tapKey(added.toLowerCase());
      else {
        link.send({ type: "text", value: added });
        releaseMods();
      }
    }
    prevVal.current = val;
    // Keep the field from growing unbounded; reset the base without emitting keys.
    if (val.length > 240) resetField();
  };

  const onKbdInput = () => {
    if (kbMode === "buffered") return; // sent on Enter
    if (composing.current) return; // wait for compositionend (CJK/IME)
    flushDiff();
  };

  // Buffered mode: flush the whole composed line to the PC -- never a PC Enter.
  const sendBuffer = () => {
    const el = kbdRef.current;
    const val = el?.value ?? "";
    if (val) {
      link.send({ type: "text", value: val });
      releaseMods();
    }
    resetField();
  };

  const onKbdKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Android Enter must NEVER press Enter on the PC. Buffered mode sends the line;
    // direct mode does nothing here (use the dock's Enter key for a real PC Enter).
    if (e.key === "Enter") {
      e.preventDefault();
      if (kbMode === "buffered") sendBuffer();
      return;
    }
    // Hardware-keyboard navigation (soft keyboards rarely emit these).
    const nav: Record<string, string> = {
      Tab: "tab",
      Escape: "escape",
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
      Home: "home",
      End: "end",
      PageUp: "pageup",
      PageDown: "pagedown",
    };
    const name = nav[e.key];
    if (name) {
      e.preventDefault();
      tapKey(name);
    }
  };
  // Reset the field whenever the mode changes so diffs start clean.
  useEffect(() => {
    resetField();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kbMode]);

  /** Run a chord as an explicit hold→press→release sequence (independent of sticky). */
  const chord = (modKeys: Mod[], key?: string) => {
    modKeys.forEach((m) => link.send({ type: "keydown", name: m }));
    if (key) link.send({ type: "key", name: key });
    [...modKeys].reverse().forEach((m) => link.send({ type: "keyup", name: m }));
    navigator.vibrate?.(8);
  };

  const screenshot = () => {
    const v = videoRef.current;
    if (hasStream && v && v.videoWidth) {
      const tmp = document.createElement("canvas");
      tmp.width = v.videoWidth;
      tmp.height = v.videoHeight;
      tmp.getContext("2d")?.drawImage(v, 0, 0);
      const a = document.createElement("a");
      a.href = tmp.toDataURL("image/jpeg", 0.92);
      a.download = `remote-${Date.now()}.jpg`;
      a.click();
      return;
    }
    const c = canvasRef.current;
    if (!c || !c.width) return;
    const a = document.createElement("a");
    a.href = c.toDataURL("image/jpeg", 0.92);
    a.download = `remote-${Date.now()}.jpg`;
    a.click();
  };
  const toggleKeyboard = () => {
    if (kbdOpen) kbdRef.current?.blur();
    else kbdRef.current?.focus();
  };

  const zoomed = zoom > 1.01 || pan.x !== 0 || pan.y !== 0;
  const cursorScreen = useMemo(() => {
    const l = layoutRef.current;
    return l ? normToScreen(l, zoom, pan.x, pan.y, cursor.x, cursor.y) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, zoom, pan]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black select-none">
      {/* ---- screen viewport ---- */}
      <div
        ref={viewportRef}
        className="absolute inset-0 flex items-center justify-center overflow-hidden touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          hidden={!hasStream}
          onLoadedMetadata={onVideoSized}
          onResize={onVideoSized}
          className="max-h-full max-w-full select-none object-contain will-change-transform"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "center center" }}
        />
        <canvas
          ref={canvasRef}
          hidden={hasStream}
          className="max-h-full max-w-full select-none object-contain will-change-transform"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "center center" }}
        />
        {mode === "trackpad" && connected && cursorScreen && (
          <div className="pointer-events-none absolute z-10" style={{ left: cursorScreen.x, top: cursorScreen.y, transform: "translate(-2px,-2px)" }}>
            <MousePointer2 className="h-6 w-6 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]" fill="rgba(0,0,0,0.35)" />
          </div>
        )}
        {!connected && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-sm text-white backdrop-blur">
              <Loader2 className="h-4 w-4 animate-spin" /> Reconnecting…
            </div>
          </div>
        )}
      </div>

      {/* ---- immersive restore chip ---- */}
      {immersive && (
        <button onClick={() => setImmersive(false)} className="absolute left-3 top-3 z-50 flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-xs font-700 text-white backdrop-blur active:scale-95">
          <Minimize2 className="h-3.5 w-3.5" /> Show controls
        </button>
      )}

      {/* ---- top status bar ---- */}
      {!immersive && (
        <div
          className="absolute left-3 right-3 z-40 flex items-center justify-between gap-2"
          style={{ top: "max(0.75rem, calc(env(safe-area-inset-top) + 0.25rem))" }}
        >
          <div className="relative flex items-center gap-2 rounded-2xl glass border border-white/[0.08] px-2.5 py-1.5 shadow-float">
            {onNavigate && (
              <button
                onClick={() => setNavOpen((o) => !o)}
                className="grid h-7 w-7 place-items-center rounded-lg text-ink-soft active:bg-white/[0.08]"
                title="Go to…"
              >
                <Menu className="h-4 w-4" />
              </button>
            )}
            {onNavigate && navOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setNavOpen(false)} />
                <div className="absolute left-0 top-[calc(100%+6px)] z-50 flex flex-col gap-0.5 rounded-2xl glass border border-white/[0.08] p-1.5 shadow-float">
                  {([
                    { id: "stats", label: "Stats", icon: BarChart3 },
                    { id: "library", label: "Library", icon: LibraryIcon },
                    { id: "music", label: "Music", icon: Headphones },
                  ] as const).map((t) => (
                    <button
                      key={t.id}
                      onClick={() => {
                        setNavOpen(false);
                        onNavigate(t.id);
                      }}
                      className="flex items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-700 text-ink-soft active:bg-white/[0.08]"
                    >
                      <t.icon className="h-4 w-4" /> {t.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            {connected ? (
              <span className="flex items-center gap-1.5 text-xs font-700 text-green">
                <span className="h-2 w-2 rounded-full bg-green" style={{ boxShadow: "0 0 8px #34d399" }} />
                Live
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-700 text-ink-dim">
                <Loader2 className="h-3 w-3 animate-spin" /> Connecting
              </span>
            )}
            {showStats && (
              <span className="flex items-center gap-1.5 border-l border-white/10 pl-2 text-[10px] font-700 text-ink-faint">
                <Wifi className="h-3 w-3" /> {fps} fps{res && <span className="text-ink-dim"> · {res}</span>}
              </span>
            )}
            {pcTextField && (
              <span className="flex items-center gap-1.5 border-l border-white/10 pl-2 text-[10px] font-700 text-accent-3">
                <Keyboard className="h-3 w-3" /> Typing on PC
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {monitors.length > 1 && (
              <button
                onClick={() => selectMonitor((monitorIdx + 1) % monitors.length)}
                className="flex items-center gap-1 rounded-xl glass border border-white/[0.08] px-2.5 py-1.5 text-xs font-700 text-ink-soft shadow-float active:scale-95"
                title="Switch display"
              >
                <Monitor className="h-3.5 w-3.5" /> {monitorIdx + 1}/{monitors.length}
              </button>
            )}
            {zoomed && (
              <button onClick={resetView} className="flex items-center gap-1 rounded-xl glass border border-white/[0.08] px-2.5 py-1.5 text-xs font-700 text-white shadow-float active:scale-95">
                <RotateCcw className="h-3.5 w-3.5" /> {zoom.toFixed(1)}×
              </button>
            )}
            <button onClick={screenshot} className="grid h-9 w-9 place-items-center rounded-xl glass border border-white/[0.08] text-ink-soft shadow-float active:scale-95" title="Save frame">
              <Camera className="h-4 w-4" />
            </button>
            <button onClick={() => setImmersive(true)} className="grid h-9 w-9 place-items-center rounded-xl glass border border-white/[0.08] text-ink-soft shadow-float active:scale-95" title="Fullscreen">
              <Maximize2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ---- floating keyboard button (always reachable) ---- */}
      {!immersive && !kbdOpen && (
        <button
          onClick={toggleKeyboard}
          className="absolute left-5 z-50 grid h-12 w-12 place-items-center rounded-full glass border border-white/[0.08] text-white shadow-float active:scale-95"
          style={{ bottom: "max(1.25rem, calc(env(safe-area-inset-bottom) + 0.75rem))" }}
          title="Keyboard"
        >
          <Keyboard className="h-5 w-5" />
        </button>
      )}

      {/* ---- FAB: toggle dock ---- */}
      {!immersive && (
        <button
          onClick={() => setDockOpen((v) => !v)}
          className="absolute right-5 z-50 grid h-14 w-14 place-items-center rounded-full bg-accent-3 text-white shadow-glow active:scale-95"
          style={{
            bottom: "max(1.25rem, calc(env(safe-area-inset-bottom) + 0.75rem))",
            transform: kbdOpen ? "translateY(-320px)" : "none",
          }}
        >
          {dockOpen ? <X className="h-6 w-6" /> : <Grip className="h-6 w-6" />}
        </button>
      )}

      {/* ---- keyboard compose bar (always mounted so focus() works from anywhere) ---- */}
      <div
        className={`absolute inset-x-0 z-[60] px-3 transition-all duration-200 ${
          kbdOpen ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-4 opacity-0"
        }`}
        style={{ bottom: "max(0.75rem, calc(env(safe-area-inset-bottom) + 0.5rem))" }}
      >
        <div className="flex items-center gap-2 rounded-2xl glass border border-white/[0.08] p-2 shadow-float">
          <button
            onClick={() => setKbMode((m) => (m === "direct" ? "buffered" : "direct"))}
            className="shrink-0 rounded-xl border border-white/[0.08] px-2.5 py-2 text-[11px] font-700 text-ink-soft active:bg-white/[0.08]"
            title="Direct sends each keystroke live; Buffered sends the line on Enter"
          >
            {kbMode === "direct" ? "Direct" : "Buffered"}
          </button>
          <input
            ref={kbdRef}
            onInput={onKbdInput}
            onKeyDown={onKbdKeyDown}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => {
              composing.current = false;
              onKbdInput();
            }}
            onFocus={() => {
              setKbdOpen(true);
              resetField();
            }}
            onBlur={() => setKbdOpen(false)}
            className="min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-accent-3"
            placeholder={kbMode === "buffered" ? "Type, then Enter to send" : "Type - keys go to your PC"}
            inputMode="text"
            enterKeyHint={kbMode === "buffered" ? "send" : "done"}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
          {kbMode === "buffered" && (
            <button onClick={sendBuffer} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-3 text-white active:scale-95" title="Send to PC">
              <Send className="h-4 w-4" />
            </button>
          )}
          <button onClick={() => kbdRef.current?.blur()} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-ink-dim active:bg-white/[0.08]" title="Close keyboard">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ---- bottom command dock ---- */}
      {!immersive && (
        <div
          className={`absolute inset-x-3 z-40 max-h-[46vh] overflow-y-auto rounded-2xl glass border border-white/[0.08] p-2 shadow-float transition-all duration-300 ${
            dockOpen ? "translate-y-0 opacity-100" : "translate-y-[130%] opacity-0 pointer-events-none"
          }`}
          style={{ marginRight: "4.75rem", bottom: "max(0.6rem, calc(env(safe-area-inset-bottom) + 0.4rem))" }}
        >
          <div className="mb-1.5 flex gap-1 rounded-xl bg-white/[0.03] p-0.5 text-xs">
            <DockTab active={dockTab === "mouse"} onClick={() => setDockTab("mouse")} icon={<MousePointer2 className="h-3.5 w-3.5" />} label="Mouse" />
            <DockTab active={dockTab === "keys"} onClick={() => setDockTab("keys")} icon={<Keyboard className="h-3.5 w-3.5" />} label="Keys" />
            <DockTab active={dockTab === "shortcuts"} onClick={() => setDockTab("shortcuts")} icon={<Command className="h-3.5 w-3.5" />} label="Shortcuts" />
            <DockTab active={dockTab === "quality"} onClick={() => setDockTab("quality")} icon={<Gauge className="h-3.5 w-3.5" />} label="Quality" />
          </div>

          {dockTab === "mouse" && (
            <div className="flex flex-col gap-2.5">
              <div className="flex gap-1 rounded-2xl bg-white/[0.03] p-1 text-xs">
                <Seg active={mode === "trackpad"} onClick={() => setMode("trackpad")} icon={<Pointer className="h-3.5 w-3.5" />} label="Trackpad" />
                <Seg active={mode === "touch"} onClick={() => setMode("touch")} icon={<Hand className="h-3.5 w-3.5" />} label="Direct touch" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Chip onClick={() => link.send({ type: "click", button: "left" })} icon={<MousePointer2 className="h-3.5 w-3.5" />}>Left</Chip>
                <Chip onClick={() => link.send({ type: "click", button: "right" })} icon={<MousePointerClick className="h-3.5 w-3.5" />}>Right</Chip>
                <Chip onClick={() => link.send({ type: "click", button: "middle" })} icon={<Pointer className="h-3.5 w-3.5" />}>Middle</Chip>
                {mode === "trackpad" && (
                  <Chip
                    active={dragLock}
                    onClick={() => {
                      if (dragLock) {
                        link.send({ type: "up", button: "left" });
                        setDragLock(false);
                      } else setDragLock(true);
                    }}
                    icon={<Hand className="h-3.5 w-3.5" />}
                  >
                    {dragLock ? "Drag: ON" : "Drag lock"}
                  </Chip>
                )}
                <Chip onClick={() => link.send({ type: "scroll", dy: -3 })} icon={<ChevronUp className="h-3.5 w-3.5" />}>Scroll ↑</Chip>
                <Chip onClick={() => link.send({ type: "scroll", dy: 3 })} icon={<ChevronDown className="h-3.5 w-3.5" />}>Scroll ↓</Chip>
              </div>
              <div className="flex items-center gap-3 px-1 text-[11px] text-ink-dim">
                <span className="whitespace-nowrap">Pointer speed</span>
                <input type="range" min="0.6" max="3.5" step="0.1" value={sensitivity} onChange={(e) => setSensitivity(parseFloat(e.target.value))} className="flex-1 accent-accent-3" />
                <span className="w-8 text-right font-700 text-white">{sensitivity.toFixed(1)}×</span>
              </div>
              <p className="px-1 text-[10px] leading-relaxed text-ink-faint">
                {mode === "trackpad"
                  ? "Drag to move · tap = click · two-finger tap = right-click · two-finger drag = scroll · pinch to zoom · double-tap-drag = drag · long-press = right-click"
                  : "Tap where you want to click · drag to move directly · two-finger tap = right-click · two-finger drag = scroll · pinch to zoom"}
              </p>
            </div>
          )}

          {dockTab === "keys" && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-1.5">
                <Chip
                  active={kbdOpen}
                  onClick={() => (kbdOpen ? kbdRef.current?.blur() : kbdRef.current?.focus())}
                  icon={<Keyboard className="h-3.5 w-3.5" />}
                >
                  Keyboard
                </Chip>
                <Chip onClick={() => tapKey("escape")}>Esc</Chip>
                <Chip onClick={() => tapKey("tab")}>Tab</Chip>
                <IconChip onClick={() => tapKey("enter")}><CornerDownLeft className="h-4 w-4" /></IconChip>
                <IconChip onClick={() => tapKey("backspace")}><Delete className="h-4 w-4" /></IconChip>
                <Chip onClick={() => tapKey("delete")}>Del</Chip>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <ModChip active={mods.has("ctrl")} onClick={() => toggleMod("ctrl")}>Ctrl</ModChip>
                <ModChip active={mods.has("alt")} onClick={() => toggleMod("alt")}>Alt</ModChip>
                <ModChip active={mods.has("shift")} onClick={() => toggleMod("shift")}>Shift</ModChip>
                <ModChip active={mods.has("win")} onClick={() => toggleMod("win")}>Win</ModChip>
                <div className="ml-auto flex items-center gap-1 rounded-xl bg-white/[0.03] p-0.5">
                  <IconChip onClick={() => tapKey("left")}><ArrowLeft className="h-4 w-4" /></IconChip>
                  <div className="flex flex-col gap-0.5">
                    <IconChip onClick={() => tapKey("up")}><ArrowUp className="h-3.5 w-3.5" /></IconChip>
                    <IconChip onClick={() => tapKey("down")}><ArrowDown className="h-3.5 w-3.5" /></IconChip>
                  </div>
                  <IconChip onClick={() => tapKey("right")}><ArrowRight className="h-4 w-4" /></IconChip>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                  <button key={n} onClick={() => tapKey(`f${n}`)} className="h-7 min-w-[2rem] rounded-lg border border-white/[0.05] bg-white/[0.02] px-1.5 text-[11px] font-700 text-ink-soft active:bg-white/[0.08]">
                    F{n}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <IconChip onClick={() => tapKey("volumedown")}><Volume1 className="h-4 w-4" /></IconChip>
                <IconChip onClick={() => tapKey("volumeup")}><Volume2 className="h-4 w-4" /></IconChip>
                <IconChip onClick={() => tapKey("volumemute")}><VolumeX className="h-4 w-4" /></IconChip>
                <IconChip onClick={() => tapKey("prevtrack")}><SkipBack className="h-4 w-4" /></IconChip>
                <IconChip onClick={() => tapKey("playpause")}><PlayCircle className="h-4 w-4" /></IconChip>
                <IconChip onClick={() => tapKey("nexttrack")}><SkipForward className="h-4 w-4" /></IconChip>
              </div>
              <div className="flex items-center gap-1.5 rounded-2xl bg-white/[0.03] p-1 text-xs">
                <Seg active={kbMode === "direct"} onClick={() => setKbMode("direct")} icon={<Keyboard className="h-3.5 w-3.5" />} label="Direct" />
                <Seg active={kbMode === "buffered"} onClick={() => setKbMode("buffered")} icon={<Send className="h-3.5 w-3.5" />} label="Buffered" />
              </div>
              <p className="px-1 text-[10px] leading-relaxed text-ink-faint">
                {kbMode === "direct"
                  ? "Each keystroke goes to your PC live; Enter presses Enter."
                  : "Type on your phone, then Enter sends the whole line — Enter is not pressed on the PC."}
              </p>
            </div>
          )}

          {dockTab === "shortcuts" && (
            <div className="grid grid-cols-3 gap-1.5 text-xs">
              <Macro onClick={() => chord(["alt"], "tab")}>Alt + Tab</Macro>
              <Macro onClick={() => chord(["win"])}>⊞ Win</Macro>
              <Macro onClick={() => chord(["win"], "d")}>Show desktop</Macro>
              <Macro onClick={() => chord(["ctrl", "shift"], "escape")}>Task Manager</Macro>
              <Macro onClick={() => chord(["alt"], "f4")}>Close (Alt+F4)</Macro>
              <Macro onClick={() => chord(["win"], "e")}>File Explorer</Macro>
              <Macro onClick={() => chord(["ctrl"], "c")}>Copy</Macro>
              <Macro onClick={() => chord(["ctrl"], "v")}>Paste</Macro>
              <Macro onClick={() => chord(["ctrl"], "x")}>Cut</Macro>
              <Macro onClick={() => chord(["ctrl"], "z")}>Undo</Macro>
              <Macro onClick={() => chord(["ctrl"], "a")}>Select all</Macro>
              <Macro onClick={() => chord(["ctrl", "alt"], "delete")}>Ctrl+Alt+Del</Macro>
            </div>
          )}

          {dockTab === "quality" && (
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setPresetId(p.id)}
                    className={`flex flex-col items-start rounded-xl border px-2.5 py-1.5 text-left transition ${
                      presetId === p.id ? "border-accent-3 bg-accent-3/15 text-white" : "border-white/[0.06] bg-white/[0.02] text-ink-soft"
                    }`}
                  >
                    <span className="text-xs font-700">{p.label}</span>
                    <span className="text-[9px] text-ink-faint">{p.hint}</span>
                  </button>
                ))}
              </div>
              <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-2.5">
                <div className="mb-1.5 flex items-center justify-between text-[11px] font-700 text-ink-dim">
                  <span>Custom</span>
                  {presetId === "custom" && <span className="text-accent-3">active</span>}
                </div>
                <Slider label="Resolution" min={480} max={3840} step={80} value={custom.maxW} unit="px" onChange={(v) => { setCustom((c) => ({ ...c, maxW: v })); setPresetId("custom"); }} />
                <Slider label="Sharpness" min={20} max={95} step={1} value={custom.quality} unit="%" onChange={(v) => { setCustom((c) => ({ ...c, quality: v })); setPresetId("custom"); }} />
                <Slider label="Frame rate" min={10} max={60} step={2} value={custom.fps} unit="fps" onChange={(v) => { setCustom((c) => ({ ...c, fps: v })); setPresetId("custom"); }} />
              </div>
              <label className="flex items-center justify-between px-1 text-[11px] text-ink-dim">
                <span>Show performance stats</span>
                <input type="checkbox" checked={showStats} onChange={(e) => setShowStats(e.target.checked)} className="h-4 w-4 accent-accent-3" />
              </label>
              {monitors.length > 1 && (
                <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-2.5">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-700 text-ink-dim">
                    <Monitor className="h-3.5 w-3.5" /> Display
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {monitors.map((m) => (
                      <button
                        key={m.index}
                        onClick={() => selectMonitor(m.index)}
                        className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-700 transition ${
                          monitorIdx === m.index ? "border-accent-3 bg-accent-3/15 text-white" : "border-white/[0.06] bg-white/[0.02] text-ink-soft"
                        }`}
                      >
                        {m.name || `Display ${m.index + 1}`}
                        {m.isPrimary && <span className="text-[9px] text-ink-faint">primary</span>}
                        <span className="text-[9px] text-ink-faint">{m.width}×{m.height}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {onDisconnect && (
            <button onClick={onDisconnect} className="mt-2.5 flex h-8 w-full items-center justify-center gap-1.5 rounded-xl border border-red/15 bg-red/5 text-[11px] font-700 text-red active:bg-red/10">
              <LogOut className="h-3.5 w-3.5" /> Disconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- small UI pieces ----------
function DockTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={`flex flex-1 items-center justify-center gap-1 rounded-lg py-1 text-[11px] font-700 transition ${active ? "bg-white/[0.08] text-white shadow-sm" : "text-ink-dim"}`}>
      {icon} {label}
    </button>
  );
}
function Seg({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-1.5 font-700 transition ${active ? "bg-white/[0.08] text-white shadow-sm" : "text-ink-dim"}`}>
      {icon} {label}
    </button>
  );
}
function Chip({ onClick, children, icon, active }: { onClick: () => void; children: React.ReactNode; icon?: React.ReactNode; active?: boolean }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-700 transition active:scale-95 ${active ? "border-accent-3 bg-accent-3/15 text-white" : "border-white/[0.06] bg-white/[0.03] text-ink-soft"}`}>
      {icon} {children}
    </button>
  );
}
function IconChip({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="grid h-8 w-8 place-items-center rounded-xl border border-white/[0.06] bg-white/[0.03] text-ink-soft transition active:scale-95 active:bg-white/[0.08] active:text-white">
      {children}
    </button>
  );
}
function ModChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`rounded-xl border px-3 py-1.5 text-xs font-700 transition active:scale-95 ${active ? "border-accent-1 bg-accent-1 text-white shadow-glow" : "border-white/[0.06] bg-white/[0.03] text-ink-soft"}`}>
      {children}
    </button>
  );
}
function Macro({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-2 py-2.5 text-[11px] font-700 text-ink-soft transition active:scale-95 active:bg-white/[0.08] active:text-white">
      {children}
    </button>
  );
}
function Slider({ label, min, max, step, value, unit, onChange }: { label: string; min: number; max: number; step: number; value: number; unit: string; onChange: (v: number) => void }) {
  return (
    <div className="mb-1.5 flex items-center gap-3 text-[11px] text-ink-dim last:mb-0">
      <span className="w-20 whitespace-nowrap">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseInt(e.target.value, 10))} className="flex-1 accent-accent-3" />
      <span className="w-14 text-right font-700 text-white">{value}{unit}</span>
    </div>
  );
}
