import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
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
  Expand,
  Shrink,
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
  Clock as ClockIcon,
  Trophy as TrophyIcon,
  Headphones,
  Cpu as CpuIcon,
  Settings as SettingsIcon,
  Send,
  Type as TypeIcon,
  Film,
  Sparkles,
  Pin,
  PinOff,
  TextCursor,
  Move,
  MoveHorizontal,
  MoveVertical,
  MoveDiagonal,
  MoveDiagonal2,
  Crosshair,
  Ban,
  Grab,
  Gamepad2,
  Headset,
  Plus,
  Trash2,
  AppWindow,
} from "lucide-react";
import type { ContentMode, QualitySettings, RemoteLink } from "../links";
import { startGamepadBridge } from "../gamepad";
import { apiGet } from "../link";
import type { ConnectSnapshot, WcStats } from "../cloud";
import { ConnectionProgress, statusLabel } from "../ConnectionProgress";
import type { RemoteMonitor, RemoteCaptureStats } from "@/lib/api";
import { isQuestBrowser } from "../device";
import { isImmersiveActive, onImmersiveActiveChange } from "../runtime";

type HostRtcStats = {
  sendKbps: number;
  sendFps: number;
  rtt: number;
  keyFrames: number;
  framesEnc: number;
  nack: number;
  pli: number;
  fir: number;
  qp: number;
  codec: string;
  encMaxKbps: number;
  jpegQ: number;
  content: string;
};
type HostWcStats = {
  on: boolean;
  codec?: string;
  encMs?: number;
  frames?: number;
  bytes?: number;
  keys?: number;
  skipped?: number;
  bufKB?: number;
  kbpsMax?: number;
};
type HostStats = RemoteCaptureStats & { producedFps?: number; rtc?: HostRtcStats; wc?: HostWcStats };
type NetStats = {
  fps: number;
  kbps: number;
  w: number;
  h: number;
  jitterMs: number;
  lostPkts: number;
  dropped: number;
  freezes: number;
  /** Network round-trip (ms) on the active ICE pair. */
  rttMs: number;
  /** Avg time a frame sat in the receiver jitter buffer over the last sample window (ms). */
  bufMs: number;
  /** Avg hardware/software decode time per frame over the last sample window (ms). */
  decMs: number;
  /** App-requested jitterBufferTarget (ms). */
  jbTargetMs: number;
  /** UA minimum delay estimate (ms). */
  jbMinMs: number;
  packetsReceived: number;
  nackCount: number;
  pliCount: number;
  firCount: number;
  keyFramesDecoded: number;
  framesRendered: number;
  framesDecoded: number;
};

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
type NavTab = "stats" | "library" | "timeline" | "collection" | "music" | "control" | "system" | "settings";
/** Which bottom control panel is expanded (null = collapsed to just the tab strip).
 * Keyboard uses a ghost input (Surface Keyboard / IME); phone gets a flex compose row. */
type Panel = "mouse" | "keys" | "shortcuts" | "quality" | "gamepad";

/** A pinnable key / shortcut: `keys` are the keycap labels (>1 → combo joined by +). */
type KeyDef = {
  id: string;
  keys: string[];
  /** Optional friendly caption shown under the keycaps (e.g. "Copy"). */
  label?: string;
  run: () => void;
  /** For sticky modifiers, the modifier this key represents (drives active state). */
  mod?: Mod;
  /** The single wire key name this cap maps to — press-and-hold sends keydown
   *  while the finger is down and keyup on release (natural hold). Combos/media
   *  stay tap-only; sticky modifiers use `mod` instead. */
  wire?: string;
};

/** User-defined chord stored in `gt.remote.customShortcuts`. */
type CustomShortcut = {
  id: string;
  label?: string;
  mods: Mod[];
  key: string;
};

const MOD_LABEL: Record<Mod, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", win: "Win" };
const ALL_MODS: Mod[] = ["ctrl", "alt", "shift", "win"];

/** Display label for a wire key name used in custom shortcuts. */
function keyCapLabel(k: string): string {
  const map: Record<string, string> = {
    escape: "Esc",
    tab: "Tab",
    enter: "↵",
    delete: "Del",
    backspace: "⌫",
    space: "Space",
    home: "Home",
    end: "End",
    pageup: "PgUp",
    pagedown: "PgDn",
    insert: "Ins",
    left: "←",
    up: "↑",
    down: "↓",
    right: "→",
  };
  if (map[k]) return map[k];
  if (/^f\d+$/i.test(k)) return k.toUpperCase();
  return k.length === 1 ? k.toUpperCase() : k;
}

/** Keys the custom-shortcut editor can pick as the final chord key. */
const SHORTCUT_KEY_OPTIONS: { value: string; label: string }[] = [
  ...Array.from({ length: 26 }, (_, i) => {
    const c = String.fromCharCode(97 + i);
    return { value: c, label: c.toUpperCase() };
  }),
  ...Array.from({ length: 10 }, (_, i) => ({ value: String(i), label: String(i) })),
  ...Array.from({ length: 12 }, (_, i) => ({ value: `f${i + 1}`, label: `F${i + 1}` })),
  { value: "escape", label: "Esc" },
  { value: "tab", label: "Tab" },
  { value: "enter", label: "Enter" },
  { value: "delete", label: "Del" },
  { value: "backspace", label: "Bksp" },
  { value: "space", label: "Space" },
  { value: "home", label: "Home" },
  { value: "end", label: "End" },
  { value: "pageup", label: "PgUp" },
  { value: "pagedown", label: "PgDn" },
  { value: "insert", label: "Ins" },
  { value: "left", label: "←" },
  { value: "up", label: "↑" },
  { value: "down", label: "↓" },
  { value: "right", label: "→" },
];

function loadCustomShortcuts(): CustomShortcut[] {
  try {
    const raw = localStorage.getItem("gt.remote.customShortcuts");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is CustomShortcut => !!x && typeof x === "object" && typeof (x as CustomShortcut).id === "string" && typeof (x as CustomShortcut).key === "string")
      .map((x) => ({
        id: x.id,
        label: typeof x.label === "string" && x.label.trim() ? x.label.trim() : undefined,
        mods: Array.isArray(x.mods) ? x.mods.filter((m): m is Mod => ALL_MODS.includes(m as Mod)) : [],
        key: x.key,
      }));
  } catch {
    return [];
  }
}

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

/** Container size + the object-contain image box within it (at zoom 1). Fallback only. */
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

/**
 * Clamp pan so the scaled image stays inside the viewport.
 * At zoom ≤ 1 (image fits / letterboxes) pan is forced to 0 — otherwise a stale
 * pan from a taller pre-keyboard layout can shove the stream off the top.
 */
function clampPan(l: Layout, zoom: number, panX: number, panY: number) {
  if (zoom <= 1.001) return { x: 0, y: 0 };
  const maxX = Math.max(0, (l.dispW * zoom - l.cw) / 2);
  const maxY = Math.max(0, (l.dispH * zoom - l.ch) / 2);
  return { x: clamp(panX, -maxX, maxX), y: clamp(panY, -maxY, maxY) };
}

/**
 * Map a client point → normalized image coords using the **live** video/canvas
 * bounding box (already includes CSS pan/zoom). This stays correct across
 * browser fullscreen, collapsing chrome, and orientation changes — unlike a
 * cached object-contain Layout that can lag a frame behind the real paint.
 */
function clientToNorm(media: HTMLElement | null, clientX: number, clientY: number): { x: number; y: number } | null {
  if (!media) return null;
  const r = media.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return {
    x: clamp((clientX - r.left) / r.width, 0, 1),
    y: clamp((clientY - r.top) / r.height, 0, 1),
  };
}

/** Viewport-relative pixel of a normalized cursor, from the live media box. */
function normToViewport(
  viewport: HTMLElement | null,
  media: HTMLElement | null,
  nx: number,
  ny: number,
): { x: number; y: number } | null {
  if (!viewport || !media) return null;
  const vr = viewport.getBoundingClientRect();
  const mr = media.getBoundingClientRect();
  if (mr.width < 2 || mr.height < 2) return null;
  return {
    x: mr.left - vr.left + nx * mr.width,
    y: mr.top - vr.top + ny * mr.height,
  };
}

/** CSS cursor for absolute mouse/pen / Quest laser — mirrors the host desktop shape. */
function cssCursorFor(kind: string): string {
  switch (kind) {
    case "hand":
      return "pointer";
    case "text":
      return "text";
    case "busy":
      return "wait";
    case "move":
      return "move";
    case "resize-ns":
      return "ns-resize";
    case "resize-we":
      return "ew-resize";
    case "resize-nwse":
      return "nwse-resize";
    case "resize-nesw":
      return "nesw-resize";
    case "cross":
      return "crosshair";
    case "no":
      return "not-allowed";
    case "help":
      return "help";
    case "grab":
      return "grabbing";
    case "hidden":
      return "none";
    default:
      return "default";
  }
}

// ---------- component ----------
export function ControlScreen({
  link,
  onNavigate,
  onDisconnect,
  vrSupported,
  onEnterVr,
  vrMode = "pointer",
  onVrModeChange,
  popoutMonitor = null,
}: {
  link: RemoteLink;
  onNavigate?: (tab: NavTab) => void;
  onDisconnect?: () => void;
  /** Quest: WebXR available — show Enter VR in the top bar. */
  vrSupported?: boolean;
  onEnterVr?: () => void;
  /** Quest: pointer vs virtual Xbox pad for immersive sessions. */
  vrMode?: "pointer" | "gamepad";
  onVrModeChange?: (mode: "pointer" | "gamepad") => void;
  /** When set, this tab is a multi-monitor pop-out locked to that display index. */
  popoutMonitor?: number | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** Separate from <video> — sharing a MediaStream with audio triggers A/V sync lag. */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const kbdRef = useRef<HTMLInputElement | null>(null);
  /** Last WebRTC stream — kept so we can rebind after auth when the track was empty. */
  const pendingStreamRef = useRef<MediaStream | null>(null);

  const [connected, setConnected] = useState(false);
  const [progress, setProgress] = useState<ConnectSnapshot | null>(null);
  // Debounced "Reconnecting…" overlay: WebRTC dips into "disconnected" briefly on
  // packet-loss blips and usually self-heals within a second — flashing the
  // overlay for those made the link feel flakier than it is.
  const [showReconnect, setShowReconnect] = useState(false);
  const [hasStream, setHasStream] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  // PC sound remembers its last state: restored automatically on connect, with a
  // graceful drop back to "off" if the platform still demands a fresh gesture.
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem("gt.remote.soundOn") === "1");
  const soundOnRef = useRef(false);
  soundOnRef.current = soundOn;
  useEffect(() => {
    localStorage.setItem("gt.remote.soundOn", soundOn ? "1" : "0");
  }, [soundOn]);
  // Hand PC sound to ImmersiveScreen while WebXR is live; resume on exit.
  useEffect(() => {
    return onImmersiveActiveChange((active) => {
      const a = audioRef.current;
      if (!a) return;
      if (active) {
        a.muted = true;
        try {
          a.pause();
        } catch {
          /* ignore */
        }
      } else {
        a.muted = !soundOnRef.current;
        if (soundOnRef.current) a.play?.().catch(() => {});
      }
    });
  }, []);
  // Direct-video path (WebCodecs over the data channel): frames render on the
  // canvas — the <video> element (WebRTC track) hides while this is live.
  const [wcActive, setWcActive] = useState(false);
  const wcActiveRef = useRef(false);
  wcActiveRef.current = wcActive;
  // Android PiP: the OS shrinks the whole webview into a mini floating window.
  // There is no direct signal inside the webview, but the PiP window is far
  // smaller than any phone layout — hide ALL chrome and show pure video there.
  const [pipView, setPipView] = useState(false);
  useEffect(() => {
    const check = () => setPipView(window.innerWidth <= 550 && window.innerHeight <= 350);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  const [mode, setMode] = useState<Mode>(() => (isQuestBrowser() ? "touch" : "trackpad"));
  // Expanded bottom panel (null = collapsed). It pushes the viewport up, never overlaps.
  const [panel, setPanel] = useState<Panel | null>(null);
  const [immersive, setImmersive] = useState(false);
  /** Browser Fullscreen API (web/Quest) — separate from in-app immersive chrome hide. */
  const [browserFs, setBrowserFs] = useState(false);
  // Collapse the whole bottom dock (tab strip + panels) so the viewport fills the
  // screen. A small handle restores it. Distinct from `immersive`, which hides both
  // top and bottom chrome. Persisted so it sticks.
  const [dockCollapsed, setDockCollapsed] = useState(() => localStorage.getItem("gt.remote.dockCollapsed") === "1");
  useEffect(() => {
    localStorage.setItem("gt.remote.dockCollapsed", dockCollapsed ? "1" : "0");
  }, [dockCollapsed]);
  // Same idea for the top toolbar — independent of the bottom dock.
  const [topCollapsed, setTopCollapsed] = useState(() => localStorage.getItem("gt.remote.topCollapsed") === "1");
  useEffect(() => {
    localStorage.setItem("gt.remote.topCollapsed", topCollapsed ? "1" : "0");
  }, [topCollapsed]);

  // Soft-keyboard / VisualViewport handling.
  // `interactive-widget=resizes-content` (companion.html) should shrink the layout
  // viewport, but many Android WebViews fall back to *pan* mode: the focused
  // ghost input is scrolled into view and the remote stream slides off the top.
  // Dragging near the bottom while the keyboard is open can nudge offsetTop
  // further. Fix: when a real keyboard is up, pin this screen to the *visual*
  // viewport (fixed top/left/width/height) and zero document scroll so the
  // stream can never leave the visible area. When resizes-content works,
  // offsetTop≈0 and covered≈0 so we stay in normal flow.
  const [kbInset, setKbInset] = useState(0);
  const [vvPin, setVvPin] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      // Ignore sub-100px noise (address bar, rounding) — only real keyboards.
      const nextInset = covered > 100 ? Math.round(covered) : 0;
      setKbInset((prev) => (nextInset === prev ? prev : nextInset));

      if (nextInset > 0) {
        // Kill any document scroll the IME applied, then pin to the visible band.
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        const next = {
          top: Math.round(vv.offsetTop),
          left: Math.round(vv.offsetLeft),
          width: Math.round(vv.width),
          height: Math.round(vv.height),
        };
        setVvPin((prev) =>
          prev &&
          prev.top === next.top &&
          prev.left === next.left &&
          prev.width === next.width &&
          prev.height === next.height
            ? prev
            : next,
        );
      } else {
        setVvPin((prev) => (prev ? null : prev));
      }
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
    };
  }, []);
  const [kbMode, setKbMode] = useState<KbMode>("direct");
  const [pcTextField, setPcTextField] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [sensitivity, setSensitivity] = useState(1.6);
  const [dragLock, setDragLock] = useState(false);
  const [mods, setMods] = useState<Set<Mod>>(new Set());
  const autoKbdRef = useRef(false); // guards the once-per-focus auto keyboard pop
  const pcTextFieldRef = useRef(false);
  const lastPointerGestureAt = useRef(0);
  /** Quest: click armed keyboard; host hasn't confirmed text-field yet. */
  const questKbdArmedRef = useRef(false);
  /** Quest: host confirmed a PC text field — keep ghost focused, never timeout-blur. */
  const questKbdLockedRef = useRef(false);
  const kbdBlurTimer = useRef<number | null>(null);
  const focusFalseTimer = useRef<number | null>(null);

  // Remote-cursor polish: the live desktop cursor shape (mirrored from the host),
  // a transient action "flash" (click/right-click/scroll ripple), and a drag flag.
  const [cursorKind, setCursorKind] = useState("arrow");
  const [dragging, setDragging] = useState(false);
  const [cursorFx, setCursorFx] = useState<{ id: number; kind: "left" | "right" | "scroll"; dir?: number } | null>(null);
  const fxId = useRef(0);
  const fxClear = useRef<number | null>(null);
  const lastScrollFx = useRef(0);
  const flashCursor = (kind: "left" | "right" | "scroll", dir?: number) => {
    if (kind === "scroll") {
      const now = performance.now();
      if (now - lastScrollFx.current < 120) return; // don't spam ripples mid-scroll
      lastScrollFx.current = now;
    }
    fxId.current += 1;
    setCursorFx({ id: fxId.current, kind, dir });
    if (fxClear.current) clearTimeout(fxClear.current);
    fxClear.current = window.setTimeout(() => setCursorFx(null), 500);
  };
  // All input goes through this wrapper so the on-screen cursor can react to the
  // action (click ripple, right-click ripple, scroll pulse, grabbing while dragging).
  // Non-mouse messages (keys/quality/text) pass straight through untouched.
  // Returns the link's delivery result so gesture feedback (vibration) can be
  // tied to the input actually reaching the PC.
  const send: RemoteLink["send"] = (msg) => {
    const m = msg as { type?: string; button?: string; dy?: number };
    if (m.type === "click") flashCursor(m.button === "right" ? "right" : m.button === "left" ? "left" : "left");
    else if (m.type === "scroll") flashCursor("scroll", m.dy ?? 0);
    else if (m.type === "down" && m.button) setDragging(true);
    else if (m.type === "up" && m.button) setDragging(false);
    return link.send(msg);
  };
  /** Send a right click; vibrate ONLY if it was actually delivered to the PC. */
  const sendRightClick = () => {
    if (send({ type: "click", button: "right" })) navigator.vibrate?.(15);
  };
  // First frame received (video decoded or a canvas frame drawn) → hide the
  // app-icon "connecting" placeholder that fills the ~1s gap before pixels arrive.
  const [hasFrame, setHasFrame] = useState(false);

  // Floating compose bar: the hidden text field is ALWAYS mounted (so both the
  // auto-keyboard on PC focus and the collapsed floating keyboard button work,
  // regardless of dock state); `typing` reveals the compose chrome.
  const [typing, setTyping] = useState(false);
  // Live mirror of the ghost field so the compose bar shows WHAT you've typed
  // (not just a generic hint) — essential in buffered mode where nothing appears
  // on the PC until Send.
  const [composeText, setComposeText] = useState("");
  // Pinned keys/shortcuts → small, semi-transparent floating quick buttons pinned
  // to the screen edge so they're always one tap away without opening the dock.
  const [pinned, setPinned] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("gt.remote.pinned");
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem("gt.remote.pinned", JSON.stringify(pinned));
  }, [pinned]);
  // Pin-edit mode: while on, tapping a key in the dock pins/unpins it instead of firing.
  const [pinMode, setPinMode] = useState(false);
  const togglePin = (id: string) =>
    setPinned((prev) => {
      navigator.vibrate?.(10);
      return prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
    });

  // Natural hold: while a finger is down on a holdable key (has `wire`), we send
  // keydown and keep it in `heldKeys` for highlight; keyup on release. No manual
  // "Hold mode" toggle — press-and-hold is the normal gesture. Sticky modifiers
  // still latch via `mods` (they're meant to stay down across other taps).
  const [heldKeys, setHeldKeys] = useState<Set<string>>(new Set());
  const heldKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    heldKeysRef.current = heldKeys;
  }, [heldKeys]);
  const pressHold = (wire: string) => {
    if (heldKeysRef.current.has(wire)) return;
    navigator.vibrate?.(6);
    send({ type: "keydown", name: wire });
    setHeldKeys((prev) => {
      const next = new Set(prev);
      next.add(wire);
      return next;
    });
  };
  const releaseHold = (wire: string) => {
    if (!heldKeysRef.current.has(wire)) return;
    send({ type: "keyup", name: wire });
    setHeldKeys((prev) => {
      const next = new Set(prev);
      next.delete(wire);
      return next;
    });
  };
  const releaseAllHeld = () => {
    if (heldKeysRef.current.size === 0) return;
    heldKeysRef.current.forEach((w) => send({ type: "keyup", name: w }));
    navigator.vibrate?.(12);
    setHeldKeys(new Set());
  };
  // Never strand a held key on the PC: release everything when the screen unmounts.
  useEffect(
    () => () => {
      heldKeysRef.current.forEach((w) => link.send({ type: "keyup", name: w }));
    },
    [link],
  );

  // Custom shortcuts (user-defined chords), persisted separately from builtins.
  const [customShortcuts, setCustomShortcuts] = useState<CustomShortcut[]>(loadCustomShortcuts);
  useEffect(() => {
    localStorage.setItem("gt.remote.customShortcuts", JSON.stringify(customShortcuts));
  }, [customShortcuts]);
  const [addingShortcut, setAddingShortcut] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftMods, setDraftMods] = useState<Set<Mod>>(() => new Set(["ctrl"]));
  const [draftKey, setDraftKey] = useState("c");
  const resetDraft = () => {
    setDraftLabel("");
    setDraftMods(new Set(["ctrl"]));
    setDraftKey("c");
  };
  const saveCustomShortcut = () => {
    const id = `custom-${Date.now()}`;
    const label = draftLabel.trim() || undefined;
    const mods = ALL_MODS.filter((m) => draftMods.has(m));
    setCustomShortcuts((prev) => [...prev, { id, label, mods, key: draftKey }]);
    setAddingShortcut(false);
    resetDraft();
    navigator.vibrate?.(10);
  };
  const deleteCustomShortcut = (id: string) => {
    setCustomShortcuts((prev) => prev.filter((c) => c.id !== id));
    setPinned((prev) => prev.filter((p) => p !== `s:${id}`));
    navigator.vibrate?.(12);
  };

  // View transform: refs drive the hot gesture path, state mirrors it for render.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cursor, setCursor] = useState({ x: 0.5, y: 0.5 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const cursorRef = useRef({ x: 0.5, y: 0.5 });
  const layoutRef = useRef<Layout | null>(null);
  const natRef = useRef({ w: 0, h: 0 });

  // Live stream quality (sliders only). `bitrate` is kbps. Defaults tuned for a
  // crisp desktop: 1920-wide, Text mode, max sharpness. Persisted so a tuned
  // setup (e.g. lower res + Video mode for gaming) survives app restarts.
  const [streamQ, setStreamQ] = useState(() => {
    const dflt = { maxW: 1920, quality: 72, fps: 40, bitrate: 12000 };
    try {
      const raw = localStorage.getItem("gt.remote.streamQ");
      if (!raw) return dflt;
      const p = JSON.parse(raw) as Partial<typeof dflt>;
      return {
        maxW: clamp(Number(p.maxW) || dflt.maxW, 320, 3840),
        quality: clamp(Number(p.quality) || dflt.quality, 20, 100),
        fps: clamp(Number(p.fps) || dflt.fps, 10, 60),
        bitrate: clamp(Number(p.bitrate) || dflt.bitrate, 500, 40000),
      };
    } catch {
      return dflt;
    }
  });
  useEffect(() => {
    localStorage.setItem("gt.remote.streamQ", JSON.stringify(streamQ));
  }, [streamQ]);
  // Content optimization: sharpen for text/UI, smooth for video, or auto.
  const [contentMode, setContentMode] = useState<ContentMode>(() => {
    const m = localStorage.getItem("gt.remote.contentMode");
    return m === "auto" || m === "text" || m === "video" ? m : "text";
  });
  useEffect(() => {
    localStorage.setItem("gt.remote.contentMode", contentMode);
  }, [contentMode]);
  const [showStats, setShowStats] = useState(false);
  const [fps, setFps] = useState(0);
  const [res, setRes] = useState("");
  const frameTimes = useRef<number[]>([]);
  // Debug telemetry: host capture pipeline + decode-side WebRTC stats.
  const [hostStats, setHostStats] = useState<HostStats | null>(null);
  const [net, setNet] = useState<NetStats | null>(null);
  const [wcStats, setWcStats] = useState<WcStats | null>(null);
  const prodRef = useRef<{ frames: number; at: number } | null>(null);
  const netRef = useRef<{ bytes: number; at: number; jbDelay: number; jbCount: number; decT: number; decoded: number } | null>(null);

  // Multi-monitor.
  const [monitors, setMonitors] = useState<RemoteMonitor[]>([]);
  const [monitorIdx, setMonitorIdx] = useState(0);

  // Controller mode: forward a physical gamepad attached to the phone to a virtual
  // Xbox pad on the PC so games are playable. `padAvailable` reflects whether the
  // PC has the ViGEmBus driver (null = not yet probed / answered).
  const [controllerOn, setControllerOn] = useState(false);
  const [padConnected, setPadConnected] = useState(false);
  const [padName, setPadName] = useState("");
  const [padAvailable, setPadAvailable] = useState<boolean | null>(null);

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
      createImageBitmap(new Blob([jpg], { type: "image/jpeg" }), { colorSpaceConversion: "none" })
        .then((bmp) => {
          ctx.drawImage(bmp, tx, ty);
          bmp.close?.();
          setHasFrame(true);
        })
        .catch(() => {});
    }
  };

  // ----- frame + status lifecycle -----
  useEffect(() => {
    link.onStatus((c) => {
      setConnected(c);
      if (!c) setHasFrame(false); // show the app-icon placeholder again on reconnect
    });
    const unsubProgress = link.onProgress?.(setProgress);
    const bindStream = (stream: MediaStream, force = false) => {
      pendingStreamRef.current = stream;
      const v = videoRef.current;
      if (!v) return;
      if (force || v.srcObject !== stream) v.srcObject = stream;
      setHasStream(true);
      // Video element stays muted forever — PC sound rides audioRef.
      v.muted = true;
      stream.addEventListener?.("addtrack", () => {
        /* video-only stream */
      });
      v.play?.().catch(() => {});
    };
    // Cloud: the screen arrives as a hardware-decoded WebRTC video track.
    const unsubStream = link.onStream((stream) => bindStream(stream, true));
    const unsubAudio = link.onAudioStream?.((stream) => {
      setHasAudio(!!stream && stream.getAudioTracks().length > 0);
      const a = audioRef.current;
      if (!a) return;
      a.srcObject = stream;
      // ImmersiveScreen owns PC sound while WebXR is up (avoids double audio).
      a.muted = !soundOnRef.current || isImmersiveActive();
      if (soundOnRef.current && !isImmersiveActive()) a.play?.().catch(() => setSoundOn(false));
    });
    // Host events: auto-pop the keyboard on PC text-field focus + capture telemetry.
    const unsubEvent = link.onEvent((e) => {
      if (e.event === "focus") handleFocusEvent(!!(e as { textField?: boolean }).textField);
      else if (e.event === "cursor") setCursorKind(String((e as { kind?: string }).kind || "arrow"));
      else if (e.event === "gamepad") setPadAvailable(!!(e as { available?: boolean }).available);
      else if (e.event === "wc") {
        // Direct-video path toggled: swap the render surface (canvas ↔ video).
        const active = !!(e as { active?: boolean }).active;
        setWcActive(active);
        if (active) setHasFrame(false); // until the first decoded frame lands
      } else if (e.event === "auth" && (e as { state?: string }).state === "ok") {
        // Capture just started on the existing track — force a rebind + play.
        const s = pendingStreamRef.current;
        if (s) bindStream(s, true);
      } else if (e.event === "capstats") {
        const cs = (e as { stats?: RemoteCaptureStats; rtc?: HostRtcStats }).stats;
        if (!cs) return;
        const rtc = (e as { rtc?: HostRtcStats }).rtc;
        const wc = (e as { wc?: HostWcStats }).wc;
        const now = performance.now();
        const prev = prodRef.current;
        let producedFps: number | undefined;
        if (prev && now > prev.at) {
          const df = cs.producedFrames - prev.frames;
          if (df >= 0) producedFps = Math.round((df * 1000) / (now - prev.at));
        }
        prodRef.current = { frames: cs.producedFrames, at: now };
        setHostStats({ ...cs, producedFps, rtc, wc });
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
    return () => {
      unsubProgress?.();
      unsubStream?.();
      unsubAudio?.();
      unsubEvent?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  // Direct-video render sink: decoded VideoFrames are painted straight onto the
  // canvas the instant they leave the decoder — no <video> element, no playout
  // buffer, no compositor sampling. This is the whole point of the wc path.
  useEffect(() => {
    if (!link.onWcFrame) return;
    const un = link.onWcFrame((frame) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        frame.close();
        return;
      }
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
        natRef.current = { w, h };
        setRes(`${w}×${h}`);
        const l = measure(viewportRef.current, w, h);
        if (l) layoutRef.current = l;
        ctxRef.current = null; // canvas resize invalidates the 2d context state
      }
      if (!ctxRef.current) ctxRef.current = canvas.getContext("2d", { alpha: false, desynchronized: true });
      try {
        ctxRef.current?.drawImage(frame, 0, 0);
      } catch {
        /* decoder handed us a closed frame — skip */
      } finally {
        frame.close();
      }
      const now = performance.now();
      const t = frameTimes.current;
      t.push(now);
      while (t.length && now - t[0] > 1000) t.shift();
      setHasFrame(true);
    });
    return () => {
      un?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  // If we're "connected" (authed) but no decoded frame yet, periodically rebind
  // the stream — covers first-approval where the track was empty at attach time.
  // Skipped on the wc path (frames don't ride the <video> element there).
  useEffect(() => {
    if (!connected || hasFrame || wcActive) return;
    let n = 0;
    const id = window.setInterval(() => {
      const stream = pendingStreamRef.current;
      const v = videoRef.current;
      if (!stream || !v) return;
      n++;
      v.srcObject = null;
      v.srcObject = stream;
      v.play?.().catch(() => {});
      if (n >= 8) window.clearInterval(id);
    }, 1500);
    return () => window.clearInterval(id);
  }, [connected, hasFrame, wcActive]);

  // Track browser Fullscreen API state (web / Quest Browser).
  useEffect(() => {
    const onFs = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      setBrowserFs(!!(document.fullscreenElement || doc.webkitFullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
    };
  }, []);

  const toggleBrowserFullscreen = () => {
    const root = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => void;
    };
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => void;
    };
    const active = document.fullscreenElement || doc.webkitFullscreenElement;
    if (!active) {
      if (root.requestFullscreen) void root.requestFullscreen().catch(() => {});
      else root.webkitRequestFullscreen?.();
    } else if (document.exitFullscreen) {
      void document.exitFullscreen().catch(() => {});
    } else {
      doc.webkitExitFullscreen?.();
    }
  };
  // APK WebView: browser Fullscreen API + multi-tab pop-outs aren't useful — hide both.
  const isApk =
    typeof window !== "undefined" &&
    Boolean(
      (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ||
        (window as unknown as { __TAURI__?: unknown }).__TAURI__,
    );
  const browserFsSupported =
    !isApk &&
    typeof document !== "undefined" &&
    !!(
      document.documentElement.requestFullscreen ||
      (document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void }).webkitRequestFullscreen
    );

  // Controller mode: while on (and connected), probe the PC for the virtual-gamepad
  // driver and stream the attached physical controller. Re-runs on reconnect so the
  // pad re-probes; cleanup stops polling and releases the virtual pad to neutral.
  useEffect(() => {
    if (!controllerOn || !connected) return;
    setPadAvailable(null);
    link.send({ type: "gamepadprobe" }); // host answers via onEvent → setPadAvailable
    const stop = startGamepadBridge((msg) => link.send(msg), {
      onStatus: (c, name) => {
        setPadConnected(c);
        setPadName(name);
      },
    });
    return () => {
      stop();
      setPadConnected(false);
      link.send({ type: "gamepadstop" });
    };
  }, [controllerOn, connected, link]);

  const clearKbdTimers = () => {
    if (kbdBlurTimer.current != null) {
      window.clearTimeout(kbdBlurTimer.current);
      kbdBlurTimer.current = null;
    }
    if (focusFalseTimer.current != null) {
      window.clearTimeout(focusFalseTimer.current);
      focusFalseTimer.current = null;
    }
  };

  // Capture Surface Keyboard / IME into our ghost field. Must run inside a user
  // gesture on Quest — a late WebRTC "focus" event alone cannot re-raise it.
  const captureKeyboard = () => {
    const el = kbdRef.current;
    if (!el) return;
    if (document.activeElement === el) return; // already latched — don't refocus/flicker
    el.value = "";
    el.focus({ preventScroll: true });
  };

  // Host says PC caret is in / out of a text field.
  const handleFocusEvent = (textField: boolean) => {
    if (textField) {
      clearKbdTimers();
      questKbdArmedRef.current = false;
      questKbdLockedRef.current = true;
      pcTextFieldRef.current = true;
      autoKbdRef.current = true;
      setPcTextField(true);
      setTyping(true);
      if (document.activeElement !== kbdRef.current) {
        captureKeyboard();
      }
      return;
    }

    pcTextFieldRef.current = false;
    setPcTextField(false);
    // Quest: never auto-dismiss from host focus=false — the caret heuristic is
    // flaky and was killing Surface Keyboard after ~2s. Manual Keyboard toggle /
    // stopTyping is the only unlock (same as tapping the keyboard icon to open).
    if (isQuestBrowser()) return;

    if (focusFalseTimer.current != null) window.clearTimeout(focusFalseTimer.current);
    focusFalseTimer.current = window.setTimeout(() => {
      focusFalseTimer.current = null;
      if (pcTextFieldRef.current) return;
      questKbdLockedRef.current = false;
      questKbdArmedRef.current = false;
      autoKbdRef.current = false;
      setTyping(false);
      kbdRef.current?.blur();
    }, 600);
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
  // Count PRESENTED frames from the callback metadata, not callback invocations:
  // under main-thread load the browser skips rVFC callbacks even though the
  // compositor kept presenting frames, so counting invocations under-reported the
  // display fps (it looked like "decode 56 / display 32" when the screen was
  // actually showing nearly every decoded frame). `presentedFrames` is cumulative,
  // so the delta between callbacks credits the skipped ones too.
  useEffect(() => {
    const v = videoRef.current as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta?: { presentedFrames?: number }) => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    }) | null;
    // wc path: display fps is counted at the canvas draw instead — counting both
    // would double-book frameTimes.
    if (!v || !hasStream || wcActive || !v.requestVideoFrameCallback) return;
    let handle = 0;
    let lastPresented = 0;
    const onVF = (_ts: number, meta?: { presentedFrames?: number }) => {
      const now = performance.now();
      const t = frameTimes.current;
      const pf = meta?.presentedFrames;
      if (typeof pf === "number" && pf > 0) {
        // Cap the catch-up so a tab resume (counter jump) can't spike the reading.
        const n = lastPresented > 0 && pf > lastPresented ? Math.min(pf - lastPresented, 8) : 1;
        lastPresented = pf;
        for (let i = 0; i < n; i++) t.push(now);
      } else {
        t.push(now);
      }
      while (t.length && now - t[0] > 1000) t.shift();
      setHasFrame(true);
      handle = v.requestVideoFrameCallback!(onVF);
    };
    handle = v.requestVideoFrameCallback(onVF);
    return () => v.cancelVideoFrameCallback?.(handle);
  }, [hasStream, wcActive]);

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
          // Sync the switcher to the display the host is ACTUALLY capturing — the
          // selection persists on the host across connections, so assuming index 0
          // showed the wrong screen number until the user switched once.
          const sel = m.findIndex((x) => x.selected);
          setMonitorIdx(sel >= 0 ? sel : 0);
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
      // Direct-video path telemetry (independent of the RTP stats below).
      setWcStats(link.wcStats?.() ?? null);
      const s = await link.netStats().catch(() => null);
      if (!alive || !s) return;
      const prev = netRef.current;
      let kbps = 0;
      let bufMs = 0;
      let decMs = 0;
      if (prev && s.at > prev.at) {
        kbps = Math.round(((s.bytesReceived - prev.bytes) * 8) / (s.at - prev.at));
        // Windowed per-frame averages from the cumulative RTP counters: how long a
        // frame waited in the jitter buffer, and how long the decoder took. Together
        // with RTT these make the glass-to-glass latency estimate for the HUD.
        const dJb = s.jitterBufferEmittedCount - prev.jbCount;
        if (dJb > 0) bufMs = ((s.jitterBufferDelay - prev.jbDelay) / dJb) * 1000;
        const dDec = s.framesDecoded - prev.decoded;
        if (dDec > 0) decMs = ((s.totalDecodeTime - prev.decT) / dDec) * 1000;
      }
      netRef.current = {
        bytes: s.bytesReceived,
        at: s.at,
        jbDelay: s.jitterBufferDelay,
        jbCount: s.jitterBufferEmittedCount,
        decT: s.totalDecodeTime,
        decoded: s.framesDecoded,
      };
      setNet({
        fps: Math.round(s.framesPerSecond || 0),
        kbps,
        w: s.frameWidth,
        h: s.frameHeight,
        jitterMs: Math.round((s.jitter || 0) * 1000),
        lostPkts: s.packetsLost,
        dropped: s.framesDropped,
        freezes: s.freezeCount,
        rttMs: s.rttMs,
        bufMs: Math.round(bufMs),
        decMs: Math.round(decMs * 10) / 10,
        jbTargetMs: s.jitterTargetMs ?? 0,
        jbMinMs: s.jitterBufferMinimumMs ?? 0,
        packetsReceived: s.packetsReceived ?? 0,
        nackCount: s.nackCount ?? 0,
        pliCount: s.pliCount ?? 0,
        firCount: s.firCount ?? 0,
        keyFramesDecoded: s.keyFramesDecoded ?? 0,
        framesRendered: s.framesRendered ?? 0,
        framesDecoded: s.framesDecoded ?? 0,
      });
    }, 500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [link, showStats]);

  const selectMonitor = (i: number) => {
    if (popoutMonitor != null) return; // pop-out tabs are locked to one display
    setMonitorIdx(i);
    send({ type: "monitor", index: i });
    resetView();
  };

  const openMonitorPopout = (i: number) => {
    if (popoutMonitor != null) return;
    send({ type: "auxHost", monitor: i });
    const u = new URL(window.location.href);
    u.searchParams.set("popout", "1");
    u.searchParams.set("monitor", String(i));
    window.open(u.toString(), `gt-mon-${i}`);
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

  // Keep layout measurement fresh on resize / orientation / chrome / fullscreen /
  // keyboard pin. Remeasure + reclamp pan so a shrunk viewport can't leave a
  // stale translate shoving the stream off-screen.
  useEffect(() => {
    const refreshLayout = () => {
      const l = measure(viewportRef.current, natRef.current.w, natRef.current.h);
      if (l) {
        layoutRef.current = l;
        const next = clampPan(l, zoomRef.current, panRef.current.x, panRef.current.y);
        if (next.x !== panRef.current.x || next.y !== panRef.current.y) {
          panRef.current = next;
          setPan({ ...next });
        }
        if (zoomRef.current <= 1.001 && zoomRef.current !== 1) {
          zoomRef.current = 1;
          setZoom(1);
        }
      }
      // Force cursor overlay to re-anchor against the live media box.
      setCursor((c) => ({ ...c }));
    };
    const schedule = () => {
      requestAnimationFrame(() => {
        refreshLayout();
        requestAnimationFrame(refreshLayout);
      });
    };
    const pulse = () => {
      schedule();
      for (const ms of [50, 120, 250, 450, 800]) window.setTimeout(schedule, ms);
    };
    pulse();
    window.addEventListener("resize", pulse);
    window.addEventListener("orientationchange", pulse);
    document.addEventListener("fullscreenchange", pulse);
    document.addEventListener("webkitfullscreenchange", pulse);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", pulse);
    vv?.addEventListener("scroll", pulse);
    let ro: ResizeObserver | undefined;
    if (viewportRef.current && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(schedule);
      ro.observe(viewportRef.current);
      const media = videoRef.current || canvasRef.current;
      if (media) ro.observe(media);
    }
    return () => {
      window.removeEventListener("resize", pulse);
      window.removeEventListener("orientationchange", pulse);
      document.removeEventListener("fullscreenchange", pulse);
      document.removeEventListener("webkitfullscreenchange", pulse);
      vv?.removeEventListener("resize", pulse);
      vv?.removeEventListener("scroll", pulse);
      ro?.disconnect();
    };
  }, [immersive, topCollapsed, dockCollapsed, panel, browserFs, typing, hasStream, kbInset, vvPin]);

  // Cancel any in-flight edge-pan / view-commit frame if the screen unmounts mid-drag.
  useEffect(() => () => {
    if (edgeRaf.current != null) cancelAnimationFrame(edgeRaf.current);
    if (viewRaf.current != null) cancelAnimationFrame(viewRaf.current);
  }, []);

  // While this screen is mounted, the video is actively watched — arms the cloud
  // link's decode-stall self-heal (a wedged phone decoder after a resolution bump
  // is detected and the stream rebuilt automatically instead of freezing forever).
  useEffect(() => {
    link.noteVideoSink?.(true);
    return () => link.noteVideoSink?.(false);
  }, [link]);

  // ----- pointer-move sending: immediate, with a short-interval coalescer -----
  // Browser pointermove events are already vsync-aligned (~one per display frame),
  // so the old "queue every move for the NEXT requestAnimationFrame" added a full
  // extra frame (8–16ms) of input latency on top. Send immediately instead; the
  // rAF only acts as a trailing flush for rare same-frame bursts (coalesced
  // touch samples), rate-limited so the lossy move channel never floods.
  const MOVE_MIN_MS = 4;
  const rafId = useRef<number | null>(null);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const lastMoveSentAt = useRef(0);
  const flushMove = () => {
    const m = pendingMove.current;
    if (m) {
      pendingMove.current = null;
      lastMoveSentAt.current = performance.now();
      send({ type: "move", x: m.x, y: m.y });
    }
  };
  const rafFlushMove = () => {
    rafId.current = null;
    flushMove();
  };
  const queueMove = (x: number, y: number) => {
    pendingMove.current = { x, y };
    if (performance.now() - lastMoveSentAt.current >= MOVE_MIN_MS) flushMove();
    else if (rafId.current == null) rafId.current = requestAnimationFrame(rafFlushMove);
  };

  // ----- transform commit helpers -----
  // Refs are the source of truth on the hot gesture path; React state exists only
  // to render. Coalesce state commits to ONE per animation frame — phone touch
  // input fires at 90–120 Hz and a setState (= full ControlScreen re-render) per
  // pointer event starved the main thread, which is exactly when the video
  // compositor needs it. The refs are always current, so the coalesced commit
  // renders the same final view.
  const viewRaf = useRef<number | null>(null);
  const commitView = () => {
    if (viewRaf.current != null) return;
    viewRaf.current = requestAnimationFrame(() => {
      viewRaf.current = null;
      setZoom(zoomRef.current);
      setPan({ ...panRef.current });
      setCursor({ ...cursorRef.current });
    });
  };

  /** Always re-read the viewport box before mapping — never trust a stale Layout. */
  const liveLayout = (): Layout | null => {
    const l = measure(viewportRef.current, natRef.current.w, natRef.current.h);
    if (l) layoutRef.current = l;
    return l;
  };

  /** The painted screen surface (video track or LAN canvas) — source of truth for hit-testing. */
  const mediaEl = (): HTMLElement | null => {
    const c = canvasRef.current;
    // Direct-video path renders on the canvas — the video element may still hold
    // a stale (frozen) track frame, so the canvas must win while wc is live.
    if (wcActiveRef.current && c && c.width > 0) return c;
    const v = videoRef.current;
    if (v && v.srcObject && v.videoWidth > 0) return v;
    if (c && c.width > 0) return c;
    return v ?? c;
  };

  const setCursorPos = (nx: number, ny: number) => {
    cursorRef.current = { x: clamp(nx, 0, 1), y: clamp(ny, 0, 1) };
    // Edge pan-follow (zoomed in): keep the cursor comfortably inside the viewport.
    const l = liveLayout();
    const media = mediaEl();
    if (l && media && zoomRef.current > 1.01) {
      const s = normToViewport(viewportRef.current, media, cursorRef.current.x, cursorRef.current.y);
      if (s) {
        let px = panRef.current.x;
        let py = panRef.current.y;
        if (s.x < FOLLOW_MARGIN) px += FOLLOW_MARGIN - s.x;
        else if (s.x > l.cw - FOLLOW_MARGIN) px -= s.x - (l.cw - FOLLOW_MARGIN);
        if (s.y < FOLLOW_MARGIN) py += FOLLOW_MARGIN - s.y;
        else if (s.y > l.ch - FOLLOW_MARGIN) py -= s.y - (l.ch - FOLLOW_MARGIN);
        panRef.current = clampPan(l, zoomRef.current, px, py);
      }
    }
    commitView();
    queueMove(cursorRef.current.x, cursorRef.current.y);
  };

  const applyZoom = (nextZoom: number, focalX: number, focalY: number) => {
    const l = liveLayout();
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

  /** Absolute cursor from a viewport client point (laser / mouse / surface touchpad). */
  const moveAbsFromClient = (clientX: number, clientY: number) => {
    const n = clientToNorm(mediaEl(), clientX, clientY);
    if (!n) return;
    setCursorPos(n.x, n.y);
  };

  /** Mouse / pen / Quest surface touchpad — OS already moves an absolute cursor. */
  const isMouseLike = (e: React.PointerEvent) => e.pointerType === "mouse" || e.pointerType === "pen";

  const onPointerDown = (e: React.PointerEvent) => {
    // Mouse-like right / middle click (Quest surface touchpad two-finger = right).
    if (isMouseLike(e)) {
      moveAbsFromClient(e.clientX, e.clientY);
      if (e.button === 2) {
        e.preventDefault();
        send({ type: "click", button: "right" });
        return;
      }
      if (e.button === 1) {
        e.preventDefault();
        send({ type: "click", button: "middle" });
        return;
      }
      if (e.button !== 0) return;
    }

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
      // Mouse-like devices are always absolute (surface touchpad / desktop mouse).
      const abs = isMouseLike(e) || mode === "touch";
      gesture.current = abs ? "touchdrag" : "cursor";
      if (!abs && mode === "trackpad") startEdgePan();

      if (abs) {
        moveAbsFromClient(e.clientX, e.clientY);
        if (isMouseLike(e)) {
          // Immediate press — OS already decided this is a click/drag start.
          send({ type: "down", button: "left" });
          touchPressed.current = true;
          gesture.current = "dragging";
        }
      } else if (dragLock) {
        send({ type: "down", button: "left" });
        gesture.current = "dragging";
      } else {
        armedDrag.current = now - lastTapUp.current < DOUBLE_MS; // double-tap-drag
      }

      // Long-press → right click (touch / laser only — mouse has a real RMB).
      clearLong();
      if (!isMouseLike(e) && gesture.current !== "dragging" && !armedDrag.current) {
        longTimer.current = window.setTimeout(() => {
          if (pts.current.size === 1 && maxMove.current < TAP_SLOP) {
            gesture.current = "none"; // consume the gesture; no click on release
            sendRightClick(); // haptic fires only if the click reached the PC
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
    // Hover: Quest surface touchpad / mouse / laser-without-trigger send
    // pointermove with buttons===0 and no prior pointerdown. Phone fingers
    // never hit this path (they always down first).
    if (!p) {
      if (e.buttons === 0) moveAbsFromClient(e.clientX, e.clientY);
      return;
    }
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
          send({ type: "scroll", dy: -dir }); // natural: content follows fingers
          scrollAcc.current.y -= dir * SCROLL_STEP;
        }
        while (Math.abs(scrollAcc.current.x) >= SCROLL_STEP) {
          const dir = scrollAcc.current.x > 0 ? 1 : -1;
          send({ type: "scroll", dx: -dir, dy: 0 });
          scrollAcc.current.x -= dir * SCROLL_STEP;
        }
      }
      prevMid.current = { x: midX, y: midY };
      return;
    }

    if (pts.current.size !== 1) return;
    if (travel > TAP_SLOP) clearLong();

    // Absolute path: touch mode, or mouse/pen/surface touchpad (OS cursor is absolute).
    if (isMouseLike(e) || mode === "touch") {
      moveAbsFromClient(e.clientX, e.clientY);
      if (!isMouseLike(e) && travel > TAP_SLOP && !touchPressed.current) {
        send({ type: "down", button: "left" });
        touchPressed.current = true;
      }
      return;
    }

    // Trackpad: relative cursor movement (phone finger).
    if (armedDrag.current && gesture.current !== "dragging" && travel > TAP_SLOP) {
      gesture.current = "dragging";
      send({ type: "down", button: "left" });
    }
    const l = liveLayout();
    if (!l) return;
    const speed = sensitivity / (l.dispW * zoomRef.current);
    setCursorPos(cursorRef.current.x + (e.clientX - prevX) * speed, cursorRef.current.y + (e.clientY - prevY) * speed);
  };

  const onWheel = (e: WheelEvent) => {
    // Quest surface touchpad two-finger scroll + mouse wheel.
    e.preventDefault();
    const dy = e.deltaY !== 0 ? (e.deltaY > 0 ? 1 : -1) : 0;
    const dx = e.deltaX !== 0 ? (e.deltaX > 0 ? 1 : -1) : 0;
    if (dx || dy) send({ type: "scroll", dx, dy });
  };

  // Non-passive wheel — React's onWheel is passive and can't preventDefault, so
  // the browser would scroll the page instead of forwarding to the PC.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

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
      const primaryClick =
        e.button === 0 &&
        g !== "two" &&
        (wasTap || g === "dragging" || g === "touchdrag" || g === "cursor");

      if (mode === "touch") {
        if (touchPressed.current) send({ type: "up", button: "left" });
        else if (wasTap && downCount.current === 1) send({ type: "click", button: "left" });
        if (downCount.current === 2 && wasTap && twoMode.current === "undecided") sendRightClick();
      } else if (g === "dragging") {
        send({ type: "up", button: "left" });
      } else if (g === "two") {
        if (twoMode.current === "undecided" && wasTap && downCount.current === 2) sendRightClick();
      } else if (g === "cursor" && wasTap && downCount.current === 1) {
        send({ type: "click", button: "left" });
        lastTapUp.current = now; // enables double-tap-drag & native double-click
      }

      // Quest: latch keyboard on click the same way the Keyboard icon does — stay
      // focused until the user explicitly dismisses (no host/timeout auto-blur).
      if (isQuestBrowser() && primaryClick) {
        lastPointerGestureAt.current = now;
        clearKbdTimers();
        questKbdArmedRef.current = false;
        questKbdLockedRef.current = true;
        setTyping(true);
        captureKeyboard();
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
    mods.forEach((m) => send({ type: "keyup", name: m }));
    setMods(new Set());
  };
  const toggleMod = (m: Mod) => {
    setMods((prev) => {
      const next = new Set(prev);
      if (next.has(m)) {
        next.delete(m);
        send({ type: "keyup", name: m });
      } else {
        next.add(m);
        send({ type: "keydown", name: m });
      }
      return next;
    });
  };
  /** Fire a named key wrapped in any sticky modifiers, then release them. */
  const tapKey = (name: string) => {
    send({ type: "key", name });
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
    setComposeText("");
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
    for (let k = 0; k < removed; k++) send({ type: "key", name: "backspace" });
    if (added) {
      if (mods.size > 0 && added.length === 1) tapKey(added.toLowerCase());
      else {
        send({ type: "text", value: added });
        releaseMods();
      }
    }
    prevVal.current = val;
    // Keep the field from growing unbounded; reset the base without emitting keys.
    if (val.length > 240) resetField();
  };

  const onKbdInput = () => {
    // Mirror the field into the compose bar on every input — including during
    // IME composition, so the preview always shows what's really been typed.
    setComposeText(kbdRef.current?.value ?? "");
    if (kbMode === "buffered") return; // sent on Enter
    if (composing.current) return; // wait for compositionend (CJK/IME)
    flushDiff();
  };

  // Buffered mode: flush the whole composed line to the PC -- never a PC Enter.
  const sendBuffer = () => {
    const el = kbdRef.current;
    const val = el?.value ?? "";
    if (val) {
      send({ type: "text", value: val });
      releaseMods();
    }
    resetField();
  };

  // Pressing the soft-keyboard return key. Buffered mode flushes the composed line as
  // text; direct mode fires a real PC Enter so the return key behaves like a physical
  // one (chat, search, terminal). Reached from two paths that can both fire for one
  // press — `keydown` (Android/hardware) and `beforeinput`/insertLineBreak (the only
  // signal the Quest system keyboard emits) — so a short window dedupes them.
  const lastEnterAt = useRef(0);
  const sendPcEnter = () => {
    const now = performance.now();
    if (now - lastEnterAt.current < 80) return;
    lastEnterAt.current = now;
    if (kbMode === "buffered") sendBuffer();
    else tapKey("enter");
  };
  // Backspace on an EMPTY field: the value can't shrink so the input-diff can't turn
  // it into a PC backspace — forward it directly (direct mode only; buffered mode
  // edits its local buffer). Deduped like Enter across keydown + beforeinput.
  const lastBkspAt = useRef(0);
  const sendEmptyBackspace = () => {
    if (kbMode !== "direct") return;
    if ((kbdRef.current?.value ?? "") !== "") return; // non-empty → let flushDiff handle it
    const now = performance.now();
    if (now - lastBkspAt.current < 40) return;
    lastBkspAt.current = now;
    send({ type: "key", name: "backspace" });
  };

  // `beforeinput` is emitted by soft keyboards even when `keydown` isn't — notably
  // the Quest system keyboard, whose only observable signal is the input value / these
  // events. It's the one place the Quest keyboard's own Enter and Backspace surface.
  // A ref keeps the latest closures without re-binding the native listener each render.
  const beforeInputRef = useRef<(e: InputEvent) => void>(() => {});
  beforeInputRef.current = (e: InputEvent) => {
    if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
      e.preventDefault();
      sendPcEnter();
    } else if (e.inputType === "deleteContentBackward" && (kbdRef.current?.value ?? "") === "") {
      sendEmptyBackspace();
    }
  };
  useEffect(() => {
    const el = kbdRef.current;
    if (!el) return;
    const h = (e: Event) => beforeInputRef.current(e as InputEvent);
    el.addEventListener("beforeinput", h);
    return () => el.removeEventListener("beforeinput", h);
  }, []);

  const onKbdKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendPcEnter();
      return;
    }
    if (e.key === "Backspace") {
      // Non-empty: let flushDiff turn the shrinking value into backspaces. Empty:
      // forward directly (repeat comes from the IME's own key-repeat).
      if (kbMode === "direct" && (kbdRef.current?.value ?? "") === "") {
        e.preventDefault();
        sendEmptyBackspace();
      }
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
    modKeys.forEach((m) => send({ type: "keydown", name: m }));
    if (key) send({ type: "key", name: key });
    [...modKeys].reverse().forEach((m) => send({ type: "keyup", name: m }));
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
  // Open/close a bottom panel. Tapping an already-open panel collapses it.
  const openPanel = (id: Panel) => {
    setDockCollapsed(false); // opening any panel implies the dock is visible
    setPanel((p) => (p === id ? null : id));
  };
  // Reveal the floating compose bar + raise the soft keyboard (works whether the
  // dock is open, collapsed, or immersive — the field is always mounted).
  // Clear before focus so Quest's overwrite-on-open can't look like "delete all".
  const startTyping = () => {
    clearKbdTimers();
    questKbdLockedRef.current = true;
    questKbdArmedRef.current = false;
    setTyping(true);
    resetField();
    window.setTimeout(() => kbdRef.current?.focus({ preventScroll: true }), 30);
  };
  const stopTyping = () => {
    clearKbdTimers();
    questKbdLockedRef.current = false;
    questKbdArmedRef.current = false;
    autoKbdRef.current = false;
    pcTextFieldRef.current = false;
    setPcTextField(false);
    kbdRef.current?.blur();
    setTyping(false);
  };

  /** Zoom chip: always visible. Tap resets when zoomed; tap at 1× zooms to 1.5×. */
  const onZoomButton = () => {
    const el = viewportRef.current;
    const l = layoutRef.current;
    if (!el || !l) {
      resetView();
      return;
    }
    const r = el.getBoundingClientRect();
    const cx = r.width / 2;
    const cy = r.height / 2;
    if (zoomRef.current > 1.01) resetView();
    else applyZoom(1.5, cx, cy);
  };

  // --- pinnable key / shortcut registry --------------------------------------
  // Data-driven so the dock panels, the pin toggles, and the floating quick-button
  // rail all share one source of truth (keyed by stable `id` for persistence).
  const specialKeys: KeyDef[] = [
    { id: "esc", keys: ["Esc"], wire: "escape", run: () => tapKey("escape") },
    { id: "tab", keys: ["Tab"], wire: "tab", run: () => tapKey("tab") },
    { id: "enter", keys: ["↵"], label: "Enter", wire: "enter", run: () => tapKey("enter") },
    { id: "backspace", keys: ["⌫"], label: "Bksp", wire: "backspace", run: () => tapKey("backspace") },
    { id: "delete", keys: ["Del"], wire: "delete", run: () => tapKey("delete") },
    { id: "home", keys: ["Home"], wire: "home", run: () => tapKey("home") },
    { id: "end", keys: ["End"], wire: "end", run: () => tapKey("end") },
    { id: "pageup", keys: ["PgUp"], wire: "pageup", run: () => tapKey("pageup") },
    { id: "pagedown", keys: ["PgDn"], wire: "pagedown", run: () => tapKey("pagedown") },
    { id: "insert", keys: ["Ins"], wire: "insert", run: () => tapKey("insert") },
    { id: "printscreen", keys: ["PrtSc"], run: () => tapKey("printscreen") },
    { id: "capslock", keys: ["Caps"], run: () => tapKey("capslock") },
    { id: "numlock", keys: ["Num"], run: () => tapKey("numlock") },
    { id: "scrolllock", keys: ["ScrLk"], run: () => tapKey("scrolllock") },
    { id: "pause", keys: ["Pause"], run: () => tapKey("pause") },
    { id: "ctrl", keys: ["Ctrl"], run: () => toggleMod("ctrl"), mod: "ctrl" },
    { id: "alt", keys: ["Alt"], run: () => toggleMod("alt"), mod: "alt" },
    { id: "shift", keys: ["Shift"], run: () => toggleMod("shift"), mod: "shift" },
    { id: "win", keys: ["Win"], run: () => toggleMod("win"), mod: "win" },
    { id: "arrow-left", keys: ["←"], label: "Left", wire: "left", run: () => tapKey("left") },
    { id: "arrow-up", keys: ["↑"], label: "Up", wire: "up", run: () => tapKey("up") },
    { id: "arrow-down", keys: ["↓"], label: "Down", wire: "down", run: () => tapKey("down") },
    { id: "arrow-right", keys: ["→"], label: "Right", wire: "right", run: () => tapKey("right") },
    ...Array.from({ length: 12 }, (_, i) => i + 1).map((n) => ({
      id: `f${n}`,
      keys: [`F${n}`],
      wire: `f${n}`,
      run: () => tapKey(`f${n}`),
    })),
    { id: "voldown", keys: ["Vol−"], label: "Vol down", run: () => tapKey("volumedown") },
    { id: "volup", keys: ["Vol+"], label: "Vol up", run: () => tapKey("volumeup") },
    { id: "mute", keys: ["Mute"], run: () => tapKey("volumemute") },
    { id: "prevtrack", keys: ["⏮"], label: "Prev", run: () => tapKey("prevtrack") },
    { id: "playpause", keys: ["⏯"], label: "Play", run: () => tapKey("playpause") },
    { id: "nexttrack", keys: ["⏭"], label: "Next", run: () => tapKey("nexttrack") },
  ];
  const shortcutKeys: KeyDef[] = [
    { id: "alt-tab", keys: ["Alt", "Tab"], label: "Switch", run: () => chord(["alt"], "tab") },
    { id: "win", keys: ["Win"], label: "Start", run: () => chord(["win"]) },
    { id: "show-desktop", keys: ["Win", "D"], label: "Desktop", run: () => chord(["win"], "d") },
    { id: "task-mgr", keys: ["Ctrl", "Shift", "Esc"], label: "Task Mgr", run: () => chord(["ctrl", "shift"], "escape") },
    { id: "alt-f4", keys: ["Alt", "F4"], label: "Close", run: () => chord(["alt"], "f4") },
    { id: "explorer", keys: ["Win", "E"], label: "Files", run: () => chord(["win"], "e") },
    { id: "copy", keys: ["Ctrl", "C"], label: "Copy", run: () => chord(["ctrl"], "c") },
    { id: "paste", keys: ["Ctrl", "V"], label: "Paste", run: () => chord(["ctrl"], "v") },
    { id: "cut", keys: ["Ctrl", "X"], label: "Cut", run: () => chord(["ctrl"], "x") },
    { id: "undo", keys: ["Ctrl", "Z"], label: "Undo", run: () => chord(["ctrl"], "z") },
    { id: "redo", keys: ["Ctrl", "Y"], label: "Redo", run: () => chord(["ctrl"], "y") },
    { id: "save", keys: ["Ctrl", "S"], label: "Save", run: () => chord(["ctrl"], "s") },
    { id: "select-all", keys: ["Ctrl", "A"], label: "All", run: () => chord(["ctrl"], "a") },
    { id: "ctrl-alt-del", keys: ["Ctrl", "Alt", "Del"], label: "Secure", run: () => chord(["ctrl", "alt"], "delete") },
  ];
  const customShortcutDefs: KeyDef[] = customShortcuts.map((c) => ({
    id: c.id,
    keys: [...c.mods.map((m) => MOD_LABEL[m]), keyCapLabel(c.key)],
    label: c.label,
    run: () => chord(c.mods, c.key),
  }));
  // Pinned ids resolve against a combined registry (shortcut ids are prefixed to
  // avoid colliding with same-named special keys, e.g. "win").
  const registry = useMemo(() => {
    const m = new Map<string, KeyDef & { active?: boolean }>();
    for (const k of specialKeys) m.set(`k:${k.id}`, k);
    for (const s of shortcutKeys) m.set(`s:${s.id}`, s);
    for (const s of customShortcutDefs) m.set(`s:${s.id}`, s);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mods, customShortcuts]);
  const pinnedDefs = pinned
    .map((id) => {
      const def = registry.get(id);
      return def ? { pid: id, def } : null;
    })
    .filter((x): x is { pid: string; def: KeyDef } => x !== null);
  // Mobile browsers only allow audio to start from a user gesture, so PC sound is
  // muted until the user taps this — then we unmute the *separate* audio element
  // (video stays muted forever so Chromium never A/V-syncs the screen track).
  const toggleSound = () => {
    const a = audioRef.current;
    if (!a) return;
    const next = !soundOn;
    a.muted = !next;
    if (next) a.play?.().catch(() => {});
    setSoundOn(next);
  };

  const zoomed = zoom > 1.01 || pan.x !== 0 || pan.y !== 0;
  const questBrowser = isQuestBrowser();
  // Pin to the visual viewport while the soft keyboard is up (Android WebView pan
  // mode). Quest Surface Keyboard never shrinks the remote viewport.
  const pinKb = !questBrowser && vvPin != null;
  const bottomReserve = questBrowser || pinKb ? 0 : kbInset;
  const cursorScreen = useMemo(() => {
    return normToViewport(viewportRef.current, mediaEl(), cursor.x, cursor.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, zoom, pan, hasStream, wcActive, immersive, topCollapsed, dockCollapsed, browserFs, kbInset, vvPin]);
  // Trackpad / Quest: hide the OS pointer and draw RemoteCursor (shape mirrors host).
  // Desktop web mouse/pen: live CSS cursor instead (no double-cursor).
  const showRemoteCursor = mode === "trackpad" || questBrowser;
  const viewportCssCursor = showRemoteCursor
    ? "none"
    : cssCursorFor(dragging ? "grab" : cursorKind);

  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden bg-black select-none"
      style={{
        overscrollBehavior: "none",
        touchAction: "none",
        paddingBottom: bottomReserve || undefined,
        ...(pinKb && vvPin
          ? {
              position: "fixed",
              top: vvPin.top,
              left: vvPin.left,
              width: vvPin.width,
              height: vvPin.height,
              zIndex: 40,
            }
          : null),
      }}
    >
      {/* ==== top toolbar — flex sibling (shrinks video); collapsible like the bottom dock ==== */}
      {!immersive && !topCollapsed && !pipView && (
        <div
          className="relative z-40 flex shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-base/95 px-2 py-1.5 backdrop-blur"
          style={{ paddingTop: "max(0.35rem, env(safe-area-inset-top))" }}
        >
          <div className="relative flex min-w-0 items-center gap-2 rounded-xl bg-white/[0.04] px-2 py-1">
            {onNavigate && (
              <button
                onClick={() => setNavOpen((o) => !o)}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-soft active:bg-white/[0.08]"
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
                    { id: "stats", label: "Home", icon: BarChart3 },
                    { id: "library", label: "Library", icon: LibraryIcon },
                    { id: "timeline", label: "Timeline", icon: ClockIcon },
                    { id: "collection", label: "Collection", icon: TrophyIcon },
                    { id: "music", label: "Music", icon: Headphones },
                    { id: "system", label: "System", icon: CpuIcon },
                    { id: "settings", label: "Settings", icon: SettingsIcon },
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
                <Loader2 className="h-3 w-3 animate-spin" /> {progress ? statusLabel(progress) : "Connecting"}
              </span>
            )}
            {connected && (
              <span className="flex items-center gap-1.5 border-l border-white/10 pl-2 text-[10px] font-700 text-ink-faint">
                <Wifi className="h-3 w-3 shrink-0" />
                <span className="whitespace-nowrap tabular-nums">{fps} fps</span>
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

          <div className="flex shrink-0 items-center gap-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
            {popoutMonitor != null ? (
              <span className="flex items-center gap-1 rounded-lg bg-accent-3/15 px-2 py-1.5 text-xs font-700 text-accent-3">
                <Monitor className="h-3.5 w-3.5" /> Display {popoutMonitor + 1}
              </span>
            ) : (
              monitors.length > 1 && (
                <>
                  <button
                    onClick={() => selectMonitor((monitorIdx + 1) % monitors.length)}
                    className="flex items-center gap-1 rounded-lg bg-white/[0.04] px-2 py-1.5 text-xs font-700 text-ink-soft active:scale-95"
                    title="Switch display in this tab"
                  >
                    <Monitor className="h-3.5 w-3.5" /> {monitorIdx + 1}/{monitors.length}
                  </button>
                  {!isApk &&
                    monitors
                      .filter((m) => m.index !== monitorIdx)
                      .map((m) => (
                        <button
                          key={m.index}
                          onClick={() => openMonitorPopout(m.index)}
                          className="flex items-center gap-1 rounded-lg bg-white/[0.04] px-2 py-1.5 text-xs font-700 text-ink-soft active:scale-95"
                          title={`Open ${m.name || `Display ${m.index + 1}`} in a new tab (side-by-side)`}
                        >
                          <AppWindow className="h-3.5 w-3.5" /> {m.index + 1}
                        </button>
                      ))}
                </>
              )
            )}
            <button
              onClick={onZoomButton}
              className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-700 active:scale-95 ${
                zoomed ? "bg-accent-3/20 text-white" : "bg-white/[0.04] text-ink-soft"
              }`}
              title={zoomed ? "Reset zoom" : "Zoom in"}
            >
              <RotateCcw className="h-3.5 w-3.5" /> {zoom.toFixed(1)}×
            </button>
            {hasAudio && (
              <button
                onClick={toggleSound}
                className={`grid h-8 w-8 place-items-center rounded-lg active:scale-95 ${
                  soundOn ? "bg-accent-3/20 text-accent-3" : "bg-white/[0.04] text-ink-soft"
                }`}
                title={soundOn ? "Mute PC sound" : "Play PC sound"}
              >
                {soundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>
            )}
            <button
              onClick={screenshot}
              className="grid h-8 w-8 place-items-center rounded-lg bg-white/[0.04] text-ink-soft active:scale-95"
              title="Save frame"
            >
              <Camera className="h-4 w-4" />
            </button>
            {vrSupported && onEnterVr && (
              <>
                {onVrModeChange && (
                  <div className="flex overflow-hidden rounded-lg bg-white/[0.04]">
                    <button
                      onClick={() => onVrModeChange("pointer")}
                      className={`grid h-8 w-8 place-items-center active:scale-95 ${
                        vrMode === "pointer" ? "bg-accent-3/25 text-accent-3" : "text-ink-soft"
                      }`}
                      title="VR pointer mode"
                    >
                      <MousePointer2 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => onVrModeChange("gamepad")}
                      className={`grid h-8 w-8 place-items-center active:scale-95 ${
                        vrMode === "gamepad" ? "bg-accent-3/25 text-accent-3" : "text-ink-soft"
                      }`}
                      title="VR gamepad mode"
                    >
                      <Gamepad2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
                <button
                  onClick={onEnterVr}
                  className="flex items-center gap-1.5 rounded-lg bg-accent-3/15 px-2 py-1.5 text-xs font-700 text-accent-3 active:scale-95"
                  title="Enter immersive VR"
                >
                  <Headset className="h-3.5 w-3.5" /> VR
                </button>
              </>
            )}
            {browserFsSupported ? (
              <button
                onClick={toggleBrowserFullscreen}
                className={`grid h-8 w-8 place-items-center rounded-lg active:scale-95 ${
                  browserFs ? "bg-accent-3/20 text-accent-3" : "bg-white/[0.04] text-ink-soft"
                }`}
                title={browserFs ? "Exit browser fullscreen" : "Browser fullscreen"}
              >
                {browserFs ? <Shrink className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
              </button>
            ) : (
              <button
                onClick={() => setImmersive(true)}
                className="grid h-8 w-8 place-items-center rounded-lg bg-white/[0.04] text-ink-soft active:scale-95"
                title="Hide all chrome"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={() => setTopCollapsed(true)}
              className="grid h-8 w-8 place-items-center rounded-lg bg-white/[0.04] text-ink-soft active:scale-95"
              title="Hide toolbar"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ==== viewport — video only; chrome above/below shrinks this, never overlays it ==== */}
      <div className="relative min-h-0 flex-1">
      {/* ---- screen viewport ---- */}
      <div
        ref={viewportRef}
        className="absolute inset-0 flex items-center justify-center overflow-hidden touch-none"
        style={{ cursor: viewportCssCursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          hidden={!hasStream || wcActive}
          onLoadedMetadata={onVideoSized}
          onResize={onVideoSized}
          onPlaying={() => setHasFrame(true)}
          onLoadedData={() => {
            const v = videoRef.current;
            if (v && v.videoWidth > 0) setHasFrame(true);
          }}
          className="max-h-full max-w-full select-none object-contain will-change-transform"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "center center",
            cursor: "inherit",
          }}
        />
        {/* Desktop audio — MUST stay off the video MediaStream (A/V sync). */}
        <audio ref={audioRef} autoPlay playsInline className="hidden" />
        <canvas
          ref={canvasRef}
          hidden={hasStream && !wcActive}
          className="max-h-full max-w-full select-none object-contain will-change-transform"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "center center",
            cursor: "inherit",
          }}
        />
        {showRemoteCursor && connected && cursorScreen && (
          <RemoteCursor x={cursorScreen.x} y={cursorScreen.y} kind={cursorKind} dragging={dragging} fx={cursorFx} />
        )}
        {/* App-icon placeholder for the ~1s gap before the first frame arrives. */}
        <AnimatePresence>
          {connected && !hasFrame && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="pointer-events-none absolute inset-0 grid place-items-center bg-black"
            >
              <motion.div
                className="flex flex-col items-center gap-4"
                animate={{ scale: [1, 1.05, 1], opacity: [0.75, 1, 0.75] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
              >
                <img src="/app-icon.png" alt="" className="h-24 w-24 rounded-3xl shadow-glow" />
                <span className="flex items-center gap-2 text-xs font-700 text-ink-dim">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waking your screen…
                </span>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
        {showReconnect && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            {progress ? (
              <ConnectionProgress snapshot={progress} compact showSteps />
            ) : (
              <div className="flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-sm text-white backdrop-blur">
                <Loader2 className="h-4 w-4 animate-spin" /> Reconnecting…
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- collapsed top / immersive restore chips (same pattern as bottom Controls) ---- */}
      {(immersive || topCollapsed) && !pipView && (
        <div
          className="absolute left-2 right-2 z-40 flex items-center justify-between gap-1.5"
          // Edge-flush on purpose: the stream itself paints under the notch, so the
          // floating pills sit at the true top edge (no safe-area offset).
          style={{ top: "0.375rem" }}
        >
          <div className="flex items-center gap-1.5">
            {connected && (
              <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-black/45 px-2.5 py-1 text-[10px] font-700 text-green backdrop-blur">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green" style={{ boxShadow: "0 0 6px #34d399" }} />
                <span className="whitespace-nowrap tabular-nums">{fps} fps</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={onZoomButton}
              className="flex items-center gap-1 rounded-full bg-black/45 px-2.5 py-1.5 text-xs font-700 text-white/90 backdrop-blur"
              title={zoomed ? "Reset zoom" : "Zoom in"}
            >
              <RotateCcw className="h-3.5 w-3.5" /> {zoom.toFixed(1)}×
            </motion.button>
            {/* No keyboard chip here: immersive/collapsed-dock states already show
                the bottom-left keyboard FAB, and the visible dock has its own
                Keyboard tab — a second toggle up top was a confusing duplicate. */}
            {browserFsSupported && (
              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={toggleBrowserFullscreen}
                className={`grid h-9 w-9 place-items-center rounded-full border backdrop-blur ${
                  browserFs ? "border-accent-3/50 bg-accent-3/30 text-white" : "border-white/15 bg-black/45 text-white/90"
                }`}
                title={browserFs ? "Exit browser fullscreen" : "Browser fullscreen"}
              >
                {browserFs ? <Shrink className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
              </motion.button>
            )}
            {immersive ? (
              <motion.button
                whileTap={{ scale: 0.92 }}
                onClick={() => setImmersive(false)}
                className="flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-xs font-700 text-white/90 backdrop-blur"
                title="Show controls"
              >
                <Minimize2 className="h-4 w-4" /> Controls
              </motion.button>
            ) : (
              <motion.button
                whileTap={{ scale: 0.92 }}
                onClick={() => setTopCollapsed(false)}
                className="flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-xs font-700 text-white/90 backdrop-blur"
                title="Show toolbar"
              >
                <ChevronDown className="h-4 w-4" /> Toolbar
              </motion.button>
            )}
          </div>
        </div>
      )}

      {/* ---- performance / debug HUD (dense 2-col — double the telemetry, same footprint) ---- */}
      {showStats && !immersive && !topCollapsed && !pipView && (
        <div className="absolute right-2 top-2 z-30 w-[17.5rem] max-w-[92vw] rounded-xl border border-white/[0.1] bg-black/70 p-2 text-[9px] leading-snug text-ink-soft shadow-float backdrop-blur-md">
          <div className="mb-1 flex items-center justify-between gap-1.5">
            <span className="flex items-center gap-1 text-[10px] font-800 text-white">
              <Gauge className="h-3 w-3 text-accent-3" /> Stream stats
              <span className={`rounded px-1 py-0.5 text-[8px] font-800 ${wcStats ? "bg-green/20 text-green" : "bg-white/[0.08] text-ink-soft"}`}>
                {wcStats ? "DIRECT" : hasStream ? "RTC" : "LAN"}
              </span>
            </span>
            {(() => {
              // Glass-to-glass estimate: wc path measures it for real (clock-synced
              // capture→decode); the RTC path approximates rtt/2 + buffer + decode.
              const lag = wcStats ? wcStats.e2eMs : net ? Math.round(net.rttMs / 2 + net.bufMs + net.decMs) : null;
              if (lag == null) return null;
              return (
                <span
                  className={`rounded px-1 py-0.5 font-800 tabular-nums ${
                    lag <= 50 ? "bg-green/20 text-green" : lag <= 100 ? "bg-amber/20 text-amber" : "bg-red/20 text-red"
                  }`}
                >
                  ~{Math.max(1, lag)}ms
                </span>
              );
            })()}
          </div>
          {wcStats ? (
            /* Direct WebCodecs path — per-stage latency is measured, not inferred. */
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
              <StatCell k="Display" v={`${fps} fps`} />
              <StatCell k="Decode" v={`${wcStats.fps} fps`} />
              <StatCell k="Res out" v={res || "—"} />
              <StatCell k="Bitrate ↓" v={wcStats.kbps >= 1000 ? `${(wcStats.kbps / 1000).toFixed(1)}M` : `${wcStats.kbps}k`} />
              <StatCell k="E2E" v={`${wcStats.e2eMs} ms`} hi={wcStats.e2eMs > 80} />
              <StatCell k="Net+enc" v={`${wcStats.netMs} ms`} />
              <StatCell k="Decode ms" v={`${wcStats.decodeMs.toFixed(1)}`} />
              <StatCell k="Dec queue" v={`${wcStats.queue}`} hi={wcStats.queue > 3} />
              <StatCell k="Frame KB" v={`${wcStats.avgFrameKB}`} />
              <StatCell k="Codec" v={wcStats.codec.replace(/^avc1\./, "H264/")} />
              <StatCell k="Frames" v={`${wcStats.frames}`} />
              <StatCell k="Keyframes" v={`${wcStats.keyFrames}`} />
              <StatCell k="Data ↓" v={`${(wcStats.bytes / 1048576).toFixed(1)} MB`} />
              <StatCell k="Clock ±" v={`${wcStats.clockRttMs} ms`} />
              <StatCell k="Buffer" v="0 ms" />
              <StatCell k="JB tgt/min" v="bypassed" />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
              <StatCell k="Display" v={`${fps} fps`} />
              <StatCell k="Decode" v={net ? `${net.fps} fps` : "—"} />
              <StatCell k="Res out" v={net && net.w ? `${net.w}×${net.h}` : res || "—"} />
              <StatCell
                k="Bitrate ↓"
                v={net ? (net.kbps >= 1000 ? `${(net.kbps / 1000).toFixed(1)}M` : `${net.kbps}k`) : "—"}
              />
              <StatCell k="RTT" v={net ? `${net.rttMs} ms` : "—"} />
              <StatCell k="Buffer" v={net ? `${net.bufMs} ms` : "—"} hi={!!net && net.bufMs > 60} />
              <StatCell k="JB tgt/min" v={net ? `${net.jbTargetMs}·${net.jbMinMs}` : "—"} />
              <StatCell k="Decode ms" v={net ? `${net.decMs.toFixed(1)}` : "—"} />
              <StatCell k="Jitter" v={net ? `${net.jitterMs} ms` : "—"} />
              <StatCell k="Loss" v={net ? `${net.lostPkts} pkt` : "—"} />
              <StatCell k="Drop / frz" v={net ? `${net.dropped} · ${net.freezes}` : "—"} hi={!!net && net.freezes > 10} />
              <StatCell k="NACK/PLI" v={net ? `${net.nackCount} · ${net.pliCount}` : "—"} />
              <StatCell k="FIR / IDR↓" v={net ? `${net.firCount} · ${net.keyFramesDecoded}` : "—"} />
              <StatCell k="Pkts ↓" v={net ? `${net.packetsReceived}` : "—"} />
              <StatCell k="Decoded" v={net ? `${net.framesDecoded}` : "—"} />
              <StatCell k="Rendered" v={net ? `${net.framesRendered || "—"}` : "—"} />
            </div>
          )}
          {hostStats && (
            <>
              <div className="my-1 border-t border-white/[0.08]" />
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                <StatCell k="Host prod" v={`${hostStats.producedFps ?? "–"}/${hostStats.fps}`} />
                <StatCell k="Send fps" v={hostStats.rtc ? `${hostStats.rtc.sendFps}` : "—"} />
                <StatCell k="Cap/scl" v={`${hostStats.captureMs.toFixed(0)}·${hostStats.scaleMs.toFixed(0)}`} />
                <StatCell k="JPEG ms" v={`${hostStats.encodeMs.toFixed(1)}`} />
                <StatCell k="Host Σ" v={`${(hostStats.captureMs + hostStats.scaleMs + hostStats.encodeMs).toFixed(0)} ms`} />
                <StatCell k="JPEG KB" v={`${(hostStats.frameBytes / 1024).toFixed(0)}`} hi={hostStats.frameBytes > 200_000} />
                <StatCell k="Native" v={`${hostStats.nativeW}×${hostStats.nativeH}`} />
                <StatCell k="Out" v={`${hostStats.outW}×${hostStats.outH}`} />
                <StatCell
                  k="Send ↑"
                  v={
                    hostStats.rtc
                      ? hostStats.rtc.sendKbps >= 1000
                        ? `${(hostStats.rtc.sendKbps / 1000).toFixed(1)}M`
                        : `${hostStats.rtc.sendKbps}k`
                      : "—"
                  }
                />
                <StatCell k="Enc max" v={hostStats.rtc ? `${hostStats.rtc.encMaxKbps}k` : "—"} />
                <StatCell k="Codec" v={hostStats.rtc?.codec || "—"} />
                <StatCell k="QP avg" v={hostStats.rtc ? `${hostStats.rtc.qp}` : "—"} />
                <StatCell k="IDR ↑" v={hostStats.rtc ? `${hostStats.rtc.keyFrames}` : "—"} />
                <StatCell k="NACK↑/PLI↑" v={hostStats.rtc ? `${hostStats.rtc.nack}·${hostStats.rtc.pli}` : "—"} />
                <StatCell k="JPEG q" v={hostStats.rtc ? `${hostStats.rtc.jpegQ}` : "—"} />
                <StatCell k="Mode" v={hostStats.rtc?.content || "—"} />
                {hostStats.wc?.on && (
                  <>
                    <StatCell k="H264 enc" v={`${hostStats.wc.encMs ?? 0} ms`} hi={(hostStats.wc.encMs ?? 0) > 15} />
                    <StatCell k="Enc cap" v={`${hostStats.wc.kbpsMax ?? 0}k`} />
                    <StatCell k="Skipped" v={`${hostStats.wc.skipped ?? 0}`} hi={(hostStats.wc.skipped ?? 0) > 30} />
                    <StatCell k="Ch buf" v={`${hostStats.wc.bufKB ?? 0} KB`} hi={(hostStats.wc.bufKB ?? 0) > 128} />
                  </>
                )}
              </div>
            </>
          )}
          <div className="mt-1 rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[9px] font-700 text-accent-3">
            {bottleneckHint(hostStats, net, fps, wcStats)}
          </div>
        </div>
      )}

      {/* ---- pinned quick-button rail (small, semi-transparent, screen edge) ---- */}
      {pinnedDefs.length > 0 && !pipView && (
        <div
          className="pointer-events-none absolute right-1.5 top-1/2 z-30 flex max-h-[70%] -translate-y-1/2 flex-col gap-1.5 overflow-y-auto py-1"
          style={{ scrollbarWidth: "none" }}
        >
          <AnimatePresence initial={false}>
            {pinnedDefs.map(({ pid, def }) => (
              <PinnedButton
                key={pid}
                def={def}
                pinMode={pinMode}
                active={(def.mod ? mods.has(def.mod) : false) || (!!def.wire && heldKeys.has(def.wire))}
                onRun={() => {
                  navigator.vibrate?.(8);
                  def.run();
                }}
                onHoldDown={() => def.wire && pressHold(def.wire)}
                onHoldUp={() => def.wire && releaseHold(def.wire)}
                onUnpin={() => togglePin(pid)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* ---- "tap to type" — phone fallback when auto-focus needs a gesture ---- */}
      {!typing && pcTextField && !questBrowser && !pipView && (
        <motion.button
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          whileTap={{ scale: 0.94 }}
          onClick={startTyping}
          className="absolute bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-accent-3 px-4 py-2 text-xs font-800 text-white shadow-glow"
        >
          <Keyboard className="h-4 w-4" /> Tap to type on PC
        </motion.button>
      )}

      {/* ---- collapsed-dock helpers: stay visible while typing (Controls must not vanish) ---- */}
      {(immersive || dockCollapsed) && !pipView && (
        <div
          className="absolute bottom-2 left-2 right-2 z-40 flex items-center justify-between"
          style={{ marginBottom: "env(safe-area-inset-bottom)" }}
        >
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => (typing ? stopTyping() : startTyping())}
            className={`grid h-11 w-11 place-items-center rounded-full border shadow-float backdrop-blur ${
              typing ? "border-accent-3/50 bg-accent-3/30 text-white" : "border-white/15 bg-black/45 text-white/90"
            }`}
            title={typing ? "Stop typing" : "Keyboard"}
          >
            <Keyboard className="h-5 w-5" />
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.92 }}
            onClick={() => {
              if (immersive) setImmersive(false);
              else setDockCollapsed(false);
            }}
            className="ml-auto flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-xs font-700 text-white/90 backdrop-blur"
            title="Show controls"
          >
            <ChevronUp className="h-4 w-4" /> Controls
          </motion.button>
        </div>
      )}
      </div>{/* ==== end viewport area ==== */}

      {/* Ghost input — ABSOLUTE inside this screen (not fixed to the layout
          viewport). A fixed bottom-anchored field sits under the soft keyboard,
          so Android pans the visual viewport and the stream slides off the top;
          dragging near the bottom then worsens the offset. Keeping the caret
          inside the pinned/shrunk screen stops that. */}
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
          // Reset diff base on each focus session (Quest overwrite-on-open).
          // Speculative click-capture must not flip phone chrome.
          resetField();
          if (pcTextFieldRef.current || questKbdLockedRef.current) setTyping(true);
          if (!isQuestBrowser()) {
            setTyping(true);
            // The dock (and any open panel) stays as-is — panels and the soft
            // keyboard are allowed to coexist; dock buttons no longer steal focus.
          }
          // Belt-and-braces: undo any IME scroll the moment focus lands.
          window.scrollTo(0, 0);
        }}
        onBlur={() => {
          // Quest: reclaim focus while latched (Surface Keyboard can transiently
          // blur the field). Never reclaim after an explicit stopTyping (lock cleared).
          if (questKbdLockedRef.current) {
            window.setTimeout(() => {
              if (questKbdLockedRef.current && document.activeElement !== kbdRef.current) {
                kbdRef.current?.focus({ preventScroll: true });
              }
            }, 0);
            return;
          }
          setTyping(false);
        }}
        className="pointer-events-none absolute z-[60] h-7 w-7 border-0 p-0 outline-none"
        style={{
          opacity: 0.01,
          caretColor: "transparent",
          // Sit in the compose band (or just above the dock) — always inside the
          // visible Control shell, never under the soft keyboard.
          left: 12,
          bottom: typing && !questBrowser ? 10 : 12,
        }}
        aria-hidden={!typing}
        inputMode="text"
        enterKeyHint={kbMode === "buffered" ? "send" : "enter"}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
      />

      {/* Phone-only compose row — flex sibling (shrinks video), never overlays stream */}
      {typing && !questBrowser && (
        <div
          className="shrink-0 border-t border-white/10 bg-base/95 px-2 py-1.5 backdrop-blur"
          style={{ paddingBottom: "max(0.35rem, env(safe-area-inset-bottom))" }}
        >
          <div className="flex items-center gap-1.5">
            {/* preventDefault on pointerdown: keep the ghost input focused so the
                soft keyboard stays up across mode switches and Send taps. */}
            <div className="flex shrink-0 rounded-lg bg-white/[0.05] p-0.5">
              <button onPointerDown={(e) => e.preventDefault()} onClick={() => setKbMode("direct")} title="Direct" className={`grid h-8 w-8 place-items-center rounded-md transition ${kbMode === "direct" ? "bg-accent-3 text-white" : "text-ink-dim"}`}><Keyboard className="h-4 w-4" /></button>
              <button onPointerDown={(e) => e.preventDefault()} onClick={() => setKbMode("buffered")} title="Buffered" className={`grid h-8 w-8 place-items-center rounded-md transition ${kbMode === "buffered" ? "bg-accent-3 text-white" : "text-ink-dim"}`}><Send className="h-4 w-4" /></button>
            </div>
            {/* Live preview of the typed text; show the TAIL when it overflows
                (the recent characters matter, not the start of the line). */}
            <div className="min-w-0 flex-1 truncate px-2 text-xs" style={{ direction: composeText ? "rtl" : undefined }}>
              {composeText ? (
                <span className="font-600 text-white" style={{ unicodeBidi: "plaintext" }}>
                  {composeText}
                </span>
              ) : (
                <span className="text-ink-dim">{kbMode === "buffered" ? "Type on the keyboard, then Send" : "Typing to PC…"}</span>
              )}
            </div>
            {kbMode === "buffered" && (
              <button onPointerDown={(e) => e.preventDefault()} onClick={sendBuffer} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-3 text-white active:scale-95" title="Send"><Send className="h-4 w-4" /></button>
            )}
            <button onClick={stopTyping} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-dim active:bg-white/[0.08]" title="Close"><X className="h-4 w-4" /></button>
          </div>
        </div>
      )}

      {/* ==== bottom control bar ==== */}
      {!immersive && !dockCollapsed && !pipView && (
        <motion.div
          initial={{ y: 32, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          className="shrink-0 border-t border-white/10 bg-base/95 backdrop-blur"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          {/* expanded control panels — each a single horizontally-scrollable row of icons */}
          {panel === "mouse" && (
            <div className="flex items-center gap-1.5 overflow-x-auto border-b border-white/5 px-2 py-2">
              <IcoBtn active title={mode === "trackpad" ? "Trackpad mode" : "Direct-touch mode"} onClick={() => setMode((m) => (m === "trackpad" ? "touch" : "trackpad"))}>
                {mode === "trackpad" ? <Pointer className="h-4 w-4" /> : <Hand className="h-4 w-4" />}
              </IcoBtn>
              <Sep />
              <IcoBtn title="Left click" onClick={() => send({ type: "click", button: "left" })}><MousePointer2 className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Right click" onClick={() => send({ type: "click", button: "right" })}><MousePointerClick className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Middle click" onClick={() => send({ type: "click", button: "middle" })}><Command className="h-4 w-4" /></IcoBtn>
              {mode === "trackpad" && (
                <IcoBtn active={dragLock} title={dragLock ? "Drag lock: ON" : "Drag lock"} onClick={() => { if (dragLock) { send({ type: "up", button: "left" }); setDragLock(false); } else setDragLock(true); }}>
                  <Hand className="h-4 w-4" />
                </IcoBtn>
              )}
              <IcoBtn title="Scroll up" onClick={() => send({ type: "scroll", dy: -3 })}><ChevronUp className="h-4 w-4" /></IcoBtn>
              <IcoBtn title="Scroll down" onClick={() => send({ type: "scroll", dy: 3 })}><ChevronDown className="h-4 w-4" /></IcoBtn>
              <Sep />
              <div className="flex shrink-0 items-center gap-1.5 pr-1" title="Pointer speed">
                <Gauge className="h-3.5 w-3.5 text-ink-dim" />
                <input type="range" min="0.6" max="3.5" step="0.1" value={sensitivity} onChange={(e) => setSensitivity(parseFloat(e.target.value))} className="w-24 accent-accent-3" />
                <span className="w-7 text-[10px] font-700 text-white">{sensitivity.toFixed(1)}×</span>
              </div>
            </div>
          )}

          {panel === "keys" && (
            <div className="flex items-center gap-1.5 overflow-x-auto border-b border-white/5 px-2 py-2.5">
              <PinModeToggle
                active={pinMode}
                onClick={() => setPinMode((v) => !v)}
              />
              {heldKeys.size > 0 && <ReleaseHeldButton count={heldKeys.size} onClick={releaseAllHeld} />}
              <Sep />
              {specialKeys.map((k) => (
                <KeyCapButton
                  key={k.id}
                  def={k}
                  pinMode={pinMode}
                  pinned={pinned.includes(`k:${k.id}`)}
                  active={k.mod ? mods.has(k.mod) : false}
                  held={!!k.wire && heldKeys.has(k.wire)}
                  onFire={k.run}
                  onHoldDown={() => k.wire && pressHold(k.wire)}
                  onHoldUp={() => k.wire && releaseHold(k.wire)}
                  onTogglePin={() => togglePin(`k:${k.id}`)}
                />
              ))}
            </div>
          )}

          {panel === "shortcuts" && (
            <div className="flex items-center gap-1.5 overflow-x-auto border-b border-white/5 px-2 py-2.5">
              <PinModeToggle active={pinMode} onClick={() => setPinMode((v) => !v)} />
              <Sep />
              {shortcutKeys.map((s) => (
                <KeyCapButton
                  key={s.id}
                  def={s}
                  pinMode={pinMode}
                  pinned={pinned.includes(`s:${s.id}`)}
                  onFire={s.run}
                  onTogglePin={() => togglePin(`s:${s.id}`)}
                />
              ))}
              {customShortcutDefs.map((s) => (
                <KeyCapButton
                  key={s.id}
                  def={s}
                  pinMode={pinMode}
                  pinned={pinned.includes(`s:${s.id}`)}
                  onFire={s.run}
                  onTogglePin={() => togglePin(`s:${s.id}`)}
                  deletable
                  onDelete={() => deleteCustomShortcut(s.id)}
                />
              ))}
              {addingShortcut ? (
                <div className="flex shrink-0 items-center gap-1.5 rounded-xl border border-white/[0.1] bg-white/[0.04] px-2 py-1">
                  <input
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                    placeholder="Label"
                    className="w-16 rounded-md border border-white/[0.08] bg-black/30 px-1.5 py-1 text-[10px] font-700 text-white outline-none placeholder:text-ink-faint focus:border-accent-3"
                  />
                  {ALL_MODS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() =>
                        setDraftMods((prev) => {
                          const next = new Set(prev);
                          if (next.has(m)) next.delete(m);
                          else next.add(m);
                          return next;
                        })
                      }
                      className={`rounded-md px-1.5 py-1 text-[9px] font-800 uppercase ${
                        draftMods.has(m) ? "bg-accent-3 text-white" : "bg-white/[0.06] text-ink-dim"
                      }`}
                    >
                      {MOD_LABEL[m]}
                    </button>
                  ))}
                  <select
                    value={draftKey}
                    onChange={(e) => setDraftKey(e.target.value)}
                    className="max-w-[4.5rem] rounded-md border border-white/[0.08] bg-black/30 px-1 py-1 text-[10px] font-700 text-white outline-none"
                  >
                    {SHORTCUT_KEY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={saveCustomShortcut}
                    className="rounded-md bg-accent-3 px-2 py-1 text-[10px] font-800 text-white active:scale-95"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingShortcut(false);
                      resetDraft();
                    }}
                    className="grid h-7 w-7 place-items-center rounded-md text-ink-dim active:bg-white/[0.08]"
                    title="Cancel"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={() => setAddingShortcut(true)}
                  className="relative flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-xl border border-dashed border-white/20 text-ink-dim active:bg-white/[0.06]"
                  title="Add custom shortcut"
                >
                  <Plus className="h-4 w-4" />
                </motion.button>
              )}
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

          {panel === "gamepad" && (
            <div className="flex flex-col gap-2 border-b border-white/5 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setControllerOn((v) => !v)}
                  className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12px] font-700 ${controllerOn ? "bg-accent-3 text-white" : "bg-white/[0.06] text-ink-soft"}`}
                >
                  <Gamepad2 className="h-4 w-4" />
                  {controllerOn ? "Controller ON" : "Turn on controller"}
                </button>
                {controllerOn && (
                  <span className={`flex items-center gap-1.5 text-[11px] font-600 ${padConnected ? "text-green" : "text-ink-dim"}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${padConnected ? "bg-green" : "bg-ink-faint"}`} />
                    {padConnected ? "Pad connected" : "Press a button on your controller"}
                  </span>
                )}
              </div>
              {controllerOn && padConnected && padName && (
                <p className="truncate text-[10px] text-ink-faint">{padName}</p>
              )}
              {controllerOn && padAvailable === false ? (
                <p className="text-[11px] leading-snug text-red">
                  Your PC needs the free <span className="font-700">ViGEmBus</span> driver to accept a controller. Install it from <span className="font-700">vigembus.com</span>, then reconnect.
                </p>
              ) : (
                <p className="text-[10px] leading-snug text-ink-dim">
                  Plug or pair a controller to your phone, then play the game shown here — your controller drives the PC as an Xbox pad. Keep the game focused on the PC.
                </p>
              )}
            </div>
          )}

          {/* always-visible icon tab strip */}
          <div className="flex items-center gap-1 px-1.5 py-1.5">
            <Tab active={panel === "mouse"} onClick={() => openPanel("mouse")} title="Mouse"><MousePointer2 className="h-5 w-5" /></Tab>
            <Tab active={panel === "keys"} onClick={() => openPanel("keys")} title="Special keys"><Command className="h-5 w-5" /></Tab>
            <Tab active={panel === "shortcuts"} onClick={() => openPanel("shortcuts")} title="Shortcuts"><Grip className="h-5 w-5" /></Tab>
            <Tab active={typing} onClick={() => (typing ? stopTyping() : startTyping())} title="Keyboard"><Keyboard className="h-5 w-5" /></Tab>
            <Tab active={panel === "gamepad" || controllerOn} onClick={() => openPanel("gamepad")} title="Controller"><Gamepad2 className="h-5 w-5" /></Tab>
            <Tab active={panel === "quality"} onClick={() => openPanel("quality")} title="Quality"><Gauge className="h-5 w-5" /></Tab>
            <button
              onClick={() => {
                setPanel(null);
                setDockCollapsed(true);
              }}
              title="Hide controls (full-screen viewport)"
              className="ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-soft active:bg-white/[0.08]"
            >
              <ChevronDown className="h-5 w-5" />
            </button>
            {onDisconnect && (
              <button onClick={onDisconnect} title="Disconnect" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-red/20 bg-red/5 text-red active:scale-95">
                <LogOut className="h-4 w-4" />
              </button>
            )}
          </div>
        </motion.div>
      )}
    </div>
  );
}

// ---------- remote cursor ----------
/** Icons for each mirrored desktop cursor shape. `center` = the icon's hotspot is
 *  its centre (I-beam, resize, move) vs. the top-left tip (arrow/hand). */
const CURSOR_ICONS: Record<string, { Icon: typeof MousePointer2; center?: boolean }> = {
  arrow: { Icon: MousePointer2 },
  hand: { Icon: Pointer },
  grab: { Icon: Grab, center: true },
  text: { Icon: TextCursor, center: true },
  busy: { Icon: Loader2, center: true },
  move: { Icon: Move, center: true },
  "resize-ns": { Icon: MoveVertical, center: true },
  "resize-we": { Icon: MoveHorizontal, center: true },
  "resize-nwse": { Icon: MoveDiagonal, center: true },
  "resize-nesw": { Icon: MoveDiagonal2, center: true },
  cross: { Icon: Crosshair, center: true },
  no: { Icon: Ban, center: true },
};

/** The on-screen remote cursor: mirrors the live desktop cursor shape, springs on
 *  every state change, shrinks while dragging, and ripples on click/scroll. */
function RemoteCursor({
  x,
  y,
  kind,
  dragging,
  fx,
}: {
  x: number;
  y: number;
  kind: string;
  dragging: boolean;
  fx: { id: number; kind: "left" | "right" | "scroll"; dir?: number } | null;
}) {
  const effective = dragging ? "grab" : kind;
  const hidden = kind === "hidden" && !dragging;
  const entry = CURSOR_ICONS[effective] ?? CURSOR_ICONS.arrow;
  const Icon = entry.Icon;
  // Hotspot alignment: (x,y) is the true pointer point. `center` cursors (I-beam,
  // resize, move, crosshair) have their hotspot at the icon's centre, so shift the
  // icon by -50%,-50% to sit its middle on the point — this is what makes the text
  // caret land exactly where you tap. Arrow/hand point from a tip near the top-left.
  // The offset MUST live on a static wrapper, NOT the motion element: Framer Motion
  // owns `transform` for its scale/opacity animation and would otherwise clobber an
  // inline transform, leaving every center cursor mis-anchored by half its size.
  const offset = entry.center ? "translate(-50%,-50%)" : "translate(-2px,-2px)";
  return (
    <div className="pointer-events-none absolute z-10" style={{ left: x, top: y }}>
      {!hidden && (
        <div style={{ transform: offset }}>
          <motion.div
            key={effective}
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: dragging ? 0.85 : 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 650, damping: 22 }}
          >
            <Icon
              className={`h-6 w-6 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] ${effective === "busy" ? "animate-spin" : ""}`}
              fill={effective === "arrow" || effective === "hand" ? "rgba(0,0,0,0.35)" : "none"}
              strokeWidth={2.25}
            />
          </motion.div>
        </div>
      )}
      <AnimatePresence>{fx && <CursorFx key={fx.id} kind={fx.kind} dir={fx.dir} />}</AnimatePresence>
    </div>
  );
}

/** A one-shot ripple/pulse at the cursor for a click / right-click / scroll. */
function CursorFx({ kind, dir }: { kind: "left" | "right" | "scroll"; dir?: number }) {
  if (kind === "scroll") {
    const up = (dir ?? 0) < 0;
    const Chevron = up ? ChevronUp : ChevronDown;
    return (
      <motion.div
        className="absolute left-0 top-0"
        style={{ transform: "translate(-50%,-50%)" }}
        initial={{ opacity: 0.95, y: 0, scale: 0.8 }}
        animate={{ opacity: 0, y: up ? -18 : 18, scale: 1.15 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
      >
        <Chevron className="h-5 w-5 text-accent-3 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" strokeWidth={3} />
      </motion.div>
    );
  }
  const color = kind === "right" ? "#f472b6" : "#ffffff";
  return (
    <>
      <motion.span
        className="absolute left-0 top-0 rounded-full border-2"
        style={{ width: 12, height: 12, transform: "translate(-50%,-50%)", borderColor: color }}
        initial={{ opacity: 0.85, scale: 0.35 }}
        animate={{ opacity: 0, scale: 3.4 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.44, ease: "easeOut" }}
      />
      {kind === "right" && (
        <motion.span
          className="absolute left-0 top-0 rounded-full"
          style={{ width: 6, height: 6, transform: "translate(-50%,-50%)", background: color }}
          initial={{ opacity: 0.9, scale: 1 }}
          animate={{ opacity: 0, scale: 0.4 }}
          transition={{ duration: 0.3 }}
        />
      )}
    </>
  );
}

// ---------- small UI pieces ----------
function StatCell({ k, v, hi }: { k: string; v: string; hi?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-1">
      <span className="shrink-0 text-ink-faint">{k}</span>
      <span className={`truncate font-700 tabular-nums ${hi ? "text-amber" : "text-white"}`}>{v}</span>
    </div>
  );
}

/** A plain-language guess at where latency / fps is being lost. */
function bottleneckHint(host: HostStats | null, net: NetStats | null, displayFps?: number, wc?: WcStats | null): string {
  // Direct WebCodecs path: E2E is measured (clock-synced), so read it literally.
  if (wc) {
    const hostMs = host ? host.captureMs + host.scaleMs + host.encodeMs : 0;
    if (wc.queue > 3) return `Decoder backlog ${wc.queue} — phone decode too slow; lower res/fps.`;
    if ((host?.wc?.bufKB ?? 0) > 128) return "Channel backlog — network can't drain the bitrate; lower it.";
    if (wc.e2eMs > 100) return `E2E ${wc.e2eMs}ms: net+enc ${wc.netMs} · dec ${wc.decodeMs}ms — check link.`;
    if (displayFps != null && wc.fps > 0 && displayFps < wc.fps * 0.7) {
      return "Display behind decode — phone UI thread busy.";
    }
    return `Direct path: no jitter buffer (~${Math.max(1, wc.e2eMs)}ms + host ${hostMs.toFixed(0)}ms).`;
  }
  if (!host && !net) return "Gathering stats…";
  const phoneLag = net ? Math.round(net.rttMs / 2 + net.bufMs + net.decMs) : 0;
  const hostMs = host ? host.captureMs + host.scaleMs + host.encodeMs : 0;
  if (net && net.bufMs > 80) {
    if (net.jbMinMs > net.jbTargetMs + 40) {
      return `UA min ${net.jbMinMs}ms ≫ target ${net.jbTargetMs} — A/V sync or arrival jitter.`;
    }
    return `Buffer ${net.bufMs}ms (target ${net.jbTargetMs}) — main lag. Want ≤40.`;
  }
  if (net && phoneLag > 60 && net.bufMs > 45) {
    return `Phone lag ~${phoneLag}ms — shrink buffer/target.`;
  }
  if (host && host.frameBytes > 220_000) {
    return `JPEG ${(host.frameBytes / 1024).toFixed(0)}KB — heavy IPC; q capped for RTC.`;
  }
  const target = host?.fps ?? 30;
  const produced = host?.producedFps;
  if (host && produced != null && produced < target * 0.75 && hostMs > 12) {
    const worst =
      host.encodeMs >= host.scaleMs && host.encodeMs >= host.captureMs
        ? "encode"
        : host.scaleMs >= host.captureMs
          ? "downscale"
          : "capture";
    return `Host CPU (${worst} ${hostMs.toFixed(0)}ms). Lower res/fps.`;
  }
  if (host && net && produced != null && produced > 0 && net.fps < produced * 0.7) {
    return "Net/decoder behind host produce. Lower bitrate.";
  }
  if (net && displayFps != null && net.fps > 0 && displayFps < net.fps * 0.7) {
    return "Display behind decode — phone UI thread busy.";
  }
  if (net && phoneLag <= 50) return `Pipeline lean (~${phoneLag}ms phone lag).`;
  return "Pipeline healthy.";
}

/** A thin vertical divider between icon groups in a panel row. */
function Sep() {
  return <span className="mx-0.5 h-6 w-px shrink-0 bg-white/10" />;
}
/** Square icon button used across the panels. */
function IcoBtn({ onClick, active, title, children }: { onClick: () => void; active?: boolean; title?: string; children: React.ReactNode }) {
  return (
    <motion.button
      whileTap={{ scale: 0.86 }}
      transition={{ type: "spring", stiffness: 600, damping: 20 }}
      // Keep the ghost input focused (soft keyboard up) when panel buttons are
      // used mid-typing — see Tab for the full rationale.
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        navigator.vibrate?.(5);
        onClick();
      }}
      title={title}
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border ${active ? "border-accent-3 bg-accent-3/15 text-white" : "border-white/[0.06] bg-white/[0.03] text-ink-soft active:bg-white/[0.08]"}`}
    >
      {children}
    </motion.button>
  );
}
/** A single physical-looking keycap with the label centred (task: keycap style). */
function Keycap({ children, active, small }: { children: React.ReactNode; active?: boolean; small?: boolean }) {
  return (
    <span
      className={`inline-grid ${small ? "h-6 min-w-[1.4rem] text-[10px]" : "h-7 min-w-[1.75rem] text-[11px]"} place-items-center rounded-[7px] px-1.5 font-800 leading-none tracking-tight ${
        active
          ? "border border-accent-1/70 bg-gradient-to-b from-accent-1/85 to-accent-1/50 text-white shadow-[0_2px_0_rgba(0,0,0,0.45),0_0_10px_var(--accent-1),inset_0_1px_0_rgba(255,255,255,0.35)]"
          : "border border-white/15 bg-gradient-to-b from-white/[0.17] to-white/[0.04] text-white shadow-[0_2px_0_rgba(0,0,0,0.5),0_3px_5px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.22)]"
      }`}
    >
      {children}
    </span>
  );
}
/** A key or key-combo: multiple keys are joined by a small "+" (task: combos). */
function KeyCombo({ keys, active, small }: { keys: string[]; active?: boolean; small?: boolean }) {
  return (
    <span className="flex items-center gap-0.5">
      {keys.map((k, i) => (
        <span key={i} className="flex items-center gap-0.5">
          {i > 0 && <span className="px-px text-[10px] font-800 text-ink-dim">+</span>}
          <Keycap active={active} small={small}>{k}</Keycap>
        </span>
      ))}
    </span>
  );
}
/** A dock button rendering a keycap combo with a caption + pin overlay. In pin
 *  mode a tap toggles the pin instead of firing the key. Holdable keys (single
 *  wire) use press-and-hold: keydown while the finger is down, keyup on release.
 *  Custom shortcuts also get a trash badge in pin mode so they can be deleted. */
function KeyCapButton({
  def,
  pinMode,
  pinned,
  active,
  held,
  onFire,
  onHoldDown,
  onHoldUp,
  onTogglePin,
  deletable,
  onDelete,
}: {
  def: KeyDef;
  pinMode: boolean;
  pinned: boolean;
  active?: boolean;
  /** This cap is currently held down (finger still on it). */
  held?: boolean;
  onFire: () => void;
  onHoldDown?: () => void;
  onHoldUp?: () => void;
  onTogglePin: () => void;
  deletable?: boolean;
  onDelete?: () => void;
}) {
  // A cap can be held if it maps to a single wire key (not a sticky modifier — those
  // already latch via the mods set — and not a multi-key chord).
  const holdable = !!def.wire && !def.mod;
  const holding = useRef(false);
  return (
    <motion.button
      whileTap={pinMode ? { scale: 0.92 } : { scale: 0.86, y: 2 }}
      transition={{ type: "spring", stiffness: 600, damping: 20 }}
      onPointerDown={(e) => {
        e.preventDefault(); // don't steal focus from the ghost input (keyboard stays up)
        if (pinMode || !holdable) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        holding.current = true;
        onHoldDown?.();
      }}
      onPointerUp={(e) => {
        if (!holding.current) return;
        holding.current = false;
        try {
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        } catch {
          /* ignore */
        }
        onHoldUp?.();
      }}
      onPointerCancel={() => {
        if (!holding.current) return;
        holding.current = false;
        onHoldUp?.();
      }}
      onClick={() => {
        if (pinMode) {
          onTogglePin();
          return;
        }
        // Holdable keys are driven by pointer down/up — ignore the click.
        if (holdable) return;
        navigator.vibrate?.(6);
        onFire();
      }}
      className="relative flex shrink-0 flex-col items-center gap-0.5 rounded-xl px-1 py-0.5"
    >
      <KeyCombo keys={def.keys} active={active || held} />
      {def.label && <span className="text-[8.5px] font-700 leading-none text-ink-dim">{def.label}</span>}
      {pinMode && deletable && onDelete && (
        <span
          role="button"
          title="Delete custom shortcut"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute -left-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full border border-red/40 bg-black/70 text-red"
        >
          <Trash2 className="h-2.5 w-2.5" />
        </span>
      )}
      {pinMode && (
        <span
          className={`absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full border ${
            pinned ? "border-accent-3 bg-accent-3 text-white" : "border-white/25 bg-black/70 text-ink-dim"
          }`}
        >
          <Pin className="h-2.5 w-2.5" />
        </span>
      )}
    </motion.button>
  );
}
/** The pin-mode enable toggle shown at the start of the keys/shortcuts panels. */
function PinModeToggle({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={active ? "Done pinning" : "Pin keys to a floating quick bar"}
      className={`flex h-9 shrink-0 items-center gap-1 rounded-lg border px-2 text-[10px] font-800 uppercase tracking-wide transition active:scale-95 ${
        active ? "border-accent-3 bg-accent-3/20 text-accent-3" : "border-white/[0.08] bg-white/[0.03] text-ink-dim"
      }`}
    >
      {active ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
      {active ? "Done" : "Pin"}
    </button>
  );
}
/** Emergency release if a holdable key got stuck (rare pointer-cancel misses). */
function ReleaseHeldButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Release all held keys"
      className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-accent-1/40 bg-accent-1/15 px-2 text-[10px] font-800 uppercase tracking-wide text-accent-1 transition active:scale-95"
    >
      <X className="h-3.5 w-3.5" />
      {count} held
    </button>
  );
}
/** A pinned quick button on the floating edge rail — small + semi-transparent.
 *  Holdable keys use natural press-and-hold (keydown while down). Unpin only in
 *  Pin mode (tap the rail button) — long-press used to unpin and stole holds. */
function PinnedButton({
  def,
  pinMode,
  active,
  onRun,
  onHoldDown,
  onHoldUp,
  onUnpin,
}: {
  def: KeyDef;
  pinMode: boolean;
  active?: boolean;
  onRun: () => void;
  onHoldDown?: () => void;
  onHoldUp?: () => void;
  onUnpin: () => void;
}) {
  const holdable = !!def.wire && !def.mod;
  const holding = useRef(false);
  return (
    <motion.button
      layout
      initial={{ opacity: 0, x: 24, scale: 0.8 }}
      animate={{ opacity: active ? 1 : 0.55, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.8 }}
      whileTap={{ scale: 0.9, opacity: 1 }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
      onPointerDown={(e) => {
        e.preventDefault(); // don't steal focus from the ghost input (keyboard stays up)
        if (pinMode || !holdable) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        holding.current = true;
        onHoldDown?.();
      }}
      onPointerUp={(e) => {
        if (holding.current) {
          holding.current = false;
          try {
            e.currentTarget.releasePointerCapture?.(e.pointerId);
          } catch {
            /* ignore */
          }
          onHoldUp?.();
          return;
        }
        if (pinMode) {
          onUnpin();
          return;
        }
        if (!holdable) onRun();
      }}
      onPointerCancel={() => {
        if (!holding.current) return;
        holding.current = false;
        onHoldUp?.();
      }}
      className={`pointer-events-auto relative flex items-center rounded-lg border px-1.5 py-1 backdrop-blur ${
        active ? "border-accent-1/70 bg-black/55" : "border-white/10 bg-black/35"
      } ${pinMode ? "ring-1 ring-accent-3/50" : ""}`}
      title={
        pinMode
          ? `Tap to unpin ${def.keys.join(" + ")}`
          : holdable
            ? `${def.keys.join(" + ")} — press and hold`
            : `${def.keys.join(" + ")}${def.label ? ` (${def.label})` : ""}`
      }
    >
      <KeyCombo keys={def.keys} active={active} small />
      {pinMode && (
        <span className="absolute -right-1 -top-1 grid h-3.5 w-3.5 place-items-center rounded-full bg-accent-3 text-white">
          <PinOff className="h-2 w-2" />
        </span>
      )}
    </motion.button>
  );
}
/** A tab in the always-visible bottom strip (icon only). */
function Tab({ onClick, active, title, children }: { onClick: () => void; active: boolean; title: string; children: React.ReactNode }) {
  return (
    <motion.button
      whileTap={{ scale: 0.9 }}
      // Don't take focus on tap: while the soft keyboard is up (ghost input
      // focused), a focus-stealing tap blurred the field, collapsed the keyboard,
      // and the resulting reflow often swallowed the tap entirely — panels felt
      // un-openable while typing. Cancelling pointerdown's default keeps the
      // ghost input focused (keyboard stays up); click still fires.
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      className={`relative grid h-9 flex-1 place-items-center rounded-lg transition ${active ? "text-white" : "text-ink-dim active:bg-white/[0.06]"}`}
    >
      {active && (
        <motion.span
          layoutId="dockTabActive"
          className="absolute inset-0 rounded-lg bg-accent-3 shadow-glow"
          transition={{ type: "spring", stiffness: 500, damping: 34 }}
        />
      )}
      <span className="relative z-10">{children}</span>
    </motion.button>
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
