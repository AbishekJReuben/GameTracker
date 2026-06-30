import { create } from "zustand";
import type { MediaState } from "@/lib/api";

interface MediaStore {
  /** Latest SMTC "now listening" snapshot pushed from the tracker. */
  media: MediaState | null;
  setMedia: (m: MediaState) => void;
}

export const useMediaStore = create<MediaStore>((set) => ({
  media: null,
  setMedia: (media) => set({ media }),
}));

/** The current external (SMTC) media, or null when nothing is playing. */
export function useNowListening() {
  return useMediaStore((s) => (s.media?.playing ? s.media : null));
}
