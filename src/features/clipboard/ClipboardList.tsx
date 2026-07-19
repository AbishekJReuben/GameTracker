import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Copy, Share2, Trash2, Pin, PinOff, Check, Type, Image as ImageIcon, X } from "lucide-react";
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

export function ClipRow({
  item,
  onCopy,
  onDelete,
  onTogglePin,
  compact,
}: {
  item: ClipItem;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (item: ClipItem) => void;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const doCopy = () => {
    haptic();
    onCopy(item.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1100);
  };

  const thumb = clipAssetUrl(item.thumbPath ?? item.imagePath);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      whileHover={{ y: -1 }}
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 76px" } as React.CSSProperties}
      className={cn(
        "group relative flex items-start gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.03]",
        "px-3 py-2.5 backdrop-blur-sm transition-colors hover:border-white/10 hover:bg-white/[0.05]",
      )}
    >
      {/* preview */}
      <button
        onClick={doCopy}
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
        title="Copy"
      >
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-accent-3">
          {item.kind === "image" ? <ImageIcon className="h-4 w-4" /> : <Type className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          {item.kind === "image" && thumb ? (
            <img
              src={thumb}
              loading="lazy"
              className="max-h-24 w-auto max-w-full rounded-lg border border-white/10 object-cover"
            />
          ) : (
            <span className={cn("block break-words text-sm text-ink-soft", compact ? "line-clamp-2" : "line-clamp-4")}>
              {item.text || "(empty)"}
            </span>
          )}
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-600 uppercase tracking-wide text-ink-faint">
            {item.deviceName && <span className="rounded bg-white/[0.05] px-1.5 py-0.5">{item.deviceName}</span>}
            <span>{relativeTime(item.createdUtc)}</span>
            {item.kind === "image" && item.size > 0 && <span>{Math.round(item.size / 1024)} KB</span>}
          </span>
        </span>
      </button>

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
  onLoadMore,
  compact,
}: {
  pinned: ClipItem[];
  rest: ClipItem[];
  loading: boolean;
  hasMore: boolean;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (item: ClipItem) => void;
  onLoadMore: () => void;
  compact?: boolean;
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
              <ClipRow key={it.id} item={it} onCopy={onCopy} onDelete={onDelete} onTogglePin={onTogglePin} compact={compact} />
            ))}
          </AnimatePresence>
          {rest.length > 0 && <div className="my-1 h-px bg-white/[0.06]" />}
        </>
      )}
      <AnimatePresence initial={false}>
        {rest.map((it) => (
          <ClipRow key={it.id} item={it} onCopy={onCopy} onDelete={onDelete} onTogglePin={onTogglePin} compact={compact} />
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
