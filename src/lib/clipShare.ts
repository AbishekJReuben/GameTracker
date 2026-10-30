import { clip, clipAssetUrl, type ClipItem } from "@/lib/clip";

/** Best-effort native share; falls back to the caller's copy. */
export async function shareClip(item: ClipItem, fallbackCopy: () => void) {
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  try {
    if (item.kind === "text" && item.text && nav.share) {
      // Desktop lists carry a preview; the companion's items are already whole.
      const whole = (item.textLen ?? 0) > item.text.length ? await clip.text(item.id).catch(() => null) : null;
      await nav.share({ text: whole ?? item.text });
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
