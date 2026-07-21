import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Copy,
  Share2,
  Trash2,
  Pin,
  PinOff,
  Check,
  Type,
  Image as ImageIcon,
  X,
  ChevronDown,
  Pencil,
  Folder,
  FolderPlus,
  History,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { clipAssetUrl, type ClipItem } from "@/lib/clip";
import { Skeleton } from "@/components/ui";

function haptic() {
  try {
    navigator.vibrate?.(8);
  } catch {
    /* ignore */
  }
}

/** Best-effort native share; falls back to the caller's copy. */
async function shareClip(item: ClipItem, fallbackCopy: () => void) {
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  try {
    if (item.kind === "text" && item.text && nav.share) {
      await nav.share({ text: item.text });
      return;
    }
    if (item.kind === "image" && item.imagePath && nav.share) {
      const url = clipAssetUrl(item.imagePath)!;
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], "clip.png", { type: blob.type || "image/png" });
      if (!nav.canShare || nav.canShare({ files: [file] })) {
        await nav.share({ files: [file] });
        return;
      }
    }
  } catch {
    /* user cancelled or unsupported */
    return;
  }
  fallbackCopy();
}

/** Inline folder picker shown when the row's Folder action is tapped. */
function FolderPicker({
  current,
  folders,
  onPick,
  onClose,
}: {
  current: string;
  folders: string[];
  onPick: (folder: string) => void;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const all = folders.filter((f) => f.trim().length > 0);
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="overflow-hidden"
    >
      <div className="mt-1 flex flex-wrap items-center gap-1 rounded-xl bg-white/[0.04] p-1.5">
        <button
          onClick={() => {
            onPick("");
            onClose();
          }}
          className={cn(
            "rounded-md px-2 py-0.5 text-[10px] font-600",
            current === "" ? "bg-white/15 text-ink" : "text-ink-dim hover:bg-white/10 hover:text-ink",
          )}
        >
          No folder
        </button>
        {all.map((f) => (
          <button
            key={f}
            onClick={() => {
              onPick(f);
              onClose();
            }}
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-600",
              current === f ? "bg-accent-2/25 text-ink" : "text-ink-dim hover:bg-white/10 hover:text-ink",
            )}
          >
            <Folder className="h-2.5 w-2.5" /> {f}
          </button>
        ))}
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const n = newName.trim();
            if (!n) return;
            onPick(n);
            onClose();
          }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New folder…"
            className="w-24 rounded-md bg-white/[0.06] px-2 py-0.5 text-[10px] text-ink outline-none placeholder:text-ink-faint"
          />
          <button
            type="submit"
            disabled={!newName.trim()}
            className="grid h-5 w-5 place-items-center rounded-md text-accent-3 hover:bg-white/10 disabled:opacity-40"
            title="Create folder and move"
          >
            <FolderPlus className="h-3 w-3" />
          </button>
        </form>
      </div>
    </motion.div>
  );
}

export function ClipRow({
  item,
  onCopy,
  onDelete,
  onTogglePin,
  onEdit,
  onMoveToFolder,
  folders,
  compact,
  showHistory,
}: {
  item: ClipItem;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (item: ClipItem) => void;
  onEdit?: (item: ClipItem) => void;
  onMoveToFolder?: (id: string, folder: string) => void;
  folders?: string[];
  compact?: boolean;
  /** App screens (not the floating panels) show every date this exact item was
   *  copied. Off in the overlay/dock. */
  showHistory?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [datesOpen, setDatesOpen] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  // Distinct copy timestamps, newest first; only meaningful when the same content
  // was copied more than once.
  const copyDates = Array.from(new Set(item.copies ?? []))
    .filter(Boolean)
    .sort()
    .reverse();
  const hasHistory = !!showHistory && copyDates.length > 1;

  const doCopy = () => {
    haptic();
    onCopy(item.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1100);
  };

  const thumb = clipAssetUrl(item.thumbPath ?? item.imagePath);
  const full = clipAssetUrl(item.imagePath ?? item.thumbPath);
  const isImage = item.kind === "image";
  const collapsedLines = compact ? 3 : 5;

  // Detect whether the collapsed text actually overflows, so the "Show more"
  // affordance only appears when there's genuinely more to reveal.
  useLayoutEffect(() => {
    if (isImage || expanded) return;
    const el = textRef.current;
    if (el) setClamped(el.scrollHeight - el.clientHeight > 2);
  }, [item.text, isImage, expanded, compact]);

  const canExpand = isImage || clamped || expanded;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      whileHover={{ y: -1 }}
      className={cn(
        "group relative flex flex-col gap-1.5 rounded-2xl border border-white/[0.06] bg-white/[0.03]",
        "px-3 py-2.5 backdrop-blur-sm transition-colors hover:border-white/10 hover:bg-white/[0.05]",
      )}
    >
      {/* content — the primary element */}
      <button
        onClick={doCopy}
        className="block min-w-0 text-left"
        title="Click to copy"
      >
        {isImage ? (
          <img
            src={(expanded ? full : thumb) ?? undefined}
            loading="lazy"
            className={cn(
              "w-auto max-w-full rounded-lg border border-white/10 object-contain transition-all",
              expanded ? "max-h-[52vh]" : "max-h-32",
            )}
          />
        ) : (
          <p
            ref={textRef}
            className={cn(
              "m-0 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink",
              expanded ? "max-h-[52vh] overflow-y-auto pr-1" : "overflow-hidden",
            )}
            style={
              expanded
                ? undefined
                : ({
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: collapsedLines,
                  } as React.CSSProperties)
            }
          >
            {item.text || "(empty)"}
          </p>
        )}
      </button>

      {/* footer: expand affordance + muted metadata + actions */}
      <div className="flex items-center gap-2">
        {canExpand ? (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-[10px] font-700 uppercase tracking-wide text-accent-3 hover:bg-white/[0.06]"
            title={expanded ? "Show less" : "Show full content"}
          >
            <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
            {expanded ? "Less" : isImage ? "View" : "More"}
          </button>
        ) : (
          <span className="shrink-0 text-ink-faint" title={isImage ? "Image" : "Text"}>
            {isImage ? <ImageIcon className="h-3 w-3" /> : <Type className="h-3 w-3" />}
          </span>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-[10px] text-ink-faint">
          {(item.folder ?? "") !== "" && (
            <span className="flex shrink-0 items-center gap-0.5 rounded bg-accent-2/15 px-1 py-px text-accent-2">
              <Folder className="h-2.5 w-2.5" />
              <span className="max-w-[7rem] truncate">{item.folder}</span>
            </span>
          )}
          {item.deviceName && <span className="truncate">{item.deviceName}</span>}
          <span className="text-white/15">·</span>
          <span className="shrink-0">{relativeTime(item.createdUtc)}</span>
          {hasHistory && (
            <button
              onClick={() => setDatesOpen((v) => !v)}
              className="flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-accent-3 hover:bg-white/[0.06]"
              title="Show every time this was copied"
            >
              <History className="h-2.5 w-2.5" />
              {copyDates.length}×
            </button>
          )}
          {isImage && item.size > 0 && (
            <>
              <span className="text-white/15">·</span>
              <span className="shrink-0">{Math.round(item.size / 1024)} KB</span>
            </>
          )}
        </span>

        {/* actions */}
        <div className="flex shrink-0 items-center gap-0.5">
        {item.pinned && (
          <span className="mr-0.5 text-accent-2" title="Pinned">
            <Pin className="h-3.5 w-3.5 fill-current" />
          </span>
        )}
        <AnimatePresence mode="wait" initial={false}>
          {confirming ? (
            <motion.div
              key="confirm"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="flex items-center gap-1"
            >
              <button
                onClick={() => {
                  haptic();
                  onDelete(item.id);
                }}
                className="rounded-lg bg-rose-500/90 px-2 py-1 text-[11px] font-700 text-white hover:bg-rose-500"
              >
                Delete
              </button>
              <IconBtn label="Cancel" onClick={() => setConfirming(false)}>
                <X className="h-4 w-4" />
              </IconBtn>
            </motion.div>
          ) : (
            <motion.div
              key="actions"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100"
            >
              <IconBtn label={copied ? "Copied" : "Copy"} onClick={doCopy}>
                {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </IconBtn>
              {!isImage && onEdit && (
                <IconBtn label="Edit" onClick={() => onEdit(item)}>
                  <Pencil className="h-4 w-4" />
                </IconBtn>
              )}
              {onMoveToFolder && (
                <IconBtn label="Move to folder" onClick={() => setFolderOpen((v) => !v)}>
                  <Folder className={cn("h-4 w-4", folderOpen && "text-accent-2")} />
                </IconBtn>
              )}
              <IconBtn label="Share" onClick={() => shareClip(item, doCopy)}>
                <Share2 className="h-4 w-4" />
              </IconBtn>
              <IconBtn label={item.pinned ? "Unpin" : "Pin"} onClick={() => onTogglePin(item)}>
                {item.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
              </IconBtn>
              <IconBtn label="Delete" onClick={() => setConfirming(true)}>
                <Trash2 className="h-4 w-4" />
              </IconBtn>
            </motion.div>
          )}
        </AnimatePresence>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {folderOpen && onMoveToFolder && (
          <FolderPicker
            current={item.folder ?? ""}
            folders={folders ?? []}
            onPick={(f) => onMoveToFolder(item.id, f)}
            onClose={() => setFolderOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {hasHistory && datesOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-1 rounded-xl bg-white/[0.04] p-2">
              <div className="mb-1 px-0.5 text-[9px] font-700 uppercase tracking-wide text-ink-faint">
                Copied {copyDates.length} times
              </div>
              <ul className="flex flex-col gap-0.5">
                {copyDates.map((d, i) => (
                  <li key={d + i} className="flex items-center gap-1.5 text-[10px] text-ink-dim">
                    <span className="h-1 w-1 shrink-0 rounded-full bg-accent-3/60" />
                    <span className="shrink-0 tabular-nums">{new Date(d).toLocaleString()}</span>
                    <span className="text-white/15">·</span>
                    <span className="text-ink-faint">{relativeTime(d)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function IconBtn({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.88 }}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid h-7 w-7 place-items-center rounded-lg text-ink-dim hover:bg-white/10 hover:text-ink"
    >
      {children}
    </motion.button>
  );
}

export function ClipboardList({
  pinned,
  rest,
  loading,
  hasMore,
  onCopy,
  onDelete,
  onTogglePin,
  onEdit,
  onMoveToFolder,
  folders,
  onLoadMore,
  compact,
  showHistory,
}: {
  pinned: ClipItem[];
  rest: ClipItem[];
  loading: boolean;
  hasMore: boolean;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (item: ClipItem) => void;
  onEdit?: (item: ClipItem) => void;
  onMoveToFolder?: (id: string, folder: string) => void;
  folders?: string[];
  onLoadMore: () => void;
  compact?: boolean;
  showHistory?: boolean;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loading) onLoadMore();
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, onLoadMore]);

  return (
    <div className="flex flex-col gap-2">
      {pinned.length > 0 && (
        <>
          <div className="px-1 text-[10px] font-700 uppercase tracking-[0.18em] text-ink-faint">Pinned</div>
          <AnimatePresence initial={false}>
            {pinned.map((it) => (
              <ClipRow
                key={it.id}
                item={it}
                onCopy={onCopy}
                onDelete={onDelete}
                onTogglePin={onTogglePin}
                onEdit={onEdit}
                onMoveToFolder={onMoveToFolder}
                folders={folders}
                compact={compact}
                showHistory={showHistory}
              />
            ))}
          </AnimatePresence>
          {rest.length > 0 && <div className="my-1 h-px bg-white/[0.06]" />}
        </>
      )}
      <AnimatePresence initial={false}>
        {rest.map((it) => (
          <ClipRow
            key={it.id}
            item={it}
            onCopy={onCopy}
            onDelete={onDelete}
            onTogglePin={onTogglePin}
            onEdit={onEdit}
            onMoveToFolder={onMoveToFolder}
            folders={folders}
            compact={compact}
            showHistory={showHistory}
          />
        ))}
      </AnimatePresence>
      {loading && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}
      <div ref={sentinel} className="h-1" />
    </div>
  );
}
