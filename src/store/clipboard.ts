// Shared-clipboard UI + data store (desktop). Pages the permanent history lazily
// (keyset by createdUtc) so nothing loads the whole store into memory.

import { create } from "zustand";
import { clip, type ClipItem, type ClipKind } from "@/lib/clip";
import { clipSync } from "@/lib/clipboardSync";

const PAGE = 40;

export type ClipFilter = "all" | ClipKind;

interface ClipStore {
  items: ClipItem[];
  pinned: ClipItem[];
  filter: ClipFilter;
  search: string;
  loading: boolean;
  hasMore: boolean;

  setFilter: (f: ClipFilter) => void;
  setSearch: (s: string) => void;

  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;

  addText: (text: string) => Promise<void>;
  addImage: (imageBase64: string, mime?: string) => Promise<void>;
  copy: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  togglePin: (item: ClipItem) => Promise<void>;
  clearAll: () => Promise<void>;
}

export const useClipboard = create<ClipStore>((set, get) => ({
  items: [],
  pinned: [],
  filter: "all",
  search: "",
  loading: false,
  hasMore: false,

  setFilter: (filter) => set({ filter }),
  setSearch: (search) => set({ search }),

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const [pinned, items] = await Promise.all([clip.pinned(), clip.list(undefined, PAGE)]);
      set({ pinned, items, hasMore: items.length >= PAGE, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  loadMore: async () => {
    const { items, loading, hasMore } = get();
    if (loading || !hasMore || items.length === 0) return;
    set({ loading: true });
    try {
      const last = items[items.length - 1];
      const more = await clip.list(last.createdUtc, PAGE);
      const seen = new Set(items.map((i) => i.id));
      const merged = [...items, ...more.filter((m) => !seen.has(m.id))];
      set({ items: merged, hasMore: more.length >= PAGE, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  // Reload the pinned set + first page (new items land at the top). Keeps the
  // list from growing unbounded on every push.
  refresh: async () => {
    try {
      const [pinned, items] = await Promise.all([clip.pinned(), clip.list(undefined, PAGE)]);
      set({ pinned, items, hasMore: items.length >= PAGE });
    } catch {
      /* ignore */
    }
  },

  addText: async (text) => {
    const t = text.trim();
    if (!t) return;
    await clip.add({ kind: "text", text: t, source: "manual" });
    await get().refresh();
  },

  addImage: async (imageBase64, mime) => {
    await clip.add({ kind: "image", imageBase64, mime: mime ?? "image/png", source: "manual" });
    await get().refresh();
  },

  copy: async (id) => {
    await clip.copy(id).catch(() => {});
  },

  remove: async (id) => {
    await clip.delete(id, true);
    set((s) => ({
      items: s.items.filter((i) => i.id !== id),
      pinned: s.pinned.filter((i) => i.id !== id),
    }));
  },

  togglePin: async (item) => {
    const pinned = !item.pinned;
    await clip.setPinned(item.id, pinned);
    clipSync.sendPin(item.id, pinned);
    await get().refresh();
  },

  clearAll: async () => {
    await clip.clearAll();
    set({ items: [], pinned: [] });
  },
}));

/** Items after search + type filter (pinned first, then the paged list, deduped). */
export function visibleClips(s: {
  items: ClipItem[];
  pinned: ClipItem[];
  filter: ClipFilter;
  search: string;
}): { pinned: ClipItem[]; rest: ClipItem[] } {
  const q = s.search.trim().toLowerCase();
  const match = (i: ClipItem) => {
    if (s.filter !== "all" && i.kind !== s.filter) return false;
    if (!q) return true;
    return (i.text ?? "").toLowerCase().includes(q) || (i.deviceName ?? "").toLowerCase().includes(q);
  };
  const pinnedIds = new Set(s.pinned.map((p) => p.id));
  return {
    pinned: s.pinned.filter(match),
    rest: s.items.filter((i) => !pinnedIds.has(i.id) && match(i)),
  };
}
