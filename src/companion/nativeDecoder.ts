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
  /** Diagnostic — the bridge's reason for the probe result (e.g. "picked=c2.qti.avc.decoder"). */
  detail: string;
};

export type DecoderStats = {
  decodeMs: number;
  queue: number;
  frames: number;
  active: boolean;
  width: number;
  height: number;
  error: string;
  /** SurfaceView has a live Surface. Without it the codec cannot start at all,
   *  which looks identical to a fault (`active: false`) but has a different cause. */
  surfaceReady?: boolean;
  /** Still waiting for IDR/CSD — JS feed counts are mostly no-ops. */
  awaitKey?: boolean;
  /** SPS/PPS accepted as CODEC_CONFIG this session. */
  csdQueued?: boolean;
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
    return { available: false, name: "", lowLatency: false, detail: "not Tauri/companion" };
  }
  if (probeCache) return probeCache;
  try {
    probeCache = await invoke<DecoderProbe>("decoder_probe");
  } catch (e) {
    console.warn("[nativeDecoder] probe failed:", e);
    // Keep the whole error (the Rust side now attaches the Java throwable's
    // toString + stack) — the toast clamps visually and offers copy-to-clipboard,
    // so truncating here would only destroy the part that makes it debuggable.
    probeCache = {
      available: false,
      name: "",
      lowLatency: false,
      detail: `probe threw: ${String(e).slice(0, 2000)}`,
    };
  }
  return probeCache;
}

/** Returns null on success, or the full error string on failure. */
export async function initNativeDecoder(width: number, height: number): Promise<string | null> {
  if (!nativeDecoderPossible()) return "not Tauri/companion";
  try {
    await invoke("decoder_init", { width, height });
    return null;
  } catch (e) {
    console.warn("[nativeDecoder] init failed:", e);
    return String(e).slice(0, 2000);
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

/**
 * Full native-side diagnostics blob: device identity, H.264 decoder inventory
 * with capabilities, live codec/surface state, the view hierarchy above the
 * SurfaceView's hole punch, and the bridge's lifecycle journal. Everything a
 * black-screen bug report needs in one paste. Empty string off-Android or on
 * failure (never throws — this runs inside error paths).
 */
export async function dumpNativeDecoderDiag(): Promise<string> {
  if (!nativeDecoderPossible()) return "";
  try {
    return await invoke<string>("decoder_dump_diag");
  } catch (e) {
    return `decoder_dump_diag failed: ${String(e).slice(0, 500)}`;
  }
}

/**
 * Hold/release the Android Wi-Fi low-latency lock (+ keep-screen-on) for the
 * duration of a remote session. Wi-Fi power save batches inbound packets when
 * the radio thinks the app is idle — that's the periodic 100–700 ms frame-gap
 * pattern in the hitch log on budget phones. Applies to BOTH decode paths
 * (the radio doesn't care who decodes); no-op outside the Tauri companion.
 * Best-effort: a failed lock must never take the session down.
 */
export async function setStreamPowerActive(active: boolean): Promise<void> {
  if (!nativeDecoderPossible()) return;
  try {
    await invoke("stream_active", { active });
  } catch {
    /* best effort */
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
