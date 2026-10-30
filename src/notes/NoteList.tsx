import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronDown, Copy, Pencil, Pin, PinOff, Plus, Share2, Tag, Tags, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { clip, clipAssetUrl, type ClipItem } from "@/lib/clip";
import { relativeTime } from "@/lib/format";
import { firstHttpUrl, LinkPreview } from "@/lib/linkPreview";
import { shareClip } from "@/lib/clipShare";
import { ClipBody } from "@/features/clipboard/ClipBody";
import { contentOf, type Row } from "./model";

/** Rendering a whole 20 MB note would stall the page. Copy always gets all of it. */
const MAX_SHOWN = 256 * 1024;
const COLLAPSED_LINES = 5;

export interface NoteActions {
  copy: (item: ClipItem) => Promise<boolean>;
  remove: (item: ClipItem) => void;
  togglePin: (item: ClipItem) => void;
  edit: (item: ClipItem) => void;
  setTags: (item: ClipItem, tags: string[]) => void;
  select: (id: string) => void;
  /** Rows are about to change places on purpose: let them glide. */
  reflow: () => void;
}

/** A note that just landed gets a sweep of light. */
const FRESH_MS = 4000;

function TagPicker({ current, known, onChange, onClose }: { current: string[]; known: string[]; onChange: (tags: string[]) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const all = Array.from(new Set([...known, ...current])).filter(Boolean);
  const has = (tag: string) => current.some((t) => t.toLowerCase() === tag.toLowerCase());
  const toggle = (tag: string) => onChange(has(tag) ? current.filter((t) => t.toLowerCase() !== tag.toLowerCase()) : [...current, tag]);
  const add = () => {
    const tag = name.trim();
    if (tag && !has(tag)) onChange([...current, tag]);
    setName("");
  };
  return (
    <div className="np-tags">
      {all.map((tag) => (
        <button key={tag} type="button" onClick={() => toggle(tag)} className="np-tag" data-on={has(tag)}>
          <Tag /> {tag} {has(tag) && <Check />}
        </button>
      ))}
      <form
        className="np-tag-new"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New tag" aria-label="New tag" />
        <button type="submit" disabled={!name.trim()} aria-label="Add tag">
          <Plus />
        </button>
      </form>
      <button type="button" className="np-tag-done" onClick={onClose}>
        Done
      </button>
    </div>
  );
}

function Act({ label, onClick, active, children }: { label: string; onClick: (e: MouseEvent<HTMLButtonElement>) => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" className="np-act" data-active={active || undefined} title={label} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

export const NoteCard = memo(function NoteCard({ item, selected, knownTags, actions }: { item: ClipItem; selected: boolean; knownTags: string[]; actions: NoteActions }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const [imageCanGrow, setImageCanGrow] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [ripple, setRipple] = useState<{ x: number; y: number; n: number } | null>(null);
  const [fresh, setFresh] = useState(() => Date.now() - Date.parse(item.createdUtc) < FRESH_MS);
  const body = useRef<HTMLElement>(null);
  const card = useRef<HTMLDivElement>(null);

  const isImage = item.kind === "image";
  const content = contentOf(item);
  const preview = item.text ?? "";
  const shown = expanded && full !== null ? full : preview;
  const whole = item.textLen ?? preview.length;
  const shortened = shown.length < whole;
  const link = !isImage && (content.kind === "link" || content.kind === "text") ? firstHttpUrl(preview) : null;
  // A note that's only a link reads better as its card than as a URL and its card.
  const onlyLink = content.kind === "link" && !!link;

  useLayoutEffect(() => {
    const el = body.current;
    if (isImage || !el) return;
    const measure = () => setClamped(el.scrollHeight - el.clientHeight > 2);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [item.text, isImage, expanded]);

  const leave = () => {
    const el = card.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      actions.remove(item);
      return;
    }
    el.style.pointerEvents = "none";
    const out = el.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateX(28px) scale(.97)" },
      ],
      { duration: 170, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" },
    );
    void out.finished.then(() => actions.remove(item)).catch(() => actions.remove(item));
  };

  const toggleExpanded = async () => {
    const opening = !expanded;
    actions.reflow();
    if (opening && !isImage && whole > preview.length && full === null) {
      const text = await clip.text(item.id).catch(() => null);
      if (text !== null) setFull(text.slice(0, MAX_SHOWN));
    }
    setExpanded(opening);
  };

  const doCopy = async (e?: { clientX: number; clientY: number }) => {
    const box = card.current?.getBoundingClientRect();
    if (e && box) setRipple({ x: e.clientX - box.left, y: e.clientY - box.top, n: Date.now() });
    if (await actions.copy(item)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  };

  const [imageFailed, setImageFailed] = useState(false);
  const thumb = imageFailed ? undefined : clipAssetUrl(item.thumbPath ?? item.imagePath);
  const fullImage = clipAssetUrl(item.imagePath ?? item.thumbPath);
  const canExpand = isImage ? imageCanGrow || expanded : clamped || expanded;

  return (
    <div
      ref={card}
      className="np-card"
      data-kind={isImage ? "image" : content.kind}
      data-selected={selected || undefined}
      data-pinned={item.pinned || undefined}
      data-copied={copied || undefined}
      data-expanded={expanded || undefined}
      data-fresh={fresh || undefined}
      onAnimationEnd={(e) => {
        if (e.animationName === "np-fresh") setFresh(false);
      }}
      onPointerDown={() => actions.select(item.id)}
    >
      {ripple && <span key={ripple.n} className="np-ripple" style={{ left: ripple.x, top: ripple.y }} onAnimationEnd={() => setRipple(null)} />}
      <div className="np-body">
        {isImage ? (
          thumb ? (
            <img
              src={(expanded ? fullImage : thumb) ?? undefined}
              alt=""
              draggable={false}
              className="np-image"
              data-expanded={expanded || undefined}
              onError={() => setImageFailed(true)}
              onLoad={(e) => {
                const img = e.currentTarget;
                setImageCanGrow(img.naturalHeight > 136 || img.naturalWidth > img.clientWidth);
              }}
            />
          ) : (
            <p className="np-missing">This image isn't on this PC yet.</p>
          )
        ) : (
          <>
            {!onlyLink && <ClipBody ref={body} text={shown || "(empty)"} content={content} expanded={expanded} collapsedLines={COLLAPSED_LINES} />}
            {shortened && expanded && <p className="np-note">Showing the start of this note. Copy gets all of it.</p>}
            {link && <LinkPreview url={link} compact />}
          </>
        )}
      </div>
      <div className="np-foot">
        {canExpand && (
          <button type="button" className="np-more" data-open={expanded || undefined} onClick={() => void toggleExpanded()}>
            <ChevronDown />
            {expanded ? "Less" : isImage ? "View" : "More"}
          </button>
        )}
        <span className="np-meta">
          {content.label && <span className="np-meta-kind">{content.label}</span>}
          {(item.tags ?? []).slice(0, 2).map((tag) => (
            <span key={tag} className="np-meta-tag">
              {tag}
            </span>
          ))}
          {item.deviceName && <span className="np-meta-device">{item.deviceName}</span>}
          <span>{relativeTime(item.createdUtc)}</span>
          {isImage && item.size > 0 && <span>{Math.round(item.size / 1024)} KB</span>}
        </span>
        <span className="np-acts">
          <Act label={copied ? "Copied" : "Copy"} onClick={(e) => void doCopy(e)} active={copied}>
            {copied ? <Check /> : <Copy />}
          </Act>
          {!isImage && (
            <Act label="Edit" onClick={() => actions.edit(item)}>
              <Pencil />
            </Act>
          )}
          <Act label="Tags" onClick={() => setTagsOpen((v) => !v)} active={tagsOpen}>
            <Tags />
          </Act>
          <Act label="Share" onClick={() => void shareClip(item, () => void doCopy())}>
            <Share2 />
          </Act>
          <Act label={item.pinned ? "Unpin" : "Pin"} onClick={() => actions.togglePin(item)} active={item.pinned}>
            {item.pinned ? <PinOff /> : <Pin />}
          </Act>
          <Act label="Delete" onClick={leave}>
            <Trash2 />
          </Act>
        </span>
      </div>
      {tagsOpen && <TagPicker current={item.tags ?? []} known={knownTags} onChange={(tags) => actions.setTags(item, tags)} onClose={() => setTagsOpen(false)} />}
    </div>
  );
});

export function NoteList({
  rows,
  selected,
  knownTags,
  actions,
  hasMore,
  loading,
  onLoadMore,
  scrollTo,
}: {
  rows: Row[];
  selected: string | null;
  knownTags: string[];
  actions: NoteActions;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  /** Bumped with an id to bring that note into view. */
  scrollTo: { id: string; n: number } | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const list = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (rows[i]?.kind === "label" ? 32 : 98),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 6,
  });
  const items = list.getVirtualItems();
  const last = items[items.length - 1]?.index ?? 0;

  useEffect(() => {
    if (hasMore && !loading && last >= rows.length - 8) onLoadMore();
  }, [hasMore, loading, last, rows.length, onLoadMore]);

  const index = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  useEffect(() => {
    if (!scrollTo) return;
    const at = index.get(scrollTo.id);
    if (at !== undefined) list.scrollToIndex(at, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTo]);

  // The light that follows the pointer across a card. One handler for the whole
  // list, and it only writes two variables on the card under the pointer.
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".np-card");
    if (!card) return;
    const box = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${e.clientX - box.left}px`);
    card.style.setProperty("--my", `${e.clientY - box.top}px`);
  };

  return (
    <div ref={scroller} className="np-scroll" onPointerMove={onPointerMove}>
      <div ref={track} className="np-track" style={{ height: list.getTotalSize() }}>
        {items.map((v) => {
          const row = rows[v.index];
          if (!row) return null;
          return (
            <div key={v.key} ref={list.measureElement} data-index={v.index} className="np-slot" style={{ transform: `translateY(${v.start}px)` }}>
              {row.kind === "label" ? (
                <div className={cn("np-label", row.key === "label:pinned" && "np-label-pinned")}>{row.text}</div>
              ) : (
                <NoteCard item={row.item} selected={selected === row.key} knownTags={knownTags} actions={actions} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function EmptyNotes({ searching }: { searching: boolean }) {
  return (
    <div className="np-empty">
      <span className="np-empty-orb" />
      <strong>{searching ? "Nothing matches that" : "Nothing here yet"}</strong>
      <span>{searching ? "Try fewer words, or clear the filters." : "Copy something, or write a note below. It reaches all your devices."}</span>
    </div>
  );
}
