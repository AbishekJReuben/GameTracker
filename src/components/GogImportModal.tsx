import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check, Clock, Loader2, Search, Trophy } from "lucide-react";
import { api, type GogLibraryGame } from "@/lib/api";
import { Modal } from "./Modal";
import { EmptyState } from "./ui";
import { useApp, useMotionEnabled } from "@/store/app";
import { fadeSlide, makeStaggerContainer } from "@/lib/motion";
import { dur } from "@/lib/format";

function playtimeLabel(minutes: number) {
  if (minutes <= 0) return "Unplayed";
  return dur(minutes * 60);
}

export function GogImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [games, setGames] = useState<GogLibraryGame[]>([]);
  const [query, setQuery] = useState("");
  const [showImported, setShowImported] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const pushToast = useApp((s) => s.pushToast);
  const enabled = useMotionEnabled();

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setQuery("");
    setPicked(new Set());
    api
      .gogLibrary()
      .then((list) => {
        setGames(list);
        setPicked(new Set(list.filter((g) => !g.imported).map((g) => g.productId)));
      })
      .catch((e) => {
        setGames([]);
        pushToast({ kind: "info", title: "Could not load GOG library", message: String(e) });
      })
      .finally(() => setLoading(false));
  }, [open, pushToast]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return games.filter((g) => {
      if (!showImported && g.imported) return false;
      if (!q) return true;
      return g.name.toLowerCase().includes(q);
    });
  }, [games, query, showImported]);

  const toggle = (productId: number, imported: boolean) => {
    if (imported) return;
    setPicked((s) => {
      const next = new Set(s);
      next.has(productId) ? next.delete(productId) : next.add(productId);
      return next;
    });
  };

  const importSelected = async () => {
    const productIds = [...picked];
    if (productIds.length === 0) return;
    setSaving(true);
    try {
      await api.gogImport(productIds);
      onClose();
    } catch (e) {
      pushToast({ kind: "info", title: "Import failed", message: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const notImportedCount = games.filter((g) => !g.imported).length;

  return (
    <Modal open={open} onClose={onClose} title="Import from GOG" className="max-w-2xl">
      <div className="p-5">
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-3 py-12 text-ink-dim"
            >
              <motion.div
                animate={enabled ? { rotate: 360 } : undefined}
                transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
              >
                <Loader2 className="h-6 w-6" />
              </motion.div>
              <p className="text-sm">Loading your GOG library…</p>
            </motion.div>
          ) : games.length === 0 ? (
            <EmptyState title="No games found" message="Sign in to GOG and try again." />
          ) : (
            <motion.div key="list" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[12rem] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                  <input
                    className="input w-full pl-9"
                    placeholder="Search library…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-ink-dim">
                  <input
                    type="checkbox"
                    checked={showImported}
                    onChange={(e) => setShowImported(e.target.checked)}
                  />
                  Show imported
                </label>
              </div>

              <p className="text-xs text-ink-faint">
                {notImportedCount} not yet in Tracker · {picked.size} selected
              </p>

              <motion.ul
                className="max-h-[min(50vh,24rem)] space-y-1 overflow-y-auto pr-1"
                variants={enabled ? makeStaggerContainer(0.02) : undefined}
                initial="hidden"
                animate="show"
              >
                {filtered.map((g) => {
                  const selected = picked.has(g.productId);
                  return (
                    <motion.li
                      key={g.productId}
                      variants={enabled ? fadeSlide : undefined}
                      className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
                        g.imported
                          ? "border-white/5 opacity-60"
                          : selected
                            ? "border-accent/40 bg-accent/10"
                            : "border-white/8 hover:bg-base-850/80"
                      }`}
                      onClick={() => toggle(g.productId, g.imported)}
                    >
                      <div
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                          selected ? "border-accent bg-accent text-base" : "border-white/20"
                        }`}
                      >
                        {selected && <Check className="h-3 w-3" />}
                      </div>
                      {g.coverImageUrl ? (
                        <img src={g.coverImageUrl} alt="" className="h-10 w-7 rounded object-cover" />
                      ) : (
                        <div className="h-10 w-7 rounded bg-base-800" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-600">{g.name}</p>
                        <p className="flex items-center gap-2 text-xs text-ink-dim">
                          <Clock className="h-3 w-3" />
                          {playtimeLabel(g.playtimeMinutes)}
                          {g.hasAchievements && (
                            <>
                              <Trophy className="h-3 w-3" />
                              Achievements
                            </>
                          )}
                          {g.imported && <span className="text-accent">In library</span>}
                        </p>
                      </div>
                    </motion.li>
                  );
                })}
              </motion.ul>

              <div className="flex justify-end gap-2 border-t border-white/8 pt-4">
                <button type="button" className="btn btn-ghost" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={picked.size === 0 || saving}
                  onClick={importSelected}
                >
                  {saving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Importing…
                    </>
                  ) : (
                    `Import ${picked.size} game${picked.size === 1 ? "" : "s"}`
                  )}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Modal>
  );
}
