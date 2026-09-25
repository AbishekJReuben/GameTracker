import type { SyntheticEvent } from "react";

// Steam serves each store screenshot at several sizes. We store the 1920×1080 original
// (~0.8 MB, ~8 MB decoded), which is right for the lightbox and hero art but wasteful
// for marquee tiles and gallery thumbnails a few hundred pixels wide.
const STEAM_FULL = /\.1920x1080\.jpg(?=\?|$)/i;
const STEAM_THUMB = /\.600x338\.jpg(?=\?|$)/i;

/** The 600×338 rendition of a Steam screenshot (~100 KB); any other URL unchanged. */
export function screenshotThumb(url: string): string {
  return url.replace(STEAM_FULL, ".600x338.jpg");
}

/** `onError` for an <img> showing screenshotThumb(): fall back to the original, once. */
export function thumbFallback(event: SyntheticEvent<HTMLImageElement>) {
  const img = event.currentTarget;
  const full = img.src.replace(STEAM_THUMB, ".1920x1080.jpg");
  if (full !== img.src) img.src = full;
}
