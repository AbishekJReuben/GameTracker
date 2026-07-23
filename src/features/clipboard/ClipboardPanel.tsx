import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { motion } from "motion/react";
import { Search, NotebookPen, Tag, Link2, Code2, Braces, AlertTriangle, TerminalSquare, FolderTree, AlignLeft } from "lucide-react";
import { cn } from "@/lib/cn";
import { classifyClip, type ClipContentKind } from "@/lib/clipContent";
import { useClipboard, visibleClips, type ClipFilter } from "@/store/clipboard";
import { EmptyState } from "@/components/ui";
import { Composer, type ComposerEdit } from "./Composer";
import { ClipboardList } from "./ClipboardList";
import type { ClipItem } from "@/lib/clip";

const FILTERS: ClipFilter[] = ["all", "text", "image"];

export function TagChips({
  tags,
  active,
  onPick,
}: {
  tags: string[];
  active: string | null;
  onPick: (tag: string | null) => void;
}) {
  if (tags.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5 overflow-x-auto rounded-lg bg-white/[0.03] p-0.5 [scrollbar-width:none]">
      <button
        onClick={() => onPick(null)}
        className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-600", active === null ? "bg-accent-2/25 text-ink" : "text-ink-dim")}
      >
        All
      </button>
      {tags.map((tag) => (
        <button
          key={tag}
          onClick={() => onPick(active === tag ? null : tag)}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-600 transition-colors",
            active === tag ? "bg-accent-2/25 text-ink" : "text-ink-dim hover:bg-white/[0.06] hover:text-ink-soft",
          )}
        >
          <Tag className="h-2.5 w-2.5" /> {tag}
        </button>
      ))}
    </div>
  );
}

/** Content-type chips. Only kinds actually present are offered — an empty
 *  "Commands" filter is a dead end, not a feature. */
export function TypeChips({
  items,
  active,
  onPick,
}: {
  items: ClipItem[];
  active: ClipContentKind | null;
  onPick: (kind: ClipContentKind | null) => void;
}) {
  const present = useMemo(() => {
    const counts = new Map<ClipContentKind, number>();
    for (const i of items) {
      if (i.kind !== "text") continue;
      const k = classifyClip(i.text).kind;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return TYPES.filter((t) => (counts.get(t.kind) ?? 0) > 0).map((t) => ({ ...t, count: counts.get(t.kind)! }));
  }, [items]);
  // One kind covering everything is the same as no filter at all.
  if (present.length < 2) return null;
  return (
    <div className="flex items-center gap-0.5 overflow-x-auto rounded-lg bg-white/[0.03] p-0.5 [scrollbar-width:none]">
      <button
        onClick={() => onPick(null)}
        className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-600", active === null ? "bg-accent-3/25 text-ink" : "text-ink-dim hover:text-ink-soft")}
      >
        Any
      </button>
      {present.map(({ kind, label, Icon, count }) => (
        <button
          key={kind}
          onClick={() => onPick(active === kind ? null : kind)}
          title={`${count} ${label.toLowerCase()}`}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-600 transition-colors",
            active === kind ? "bg-accent-3/25 text-ink" : "text-ink-dim hover:bg-white/[0.06] hover:text-ink-soft",
          )}
        >
          <Icon className="h-2.5 w-2.5" /> {label}
          <span className="tabular-nums text-ink-faint">{count}</span>
        </button>
      ))}
    </div>
  );
}

const TYPES: { kind: ClipContentKind; label: string; Icon: typeof Link2 }[] = [
  { kind: "link", label: "Links", Icon: Link2 },
  { kind: "code", label: "Code", Icon: Code2 },
  { kind: "json", label: "JSON", Icon: Braces },
  { kind: "log", label: "Logs", Icon: AlertTriangle },
  { kind: "command", label: "Commands", Icon: TerminalSquare },
  { kind: "path", label: "Paths", Icon: FolderTree },
  { kind: "text", label: "Notes", Icon: AlignLeft },
];

export function ClipboardPanel({ compact, sttEnabled, draftKey = "gt.clip.draft.desktop" }: { compact?: boolean; sttEnabled: boolean; draftKey?: string }) {
  const s = useClipboard();
  const [editing, setEditing] = useState<ComposerEdit | null>(null);
  const { pinned, rest } = visibleClips(s);

  useEffect(() => {
    void s.load();
    const unChanged = listen("clipboard://changed", () => void s.refresh());
    const unItem = listen("clipboard://item", () => void s.refresh());
    return () => { unChanged.then((f) => f()); unItem.then((f) => f()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Narrowing to a tag (or a search term) has to reach past the pages already in
  // memory, otherwise a tag whose notes are older than the first page looks empty.
  // Debounced so typing a query doesn't fire a paging run per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => void s.ensureMatches(), s.search ? 250 : 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.tagFilter, s.typeFilter, s.filter, s.search]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <Composer
        onAddText={s.addText}
        onAddImage={s.addImage}
        sttEnabled={sttEnabled}
        draftKey={draftKey}
        editing={editing}
        onSaveEdit={(id, text) => void s.editText(id, text)}
        onCancelEdit={() => setEditing(null)}
        compact={compact}
      />
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-faint" />
          <input value={s.search} onChange={(e) => s.setSearch(e.target.value)} placeholder="Search notes or tags" className="input w-full py-1 pl-6 text-[11px]" />
        </div>
        <div className="flex shrink-0 rounded-lg bg-white/[0.04] p-0.5">
          {FILTERS.map((f) => (
            <button key={f} onClick={() => s.setFilter(f)} className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-600 capitalize", s.filter === f ? "bg-white/10 text-ink" : "text-ink-dim")}>{f === "image" ? "Images" : f}</button>
          ))}
        </div>
      </div>
      <TagChips tags={s.tags} active={s.tagFilter} onPick={s.setTagFilter} />
      <TypeChips items={[...s.pinned, ...s.items]} active={s.typeFilter} onPick={s.setTypeFilter} />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pr-1 [scrollbar-gutter:stable]">
        {pinned.length === 0 && rest.length === 0 && !s.loading ? (
          <EmptyState icon={<NotebookPen className="h-6 w-6" />} title="Nothing here yet" message="Copy anything or jot a note above. Add as many tags as you need and it syncs everywhere." />
        ) : (
          // Keyed on the active filter so switching tags crossfades the list
          // instead of hard-cutting between two unrelated sets of rows.
          <motion.div key={`${s.tagFilter ?? "all"}·${s.typeFilter ?? "any"}·${s.filter}`} initial={{ opacity: 0.35 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: "easeOut" }}>
          <ClipboardList
            pinned={pinned} rest={rest} loading={s.loading} hasMore={s.hasMore}
            onCopy={s.copy} onDelete={s.remove} onTogglePin={s.togglePin}
            onEdit={(item: ClipItem) => item.kind === "text" && setEditing({ id: item.id, text: item.text ?? "" })}
            onSetTags={(id, tags) => void s.setTags(id, tags)} knownTags={s.tags}
            onLoadMore={s.loadMore} compact={compact} showHistory={!compact}
          />
          </motion.div>
        )}
      </div>
    </div>
  );
}
