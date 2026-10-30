// Shared-clipboard UI + data store (desktop). Pages the permanent history lazily
// (keyset by createdUtc) so nothing loads the whole store into memory.

import { create } from "zustand";
import { clip, type ClipItem, type ClipKind } from "@/lib/clip";
import { classifyClip, type ClipContentKind } from "@/lib/clipContent";

const PAGE = 40;

export type ClipFilter = "all" | ClipKind;

interface ClipStore {
  items: ClipItem[];
  pinned: ClipItem[];
  filter: ClipFilter;
  search: string;
  /** null = all; a tag name filters items containing that tag. */
  tagFilter: string | null;
  /** null = all; otherwise only notes of that content kind (links, code, …). */
  typeFilter: ClipContentKind | null;
  tags: string[];
  loading: boolean;
  hasMore: boolean;
  /** Last revision merged into this store. */
  rev: number;
  /** Search hits from the whole history; null when not searching. */
  results: ClipItem[] | null;

  setFilter: (f: ClipFilter) => void;
  setSearch: (s: string) => void;
  setTagFilter: (f: string | null) => void;
  setTypeFilter: (f: ClipContentKind | null) => void;

  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Merge only what changed since the last look. */
  sync: () => Promise<void>;
  /** Run the current search against the whole history. */
  runSearch: () => Promise<void>;
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
  typeFilter: null,
  tags: [],
  loading: false,
  hasMore: false,
  rev: 0,
  results: null,

  setFilter: (filter) => set({ filter }),
  setSearch: (search) => set(search.trim() ? { search } : { search, results: null }),
  setTagFilter: (tagFilter) => set({ tagFilter }),
  setTypeFilter: (typeFilter) => set({ typeFilter }),

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      // The revision is read first: a change landing during this load is then seen
      // again by the next sync, which is harmless, instead of being missed.
      const { rev } = await clip.changes(Number.MAX_SAFE_INTEGER);
      const [pinned, items, tags] = await Promise.all([
        clip.pinned(),
        clip.list(undefined, PAGE),
        clip.tags().catch(() => []),
      ]);
      set({ pinned, items, tags, rev, hasMore: items.length >= PAGE, loading: false });
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
      const { rev } = await clip.changes(Number.MAX_SAFE_INTEGER);
      const [pinned, items, tags] = await Promise.all([
        clip.pinned(),
        clip.list(undefined, PAGE),
        clip.tags().catch(() => []),
      ]);
      set({ pinned, items, tags, rev, hasMore: items.length >= PAGE });
    } catch {
      /* ignore */
    }
  },

  // A burst of notices collapses into one more pass, and the list keeps its loaded
  // pages and scroll position instead of snapping back to the first page.
  sync: async () => {
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    try {
      do {
        syncAgain = false;
        const { rev, reload, items: changed } = await clip.changes(get().rev);
        if (reload) {
          await get().refresh();
          continue;
        }
        if (changed.length === 0) {
          set({ rev });
          continue;
        }
        set((s) => ({ ...mergeChanges(s.items, s.pinned, changed), rev }));
        if (changed.some((c) => c.tags?.length)) {
          const tags = await clip.tags().catch(() => null);
          if (tags) set({ tags });
        }
        if (get().search.trim()) await get().runSearch();
      } while (syncAgain);
    } catch {
      /* the next notice tries again */
    } finally {
      syncing = false;
    }
  },

  runSearch: async () => {
    const q = get().search.trim();
    const mine = ++searchRun;
    if (!q) {
      set({ results: null });
      return;
    }
    try {
      const results = await clip.search(q);
      if (mine === searchRun) set({ results });
    } catch {
      /* keep the previous hits */
    }
  },

  // A note created while filtering a tag inherits that tag.
  addText: async (text) => {
    const t = text.trim();
    if (!t) return;
    const tags = get().tagFilter ? [get().tagFilter!] : [];
    await clip.add({ kind: "text", text: t, source: "manual", tags, folder: tags[0] ?? "" });
    await get().sync();
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
    await get().sync();
  },

  editText: async (id, text) => {
    const t = text.trim();
    if (!t) return;
    await clip.updateText(id, t);
    await get().sync();
  },

  setTags: async (id, tags) => {
    await clip.setTags(id, tags);
    await get().sync();
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
    await get().sync();
  },

  clearAll: async () => {
    await clip.clearAll();
    set({ items: [], pinned: [] });
  },
}));

let syncing = false;
let syncAgain = false;
let searchRun = 0;

/** Apply changed rows to the loaded lists: newest first, tombstones removed, and
 *  rows older than what's loaded left for paging to find. */
export function mergeChanges(items: ClipItem[], pinned: ClipItem[], changed: ClipItem[]): { items: ClipItem[]; pinned: ClipItem[] } {
  const ids = new Set(changed.map((c) => c.id));
  const oldest = items[items.length - 1]?.createdUtc ?? "";
  const live = changed.filter((c) => !c.deleted);
  const byNewest = (a: ClipItem, b: ClipItem) => b.createdUtc.localeCompare(a.createdUtc);
  return {
    items: [...items.filter((i) => !ids.has(i.id)), ...live.filter((c) => c.createdUtc >= oldest)].sort(byNewest),
    pinned: [...pinned.filter((i) => !ids.has(i.id)), ...live.filter((c) => c.pinned)].sort(byNewest),
  };
}

/** Items after search + kind + tag + content-type filters (pinned first, then the paged list, deduped). */
export function visibleClips(s: {
  items: ClipItem[];
  pinned: ClipItem[];
  filter: ClipFilter;
  search: string;
  tagFilter?: string | null;
  typeFilter?: ClipContentKind | null;
  results?: ClipItem[] | null;
}): { pinned: ClipItem[]; rest: ClipItem[] } {
  const q = s.search.trim().toLowerCase();
  const tf = s.tagFilter ?? null;
  const yf = s.typeFilter ?? null;
  const match = (i: ClipItem) => {
    if (s.filter !== "all" && i.kind !== s.filter) return false;
    if (tf !== null && !(i.tags ?? []).some((t) => t.toLowerCase() === tf.toLowerCase())) return false;
    // Images have no text to classify; a content-type filter simply excludes them.
    if (yf !== null && (i.kind !== "text" || classifyClip(i.text).kind !== yf)) return false;
    // Search hits come from the database, which reads full notes; what's loaded
    // here is only each note's first 8 KB.
    if (!q || s.results) return true;
    return (i.text ?? "").toLowerCase().includes(q) ||
      (i.deviceName ?? "").toLowerCase().includes(q) ||
      (i.tags ?? []).some((tag) => tag.toLowerCase().includes(q));
  };
  if (s.results) {
    const hits = s.results.filter(match);
    return { pinned: hits.filter((i) => i.pinned), rest: hits.filter((i) => !i.pinned) };
  }
  const pinnedIds = new Set(s.pinned.map((p) => p.id));
  return {
    pinned: s.pinned.filter(match),
    rest: s.items.filter((i) => !pinnedIds.has(i.id) && match(i)),
  };
}
