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
  Type as TypeIcon,
  Film,
  Sparkles,
} from "lucide-react";
import type { ContentMode, QualitySettings, RemoteLink } from "../links";
import { apiGet } from "../link";
import type { RemoteMonitor, RemoteCaptureStats } from "@/lib/api";

type HostStats = RemoteCaptureStats & { producedFps?: number };
type NetStats = { fps: number; kbps: number; w: number; h: number; jitterMs: number; lostPkts: number; dropped: number; freezes: number };

// ---------- tuning constants ----------
const TAP_MS = 260; // max press time still counted as a tap
const TAP_SLOP = 12; // max finger travel (px) still counted as a tap
const DOUBLE_MS = 320; // window to chain a double-tap (→ double click / drag)
const LONGPRESS_MS = 550; // hold to fire a right-click
const SCROLL_STEP = 20; // finger px per wheel notch
const MAX_ZOOM = 6;
const FOLLOW_MARGIN = 72; // keep the cursor this far from the viewport edge when zoomed
const EDGE_MARGIN = 56; // trackpad edge zone (px): a held finger here auto-pans the cursor
const EDGE_SPEED = 0.016; // max cursor movement (fraction of the screen) per frame at the very edge

type Mode = "trackpad" | "touch";
type Mod = "ctrl" | "alt" | "shift" | "win";
type KbMode = "direct" | "buffered";
type NavTab = "stats" | "library" | "music" | "control";
/** Which bottom control panel is expanded (null = collapsed to just the tab strip). */
type Panel = "mouse" | "keys" | "shortcuts" | "quality" | "keyboard";

// Content optimization: tunes the whole pipeline (downscale filter, JPEG chroma,
// encoder content-hint + bitrate-degradation) for the kind of thing on screen.
const CONTENT_MODES: { id: ContentMode; label: string; hint: string; icon: typeof TypeIcon }[] = [
  { id: "auto", label: "Auto", hint: "Balanced", icon: Sparkles },
  { id: "text", label: "Text", hint: "Crisp UI / code", icon: TypeIcon },
  { id: "video", label: "Video", hint: "Smooth motion", icon: Film },
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
  // Debounced "Reconnecting…" overlay: WebRTC dips into "disconnected" briefly on
  // packet-loss blips and usually self-heals within a second — flashing the
  // overlay for those made the link feel flakier than it is.
  const [showReconnect, setShowReconnect] = useState(false);
  const [hasStream, setHasStream] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [mode, setMode] = useState<Mode>("trackpad");
  // Expanded bottom panel (null = collapsed). It pushes the viewport up, never overlaps.
  const [panel, setPanel] = useState<Panel | null>(null);
  const [immersive, setImmersive] = useState(false);
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

  // Live stream quality (sliders only). `bitrate` is kbps.
  const [streamQ, setStreamQ] = useState({ maxW: 1600, quality: 55, fps: 40, bitrate: 12000 });
  // Content optimization: sharpen for text/UI, smooth for video, or auto.
  const [contentMode, setContentMode] = useState<ContentMode>("auto");
  const [showStats, setShowStats] = useState(false);
  const [fps, setFps] = useState(0);
  const [res, setRes] = useState("");
  const frameTimes = useRef<number[]>([]);
  // Debug telemetry: host capture pipeline + decode-side WebRTC stats.
  const [hostStats, setHostStats] = useState<HostStats | null>(null);
  const [net, setNet] = useState<NetStats | null>(null);
  const prodRef = useRef<{ frames: number; at: number } | null>(null);
  const netRef = useRef<{ bytes: number; at: number } | null>(null);

  // Multi-monitor.
  const [monitors, setMonitors] = useState<RemoteMonitor[]>([]);
  const [monitorIdx, setMonitorIdx] = useState(0);

  const activeQuality = useMemo<QualitySettings>(
    () => ({ ...streamQ, mode: contentMode }),
    [streamQ, contentMode],
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
      setHasAudio(stream.getAudioTracks().length > 0);
      stream.addEventListener?.("addtrack", (e) => {
        if ((e as MediaStreamTrackEvent).track?.kind === "audio") setHasAudio(true);
      });
      v.play?.().catch(() => {});
    });
    // Host events: auto-pop the keyboard on PC text-field focus + capture telemetry.
    link.onEvent((e) => {
      if (e.event === "focus") handleFocusEvent(!!(e as { textField?: boolean }).textField);
      else if (e.event === "capstats") {
        const cs = (e as { stats?: RemoteCaptureStats }).stats;
        if (!cs) return;
        const now = performance.now();
        const prev = prodRef.current;
        let producedFps: number | undefined;
        if (prev && now > prev.at) {
          const df = cs.producedFrames - prev.frames;
          if (df >= 0) producedFps = Math.round((df * 1000) / (now - prev.at));
        }
        prodRef.current = { frames: cs.producedFrames, at: now };
        setHostStats({ ...cs, producedFps });
      }
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

  // Load the monitor list once connected (for the display switcher). The data
  // channel can lag the "connected" signal, so retry until it answers — otherwise
  // the quick display-switch button would silently never appear.
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    let tries = 0;
    const load = async () => {
      if (!alive) return;
      try {
        const m = await apiGet<RemoteMonitor[]>("/api/monitors");
        if (alive && m && m.length) {
          setMonitors(m);
          return;
        }
      } catch {
        /* channel not ready yet */
      }
      if (alive && tries++ < 10) window.setTimeout(load, 800);
    };
    load();
    return () => {
      alive = false;
    };
  }, [connected]);

  // Poll decode-side WebRTC video stats (bitrate/fps/jitter/loss) while the HUD
  // is open, so the phone can show where the frame-rate bottleneck actually is.
  useEffect(() => {
    if (!showStats) return;
    let alive = true;
    const id = window.setInterval(async () => {
      const s = await link.netStats().catch(() => null);
      if (!alive || !s) return;
      const prev = netRef.current;
      let kbps = 0;
      if (prev && s.at > prev.at) kbps = Math.round(((s.bytesReceived - prev.bytes) * 8) / (s.at - prev.at));
      netRef.current = { bytes: s.bytesReceived, at: s.at };
      setNet({
        fps: Math.round(s.framesPerSecond || 0),
        kbps,
        w: s.frameWidth,
        h: s.frameHeight,
        jitterMs: Math.round((s.jitter || 0) * 1000),
        lostPkts: s.packetsLost,
        dropped: s.framesDropped,
        freezes: s.freezeCount,
      });
    }, 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [link, showStats]);

  const selectMonitor = (i: number) => {
    setMonitorIdx(i);
    link.send({ type: "monitor", index: i });
    resetView();
  };

  // Push quality to the desktop whenever it changes AND on every (re)connect.
  // Sends before the control channel opens are dropped silently, so retry a
  // couple of times shortly after — the message is idempotent on the host.
  useEffect(() => {
    if (!connected) return;
    link.setQuality(activeQuality);
    const t1 = window.setTimeout(() => link.setQuality(activeQuality), 1200);
    const t2 = window.setTimeout(() => link.setQuality(activeQuality), 4000);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [link, activeQuality, connected]);

  // Only surface "Reconnecting…" after the link has been down for a moment.
  useEffect(() => {
    if (connected) {
      setShowReconnect(false);
      return;
    }
    const t = window.setTimeout(() => setShowReconnect(true), 1200);
    return () => window.clearTimeout(t);
  }, [connected]);

  // Sample fps once a second for the stats overlay.
  useEffect(() => {
    const id = window.setInterval(() => setFps(frameTimes.current.length), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Keep layout measurement fresh on resize / orientation change. A ResizeObserver
  // also catches the viewport shrinking/growing when a bottom panel opens/closes
  // (it now occupies real space instead of overlaying) — without it the cursor and
  // touch-to-screen mapping would drift by the panel's height.
  useEffect(() => {
    const remeasure = () => {
      const l = measure(viewportRef.current, natRef.current.w, natRef.current.h);
      if (l) layoutRef.current = l;
    };
    remeasure();
    window.addEventListener("resize", remeasure);
    window.addEventListener("orientationchange", remeasure);
    let ro: ResizeObserver | undefined;
    if (viewportRef.current && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(remeasure);
      ro.observe(viewportRef.current);
    }
    return () => {
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("orientationchange", remeasure);
      ro?.disconnect();
    };
  }, []);

  // Cancel any in-flight edge-pan frame if the screen unmounts mid-drag.
  useEffect(() => () => {
    if (edgeRaf.current != null) cancelAnimationFrame(edgeRaf.current);
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

  // ----- edge auto-pan (trackpad): holding a finger at a screen edge keeps nudging
  // the remote cursor in that direction, so you can reach anywhere on a big PC
  // display from a small phone without lifting/repositioning. Runs while a single
  // finger drives the cursor (moving or dragging); speed scales with edge depth.
  const edgeRaf = useRef<number | null>(null);
  const fingerPos = useRef({ x: 0, y: 0 });
  const edgeTick = () => {
    const r = viewportRef.current?.getBoundingClientRect();
    // Keep looping for the whole single-finger trackpad gesture...
    const gestureAlive = pts.current.size === 1 && (gesture.current === "cursor" || gesture.current === "dragging");
    if (!r || mode !== "trackpad" || !gestureAlive) {
      edgeRaf.current = null;
      return;
    }
    // ...but only pan once it's clearly a drag (or drag-lock) — never during a
    // stationary tap or long-press that merely happens to land near an edge.
    const panning = gesture.current === "dragging" || maxMove.current > TAP_SLOP;
    if (panning) {
      const fx = fingerPos.current.x - r.left;
      const fy = fingerPos.current.y - r.top;
      let vx = 0;
      let vy = 0;
      if (fx < EDGE_MARGIN) vx = -(EDGE_MARGIN - fx) / EDGE_MARGIN;
      else if (fx > r.width - EDGE_MARGIN) vx = (fx - (r.width - EDGE_MARGIN)) / EDGE_MARGIN;
      if (fy < EDGE_MARGIN) vy = -(EDGE_MARGIN - fy) / EDGE_MARGIN;
      else if (fy > r.height - EDGE_MARGIN) vy = (fy - (r.height - EDGE_MARGIN)) / EDGE_MARGIN;
      if (vx !== 0 || vy !== 0) {
        // Ease-in on depth so the edge feels gentle near the boundary, fast at the rim.
        setCursorPos(cursorRef.current.x + vx * Math.abs(vx) * EDGE_SPEED, cursorRef.current.y + vy * Math.abs(vy) * EDGE_SPEED);
      }
    }
    edgeRaf.current = requestAnimationFrame(edgeTick);
  };
  const startEdgePan = () => {
    if (edgeRaf.current == null && mode === "trackpad") edgeRaf.current = requestAnimationFrame(edgeTick);
  };
  const stopEdgePan = () => {
    if (edgeRaf.current != null) {
      cancelAnimationFrame(edgeRaf.current);
      edgeRaf.current = null;
    }
  };

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
    fingerPos.current = { x: e.clientX, y: e.clientY };

    if (pts.current.size === 1) {
      downT.current = now;
      maxMove.current = 0;
      downCount.current = 1;
      touchPressed.current = false;
      armedDrag.current = false;
      gesture.current = mode === "touch" ? "touchdrag" : "cursor";
      if (mode === "trackpad") startEdgePan();

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
      stopEdgePan(); // two-finger gesture (pinch/scroll) — no cursor edge-pan
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
    fingerPos.current = { x: e.clientX, y: e.clientY }; // feed the edge-pan loop
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
      stopEdgePan(); // finger lifted — stop nudging the cursor
    } else if (pts.current.size === 1) {
      // Dropped to one finger — reset its origin so the pointer doesn't jump.
      const [rem] = [...pts.current.values()];
      rem.sx = rem.x;
      rem.sy = rem.y;
      fingerPos.current = { x: rem.x, y: rem.y };
      gesture.current = mode === "touch" ? "touchdrag" : "cursor";
      twoMode.current = "undecided";
      prevMid.current = null;
      if (mode === "trackpad") startEdgePan(); // back to single-finger cursor control
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
  // Open/close a bottom panel; the keyboard panel also focuses/blurs the input so
  // the soft keyboard follows. Tapping an already-open panel collapses it.
  const openPanel = (id: Panel) => {
    const next = panel === id ? null : id;
    setPanel(next);
    if (id === "keyboard") {
      if (next) window.setTimeout(() => kbdRef.current?.focus(), 30);
      else kbdRef.current?.blur();
    }
  };
  // Mobile browsers only allow audio to start from a user gesture, so PC sound is
  // muted until the user taps this — then we unmute the video element's audio track.
  const toggleSound = () => {
    const v = videoRef.current;
    if (!v) return;
    const next = !soundOn;
    v.muted = !next;
    if (next) v.play?.().catch(() => {});
    setSoundOn(next);
  };

  const zoomed = zoom > 1.01 || pan.x !== 0 || pan.y !== 0;
  const cursorScreen = useMemo(() => {
    const l = layoutRef.current;
    return l ? normToScreen(l, zoom, pan.x, pan.y, cursor.x, cursor.y) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, zoom, pan]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-black select-none">
      {/* ==== viewport area — takes the remaining height; shrinks when a panel opens ==== */}
      <div className="relative min-h-0 flex-1">
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
        {showReconnect && (
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
              <button
                onClick={() => kbdRef.current?.focus()}
                className="flex items-center gap-1.5 border-l border-white/10 pl-2 text-[10px] font-700 text-accent-3 active:scale-95"
                title="A PC text field is focused — tap to type"
              >
                <Keyboard className="h-3 w-3" /> Typing on PC
              </button>
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
            {hasAudio && (
              <button
                onClick={toggleSound}
                className={`grid h-9 w-9 place-items-center rounded-xl glass border shadow-float active:scale-95 ${
                  soundOn ? "border-accent-3/40 text-accent-3" : "border-white/[0.08] text-ink-soft"
                }`}
                title={soundOn ? "Mute PC sound" : "Play PC sound"}
              >
                {soundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
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

      {/* ---- performance / debug HUD ---- */}
      {showStats && !immersive && (
        <div
          className="absolute right-3 z-30 w-[16.5rem] max-w-[80vw] rounded-2xl glass border border-white/[0.08] p-2.5 text-[10px] leading-relaxed text-ink-soft shadow-float"
          style={{ top: "max(3.6rem, calc(env(safe-area-inset-top) + 3rem))" }}
        >
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-800 text-white">
            <Gauge className="h-3.5 w-3.5 text-accent-3" /> Stream stats
          </div>
          <StatRow k="Display (phone)" v={`${fps} fps${res ? ` · ${res}` : ""}`} />
          {net && (
            <>
              <StatRow k="Decode" v={`${net.fps} fps · ${net.w}×${net.h}`} />
              <StatRow k="Bitrate" v={net.kbps >= 1000 ? `${(net.kbps / 1000).toFixed(1)} Mbps` : `${net.kbps} kbps`} />
              <StatRow k="Jitter / loss" v={`${net.jitterMs} ms · ${net.lostPkts} pkt`} />
              <StatRow k="Dropped / freezes" v={`${net.dropped} · ${net.freezes}`} />
            </>
          )}
          {hostStats && (
            <>
              <div className="my-1 border-t border-white/[0.06]" />
              <StatRow k="Host produce" v={`${hostStats.producedFps ?? "–"} fps (target ${hostStats.fps})`} />
              <StatRow k="Capture / scale" v={`${hostStats.captureMs.toFixed(1)} · ${hostStats.scaleMs.toFixed(1)} ms`} />
              <StatRow k="Encode" v={`${hostStats.encodeMs.toFixed(1)} ms`} />
              <StatRow k="Frame size" v={`${(hostStats.frameBytes / 1024).toFixed(0)} KB`} />
              <StatRow k="Resolution" v={`${hostStats.nativeW}×${hostStats.nativeH} → ${hostStats.outW}×${hostStats.outH}`} />
            </>
          )}
          <div className="mt-1.5 rounded-lg bg-white/[0.04] px-2 py-1 text-[10px] font-700 text-accent-3">
            {bottleneckHint(hostStats, net)}
          </div>
        </div>
      )}

      {/* ---- "tap to type" prompt when a PC text field is focused ---- */}
      {!immersive && panel !== "keyboard" && pcTextField && (
        <button
          onClick={() => openPanel("keyboard")}
          className="absolute bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-accent-3 px-4 py-2 text-xs font-800 text-white shadow-glow active:scale-95"
        >
          <Keyboard className="h-4 w-4" /> Tap to type on PC
        </button>
      )}
      </div>{/* ==== end viewport area ==== */}

      {/* ==== bottom control bar — collapsed = just the icon tab strip; expanding a
             panel grows this section and shrinks the viewport above (never overlaps) ==== */}
      {!immersive && (
        <div className="shrink-0 border-t border-white/10 bg-base/95 backdrop-blur" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          {/* keyboard compose row — always mounted so focus() works; height collapses to 0 when inactive */}
          <div className={`overflow-hidden transition-[max-height] duration-200 ${panel === "keyboard" ? "max-h-20" : "max-h-0"}`}>
            <div className="flex items-center gap-1.5 border-b border-white/5 px-2 py-2">
              {/* Direct / Buffered — an obvious two-state toggle, right in the field row */}
              <div className="flex shrink-0 rounded-lg bg-white/[0.05] p-0.5">
                <button onClick={() => setKbMode("direct")} title="Direct: each keystroke is sent live" className={`grid h-8 w-8 place-items-center rounded-md ${kbMode === "direct" ? "bg-accent-3 text-white" : "text-ink-dim"}`}><Keyboard className="h-4 w-4" /></button>
                <button onClick={() => setKbMode("buffered")} title="Buffered: type, then send the whole line" className={`grid h-8 w-8 place-items-center rounded-md ${kbMode === "buffered" ? "bg-accent-3 text-white" : "text-ink-dim"}`}><Send className="h-4 w-4" /></button>
              </div>
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
                  setPanel("keyboard");
                  resetField();
                }}
                onBlur={() => setPanel((p) => (p === "keyboard" ? null : p))}
                className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-accent-3"
                placeholder={kbMode === "buffered" ? "Type, then Enter to send" : "Type — keys go to your PC"}
                inputMode="text"
                enterKeyHint={kbMode === "buffered" ? "send" : "done"}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
              {kbMode === "buffered" && (
                <button onClick={sendBuffer} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-3 text-white active:scale-95" title="Send to PC">
                  <Send className="h-4 w-4" />
                </button>
              )}
              <button onClick={() => { kbdRef.current?.blur(); setPanel(null); }} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-dim active:bg-white/[0.08]" title="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* expanded control panels — each a single horizontally-scrollable row of icons */}
          {panel === "mouse" && (
            <div className="flex items-center gap-1.5 overflow-x-auto border-b border-white/5 px-2 py-2">
              <IcoBtn active title={mode === "trackpad" ? "Trackpad mode" : "Direct-touch mode"} onClick={() => setMode((m) => (m === "trackpad" ? "touch" : "trackpad"))}>
                {mode === "trackpad" ? <Pointer className="h-4 w-4" /> : <Hand className="h-4 w-4" />}
              </IcoBtn>
              <Sep />
              <IcoBtn title="Left click" onClick={() => link.send({ type: "click", button: "left" })}><MousePointer2 className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Right click" onClick={() => link.send({ type: "click", button: "right" })}><MousePointerClick className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Middle click" onClick={() => link.send({ type: "click", button: "middle" })}><Command className="h-4 w-4" /></IcoBtn>
              {mode === "trackpad" && (
                <IcoBtn active={dragLock} title={dragLock ? "Drag lock: ON" : "Drag lock"} onClick={() => { if (dragLock) { link.send({ type: "up", button: "left" }); setDragLock(false); } else setDragLock(true); }}>
                  <Hand className="h-4 w-4" />
                </IcoBtn>
              )}
              <IcoBtn title="Scroll up" onClick={() => link.send({ type: "scroll", dy: -3 })}><ChevronUp className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Scroll down" onClick={() => link.send({ type: "scroll", dy: 3 })}><ChevronDown className="h-4 w-4" /></IcoBtn>
              <Sep />
              <div className="flex shrink-0 items-center gap-1.5 pr-1" title="Pointer speed">
                <Gauge className="h-3.5 w-3.5 text-ink-dim" />
                <input type="range" min="0.6" max="3.5" step="0.1" value={sensitivity} onChange={(e) => setSensitivity(parseFloat(e.target.value))} className="w-24 accent-accent-3" />
                <span className="w-7 text-[10px] font-700 text-white">{sensitivity.toFixed(1)}×</span>
              </div>
            </div>
          )}

          {panel === "keys" && (
            <div className="flex items-center gap-1 overflow-x-auto border-b border-white/5 px-2 py-2">
              <KeyBtn onClick={() => tapKey("escape")}>Esc</KeyBtn>
              <KeyBtn onClick={() => tapKey("tab")}>Tab</KeyBtn>
              <IcoBtn title="Enter" onClick={() => tapKey("enter")}><CornerDownLeft className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Backspace" onClick={() => tapKey("backspace")}><Delete className="h-4 w-4" /></IcoBtn>
              <KeyBtn onClick={() => tapKey("delete")}>Del</KeyBtn>
              <Sep />
              <KeyBtn active={mods.has("ctrl")} onClick={() => toggleMod("ctrl")}>Ctrl</KeyBtn>
              <KeyBtn active={mods.has("alt")} onClick={() => toggleMod("alt")}>Alt</KeyBtn>
              <KeyBtn active={mods.has("shift")} onClick={() => toggleMod("shift")}>Shift</KeyBtn>
              <KeyBtn active={mods.has("win")} onClick={() => toggleMod("win")}>Win</KeyBtn>
              <Sep />
              <IcoBtn title="Left" onClick={() => tapKey("left")}><ArrowLeft className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Up" onClick={() => tapKey("up")}><ArrowUp className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Down" onClick={() => tapKey("down")}><ArrowDown className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Right" onClick={() => tapKey("right")}><ArrowRight className="h-4 w-4" /></IcoBtn>
              <Sep />
              {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                <KeyBtn key={n} onClick={() => tapKey(`f${n}`)}>F{n}</KeyBtn>
              ))}
              <Sep />
              <IcoBtn title="Volume down" onClick={() => tapKey("volumedown")}><Volume1 className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Volume up" onClick={() => tapKey("volumeup")}><Volume2 className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Mute" onClick={() => tapKey("volumemute")}><VolumeX className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Previous track" onClick={() => tapKey("prevtrack")}><SkipBack className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Play / pause" onClick={() => tapKey("playpause")}><PlayCircle className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Next track" onClick={() => tapKey("nexttrack")}><SkipForward className="h-4 w-4" /></IcoBtn>
            </div>
          )}

          {panel === "shortcuts" && (
            <div className="flex items-center gap-1 overflow-x-auto border-b border-white/5 px-2 py-2">
              <KeyBtn onClick={() => chord(["alt"], "tab")}>Alt+Tab</KeyBtn>
              <KeyBtn onClick={() => chord(["win"])}>Win</KeyBtn>
              <KeyBtn onClick={() => chord(["win"], "d")}>Desktop</KeyBtn>
              <KeyBtn onClick={() => chord(["ctrl", "shift"], "escape")}>Task&nbsp;Mgr</KeyBtn>
              <KeyBtn onClick={() => chord(["alt"], "f4")}>Alt+F4</KeyBtn>
              <KeyBtn onClick={() => chord(["win"], "e")}>Explorer</KeyBtn>
              <Sep />
              <KeyBtn onClick={() => chord(["ctrl"], "c")}>Copy</KeyBtn>
              <KeyBtn onClick={() => chord(["ctrl"], "v")}>Paste</KeyBtn>
              <KeyBtn onClick={() => chord(["ctrl"], "x")}>Cut</KeyBtn>
              <KeyBtn onClick={() => chord(["ctrl"], "z")}>Undo</KeyBtn>
              <KeyBtn onClick={() => chord(["ctrl"], "a")}>All</KeyBtn>
              <KeyBtn onClick={() => chord(["ctrl", "alt"], "delete")}>Ctrl+Alt+Del</KeyBtn>
            </div>
          )}

          {panel === "quality" && (
            <div className="flex items-center gap-2 overflow-x-auto border-b border-white/5 px-2 py-2">
              <div className="flex shrink-0 rounded-lg bg-white/[0.05] p-0.5">
                {CONTENT_MODES.map((m) => (
                  <button key={m.id} onClick={() => setContentMode(m.id)} title={`${m.label} — ${m.hint}`} className={`grid h-8 w-8 place-items-center rounded-md ${contentMode === m.id ? "bg-accent-3 text-white" : "text-ink-dim"}`}>
                    <m.icon className="h-4 w-4" />
                  </button>
                ))}
              </div>
              <Sep />
              <QSlider icon={<Monitor className="h-3.5 w-3.5" />} label="Res" min={480} max={3840} step={80} value={streamQ.maxW} fmt={(v) => `${v}`} onChange={(v) => setStreamQ((p) => ({ ...p, maxW: v }))} />
              <QSlider icon={<Sparkles className="h-3.5 w-3.5" />} label="Sharp" min={20} max={95} step={1} value={streamQ.quality} fmt={(v) => `${v}`} onChange={(v) => setStreamQ((p) => ({ ...p, quality: v }))} />
              <QSlider icon={<Film className="h-3.5 w-3.5" />} label="FPS" min={10} max={60} step={2} value={streamQ.fps} fmt={(v) => `${v}`} onChange={(v) => setStreamQ((p) => ({ ...p, fps: v }))} />
              <QSlider icon={<Wifi className="h-3.5 w-3.5" />} label="Mbps" min={1000} max={40000} step={500} value={streamQ.bitrate} fmt={(v) => (v / 1000).toFixed(1)} onChange={(v) => setStreamQ((p) => ({ ...p, bitrate: v }))} />
              <Sep />
              <IcoBtn active={showStats} title="Performance stats" onClick={() => setShowStats((s) => !s)}><Gauge className="h-4 w-4" /></IcoBtn>
            </div>
          )}

          {/* always-visible icon tab strip */}
          <div className="flex items-center gap-1 px-1.5 py-1.5">
            <Tab active={panel === "mouse"} onClick={() => openPanel("mouse")} title="Mouse"><MousePointer2 className="h-5 w-5" /></Tab>
            <Tab active={panel === "keys"} onClick={() => openPanel("keys")} title="Special keys"><Command className="h-5 w-5" /></Tab>
            <Tab active={panel === "shortcuts"} onClick={() => openPanel("shortcuts")} title="Shortcuts"><Grip className="h-5 w-5" /></Tab>
            <Tab active={panel === "keyboard"} onClick={() => openPanel("keyboard")} title="Keyboard"><Keyboard className="h-5 w-5" /></Tab>
            <Tab active={panel === "quality"} onClick={() => openPanel("quality")} title="Quality"><Gauge className="h-5 w-5" /></Tab>
            {onDisconnect && (
              <button onClick={onDisconnect} title="Disconnect" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-red/20 bg-red/5 text-red active:scale-95">
                <LogOut className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- small UI pieces ----------
function StatRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-ink-faint">{k}</span>
      <span className="font-700 text-white">{v}</span>
    </div>
  );
}

/** A plain-language guess at where the frame-rate is being lost. */
function bottleneckHint(host: HostStats | null, net: NetStats | null): string {
  if (!host && !net) return "Gathering stats…";
  const target = host?.fps ?? 30;
  const produced = host?.producedFps;
  const hostCpuMs = host ? host.captureMs + host.scaleMs + host.encodeMs : 0;
  // Host can't produce near the target and is spending real time doing it → CPU-bound.
  if (host && produced != null && produced < target * 0.75 && hostCpuMs > 12) {
    const worst = host.encodeMs >= host.scaleMs && host.encodeMs >= host.captureMs ? "encode" : host.scaleMs >= host.captureMs ? "downscale" : "capture";
    return `Bottleneck: host CPU (${worst}). Lower resolution or sharpness.`;
  }
  // Host produces fine but the phone decodes far fewer → network or decoder limited.
  if (host && net && produced != null && produced > 0 && net.fps < produced * 0.7) {
    return "Bottleneck: network / decoder. Lower bitrate (resolution/fps).";
  }
  if (net && net.freezes > 0 && net.fps < target * 0.6) return "Bottleneck: unstable link (freezes).";
  return "Pipeline healthy.";
}

/** A thin vertical divider between icon groups in a panel row. */
function Sep() {
  return <span className="mx-0.5 h-6 w-px shrink-0 bg-white/10" />;
}
/** Square icon button used across the panels. */
function IcoBtn({ onClick, active, title, children }: { onClick: () => void; active?: boolean; title?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border transition active:scale-95 ${active ? "border-accent-3 bg-accent-3/15 text-white" : "border-white/[0.06] bg-white/[0.03] text-ink-soft active:bg-white/[0.08]"}`}
    >
      {children}
    </button>
  );
}
/** Compact labelled key (for Esc / modifiers / F-keys / shortcut chords). */
function KeyBtn({ onClick, active, children }: { onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`grid h-9 shrink-0 place-items-center whitespace-nowrap rounded-lg border px-2 text-[11px] font-700 transition active:scale-95 ${active ? "border-accent-1 bg-accent-1 text-white shadow-glow" : "border-white/[0.06] bg-white/[0.03] text-ink-soft active:bg-white/[0.08]"}`}
    >
      {children}
    </button>
  );
}
/** A tab in the always-visible bottom strip (icon only). */
function Tab({ onClick, active, title, children }: { onClick: () => void; active: boolean; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`grid h-9 flex-1 place-items-center rounded-lg transition active:scale-95 ${active ? "bg-accent-3 text-white shadow-glow" : "text-ink-dim active:bg-white/[0.06]"}`}
    >
      {children}
    </button>
  );
}
/** Compact labelled slider for the single-row quality panel. */
function QSlider({ icon, label, min, max, step, value, fmt, onChange }: { icon: React.ReactNode; label: string; min: number; max: number; step: number; value: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <div className="flex w-[4.75rem] shrink-0 flex-col gap-0.5">
      <div className="flex items-center justify-between text-[9px] font-700 leading-none text-ink-dim">
        <span className="flex items-center gap-0.5">
          {icon}
          {label}
        </span>
        <span className="text-white">{fmt(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseInt(e.target.value, 10))} className="w-full accent-accent-3" />
    </div>
  );
}
