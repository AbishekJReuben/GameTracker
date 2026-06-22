import { useEffect, useId, useRef, useState } from "react";
import { ExternalLink, ChevronDown, ChevronUp } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "@/lib/api";
import { isTauri } from "@/lib/tauri";

type Props = {
  title: string;
  url: string;
  height?: number;
};

/** Logical bounds of the host placeholder relative to the main window viewport. */
function hostBounds(host: HTMLElement) {
  const rect = host.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    w: rect.width,
    h: rect.height,
    visible: rect.bottom > 8 && rect.top < window.innerHeight - 8 && rect.width > 4 && rect.height > 4,
  };
}

export function EmbeddedPanel({ title, url, height = 640 }: Props) {
  const id = useId().replace(/:/g, "");
  const label = `embed-${id}`;
  const hostRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const [open, setOpen] = useState(true);
  const tauri = isTauri();

  useEffect(() => {
    if (!tauri || !open || !url) return;
    const host = hostRef.current;
    if (!host) return;

    let alive = true;
    let opened = false;

    const sync = async () => {
      if (!alive || !hostRef.current) return;
      const { x, y, w, h, visible } = hostBounds(hostRef.current);
      if (!visible) {
        if (opened) await api.setEmbedVisible(label, false);
        return;
      }
      if (!opened) {
        await api.openEmbed(label, url, x, y, w, h);
        opened = true;
        openRef.current = true;
      } else {
        await api.setEmbedVisible(label, true);
        await api.setEmbedBounds(label, x, y, w, h);
      }
    };

    const onScrollOrResize = () => {
      requestAnimationFrame(() => {
        void sync();
      });
    };

    const scrollRoot = host.closest("[data-page-scroll]") as HTMLElement | null;
    scrollRoot?.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);

    let unlistenMove: (() => void) | undefined;
    void getCurrentWindow()
      .onMoved(onScrollOrResize)
      .then((fn) => {
        unlistenMove = fn;
      })
      .catch(() => {});

    const ro = new ResizeObserver(onScrollOrResize);
    ro.observe(host);

    // Initial layout may settle after paint — sync twice.
    requestAnimationFrame(() => {
      void sync();
      requestAnimationFrame(() => void sync());
    });

    return () => {
      alive = false;
      scrollRoot?.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
      unlistenMove?.();
      ro.disconnect();
      if (openRef.current) void api.closeEmbed(label);
      openRef.current = false;
    };
  }, [tauri, open, url, label]);

  useEffect(() => {
    if (!tauri || open) return;
    void api.closeEmbed(label);
    openRef.current = false;
  }, [tauri, open, label]);

  if (!url) return null;

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 border-b border-line px-4 py-3 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="font-display text-sm font-800">{title}</span>
        <span className="flex items-center gap-2 text-ink-dim">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost h-8 px-2"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open
          </a>
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </span>
      </button>
      {open && (
        <div ref={hostRef} style={{ height }} className="relative bg-bg-850">
          {!tauri && (
            <div className="grid h-full place-items-center p-6 text-center text-sm text-ink-dim">
              Embedded site panel is available in the desktop app.
              <a href={url} target="_blank" rel="noreferrer" className="mt-2 accent-text underline">
                Open in browser
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
