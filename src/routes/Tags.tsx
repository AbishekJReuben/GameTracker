import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { Tag, Search, Star, Trophy, Clock, ArrowRight, Pencil, Trash2, Combine, Check, X, Settings2 } from "lucide-react";
import { Page } from "@/components/Page";
import { SectionTitle, EmptyState, Skeleton } from "@/components/ui";
import { Panel } from "@/components/Panel";
import { Modal } from "@/components/Modal";
import { LevelBar } from "@/components/RadialGauge";
import { useGames, useTagAnalytics, useRefreshAll } from "@/lib/queries";
import { useApp } from "@/store/app";
import { api } from "@/lib/api";
import { dur } from "@/lib/format";
import { cn } from "@/lib/cn";

export default function TagsPage() {
  const { data, isLoading } = useTagAnalytics();
  const { data: games } = useGames();
  const refresh = useRefreshAll();
  const pushToast = useApp((s) => s.pushToast);
  const [q, setQ] = useState("");
  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ tag: string; value: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const allTagNames = useMemo(() => (data ?? []).map((t) => t.tag), [data]);

  const filtered = useMemo(() => {
    const list = data ?? [];
    if (!q.trim()) return list;
    const needle = q.toLowerCase();
    return list.filter((t) => t.tag.toLowerCase().includes(needle));
  }, [data, q]);

  const maxPlay = Math.max(1, ...(data ?? []).map((t) => t.activeSeconds));

  const openTag = (tag: string) => {
    if (manage) return;
    navigate("/library", { state: { tag } });
  };

  const toggleSelect = (tag: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(tag) ? next.delete(tag) : next.add(tag);
      return next;
    });

  const exitManage = () => {
    setManage(false);
    setSelected(new Set());
    setMergeTarget("");
  };

  const doRename = async () => {
    if (!renaming) return;
    const next = renaming.value.trim();
    if (!next || next === renaming.tag) return setRenaming(null);
    setBusy(true);
    try {
      await api.renameTag(renaming.tag, next);
      pushToast({ kind: "success", title: "Tag renamed", message: `“${renaming.tag}” → “${next}”` });
      refresh();
    } catch {
      pushToast({ kind: "info", title: "Couldn't rename tag" });
    } finally {
      setBusy(false);
      setRenaming(null);
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteTag(deleting);
      pushToast({ kind: "success", title: "Tag deleted", message: `“${deleting}” removed from every game` });
      setSelected((prev) => {
        const n = new Set(prev);
        n.delete(deleting);
        return n;
      });
      refresh();
    } catch {
      pushToast({ kind: "info", title: "Couldn't delete tag" });
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  };

  const doMerge = async () => {
    const target = mergeTarget.trim();
    const sources = [...selected];
    if (!target || sources.length === 0) return;
    setBusy(true);
    try {
      await api.mergeTags(sources, target);
      pushToast({ kind: "success", title: "Tags merged", message: `${sources.length} → “${target}”` });
      setSelected(new Set());
      setMergeTarget("");
      refresh();
    } catch {
      pushToast({ kind: "info", title: "Couldn't merge tags" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title="Tags"
      subtitle="Genres and labels across your library"
      actions={
        (data?.length ?? 0) > 0 && (
          <button
            onClick={() => (manage ? exitManage() : setManage(true))}
            className={cn("btn h-10", manage ? "btn-primary" : "btn-ghost")}
          >
            {manage ? <Check className="h-4 w-4" /> : <Settings2 className="h-4 w-4" />}
            {manage ? "Done" : "Manage tags"}
          </button>
        )
      }
    >
      <div className="space-y-6 pb-24">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim" />
          <input
            className="input w-full pl-10"
            placeholder="Filter tags…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {manage && (
          <p className="rounded-xl border border-accent-3/25 bg-accent-3/[0.06] px-4 py-2.5 text-xs text-ink-soft">
            <span className="font-700 text-accent-3">Manage mode.</span> Rename or delete any tag, or select
            several and merge them into one. Changes apply across your whole library and update Collection analytics.
          </p>
        )}

        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-36 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Tag className="h-6 w-6" />}
            title={q ? "No matching tags" : "No tags yet"}
            message="Add tags when editing games, or fetch game info from Steam to import genres automatically."
          />
        ) : (
          <Panel panelKey="tags.grid" games={games ?? []} className="overflow-hidden">
            <div className="relative z-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((t, i) => {
                const isSel = selected.has(t.tag);
                return (
                  <motion.div
                    key={t.tag}
                    layout
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.04, 0.4), duration: 0.4 }}
                    onClick={() => (manage ? toggleSelect(t.tag) : openTag(t.tag))}
                    className={cn(
                      "card group relative cursor-pointer overflow-hidden p-4 text-left transition hover:-translate-y-0.5 hover:shadow-float",
                      isSel && "ring-2 ring-accent-3"
                    )}
                  >
                    <div className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full bg-accent-violet/15 blur-2xl transition group-hover:bg-accent-cyan/20" />

                    {manage && (
                      <span
                        className={cn(
                          "absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-md border transition",
                          isSel ? "border-accent-3 bg-accent-3 text-black" : "border-line bg-black/30 text-transparent"
                        )}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </span>
                    )}

                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-display text-lg font-800 text-ink">{t.tag}</div>
                        <div className="mt-1 text-xs text-ink-dim">
                          {t.gameCount} {t.gameCount === 1 ? "game" : "games"}
                          {t.completedCount > 0 && ` · ${t.completedCount} completed`}
                        </div>
                      </div>
                      {!manage && <ArrowRight className="h-4 w-4 shrink-0 text-ink-faint transition group-hover:text-accent-3" />}
                    </div>

                    <div className="mt-4 space-y-2">
                      <div className="flex items-center gap-2 text-xs text-ink-soft">
                        <Clock className="h-3.5 w-3.5" />
                        {dur(t.activeSeconds)} played
                      </div>
                      <LevelBar value={t.activeSeconds} max={maxPlay} delay={i * 0.03} />
                      <div className="flex items-center justify-between text-[11px] text-ink-dim">
                        <span className="inline-flex items-center gap-1">
                          <Trophy className="h-3 w-3" />
                          {t.completedCount} done
                        </span>
                        {t.avgRating > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <Star className="h-3 w-3 fill-amber text-amber" />
                            avg {t.avgRating.toFixed(0)}
                          </span>
                        )}
                      </div>
                    </div>

                    {manage && (
                      <div className="mt-3 flex gap-2 border-t border-line pt-3" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => setRenaming({ tag: t.tag, value: t.tag })}
                          className="btn btn-subtle h-8 flex-1 text-xs"
                        >
                          <Pencil className="h-3.5 w-3.5" /> Rename
                        </button>
                        <button
                          onClick={() => setDeleting(t.tag)}
                          className="btn h-8 flex-1 border border-pink/30 bg-pink/10 text-xs text-pink hover:bg-pink/20"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Delete
                        </button>
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          </Panel>
        )}

        {!manage && (
          <Panel panelKey="tags.tip" games={games ?? []}>
            <SectionTitle title="Tip" subtitle="Tags power Collection analytics" />
            <p className="text-sm text-ink-soft">
              Tags appear on the{" "}
              <Link to="/collection" className="font-700 text-accent-3 hover:underline">
                Collection
              </Link>{" "}
              genre radar and breakdown charts. Use <span className="font-700 text-ink">Get game info</span> in Library to
              pull Steam genres, add custom tags when editing any game, or hit <span className="font-700 text-ink">Manage tags</span>{" "}
              to rename, delete, and merge.
            </p>
          </Panel>
        )}
      </div>

      {/* Floating merge bar */}
      <AnimatePresence>
        {manage && selected.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ type: "spring", stiffness: 360, damping: 30 }}
            className="fixed inset-x-0 bottom-5 z-30 mx-auto flex w-fit max-w-[92vw] flex-wrap items-center gap-3 rounded-2xl border border-line bg-bg-850/95 px-4 py-3 shadow-float backdrop-blur-xl"
          >
            <span className="inline-flex items-center gap-2 text-sm font-700">
              <Combine className="h-4 w-4 text-accent-3" />
              {selected.size} selected
            </span>
            <span className="text-ink-dim">→</span>
            <input
              list="merge-targets"
              value={mergeTarget}
              onChange={(e) => setMergeTarget(e.target.value)}
              placeholder="Merge into… (new or existing)"
              className="input h-9 w-56"
            />
            <datalist id="merge-targets">
              {allTagNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <button onClick={doMerge} disabled={busy || !mergeTarget.trim()} className="btn btn-primary h-9 disabled:opacity-50">
              <Combine className="h-4 w-4" /> Merge
            </button>
            <button onClick={() => setSelected(new Set())} className="btn btn-ghost h-9" title="Clear selection">
              <X className="h-4 w-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Rename modal */}
      <Modal open={!!renaming} onClose={() => setRenaming(null)} title="Rename tag">
        <div className="space-y-4 p-5">
          <p className="text-sm text-ink-dim">
            Renaming updates this tag on every game. If a tag with the new name already exists, the two are merged.
          </p>
          <input
            autoFocus
            value={renaming?.value ?? ""}
            onChange={(e) => setRenaming((r) => (r ? { ...r, value: e.target.value } : r))}
            onKeyDown={(e) => e.key === "Enter" && doRename()}
            className="input w-full"
            placeholder="New tag name"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setRenaming(null)} className="btn btn-ghost h-10">Cancel</button>
            <button onClick={doRename} disabled={busy} className="btn btn-primary h-10 disabled:opacity-50">
              <Check className="h-4 w-4" /> Save
            </button>
          </div>
        </div>
      </Modal>

      {/* Delete confirm */}
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete tag">
        <div className="space-y-4 p-5">
          <p className="text-sm text-ink-soft">
            Remove <span className="font-800 text-ink">“{deleting}”</span> from every game? Your games and playtime are
            untouched — only the label is removed. This can't be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setDeleting(null)} className="btn btn-ghost h-10">Cancel</button>
            <button
              onClick={doDelete}
              disabled={busy}
              className="btn h-10 border border-pink/40 bg-pink/15 text-pink hover:bg-pink/25 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" /> Delete tag
            </button>
          </div>
        </div>
      </Modal>
    </Page>
  );
}
