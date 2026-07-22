import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, Globe2 } from "lucide-react";
import { openExternalUrl as openWithDesktop } from "@/lib/tauri";

export type LinkPreviewData = { url: string; host: string; title: string; description?: string | null; imageUrl?: string | null; faviconUrl?: string | null; source: "openGraph" | "twitterCard" | "favicon" };

export function firstHttpUrl(text?: string | null): string | null {
  const raw = text?.match(/https?:\/\/[^\s<>()]+/i)?.[0];
  if (!raw) return null;
  try { return new URL(raw).toString(); } catch { return null; }
}

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

/** Native metadata avoids WebView CORS: Open Graph image, Twitter Card image, favicon. */
export function LinkPreview({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreviewData | null>(null);
  useEffect(() => {
    let live = true;
    void invoke<LinkPreviewData>("link_preview", { url }).then((data) => live && setPreview(data)).catch(() => live && setPreview(fallbackPreview(url)));
    return () => { live = false; };
  }, [url]);
  const data = preview ?? fallbackPreview(url);
  return <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => void openExternalUrl(data.url)} className="mt-2 flex w-full select-text overflow-hidden rounded-xl border border-cyan-300/15 bg-cyan-300/[0.06] text-left transition-colors hover:border-cyan-200/35 hover:bg-cyan-300/[0.1]" title={`Open ${data.host}`}>
    {data.imageUrl ? <img src={data.imageUrl} alt="" loading="lazy" className="h-20 w-28 shrink-0 object-cover" /> : data.faviconUrl ? <span className="grid h-20 w-16 shrink-0 place-items-center bg-cyan-300/[0.08]"><img src={data.faviconUrl} alt="" className="h-7 w-7 rounded" /></span> : <span className="grid h-20 w-16 shrink-0 place-items-center bg-cyan-300/[0.08] text-cyan-200"><Globe2 className="h-5 w-5" /></span>}
    <span className="min-w-0 flex-1 px-2.5 py-2"><span className="block truncate text-[11px] font-700 text-ink">{data.title}</span>{data.description && <span className="mt-0.5 line-clamp-2 block text-[10px] leading-relaxed text-ink-dim">{data.description}</span>}<span className="mt-1 block truncate text-[10px] text-cyan-200/75">{data.host}</span></span><ExternalLink className="m-2 h-3.5 w-3.5 shrink-0 text-cyan-200/70" />
  </button>;
}

function fallbackPreview(url: string): LinkPreviewData {
  const parsed = new URL(url); const host = parsed.hostname.replace(/^www\./, "");
  return { url, host, title: host, description: parsed.pathname === "/" ? null : decodeURIComponent(parsed.pathname).replace(/^\//, ""), faviconUrl: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname)}&sz=128`, source: "favicon" };
}
