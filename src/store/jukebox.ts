import { create } from "zustand";
import type { JukeboxTrack } from "@/lib/jukeboxTracks";

const POS_KEY = "gt.jukebox.pos";

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

interface JukeboxStore {
  tracks: JukeboxTrack[];
  index: number;
  playing: boolean;
  /** Session is open — floater visible, per-game themes yield to jukebox. */
  active: boolean;
  floaterPos: { x: number; y: number } | null;
  start: (tracks: JukeboxTrack[], index?: number) => void;
  stop: () => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (index: number) => void;
  setFloaterPos: (x: number, y: number) => void;
}

export const useJukebox = create<JukeboxStore>((set, get) => ({
  tracks: [],
  index: 0,
  playing: false,
  active: false,
  floaterPos: loadFloaterPos(),

  start: (tracks, index = 0) => {
    if (!tracks.length) return;
    const i = Math.max(0, Math.min(index, tracks.length - 1));
    set({ tracks, index: i, playing: true, active: true });
  },

  stop: () => set({ tracks: [], index: 0, playing: false, active: false }),

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
    const { tracks, index } = get();
    if (tracks.length < 2) return;
    set({ index: (index + 1) % tracks.length, playing: true, active: true });
  },

  prev: () => {
    const { tracks, index } = get();
    if (tracks.length < 2) return;
    set({ index: (index - 1 + tracks.length) % tracks.length, playing: true, active: true });
  },

  seek: (index) => {
    const { tracks } = get();
    if (!tracks.length) return;
    set({
      index: Math.max(0, Math.min(index, tracks.length - 1)),
      playing: true,
      active: true,
    });
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

/** True while the global jukebox owns playback (per-game themes stay silent). */
export function useJukeboxOwnsPlayback() {
  return useJukebox((s) => s.active && s.tracks.length > 0);
}
