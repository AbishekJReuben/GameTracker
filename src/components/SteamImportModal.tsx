import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check, Clock, Gamepad2, Loader2, Search, Trophy } from "lucide-react";
import { api, type SteamLibraryGame } from "@/lib/api";
import { Modal } from "./Modal";
import { EmptyState } from "./ui";
import { useApp, useMotionEnabled } from "@/store/app";
import { fadeSlide, makeStaggerContainer, staggerTransition } from "@/lib/motion";
import { dur } from "@/lib/format";

function playtimeLabel(minutes: number) {
  if (minutes <= 0) return "Unplayed";
  return dur(minutes * 60);
}

export function SteamImportModal({
  open,
  onClose,
  importPlaytime = true,
  importAchievements = true,
}: {
  open: boolean;
  onClose: () => void;
  importPlaytime?: boolean;
  importAchievements?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [games, setGames] = useState<SteamLibraryGame[]>([]);
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
      .steamLibrary()
      .then((list) => {
        setGames(list);
        const selectable = list.filter((g) => !g.imported).map((g) => g.appid);
        setPicked(new Set(selectable));
      })
      .catch((e) => {
        setGames([]);
        pushToast({ kind: "info", title: "Could not load Steam library", message: String(e) });
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

  const toggle = (appid: number, imported: boolean) => {
    if (imported) return;
    setPicked((s) => {
      const next = new Set(s);
      next.has(appid) ? next.delete(appid) : next.add(appid);
      return next;
    });
  };

  const selectAllVisible = () => {
    setPicked(new Set(filtered.filter((g) => !g.imported).map((g) => g.appid)));
  };

  const clearAll = () => setPicked(new Set());

  const importSelected = async () => {
    const appIds = [...picked];
    if (appIds.length === 0) return;
    setSaving(true);
    try {
      await api.steamImport({
        appIds,
        playtime: importPlaytime,
        achievements: importAchievements,
      });
      onClose();
    } catch (e) {
      pushToast({ kind: "info", title: "Import failed", message: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const notImportedCount = games.filter((g) => !g.imported).length;

  return (
    <Modal open={open} onClose={onClose} title="Import from Steam" className="max-w-2xl">
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
              <p className="text-sm">Loading your Steam library…</p>
            </motion.div>
          ) : games.length === 0 ? (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <EmptyState
                icon={<Gamepad2 className="h-6 w-6" />}
                title="No Steam games found"
                message="Sign in with Steam and set Game details to Public in your Steam privacy settings."
              />
            </motion.div>
          ) : (
            <motion.div key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <p className="mb-3 text-sm text-ink-dim">
                {notImportedCount} game{notImportedCount === 1 ? "" : "s"} not yet in Tracker. Selected games
                auto-fetch cover, info, and metadata when online enrichment is on.
              </p>

              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="relative min-w-[200px] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim" />
                  <input
                    className="input focus-ring h-9 w-full pl-9"
                    placeholder="Search library…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-dim">
                  <input
                    type="checkbox"
                    className="rounded border-line"
                    checked={showImported}
                    onChange={(e) => setShowImported(e.target.checked)}
                  />
                  Show already imported
                </label>
                <button type="button" className="btn btn-ghost h-8 text-xs" onClick={selectAllVisible}>
                  Select visible
                </button>
                <button type="button" className="btn btn-ghost h-8 text-xs" onClick={clearAll}>
                  Clear
                </button>
              </div>

              <motion.div
                className="max-h-[46vh] space-y-1.5 overflow-y-auto pr-1"
                variants={enabled ? makeStaggerContainer(0.03) : undefined}
                initial={enabled ? "hidden" : false}
                animate="show"
              >
                {filtered.map((g, i) => {
                  const on = picked.has(g.appid);
                  const disabled = g.imported;
                  return (
                    <motion.button
                      key={g.appid}
                      type="button"
                      custom={i}
                      variants={enabled ? fadeSlide : undefined}
                      transition={staggerTransition(i, 0.02, 0.3)}
                      disabled={disabled || saving}
                      onClick={() => toggle(g.appid, g.imported)}
                      className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                        disabled
                          ? "cursor-default border-line/50 bg-white/[0.01] opacity-60"
                          : on
                            ? "border-accent-1/40 bg-accent-1/10"
                            : "border-line bg-white/[0.02] hover:border-line-strong hover:bg-white/[0.04]"
                      }`}
                    >
                      <img
                        src={g.headerImageUrl}
                        alt=""
                        className="h-10 w-[140px] shrink-0 rounded-lg object-cover"
                        loading="lazy"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-700 text-ink">{g.name}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-dim">
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {playtimeLabel(g.playtimeForeverMinutes)}
                          </span>
                          {g.playtime2WeeksMinutes > 0 && (
                            <span>{Math.round(g.playtime2WeeksMinutes / 60 * 10) / 10}h last 2 weeks</span>
                          )}
                          {g.hasAchievements && (
                            <span className="inline-flex items-center gap-0.5 text-amber">
                              <Trophy className="h-3 w-3" /> Achievements
                            </span>
                          )}
                          {g.imported && <span className="text-emerald-400">Already in Tracker</span>}
                        </div>
                      </div>
                      <div
                        className={`grid h-6 w-6 shrink-0 place-items-center rounded-md border ${
                          disabled
                            ? "border-line/40 bg-transparent"
                            : on
                              ? "border-accent-1 bg-accent-1 text-white"
                              : "border-line bg-black/20"
                        }`}
                      >
                        {(on || disabled) && <Check className="h-3.5 w-3.5" />}
                      </div>
                    </motion.button>
                  );
                })}
              </motion.div>

              <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4">
                <span className="text-xs text-ink-dim">
                  {picked.size} selected
                  {importPlaytime ? " · playtime" : ""}
                  {importAchievements ? " · achievements" : ""}
                </span>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-ghost h-9" onClick={onClose} disabled={saving}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary h-9"
                    disabled={picked.size === 0 || saving}
                    onClick={importSelected}
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gamepad2 className="h-4 w-4" />}
                    Import {picked.size || ""} game{picked.size === 1 ? "" : "s"}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Modal>
  );
}
