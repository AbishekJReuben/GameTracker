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
  /** null = all; a tag name filters items containing that tag. */
  tagFilter: string | null;
  tags: string[];
  loading: boolean;
  hasMore: boolean;

  setFilter: (f: ClipFilter) => void;
  setSearch: (s: string) => void;
  setTagFilter: (f: string | null) => void;

  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Page deeper until the active filters have something to show. */
  ensureMatches: () => Promise<void>;

  addText: (text: string) => Promise<void>;
  addImage: (imageBase64: string, mime?: string) => Promise<void>;
  editText: (id: string, text: string) => Promise<void>;
  setTags: (id: string, tags: string[]) => Promise<void>;
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
  tagFilter: null,
  tags: [],
  loading: false,
  hasMore: false,

  setFilter: (filter) => set({ filter }),
  setSearch: (search) => set({ search }),
  setTagFilter: (tagFilter) => set({ tagFilter }),

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const [pinned, items, tags] = await Promise.all([
        clip.pinned(),
        clip.list(undefined, PAGE),
        clip.tags().catch(() => []),
      ]);
      set({ pinned, items, tags, hasMore: items.length >= PAGE, loading: false });
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

  // Filters run over the pages already in memory, so picking a tag whose notes
  // live deeper in history would show an empty list until the user had scrolled
  // all the way there under "All". The scroll sentinel can't rescue it either:
  // it fires on an intersection *change*, so a short filtered list loads exactly
  // one extra page and then stalls. Page forward here until the filter has a
  // screenful (or history runs out) — `loading` stays true throughout, so the
  // panel shows its skeletons instead of a false "nothing here".
  ensureMatches: async () => {
    const TARGET = 12;
    const MAX_PAGES = 25; // ~1000 notes; a bound so an unmatched tag can't spin
    for (let page = 0; page < MAX_PAGES; page++) {
      const s = get();
      if (!s.hasMore || s.loading) return;
      const { pinned, rest } = visibleClips(s);
      if (pinned.length + rest.length >= TARGET) return;
      const before = s.items.length;
      await get().loadMore();
      if (get().items.length === before) return; // no progress — stop
    }
  },

  // Reload the pinned set + first page (new items land at the top). Keeps the
  // list from growing unbounded on every push.
  refresh: async () => {
    try {
      const [pinned, items, tags] = await Promise.all([
        clip.pinned(),
        clip.list(undefined, PAGE),
        clip.tags().catch(() => []),
      ]);
      set({ pinned, items, tags, hasMore: items.length >= PAGE });
    } catch {
      /* ignore */
    }
  },

  // A note created while filtering a tag inherits that tag.
  addText: async (text) => {
    const t = text.trim();
    if (!t) return;
    const tags = get().tagFilter ? [get().tagFilter!] : [];
    await clip.add({ kind: "text", text: t, source: "manual", tags, folder: tags[0] ?? "" });
    await get().refresh();
  },

  addImage: async (imageBase64, mime) => {
    const tags = get().tagFilter ? [get().tagFilter!] : [];
    await clip.add({
      kind: "image",
      imageBase64,
      mime: mime ?? "image/png",
      source: "manual",
      tags,
      folder: tags[0] ?? "",
    });
    await get().refresh();
  },

  editText: async (id, text) => {
    const t = text.trim();
    if (!t) return;
    await clip.updateText(id, t);
    await get().refresh();
  },

  setTags: async (id, tags) => {
    await clip.setTags(id, tags);
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

/** Items after search + type + tag filters (pinned first, then the paged list, deduped). */
export function visibleClips(s: {
  items: ClipItem[];
  pinned: ClipItem[];
  filter: ClipFilter;
  search: string;
  tagFilter?: string | null;
}): { pinned: ClipItem[]; rest: ClipItem[] } {
  const q = s.search.trim().toLowerCase();
  const tf = s.tagFilter ?? null;
  const match = (i: ClipItem) => {
    if (s.filter !== "all" && i.kind !== s.filter) return false;
    if (tf !== null && !(i.tags ?? []).some((t) => t.toLowerCase() === tf.toLowerCase())) return false;
    if (!q) return true;
    return (i.text ?? "").toLowerCase().includes(q) ||
      (i.deviceName ?? "").toLowerCase().includes(q) ||
      (i.tags ?? []).some((tag) => tag.toLowerCase().includes(q));
  };
  const pinnedIds = new Set(s.pinned.map((p) => p.id));
  return {
    pinned: s.pinned.filter(match),
    rest: s.items.filter((i) => !pinnedIds.has(i.id) && match(i)),
  };
}
