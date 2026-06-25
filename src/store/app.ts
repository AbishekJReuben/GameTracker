import { create } from "zustand";
import { EntryKind, Game, GameStatus, TrackingState, api } from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { type TimelineRange, normalizeTimelineRange } from "@/lib/timelineZoom";

export interface Toast {
  id: number;
  kind: "info" | "success" | "play" | "stop";
  title: string;
  message?: string;
  icon?: string | null;
}

export type AccentTheme =
  | "aurora"
  | "toxic"
  | "ember"
  | "magma"
  | "ice"
  | "sunset"
  | "synthwave"
  | "gold"
  | "forest"
  | "rose"
  | "mono"
  | "custom";

/** A user-defined accent: three hex stops (start → mid → end). */
export type CustomAccent = [string, string, string];
export type MotionLevel = "full" | "reduced" | "off";
export type Density = "cozy" | "compact";
export type TimeFormat = "12h" | "24h";
export type WeekStart = "sun" | "mon";
export type { TimelineRange } from "@/lib/timelineZoom";
export type LibraryView = "grid" | "list" | "compact" | "album" | "theatre";
/** Marquee backdrop intensity: off = none, compact = only the original/base
 *  marquees, full = base + the extra decorative backdrops on most panels. */
export type MarqueeLevel = "off" | "compact" | "full";
export type LibraryStatusFilter = "all" | GameStatus;
export type LibrarySort = "recent" | "name" | "playtime" | "score" | "manual";

/** Persisted Library page filters/toggles (search text stays transient). */
export interface LibraryFilters {
  status: LibraryStatusFilter;
  sort: LibrarySort;
  trackedOnly: boolean;
  tag: string | null;
  tagsOpen: boolean;
}

/** Persisted Sessions page filters/toggles (specific dates stay transient). */
export interface SessionFilters {
  kind: EntryKind;
  minMinutes: string;
  excludeIdle: boolean;
}

export interface Prefs {
  accent: AccentTheme;
  /** The three hex stops used when `accent === "custom"`. */
  customAccent: CustomAccent;
  motion: MotionLevel;
  density: Density;
  background: boolean;
  landing: string;
  timelineRange: TimelineRange;
  timeFormat: TimeFormat;
  weekStart: WeekStart;
  scanlines: boolean;
  /** Decorative marquee backdrops intensity (off / compact / full). */
  marquee: MarqueeLevel;
  libraryView: LibraryView;
  /** Show the "Suggested" recommendations tab in the sidebar. Default off. */
  showSuggested: boolean;
  /** Mute the per-game theme player. Defaults muted (autoplay needs it). */
  themeMuted: boolean;
  /** Persisted game order for the Library's "Manual" sort (array of game ids). */
  manualOrder: string[];
  /** Remembered Library filters/sort/toggles. */
  libraryFilters: LibraryFilters;
  /** Remembered Sessions filters/toggles. */
  sessionFilters: SessionFilters;
  widgets: {
    goal: boolean;
    secondary: boolean;
    patterns: boolean;
    heatmap: boolean;
  };
}

const DEFAULT_PREFS: Prefs = {
  accent: "aurora",
  customAccent: ["#7c5cff", "#3b82f6", "#22d3ee"],
  motion: "full",
  density: "cozy",
  background: true,
  landing: "/",
  timelineRange: "1h",
  timeFormat: "12h",
  weekStart: "mon",
  scanlines: true,
  marquee: "full",
  libraryView: "grid",
  showSuggested: false,
  themeMuted: true,
  manualOrder: [],
  libraryFilters: { status: "all", sort: "recent", trackedOnly: false, tag: null, tagsOpen: false },
  sessionFilters: { kind: "game", minMinutes: "", excludeIdle: false },
  widgets: { goal: true, secondary: true, patterns: true, heatmap: true },
};

const PREFS_KEY = "gt.prefs.v2";

/** True when no local prefs were found at boot (fresh install or wiped storage). */
let prefsLocalEmpty = false;

function mergePrefs(parsed: Partial<Prefs>): Prefs {
  const merged = {
    ...DEFAULT_PREFS,
    ...parsed,
    widgets: { ...DEFAULT_PREFS.widgets, ...parsed.widgets },
    libraryFilters: { ...DEFAULT_PREFS.libraryFilters, ...parsed.libraryFilters },
    sessionFilters: { ...DEFAULT_PREFS.sessionFilters, ...parsed.sessionFilters },
  };
  return {
    ...merged,
    timelineRange: normalizeTimelineRange(parsed.timelineRange ?? merged.timelineRange),
  };
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) {
      prefsLocalEmpty = true;
      return DEFAULT_PREFS;
    }
    return mergePrefs(JSON.parse(raw) as Partial<Prefs>);
  } catch {
    prefsLocalEmpty = true;
    return DEFAULT_PREFS;
  }
}

/**
 * Mirror UI prefs into the backend DB so they survive a WebView localStorage
 * wipe (e.g. uninstall/reinstall). On boot, if local storage was empty but the
 * DB has a saved copy, restore it; otherwise push the current prefs to the DB.
 */
export async function hydratePrefs() {
  if (!isTauri()) return;
  try {
    const settings = await api.getSettings();
    const raw = settings["ui_prefs"];
    if (prefsLocalEmpty && raw) {
      const restored = mergePrefs(JSON.parse(raw) as Partial<Prefs>);
      useApp.setState({ prefs: restored });
      applyPrefsToDom(restored);
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(restored));
      } catch {
        /* ignore */
      }
    } else {
      // Keep the DB backup in sync with whatever is in local storage now.
      api.setSetting("ui_prefs", JSON.stringify(useApp.getState().prefs)).catch(() => {});
    }
  } catch {
    /* best-effort */
  }
}

/** Reflect appearance prefs onto <html> so CSS variables / safety valves react live. */
export function applyPrefsToDom(p: Prefs) {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.dataset.accent = p.accent;
  el.dataset.motion = p.motion === "off" ? "off" : "on";
  el.dataset.density = p.density;
  // A custom accent overrides the three palette vars inline; any preset clears
  // the overrides so its [data-accent] stylesheet rule takes effect again.
  if (p.accent === "custom" && p.customAccent) {
    el.style.setProperty("--accent-1", p.customAccent[0]);
    el.style.setProperty("--accent-2", p.customAccent[1]);
    el.style.setProperty("--accent-3", p.customAccent[2]);
  } else {
    el.style.removeProperty("--accent-1");
    el.style.removeProperty("--accent-2");
    el.style.removeProperty("--accent-3");
  }
}

interface AppStore {
  tracking: TrackingState | null;
  setTracking: (t: TrackingState) => void;

  prefs: Prefs;
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;

  toasts: Toast[];
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;

  // Add/Edit game (or app) modal
  gameModal: { open: boolean; game: Game | null; mode: "track" | "catalog"; kind: EntryKind };
  openGameModal: (opts?: { game?: Game | null; mode?: "track" | "catalog"; kind?: EntryKind }) => void;
  closeGameModal: () => void;
  // A path dropped onto the window while the add-game modal is open — consumed by
  // the modal to fill its exe/folder fields, then cleared.
  droppedPath: string | null;
  setDroppedPath: (path: string | null) => void;
}

let toastId = 1;

export const useApp = create<AppStore>((set, get) => ({
  tracking: null,
  setTracking: (t) => set({ tracking: t }),

  prefs: loadPrefs(),
  setPref: (key, value) => {
    const prefs = { ...get().prefs, [key]: value };
    set({ prefs });
    applyPrefsToDom(prefs);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore quota / privacy mode */
    }
    // Back up to the DB so prefs survive a localStorage wipe on reinstall.
    if (isTauri()) {
      api.setSetting("ui_prefs", JSON.stringify(prefs)).catch(() => {});
    }
  },

  toasts: [],
  pushToast: (t) => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
    }, 4200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

  gameModal: { open: false, game: null, mode: "track", kind: "game" },
  openGameModal: (opts) =>
    set({
      gameModal: {
        open: true,
        game: opts?.game ?? null,
        mode: opts?.mode ?? (opts?.game ? (opts.game.isTracked ? "track" : "catalog") : "track"),
        kind: opts?.kind ?? opts?.game?.kind ?? "game",
      },
    }),
  closeGameModal: () => set((s) => ({ gameModal: { ...s.gameModal, open: false }, droppedPath: null })),

  droppedPath: null,
  setDroppedPath: (path) => set({ droppedPath: path }),
}));

/** Convenience hook: whether rich motion should run, honoring the user's pref. */
export function useMotionEnabled() {
  return useApp((s) => s.prefs.motion === "full");
}

/**
 * Whether a marquee of the given tier should be shown for the current pref:
 * - "base"  — the original marquees: shown unless the level is "off".
 * - "extra" — the broad decorative backdrops: shown only when level is "full".
 */
export function useMarqueeTier(tier: "base" | "extra" = "extra") {
  return useApp((s) => {
    const lvl = s.prefs.marquee ?? "full";
    if (lvl === "off") return false;
    if (lvl === "full") return true;
    return tier === "base";
  });
}
