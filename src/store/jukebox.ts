import { create } from "zustand";
import type { JukeboxTrack } from "@/lib/jukeboxTracks";

const POS_KEY = "gt.jukebox.pos";
const PREFS_KEY = "gt.jukebox.prefs";

export type RepeatMode = "off" | "all" | "one";

interface PersistedPrefs {
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  collapsed: boolean;
}

const DEFAULT_PREFS: PersistedPrefs = {
  volume: 65,
  shuffle: false,
  repeat: "all",
  collapsed: false,
};

function loadFloaterPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x: number; y: number };
    if (typeof p.x === "number" && typeof p.y === "number") return p;
  } catch {
    /* ignore */
  }
  return null;
}

function loadPrefs(): PersistedPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PersistedPrefs>;
      return {
        volume: typeof p.volume === "number" ? Math.min(100, Math.max(0, p.volume)) : DEFAULT_PREFS.volume,
        shuffle: !!p.shuffle,
        repeat: p.repeat === "off" || p.repeat === "one" ? p.repeat : "all",
        collapsed: !!p.collapsed,
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_PREFS };
}

function savePrefs(p: PersistedPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

const keyOf = (t: JukeboxTrack) => `${t.gameId}:${t.vid}`;

/** Pick a random index != current, preferring ones not in `played`. */
function randomNext(len: number, current: number, played: number[]): number {
  if (len <= 1) return current;
  const playedSet = new Set(played);
  let pool = Array.from({ length: len }, (_, i) => i).filter((i) => i !== current && !playedSet.has(i));
  if (pool.length === 0) pool = Array.from({ length: len }, (_, i) => i).filter((i) => i !== current);
  return pool[Math.floor(Math.random() * pool.length)] ?? current;
}

interface JukeboxStore {
  tracks: JukeboxTrack[];
  /** Index into `tracks` of the current song. */
  index: number;
  playing: boolean;
  /** Session is open — floater visible, per-game themes yield to jukebox. */
  active: boolean;
  /** Visited indices, for "previous" under shuffle. */
  history: number[];
  /** Indices played since (re)start, so shuffle can stop after a full pass. */
  played: number[];
  floaterPos: { x: number; y: number } | null;

  // Player prefs (persisted)
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  collapsed: boolean;

  // Transient playback position (driven by the engine)
  progress: number;
  duration: number;
  /** Bumped to request the engine seek to `seekSeconds`. */
  seekNonce: number;
  seekSeconds: number;

  start: (tracks: JukeboxTrack[], index?: number) => void;
  stop: () => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  /** Auto-advance when a track ends (honors repeat/shuffle). */
  ended: () => void;
  /** Jump to a specific track index in the queue. */
  seek: (index: number) => void;
  /** Play a track from a list — seeks if already in the queue, otherwise starts that list. */
  playFromList: (tracks: JukeboxTrack[], index: number) => void;
  /** Append tracks to the end of the queue (starts playback if idle). Returns # added. */
  enqueue: (tracks: JukeboxTrack[]) => number;
  /** Insert tracks right after the current one (starts playback if idle). Returns # added. */
  playNext: (tracks: JukeboxTrack[]) => number;
  /** Remove a queue item by index, fixing up the current index. */
  removeAt: (index: number) => void;
  setProgress: (progress: number, duration: number) => void;
  seekTo: (seconds: number) => void;
  setVolume: (v: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setCollapsed: (v: boolean) => void;
  setFloaterPos: (x: number, y: number) => void;
}

const initial = loadPrefs();

export const useJukebox = create<JukeboxStore>((set, get) => ({
  tracks: [],
  index: 0,
  playing: false,
  active: false,
  history: [],
  played: [],
  floaterPos: loadFloaterPos(),

  volume: initial.volume,
  shuffle: initial.shuffle,
  repeat: initial.repeat,
  collapsed: initial.collapsed,

  progress: 0,
  duration: 0,
  seekNonce: 0,
  seekSeconds: 0,

  start: (tracks, index = 0) => {
    if (!tracks.length) return;
    const i = Math.max(0, Math.min(index, tracks.length - 1));
    set({ tracks, index: i, playing: true, active: true, history: [], played: [i], progress: 0, duration: 0 });
  },

  stop: () =>
    set({
      tracks: [],
      index: 0,
      playing: false,
      active: false,
      history: [],
      played: [],
      progress: 0,
      duration: 0,
    }),

  play: () => {
    if (get().tracks.length) set({ playing: true, active: true });
  },

  pause: () => set({ playing: false }),

  toggle: () => {
    const { playing, tracks } = get();
    if (!tracks.length) return;
    set({ playing: !playing, active: true });
  },

  next: () => {
    const { tracks, index, shuffle, history, played } = get();
    if (tracks.length < 2) {
      // single track — restart it
      set((s) => ({ seekNonce: s.seekNonce + 1, seekSeconds: 0, playing: true, progress: 0 }));
      return;
    }
    const nextIdx = shuffle ? randomNext(tracks.length, index, played) : (index + 1) % tracks.length;
    set({
      index: nextIdx,
      playing: true,
      active: true,
      history: [...history, index].slice(-200),
      played: played.includes(nextIdx) ? played : [...played, nextIdx],
      progress: 0,
      duration: 0,
    });
  },

  prev: () => {
    const { tracks, index, shuffle, history, progress } = get();
    // Restart the current track if we're more than a few seconds in.
    if (progress > 3) {
      set((s) => ({ seekNonce: s.seekNonce + 1, seekSeconds: 0, playing: true }));
      return;
    }
    if (tracks.length < 2) return;
    if (shuffle && history.length) {
      const prevIdx = history[history.length - 1];
      set({ index: prevIdx, history: history.slice(0, -1), playing: true, active: true, progress: 0, duration: 0 });
      return;
    }
    const prevIdx = (index - 1 + tracks.length) % tracks.length;
    set({ index: prevIdx, playing: true, active: true, progress: 0, duration: 0 });
  },

  ended: () => {
    const { tracks, index, shuffle, repeat, history, played } = get();
    if (!tracks.length) return;
    if (repeat === "one") {
      set((s) => ({ seekNonce: s.seekNonce + 1, seekSeconds: 0, playing: true, progress: 0 }));
      return;
    }
    if (tracks.length < 2) {
      if (repeat === "all") set((s) => ({ seekNonce: s.seekNonce + 1, seekSeconds: 0, playing: true }));
      else set({ playing: false });
      return;
    }
    if (shuffle) {
      const nextPlayed = played.includes(index) ? played : [...played, index];
      const allPlayed = nextPlayed.length >= tracks.length;
      if (allPlayed && repeat === "off") {
        set({ playing: false });
        return;
      }
      const base = allPlayed ? [] : nextPlayed; // repeat=all → fresh pass
      const nextIdx = randomNext(tracks.length, index, base);
      set({
        index: nextIdx,
        playing: true,
        active: true,
        history: [...history, index].slice(-200),
        played: [...base, nextIdx],
        progress: 0,
        duration: 0,
      });
      return;
    }
    const atEnd = index + 1 >= tracks.length;
    if (atEnd && repeat === "off") {
      set({ playing: false });
      return;
    }
    const nextIdx = (index + 1) % tracks.length;
    set({
      index: nextIdx,
      playing: true,
      active: true,
      history: [...history, index].slice(-200),
      played: [...played, nextIdx],
      progress: 0,
      duration: 0,
    });
  },

  seek: (index) => {
    const { tracks, history, played } = get();
    if (!tracks.length) return;
    const i = Math.max(0, Math.min(index, tracks.length - 1));
    set({
      index: i,
      playing: true,
      active: true,
      history: [...history, get().index].slice(-200),
      played: played.includes(i) ? played : [...played, i],
      progress: 0,
      duration: 0,
    });
  },

  playFromList: (list, index) => {
    if (!list.length) return;
    const i = Math.max(0, Math.min(index, list.length - 1));
    const target = list[i];
    const { tracks, active } = get();
    if (active && tracks.length) {
      const qi = tracks.findIndex((t) => t.gameId === target.gameId && t.vid === target.vid);
      if (qi >= 0) {
        get().seek(qi);
        return;
      }
    }
    get().start(list, i);
  },

  enqueue: (newTracks) => {
    const { tracks, active } = get();
    const have = new Set(tracks.map(keyOf));
    const add = newTracks.filter((t) => !have.has(keyOf(t)));
    if (!add.length) {
      // Nothing new; if idle, (re)start with what was passed.
      if (!active && newTracks.length) get().start(newTracks, 0);
      return 0;
    }
    const merged = [...tracks, ...add];
    if (!active || tracks.length === 0) {
      set({ tracks: merged });
      get().start(merged, tracks.length); // play the first newly added
    } else {
      set({ tracks: merged });
    }
    return add.length;
  },

  playNext: (newTracks) => {
    const { tracks, index, active } = get();
    if (!active || tracks.length === 0) {
      get().start(newTracks, 0);
      return newTracks.length;
    }
    // Avoid duplicating the current track right after itself.
    const curKey = tracks[index] ? keyOf(tracks[index]) : "";
    const add = newTracks.filter((t) => keyOf(t) !== curKey);
    if (!add.length) return 0;
    const merged = [...tracks.slice(0, index + 1), ...add, ...tracks.slice(index + 1)];
    // Structural change invalidates positional history/played.
    set({ tracks: merged, history: [], played: [index] });
    return add.length;
  },

  removeAt: (i) => {
    const { tracks, index } = get();
    if (i < 0 || i >= tracks.length) return;
    const merged = tracks.filter((_, k) => k !== i);
    if (merged.length === 0) {
      get().stop();
      return;
    }
    let nextIndex = index;
    if (i < index) nextIndex = index - 1;
    else if (i === index) nextIndex = Math.min(index, merged.length - 1); // points at the next track
    set({
      tracks: merged,
      index: nextIndex,
      history: [],
      played: [nextIndex],
      ...(i === index ? { progress: 0, duration: 0 } : {}),
    });
  },

  setProgress: (progress, duration) => set({ progress, duration }),

  // Seek preserves the current play/pause state (the engine only resumes if playing).
  seekTo: (seconds) =>
    set((s) => ({ seekNonce: s.seekNonce + 1, seekSeconds: Math.max(0, seconds) })),

  setVolume: (v) => {
    const volume = Math.min(100, Math.max(0, Math.round(v)));
    set({ volume });
    savePrefs({ ...prefsOf(get()), volume });
  },

  toggleShuffle: () => {
    const shuffle = !get().shuffle;
    // Reset the played-pass when toggling so a fresh shuffle has a full pool.
    set({ shuffle, played: [get().index], history: [] });
    savePrefs({ ...prefsOf(get()), shuffle });
  },

  cycleRepeat: () => {
    const order: RepeatMode[] = ["off", "all", "one"];
    const repeat = order[(order.indexOf(get().repeat) + 1) % order.length];
    set({ repeat });
    savePrefs({ ...prefsOf(get()), repeat });
  },

  setCollapsed: (collapsed) => {
    set({ collapsed });
    savePrefs({ ...prefsOf(get()), collapsed });
  },

  setFloaterPos: (x, y) => {
    const pos = { x, y };
    set({ floaterPos: pos });
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
      /* ignore */
    }
  },
}));

function prefsOf(s: JukeboxStore): PersistedPrefs {
  return { volume: s.volume, shuffle: s.shuffle, repeat: s.repeat, collapsed: s.collapsed };
}

/** True while the global jukebox owns playback (per-game themes stay silent). */
export function useJukeboxOwnsPlayback() {
  return useJukebox((s) => s.active && s.tracks.length > 0);
}
