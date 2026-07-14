/**
 * Companion Control chrome prefs — pinned buttons, free placement, per-pin look,
 * and toolbar layout. Shared by APK / discovery web / Quest flat (localStorage only).
 *
 * Mirrors the streamTune persistence pattern: one document, normalize on load,
 * dual-write legacy `gt.remote.pinned` / `pinLayout` for one release.
 */

export const CONTROL_CHROME_KEY = "gt.remote.controlChrome";
export const CONTROL_CHROME_VERSION = 1 as const;

export type PinId = string;

export type ButtonShape = "rounded" | "pill" | "square" | "capsule";
export type ButtonChrome = "keycap" | "flat" | "glass" | "solid" | "outline";
export type PressAnim = "spring" | "sink" | "glow" | "ripple" | "bounce" | "hard";
export type LabelMode = "keys" | "label" | "icon" | "keys+label";

export type PinTheme = {
  bg?: string;
  fg?: string;
  border?: string;
  accent?: string;
};

export type PinStyle = {
  scale: number;
  w: number;
  h: number;
  shape: ButtonShape;
  chrome: ButtonChrome;
  anim: PressAnim;
  theme: PinTheme;
  labelMode: LabelMode;
  customLabel?: string;
  opacity: number;
};

export type PinPlacement = { x: number; y: number };

export type ToolbarId = "mouse" | "keys" | "shortcuts" | "game" | "quality" | "gamepad";

export type ToolbarPrefs = {
  order: string[];
  hidden: string[];
  density: "compact" | "comfy";
  /** Toolbar CSS zoom — 0.25 (25%) … 10 (1000%). */
  scale: number;
};

export const TOOLBAR_SCALE_MIN = 0.25;
export const TOOLBAR_SCALE_MAX = 10;
/** Tap-cycle steps for the compact toolbar scale chip. */
export const TOOLBAR_SCALE_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10] as const;

export function clampToolbarScale(n: number): number {
  return clamp(Number.isFinite(n) ? n : 1, TOOLBAR_SCALE_MIN, TOOLBAR_SCALE_MAX);
}

export function nextToolbarScale(cur: number): number {
  const c = clampToolbarScale(cur);
  const next = TOOLBAR_SCALE_STEPS.find((s) => s > c + 0.001);
  return next ?? TOOLBAR_SCALE_STEPS[0];
}

export function toolbarScaleOf(c: ControlChrome, id: ToolbarId): number {
  return clampToolbarScale(c.toolbars[id]?.scale ?? 1);
}

export type ControlChrome = {
  v: typeof CONTROL_CHROME_VERSION;
  pinned: PinId[];
  layout: Record<PinId, PinPlacement>;
  styles: Record<PinId, Partial<PinStyle>>;
  defaultStyle: PinStyle;
  toolbars: Partial<Record<ToolbarId, ToolbarPrefs>>;
  /** Extra single keys the user added (wire names) → registry as k:{wire}. */
  extraKeys: string[];
};

export const PIN_STYLE_DEFAULTS: PinStyle = {
  scale: 1,
  w: 1,
  h: 1,
  shape: "rounded",
  chrome: "keycap",
  anim: "spring",
  theme: {},
  labelMode: "keys+label",
  opacity: 0.85,
};

const SHAPES: ButtonShape[] = ["rounded", "pill", "square", "capsule"];
const CHROMES: ButtonChrome[] = ["keycap", "flat", "glass", "solid", "outline"];
const ANIMS: PressAnim[] = ["spring", "sink", "glow", "ripple", "bounce", "hard"];
const LABELS: LabelMode[] = ["keys", "label", "icon", "keys+label"];

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function normalizePinStyle(raw: Partial<PinStyle> | null | undefined, base = PIN_STYLE_DEFAULTS): PinStyle {
  const r = raw ?? {};
  const theme = (r.theme ?? {}) as PinTheme;
  const num = (v: unknown, fallback: number) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    scale: clamp(num(r.scale, base.scale), 0.25, 10),
    w: clamp(num(r.w, base.w), 0.25, 10),
    h: clamp(num(r.h, base.h), 0.25, 10),
    shape: asEnum(r.shape, SHAPES, base.shape),
    chrome: asEnum(r.chrome, CHROMES, base.chrome),
    anim: asEnum(r.anim, ANIMS, base.anim),
    theme: {
      bg: typeof theme.bg === "string" ? theme.bg : undefined,
      fg: typeof theme.fg === "string" ? theme.fg : undefined,
      border: typeof theme.border === "string" ? theme.border : undefined,
      accent: typeof theme.accent === "string" ? theme.accent : undefined,
    },
    labelMode: asEnum(r.labelMode, LABELS, base.labelMode),
    customLabel: typeof r.customLabel === "string" ? r.customLabel.slice(0, 24) : undefined,
    opacity: clamp(num(r.opacity, base.opacity), 0.35, 1),
  };
}

export function resolvePinStyle(c: ControlChrome, id: PinId): PinStyle {
  return normalizePinStyle(c.styles[id], c.defaultStyle);
}

function normalizeToolbar(raw: Partial<ToolbarPrefs> | undefined): ToolbarPrefs {
  return {
    order: Array.isArray(raw?.order) ? raw!.order.filter((x) => typeof x === "string").slice(0, 64) : [],
    hidden: Array.isArray(raw?.hidden) ? raw!.hidden.filter((x) => typeof x === "string").slice(0, 64) : [],
    density: raw?.density === "compact" ? "compact" : "comfy",
    scale: clampToolbarScale(Number(raw?.scale) || 1),
  };
}

export function normalizeControlChrome(raw: unknown): ControlChrome {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ControlChrome>;
  const defaultStyle = normalizePinStyle(r.defaultStyle);
  const styles: Record<PinId, Partial<PinStyle>> = {};
  if (r.styles && typeof r.styles === "object") {
    for (const [id, st] of Object.entries(r.styles)) {
      if (typeof id === "string" && st && typeof st === "object") {
        // Persist a fully normalized copy so theme/scale survive round-trips and
        // partial edits can't leave half-applied styles that look like a reset.
        styles[id] = normalizePinStyle(st as Partial<PinStyle>, defaultStyle);
      }
    }
  }
  const layout: Record<PinId, PinPlacement> = {};
  if (r.layout && typeof r.layout === "object") {
    for (const [id, p] of Object.entries(r.layout)) {
      if (!p || typeof p !== "object") continue;
      layout[id] = {
        x: clamp(Number((p as PinPlacement).x) || 50, 4, 96),
        y: clamp(Number((p as PinPlacement).y) || 50, 6, 94),
      };
    }
  }
  const toolbars: Partial<Record<ToolbarId, ToolbarPrefs>> = {};
  if (r.toolbars && typeof r.toolbars === "object") {
    for (const id of ["mouse", "keys", "shortcuts", "game", "quality", "gamepad"] as ToolbarId[]) {
      if (r.toolbars[id]) toolbars[id] = normalizeToolbar(r.toolbars[id]);
    }
  }
  const pinned = Array.isArray(r.pinned)
    ? r.pinned.filter((x): x is string => typeof x === "string").slice(0, 24)
    : [];
  const extraKeys = Array.isArray(r.extraKeys)
    ? r.extraKeys
        .filter((x): x is string => typeof x === "string" && /^[a-z0-9]$|^space$/i.test(x))
        .map((x) => x.toLowerCase())
        .slice(0, 48)
    : [];
  return {
    v: CONTROL_CHROME_VERSION,
    pinned,
    layout,
    styles,
    defaultStyle,
    toolbars,
    extraKeys,
  };
}

function readLegacy(): Partial<ControlChrome> | null {
  try {
    const pinnedRaw = localStorage.getItem("gt.remote.pinned");
    const layoutRaw = localStorage.getItem("gt.remote.pinLayout");
    if (!pinnedRaw && !layoutRaw) return null;
    return {
      pinned: pinnedRaw ? (JSON.parse(pinnedRaw) as string[]) : [],
      layout: layoutRaw ? (JSON.parse(layoutRaw) as Record<string, PinPlacement>) : {},
    };
  } catch {
    return null;
  }
}

export function loadControlChrome(): ControlChrome {
  try {
    const raw = localStorage.getItem(CONTROL_CHROME_KEY);
    if (raw) return normalizeControlChrome(JSON.parse(raw));
  } catch {
    /* migrate */
  }
  const legacy = readLegacy();
  const migrated = normalizeControlChrome(legacy);
  saveControlChrome(migrated);
  return migrated;
}

/** Persist chrome + dual-write legacy pin list/layout. */
export function saveControlChrome(c: ControlChrome): void {
  const n = normalizeControlChrome(c);
  try {
    localStorage.setItem(CONTROL_CHROME_KEY, JSON.stringify(n));
    localStorage.setItem("gt.remote.pinned", JSON.stringify(n.pinned));
    localStorage.setItem("gt.remote.pinLayout", JSON.stringify(n.layout));
  } catch {
    /* private mode / quota */
  }
}

export function resetControlChrome(): ControlChrome {
  const fresh = normalizeControlChrome(null);
  saveControlChrome(fresh);
  return fresh;
}

export function patchPinStyle(c: ControlChrome, id: PinId, patch: Partial<PinStyle>): ControlChrome {
  const merged = normalizePinStyle({ ...resolvePinStyle(c, id), ...patch }, c.defaultStyle);
  return {
    ...c,
    styles: { ...c.styles, [id]: merged },
  };
}

/** Game-pack wire keys (holdable). Ids are the wire name. */
export const GAME_KEY_WIRES = [
  "w",
  "a",
  "s",
  "d",
  "space",
  "e",
  "f",
  "q",
  "r",
  "c",
  "v",
  "x",
  "z",
  "1",
  "2",
  "3",
  "4",
  "shift",
  "ctrl",
] as const;

export const LMB_HOLD_ID = "a:lmb-hold";

/** Theme presets for the pin editor. */
export const PIN_THEME_PRESETS: { id: string; label: string; theme: PinTheme }[] = [
  { id: "default", label: "Default", theme: {} },
  { id: "violet", label: "Violet", theme: { bg: "rgba(124,92,255,0.4)", border: "#7c5cff", accent: "#7c5cff", fg: "#fff" } },
  { id: "green", label: "Green", theme: { bg: "rgba(52,211,153,0.35)", border: "#34d399", accent: "#34d399", fg: "#fff" } },
  { id: "pink", label: "Pink", theme: { bg: "rgba(244,114,182,0.35)", border: "#f472b6", accent: "#f472b6", fg: "#fff" } },
  { id: "amber", label: "Amber", theme: { bg: "rgba(251,191,36,0.35)", border: "#fbbf24", accent: "#fbbf24", fg: "#111" } },
  { id: "ink", label: "Ink", theme: { bg: "rgba(0,0,0,0.7)", border: "rgba(255,255,255,0.25)", accent: "#fff", fg: "#fff" } },
  { id: "cyan", label: "Cyan", theme: { bg: "rgba(34,211,238,0.35)", border: "#22d3ee", accent: "#22d3ee", fg: "#fff" } },
];

/** Framer whileTap / transition for a press anim. */
export function pressMotion(anim: PressAnim, reduced: boolean): {
  whileTap: Record<string, number>;
  transition: { type: "spring"; stiffness: number; damping: number } | { duration: number };
} {
  if (reduced || anim === "hard") {
    return { whileTap: { scale: 0.98 }, transition: { duration: 0.08 } };
  }
  switch (anim) {
    case "sink":
      return { whileTap: { scale: 0.92, y: 4 }, transition: { type: "spring", stiffness: 700, damping: 28 } };
    case "glow":
      return { whileTap: { scale: 0.94 }, transition: { type: "spring", stiffness: 550, damping: 22 } };
    case "ripple":
      return { whileTap: { scale: 0.9 }, transition: { type: "spring", stiffness: 600, damping: 20 } };
    case "bounce":
      return { whileTap: { scale: 0.88 }, transition: { type: "spring", stiffness: 200, damping: 12 } };
    case "spring":
    default:
      return { whileTap: { scale: 0.86, y: 2 }, transition: { type: "spring", stiffness: 600, damping: 20 } };
  }
}

export function shapeClass(shape: ButtonShape): string {
  switch (shape) {
    case "pill":
      return "rounded-full";
    case "square":
      return "rounded-md";
    case "capsule":
      return "rounded-2xl";
    default:
      return "rounded-lg";
  }
}

export function chromeClass(chrome: ButtonChrome, active: boolean): string {
  switch (chrome) {
    case "flat":
      return active ? "border-accent-1/50 bg-white/[0.12]" : "border-transparent bg-white/[0.06]";
    case "glass":
      return active
        ? "border-white/25 bg-white/15 backdrop-blur-md"
        : "border-white/10 bg-white/10 backdrop-blur-md";
    case "solid":
      return active ? "border-accent-3 bg-accent-3/80" : "border-white/10 bg-bg-800/90";
    case "outline":
      return active ? "border-accent-3 bg-transparent" : "border-white/30 bg-transparent";
    case "keycap":
    default:
      return active ? "border-accent-1/70 bg-black/55" : "border-white/10 bg-black/35";
  }
}
