// Shrinks images to what the clipboard relay accepts, for the desktop sync engine
// and the phone's Notes client alike.

/** The relay's own cap on an image's encrypted blob (signaling/src/clip.rs MAX_BLOB). */
export const MAX_BLOB = 10 * 1024 * 1024;
/** What relays before 3.9.130 actually accepted: axum's default 2 MB body limit
 *  was never raised on the blob route, so every larger image was refused (the
 *  largest blob the live relay had ever stored was 2,086,434 bytes). */
export const LEGACY_BLOB = 2 * 1024 * 1024;
/** AES-GCM adds a 12-byte IV and a 16-byte tag; keep a margin. */
const CIPHER_OVERHEAD = 64;

/** The image as is when its blob fits `limit`, else re-encoded as WebP, smaller
 *  each try, until it does. The sender keeps its original either way. Null when
 *  it can't be made to fit, or this WebView can't re-encode. */
export async function fitImage(
  raw: Uint8Array,
  mime: string | null,
  limit = MAX_BLOB,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (raw.length + CIPHER_OVERHEAD <= limit) return { bytes: raw, mime: mime ?? "image/png" };
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([raw as BlobPart], { type: mime ?? "image/png" }));
  } catch {
    return null; // not an image this WebView can decode
  }
  try {
    let scale = 1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, w, h);
      const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
      if (blob.size + CIPHER_OVERHEAD <= limit) {
        return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/webp" };
      }
      scale *= 0.7;
    }
    return null;
  } finally {
    bitmap.close();
  }
}
