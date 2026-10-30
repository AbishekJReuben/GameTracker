import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle, AlignLeft, Braces, Code2, FolderTree, Hash, Link2, NotebookPen, Search, Tag, TerminalSquare, X, type LucideIcon } from "lucide-react";
import { clip, type ClipItem } from "@/lib/clip";
import type { ClipContentKind } from "@/lib/clipContent";
import { useClipboard, visibleClips, type ClipFilter } from "@/store/clipboard";
import { Composer, type ComposerEdit } from "@/features/clipboard/Composer";
import { EmptyNotes, NoteList, type NoteActions } from "./NoteList";
import { buildRows, contentOf, statusOf, stepSelection, type Tone } from "./model";

interface PanelConfig {
  sttEnabled: boolean;
  draft: string;
  hotkey: string;
}

interface Toast {
  text: string;
  undo?: () => void;
  n: number;
}

type ResizeDirection = "East" | "West" | "South" | "North" | "SouthEast" | "SouthWest" | "NorthEast" | "NorthWest";

const UNDO_MS = 5000;
const TOAST_MS = 2600;
const STATUS_EVERY_MS = 3000;

const FILTERS: { value: ClipFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "text", label: "Text" },
  { value: "image", label: "Images" },
];

const TYPES: { kind: ClipContentKind; label: string; Icon: LucideIcon }[] = [
  { kind: "link", label: "Links", Icon: Link2 },
  { kind: "code", label: "Code", Icon: Code2 },
  { kind: "json", label: "JSON", Icon: Braces },
  { kind: "log", label: "Logs", Icon: AlertTriangle },
  { kind: "command", label: "Commands", Icon: TerminalSquare },
  { kind: "path", label: "Paths", Icon: FolderTree },
  { kind: "text", label: "Notes", Icon: AlignLeft },
];

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="np np-failed">
        <strong>Notes hit a problem</strong>
        <span>Your notes are safe. Reloading usually fixes it.</span>
        <button type="button" className="np-toast-action" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

/** The active-filter pill that slides between the three choices. */
function Segments({ value, onPick }: { value: ClipFilter; onPick: (f: ClipFilter) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const on = box.current?.querySelector<HTMLElement>("[data-on='true']");
    if (on) setThumb({ x: on.offsetLeft, w: on.offsetWidth });
  }, [value]);
  return (
    <div ref={box} className="np-seg" role="group" aria-label="Filter by kind">
      {thumb && <span className="np-seg-thumb" style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }} />}
      {FILTERS.map((f) => (
        <button key={f.value} type="button" data-on={value === f.value} aria-pressed={value === f.value} onClick={() => onPick(f.value)}>
          {f.label}
        </button>
      ))}
    </div>
  );
}

function ResizeGrips() {
  const start = (direction: ResizeDirection) => (e: React.PointerEvent) => {
    if (e.button === 0) void getCurrentWindow().startResizeDragging(direction as never);
  };
  const grips: [ResizeDirection, string][] = [
    ["North", "n"],
    ["South", "s"],
    ["West", "w"],
    ["East", "e"],
    ["NorthWest", "nw"],
    ["NorthEast", "ne"],
    ["SouthWest", "sw"],
    ["SouthEast", "se"],
  ];
  return (
    <>
      {grips.map(([direction, name]) => (
        <span key={name} className={`np-grip np-grip-${name}`} onPointerDown={start(direction)} />
      ))}
    </>
  );
}

function Panel() {
  const s = useClipboard();
  const [config, setConfig] = useState<PanelConfig | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: Tone }>(() => statusOf(null));
  const [selected, setSelected] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<{ id: string; n: number } | null>(null);
  const [editing, setEditing] = useState<ComposerEdit | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [tagsOpen, setTagsOpen] = useState(false);
  const pending = useRef(new Map<string, number>());
  const searchBox = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const reflowTimer = useRef<number | undefined>(undefined);
  const ready = useRef(false);

  // Rows glide only when they move on purpose. While scrolling they must not:
  // measuring a row would make everything under it swim.
  const reflow = useCallback(() => {
    const track = root.current?.querySelector<HTMLElement>(".np-track");
    if (!track) return;
    track.dataset.reflow = "true";
    window.clearTimeout(reflowTimer.current);
    reflowTimer.current = window.setTimeout(() => delete track.dataset.reflow, 420);
  }, []);

  const say = useCallback((text: string, undo?: () => void) => {
    window.clearTimeout(toastTimer.current);
    setToast({ text, undo, n: Date.now() });
    toastTimer.current = window.setTimeout(() => setToast(null), undo ? UNDO_MS : TOAST_MS);
  }, []);

  const commitDelete = useCallback((id: string) => {
    const timer = pending.current.get(id);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    pending.current.delete(id);
    void useClipboard.getState().remove(id).finally(() =>
      setGone((old) => {
        const next = new Set(old);
        next.delete(id);
        return next;
      }),
    );
  }, []);

  const flushDeletes = useCallback(() => {
    for (const id of [...pending.current.keys()]) commitDelete(id);
  }, [commitDelete]);

  const close = useCallback(() => {
    void invoke("notes_panel_close");
  }, []);

  // Rows settle into place as the shape fades off them. They stay visible throughout:
  // a page that was hidden takes a moment to draw, and fading them in as well left
  // the panel empty for that moment.
  const riseIn = useCallback(() => {
    const page = root.current;
    if (!page) return;
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      page.querySelectorAll<HTMLElement>(".np-card, .np-label").forEach((el, i) => {
        el.animate([{ transform: "translateY(9px)" }, { transform: "none" }], {
          duration: 380,
          delay: Math.min(i, 9) * 16,
          easing: "cubic-bezier(.16,1,.3,1)",
          fill: "backwards",
        });
      });
    }
    // Two frames: the first runs before this one's paint, the second after it.
    requestAnimationFrame(() => requestAnimationFrame(() => void invoke("notes_panel_painted")));
  }, []);

  useEffect(() => {
    const store = useClipboard.getState();
    const announce = () => {
      if (ready.current) return;
      ready.current = true;
      void invoke("notes_panel_ready");
    };
    void store.load().finally(() => window.setTimeout(announce, 0));
    // A failed or slow load must not hold the panel closed.
    const deadline = window.setTimeout(announce, 1500);
    void invoke<PanelConfig>("notes_panel_config").then(setConfig).catch(() => setConfig({ sttEnabled: false, draft: "", hotkey: "" }));

    const subscriptions = [
      listen("clipboard://changed", () => void useClipboard.getState().sync()),
      listen("notes://reveal", () => {
        void useClipboard.getState().sync();
        searchBox.current?.focus();
        riseIn();
        reflow();
      }),
      listen("notes://close", () => {
        flushDeletes();
        setSelected(null);
      }),
      listen<string | null>("clipboard://copy-wait", (e) => say(e.payload ? `Waiting for ${e.payload}…` : "Waiting for the clipboard…")),
    ];
    const refreshStatus = () => {
      void invoke<Record<string, unknown> | null>("notes_panel_status")
        .then((report) => setStatus(statusOf(report)))
        .catch(() => {});
    };
    refreshStatus();
    const statusTimer = window.setInterval(() => {
      if (!document.hidden) refreshStatus();
    }, STATUS_EVERY_MS);
    return () => {
      window.clearTimeout(deadline);
      window.clearInterval(statusTimer);
      subscriptions.forEach((u) => void u.then((f) => f()));
    };
  }, [flushDeletes, reflow, riseIn, say]);

  useEffect(() => {
    void useClipboard.getState().ensureMatches();
  }, [s.tagFilter, s.typeFilter, s.filter]);

  useEffect(() => {
    const t = window.setTimeout(() => void useClipboard.getState().runSearch(), s.search ? 160 : 0);
    return () => window.clearTimeout(t);
  }, [s.search]);

  const shown = useMemo(() => {
    const { pinned, rest } = visibleClips(s);
    const live = (i: ClipItem) => !gone.has(i.id);
    return buildRows(pinned.filter(live), rest.filter(live));
  }, [s, gone]);

  const noteCount = useMemo(() => shown.reduce((n, r) => n + (r.kind === "note" ? 1 : 0), 0), [shown]);

  const types = useMemo(() => {
    const counts = new Map<ClipContentKind, number>();
    for (const item of [...s.pinned, ...s.items]) {
      if (item.kind !== "text") continue;
      const kind = contentOf(item).kind;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return TYPES.filter((t) => counts.has(t.kind)).map((t) => ({ ...t, count: counts.get(t.kind)! }));
  }, [s.pinned, s.items]);

  const copy = useCallback(
    async (item: ClipItem) => {
      try {
        await clip.copy(item.id);
        return true;
      } catch (e) {
        say(e instanceof Error ? e.message : typeof e === "string" ? e : "Couldn't copy that note.");
        return false;
      }
    },
    [say],
  );

  const remove = useCallback(
    (item: ClipItem) => {
      reflow();
      setGone((old) => new Set(old).add(item.id));
      pending.current.set(item.id, window.setTimeout(() => commitDelete(item.id), UNDO_MS));
      say("Note deleted", () => {
        window.clearTimeout(pending.current.get(item.id));
        pending.current.delete(item.id);
        reflow();
        setGone((old) => {
          const next = new Set(old);
          next.delete(item.id);
          return next;
        });
        setToast(null);
      });
    },
    [commitDelete, reflow, say],
  );

  const actions = useMemo<NoteActions>(
    () => ({
      copy,
      remove,
      togglePin: (item) => {
        reflow();
        void useClipboard.getState().togglePin(item);
      },
      edit: (item) => {
        if (item.kind !== "text") return;
        const short = (item.textLen ?? 0) > (item.text?.length ?? 0);
        void (short ? clip.text(item.id).catch(() => null) : Promise.resolve(item.text ?? "")).then((text) => setEditing({ id: item.id, text: text ?? item.text ?? "" }));
      },
      setTags: (item, tags) => void useClipboard.getState().setTags(item.id, tags),
      select: setSelected,
      reflow,
    }),
    [copy, reflow, remove],
  );

  const selectedItem = (): ClipItem | null => {
    const row = shown.find((r) => r.key === selected);
    return row?.kind === "note" ? row.item : null;
  };

  const move = (by: 1 | -1) => {
    const id = stepSelection(shown, selected, by);
    setSelected(id);
    if (id) setScrollTo({ id, n: Date.now() });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const inComposer = target.tagName === "TEXTAREA";
    const inField = inComposer || (target.tagName === "INPUT" && target !== searchBox.current);
    if (e.key === "Escape") {
      e.preventDefault();
      if (s.search) s.setSearch("");
      else if (selected) setSelected(null);
      else close();
      return;
    }
    if (inField) return;
    const item = selectedItem();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter" && item) {
      e.preventDefault();
      void copy(item);
      close();
    } else if (e.key === "Delete" && item && !s.search) {
      e.preventDefault();
      const next = stepSelection(shown, selected, 1);
      setSelected(next === selected ? stepSelection(shown, selected, -1) : next);
      remove(item);
    } else if (e.key.toLowerCase() === "p" && e.ctrlKey && item) {
      e.preventDefault();
      actions.togglePin(item);
    }
  };

  // The browser's own menu (Back, Refresh, Print…) has nothing to offer here. Fields
  // and selected text keep theirs, for Cut, Copy and Paste.
  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea") || getSelection()?.toString()) return;
    e.preventDefault();
  };

  const searching = !!s.search.trim() || s.filter !== "all" || !!s.tagFilter || !!s.typeFilter;

  return (
    <div ref={root} className="np" onKeyDown={onKeyDown} onContextMenu={onContextMenu}>
      <div className="np-aurora" aria-hidden="true">
        <i />
        <i />
      </div>
      <header className="np-head" data-tauri-drag-region>
        <span className="np-mark">
          <NotebookPen />
        </span>
        <span className="np-title">Notes</span>
        <span className="np-pill" data-tone={status.tone} title="Sync with your other devices">
          <i />
          {status.text}
        </span>
        <button type="button" className="np-close" aria-label="Close notes" title="Close (Esc)" onClick={close}>
          <X />
        </button>
      </header>

      <div className="np-tools">
        <label className="np-search">
          <Search />
          <input ref={searchBox} value={s.search} onChange={(e) => s.setSearch(e.target.value)} placeholder="Search all your notes" aria-label="Search notes" spellCheck={false} />
          {s.search ? (
            <>
              <span className="np-found">{noteCount}</span>
              <button type="button" aria-label="Clear search" onClick={() => s.setSearch("")}>
                <X />
              </button>
            </>
          ) : null}
        </label>
        <div className="np-filters">
          <Segments value={s.filter} onPick={s.setFilter} />
          {types.length > 1 && (
            <div className="np-chips" role="group" aria-label="Filter by type">
              {types.map(({ kind, label, Icon, count }) => (
                <button key={kind} type="button" className="np-chip" data-kind={kind} data-on={s.typeFilter === kind} aria-pressed={s.typeFilter === kind} title={`${count} ${label.toLowerCase()}`} onClick={() => s.setTypeFilter(s.typeFilter === kind ? null : kind)}>
                  <Icon />
                  {label}
                </button>
              ))}
            </div>
          )}
          {s.tags.length > 0 && (
            <button type="button" className="np-tags-toggle" data-on={tagsOpen || !!s.tagFilter} aria-pressed={tagsOpen || !!s.tagFilter} aria-label="Show tags" title="Tags" onClick={() => setTagsOpen((v) => !v)}>
              <Hash />
            </button>
          )}
        </div>
        {s.tags.length > 0 && (tagsOpen || s.tagFilter) && (
          <div className="np-chips np-chips-tags" role="group" aria-label="Filter by tag">
            {s.tags.map((tag) => (
              <button key={tag} type="button" className="np-chip" data-on={s.tagFilter === tag} aria-pressed={s.tagFilter === tag} onClick={() => s.setTagFilter(s.tagFilter === tag ? null : tag)}>
                <Tag />
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {shown.length === 0 && !s.loading ? (
        <EmptyNotes searching={searching} />
      ) : (
        <NoteList rows={shown} selected={selected} knownTags={s.tags} actions={actions} hasMore={s.hasMore} loading={s.loading} onLoadMore={s.loadMore} scrollTo={scrollTo} />
      )}

      <div className="np-dock">
        {toast && (
          <div key={toast.n} className="np-toast" role="status">
            <span>{toast.text}</span>
            {toast.undo && (
              <button type="button" className="np-toast-action" onClick={toast.undo}>
                Undo
              </button>
            )}
          </div>
        )}
        {config && (
          <Composer
            variant="panel"
            compact
            onAddText={(text) => {
              reflow();
              return s.addText(text);
            }}
            onAddImage={(image, mime) => {
              reflow();
              return s.addImage(image, mime);
            }}
            sttEnabled={config.sttEnabled}
            draft={config.draft}
            onDraftChange={(text) => void invoke("notes_panel_set_draft", { text }).catch(() => {})}
            onRecordingChange={(on) => void invoke("notes_panel_recording", { on }).catch(() => {})}
            editing={editing}
            onSaveEdit={(id, text) => void s.editText(id, text)}
            onCancelEdit={() => setEditing(null)}
            placeholder="Write a note…"
          />
        )}
      </div>
      <ResizeGrips />
    </div>
  );
}

export function NotesApp() {
  return (
    <ErrorBoundary>
      <Panel />
    </ErrorBoundary>
  );
}
