/**
 * Native MediaCodec decode bridge (Android APK companion only).
 *
 * Lifecycle / bounds / stats: Tauri `invoke` → Rust JNI → `WcDecoderBridge`.
 * Hot path: ArrayBuffer WebMessage on current WebViews; JavascriptInterface
 * Base64 as compatibility fallback. Annex-B never crosses Tauri's JSON IPC.
 *
 * Browsers (discovery web / Quest) cannot expose MediaCodec — they stay on
 * WebCodecs. This module probes false there and is a no-op.
 */

import { isTauri } from "@/lib/tauri";
import { nativeVideoPacket } from "./videoReceive";

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
  disableBinary?: () => void;
  beginFeed?: (session: number) => void;
};

declare global {
  interface Window {
    __GT_DECODER__?: GtDecoderJs;
    __GT_DECODER_BINARY__?: {
      postMessage: (data: ArrayBuffer) => void;
      onmessage: ((event: { data: string }) => void) | null;
    };
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
let lifecycle: Promise<unknown> = Promise.resolve();

/** JNI commands run in independent blocking tasks. Serialize lifecycle only so
 * a slow init cannot reach Java after a later teardown or resolution change. */
function lifecycleInvoke(cmd: string, args?: Record<string, unknown>) {
  const next = lifecycle.then(() => {
    if (cmd === "decoder_init" || cmd === "decoder_teardown") {
      nativeFeedSession = (nativeFeedSession + 1) >>> 0;
      binaryPendingKeys.length = 0;
      binaryInFlight = 0;
      binaryNeedsKey = true;
      window.__GT_DECODER__?.beginFeed?.(nativeFeedSession);
    }
    return invoke(cmd, args);
  });
  lifecycle = next.catch(() => {});
  return next;
}

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
    await lifecycleInvoke("decoder_init", { width, height });
    return null;
  } catch (e) {
    console.warn("[nativeDecoder] init failed:", e);
    return String(e).slice(0, 2000);
  }
}

/**
 * Monotonic bounds sequence. Each `decoder_set_bounds` is its own
 * `spawn_blocking` task on the Rust side, so a burst of updates (one per
 * animation frame during pinch-zoom) can reach the Android UI thread out of
 * order — the bridge uses this counter to drop stale rects instead of letting
 * an old one land last (video frozen on stale geometry → cursor offset that
 * grows with zoom, and the squeezed pre-first-frame full-viewport rect).
 */
let boundsSeq = 0;

export async function setNativeDecoderBounds(opts: {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}): Promise<void> {
  if (!nativeDecoderPossible()) return;
  boundsSeq += 1;
  try {
    await invoke("decoder_set_bounds", { ...opts, seq: boundsSeq });
  } catch {
    /* surface not ready yet */
  }
}

export async function resetNativeDecoder(): Promise<void> {
  if (!nativeDecoderPossible()) return;
  try {
    await lifecycleInvoke("decoder_reset");
  } catch {
    /* ignore */
  }
}

export async function teardownNativeDecoder(): Promise<void> {
  if (!nativeDecoderPossible()) return;
  try {
    await lifecycleInvoke("decoder_teardown");
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
  return typeof window.__GT_DECODER_BINARY__?.postMessage === "function" ||
    typeof window.__GT_DECODER__?.feed === "function";
}

let binaryBridge: Window["__GT_DECODER_BINARY__"];
let binaryInFlight = 0;
let binaryBroken = false;
let binaryNeedsKey = false;
let binaryProgressAt = 0;
const binaryPendingKeys: boolean[] = [];
let nativeFeedSession = 0;

function abandonBinary() {
  binaryBroken = true;
  try { window.__GT_DECODER__?.disableBinary?.(); } catch { /* compatibility */ }
}

/**
 * Feed one Annex-B access unit to MediaCodec. Returns false if the bridge isn't
 * ready (caller should fall back to WebCodecs or wait for a keyframe).
 */
export function feedNativeDecoder(tsUs: number, key: boolean, bytes: Uint8Array): boolean {
  const binary = window.__GT_DECODER_BINARY__;
  if (binary && !binaryBroken) {
    if (binaryBridge !== binary) {
      binaryBridge = binary;
      binaryInFlight = 0;
      binaryPendingKeys.length = 0;
      binary.onmessage = (event) => {
        if (binaryBroken) return;
        const [session, status] = event.data.split(":");
        if (Number(session) !== nativeFeedSession) return;
        binaryProgressAt = performance.now();
        binaryInFlight = Math.max(0, binaryInFlight - 1);
        const acknowledgedKey = binaryPendingKeys.shift();
        // A late refusal for an older P-frame must not invalidate a newer IDR
        // already in transit on the same ordered bridge.
        if (status === "key" && !binaryPendingKeys.includes(true)) binaryNeedsKey = true;
        else if (status === "ok" && acknowledgedKey) binaryNeedsKey = false;
      };
    }
    // Bound messages waiting inside WebView too, not just the MediaCodec inbox.
    // An overloaded UI must not collect seconds of encoded frames in IPC.
    if (binaryInFlight >= 4) {
      if (performance.now() - binaryProgressAt > 1500) abandonBinary();
      return false;
    }
    if (binaryNeedsKey && !key) return false;
    try {
      if (binaryInFlight === 0) binaryProgressAt = performance.now();
      binaryInFlight++;
      binaryPendingKeys.push(key);
      binary.postMessage(nativeVideoPacket(tsUs, key, bytes, nativeFeedSession));
      if (key) binaryNeedsKey = false;
      return true;
    } catch {
      binaryInFlight = Math.max(0, binaryInFlight - 1);
      binaryPendingKeys.pop();
      abandonBinary();
      // Do not mix a late binary P-frame with a synchronous legacy feed. The
      // caller gates until its next IDR, which restarts a valid reference chain.
      return false;
    }
  }
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
  const fast = (u8 as Uint8Array & { toBase64?: () => string }).toBase64;
  if (fast) return fast.call(u8);
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}
