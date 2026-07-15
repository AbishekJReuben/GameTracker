/**
 * Native MediaCodec decode bridge (Android APK companion only).
 *
 * Lifecycle / bounds / stats: Tauri `invoke` → Rust JNI → `WcDecoderBridge`.
 * Hot path: `window.__GT_DECODER__.feed(tsUs, key, b64)` (JavascriptInterface)
 * so Annex-B frames never cross the Tauri IPC boundary.
 *
 * Browsers (discovery web / Quest) cannot expose MediaCodec — they stay on
 * WebCodecs. This module probes false there and is a no-op.
 */

import { isTauri } from "@/lib/tauri";

export type DecoderProbe = {
  available: boolean;
  name: string;
  lowLatency: boolean;
};

export type DecoderStats = {
  decodeMs: number;
  queue: number;
  frames: number;
  active: boolean;
  width: number;
  height: number;
  error: string;
};

type GtDecoderJs = {
  feed: (tsUs: number, key: boolean, b64: string) => void;
};

declare global {
  interface Window {
    __GT_DECODER__?: GtDecoderJs;
  }
}

function isCompanion(): boolean {
  return Boolean((window as unknown as { __GT_COMPANION__?: boolean }).__GT_COMPANION__);
}

/** True only inside the Tauri Android companion shell. */
export function nativeDecoderPossible(): boolean {
  return isTauri() && isCompanion();
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv<T>(cmd, args);
}

let probeCache: DecoderProbe | null = null;

/** Probe once per page load — MediaCodec availability doesn't change. */
export async function probeNativeDecoder(): Promise<DecoderProbe> {
  if (!nativeDecoderPossible()) {
    return { available: false, name: "", lowLatency: false };
  }
  if (probeCache) return probeCache;
  try {
    probeCache = await invoke<DecoderProbe>("decoder_probe");
  } catch (e) {
    console.warn("[nativeDecoder] probe failed:", e);
    probeCache = { available: false, name: "", lowLatency: false };
  }
  return probeCache;
}

export async function initNativeDecoder(width: number, height: number): Promise<boolean> {
  if (!nativeDecoderPossible()) return false;
  try {
    await invoke("decoder_init", { width, height });
    return true;
  } catch (e) {
    console.warn("[nativeDecoder] init failed:", e);
    return false;
  }
}

export async function setNativeDecoderBounds(opts: {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}): Promise<void> {
  if (!nativeDecoderPossible()) return;
  try {
    await invoke("decoder_set_bounds", opts);
  } catch {
    /* surface not ready yet */
  }
}

export async function resetNativeDecoder(): Promise<void> {
  if (!nativeDecoderPossible()) return;
  try {
    await invoke("decoder_reset");
  } catch {
    /* ignore */
  }
}

export async function teardownNativeDecoder(): Promise<void> {
  if (!nativeDecoderPossible()) return;
  try {
    await invoke("decoder_teardown");
  } catch {
    /* ignore */
  }
}

export async function getNativeDecoderStats(): Promise<DecoderStats | null> {
  if (!nativeDecoderPossible()) return null;
  try {
    return await invoke<DecoderStats>("decoder_get_stats");
  } catch {
    return null;
  }
}

/** True when the JavascriptInterface is installed (MainActivity attached). */
export function nativeFeedReady(): boolean {
  return typeof window.__GT_DECODER__?.feed === "function";
}

/**
 * Feed one Annex-B access unit to MediaCodec. Returns false if the bridge isn't
 * ready (caller should fall back to WebCodecs or wait for a keyframe).
 */
export function feedNativeDecoder(tsUs: number, key: boolean, bytes: Uint8Array): boolean {
  const api = window.__GT_DECODER__;
  if (!api?.feed) return false;
  try {
    api.feed(tsUs, key, u8ToBase64(bytes));
    return true;
  } catch (e) {
    console.warn("[nativeDecoder] feed failed:", e);
    return false;
  }
}

/** Chunked base64 — avoids call-stack limits on large AUs. */
function u8ToBase64(u8: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}
