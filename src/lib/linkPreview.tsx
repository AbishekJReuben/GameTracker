import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, Globe2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { openExternalUrl as openWithDesktop } from "@/lib/tauri";

export type LinkPreviewData = { url: string; host: string; title: string; description?: string | null; imageUrl?: string | null; faviconUrl?: string | null; source: "openGraph" | "twitterCard" | "favicon" };

// Link detection lives with the rest of the content classification (it also has
// to recognize scheme-less hosts like `amazon.in/dp/…`). Re-exported here so the
// existing import sites keep working.
export { firstHttpUrl } from "@/lib/clipContent";

/** Opens through Tauri on desktop/Android, with a browser fallback for web builds. */
export async function openExternalUrl(url: string) {
  // The overlay is a separate WebView. Calling the plugin from that WebView can
  // be swallowed by its popup policy, so the desktop command opens through the
  // native application handle instead. Normal web builds retain a safe tab
  // fallback for development and the public share page.
  try {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      await invoke("open_external_link", { url });
      return;
    }
    await openWithDesktop(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** Native metadata avoids WebView CORS: Open Graph image, Twitter Card image, favicon.
 *  A page that publishes real artwork gets the full-width hero treatment; one that
 *  only yields a favicon degrades to a compact row rather than a broken image box. */
export function LinkPreview({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreviewData | null>(null);
  const [artFailed, setArtFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setArtFailed(false);
    void invoke<LinkPreviewData>("link_preview", { url }).then((data) => live && setPreview(data)).catch(() => live && setPreview(fallbackPreview(url)));
    return () => { live = false; };
  }, [url]);
  const data = preview ?? fallbackPreview(url);
  const hero = !artFailed && !!data.imageUrl && data.source !== "favicon";
  return <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => void openExternalUrl(data.url)} className={cn("mt-2 w-full select-text overflow-hidden rounded-xl border border-cyan-300/15 bg-cyan-300/[0.06] text-left transition-colors hover:border-cyan-200/35 hover:bg-cyan-300/[0.1]", hero ? "block" : "flex")} title={`Open ${data.host}`}>
    {hero ? (
      <img
        src={data.imageUrl!}
        alt=""
        loading="lazy"
        // A dead og:image (hot-link blocked, moved) must not leave a grey slab —
        // failing back to the compact layout keeps the card honest.
        onError={() => setArtFailed(true)}
        className="aspect-video w-full object-cover"
      />
    ) : data.faviconUrl ? (
      <span className="grid h-16 w-16 shrink-0 place-items-center bg-cyan-300/[0.08]"><img src={data.faviconUrl} alt="" className="h-7 w-7 rounded" /></span>
    ) : (
      <span className="grid h-16 w-16 shrink-0 place-items-center bg-cyan-300/[0.08] text-cyan-200"><Globe2 className="h-5 w-5" /></span>
    )}
    <span className="flex min-w-0 flex-1 items-start gap-1 px-2.5 py-2">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-[10px] font-700 text-cyan-200/90">
          {hero && data.faviconUrl && <img src={data.faviconUrl} alt="" className="h-3 w-3 shrink-0 rounded-[3px]" />}
          <span className="truncate">{data.host}</span>
        </span>
        <span className="mt-0.5 line-clamp-2 block text-[11.5px] font-700 leading-snug text-ink">{data.title}</span>
        {data.description && <span className="mt-0.5 line-clamp-2 block text-[10px] leading-relaxed text-ink-dim">{data.description}</span>}
      </span>
      <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-200/70" />
    </span>
  </button>;
}

function fallbackPreview(url: string): LinkPreviewData {
  const parsed = new URL(url); const host = parsed.hostname.replace(/^www\./, "");
  return { url, host, title: host, description: parsed.pathname === "/" ? null : decodeURIComponent(parsed.pathname).replace(/^\//, ""), faviconUrl: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname)}&sz=128`, source: "favicon" };
}
