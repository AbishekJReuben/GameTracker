/**
 * Tunable streaming knobs for A/B soft-spot hunting from the companion stats HUD.
 * Persisted in localStorage so APK / web / Quest flat share the same experiment
 * values. Host-side fields ride the existing `quality` control message.
 */

import type { ContentMode } from "./links";

export const STREAM_TUNE_KEY = "gt.remote.streamTune";
/** Legacy keys kept in sync so the Quality dock + tune panel stay aligned. */
export const STREAM_Q_KEY = "gt.remote.streamQ";
export const CONTENT_MODE_KEY = "gt.remote.contentMode";

export type StreamTune = {
  /** Capture max width (px). */
  maxW: number;
  /** Intermediate JPEG sharpness before H.264 (host caps via jpegCap). */
  jpeg: number;
  fps: number;
  /** Target send bitrate (kbps). */
  bitrateKbps: number;
  contentMode: ContentMode;
  /** Host: max JPEG quality fed into the WebRTC canvas path. */
  jpegCap: number;
  /** Host: maxBitrate = steady * headroom (IDR spike room). */
  bitrateHeadroom: number;
  /** Host: BWE / encoding floor (kbps). */
  minBitrateKbps: number;
  /** Host: SDP x-google-start-bitrate (kbps) on next answer. */
  startBitrateKbps: number;
  /** Guest: jitterBufferTarget base / floor (ms). */
  jbBase: number;
  /** Guest: max adaptive JB (ms). */
  jbMax: number;
  /** Guest: absolute JB floor when easing (ms). */
  jbMin: number;
  /** Guest: try WebCodecs DIRECT path after auth. */
  preferDirect: boolean;
};

export const STREAM_TUNE_DEFAULTS: StreamTune = {
  maxW: 1920,
  jpeg: 72,
  fps: 40,
  bitrateKbps: 12000,
  contentMode: "text",
  jpegCap: 72,
  bitrateHeadroom: 1.4,
  minBitrateKbps: 1500,
  startBitrateKbps: 8000,
  jbBase: 40,
  jbMax: 120,
  jbMin: 40,
  preferDirect: true,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function asMode(v: unknown): ContentMode {
  return v === "auto" || v === "text" || v === "video" ? v : STREAM_TUNE_DEFAULTS.contentMode;
}

/** Merge raw JSON with defaults and clamp to safe ranges. */
export function normalizeStreamTune(raw: Partial<StreamTune> | null | undefined): StreamTune {
  const d = STREAM_TUNE_DEFAULTS;
  const r = raw ?? {};
  let jbBase = clamp(Number(r.jbBase) || d.jbBase, 20, 200);
  let jbMin = clamp(Number(r.jbMin) || d.jbMin, 20, 200);
  let jbMax = clamp(Number(r.jbMax) || d.jbMax, 40, 400);
  if (jbMin > jbBase) jbMin = jbBase;
  if (jbMax < jbBase) jbMax = jbBase;
  return {
    maxW: clamp(Number(r.maxW) || d.maxW, 320, 3840),
    jpeg: clamp(Number(r.jpeg) || d.jpeg, 20, 95),
    fps: clamp(Number(r.fps) || d.fps, 10, 60),
    bitrateKbps: clamp(Number(r.bitrateKbps) || d.bitrateKbps, 500, 40000),
    contentMode: asMode(r.contentMode),
    jpegCap: clamp(Number(r.jpegCap) || d.jpegCap, 40, 95),
    bitrateHeadroom: clamp(Number(r.bitrateHeadroom) || d.bitrateHeadroom, 1.0, 2.5),
    minBitrateKbps: clamp(Number(r.minBitrateKbps) || d.minBitrateKbps, 500, 8000),
    startBitrateKbps: clamp(Number(r.startBitrateKbps) || d.startBitrateKbps, 1000, 20000),
    jbBase,
    jbMax,
    jbMin,
    preferDirect: r.preferDirect !== false,
  };
}

export function loadStreamTune(): StreamTune {
  try {
    const raw = localStorage.getItem(STREAM_TUNE_KEY);
    if (raw) return normalizeStreamTune(JSON.parse(raw) as Partial<StreamTune>);
  } catch {
    /* fall through — migrate from legacy streamQ */
  }
  // Migrate Quality-dock prefs if tune was never saved.
  try {
    const qRaw = localStorage.getItem(STREAM_Q_KEY);
    const mode = localStorage.getItem(CONTENT_MODE_KEY);
    if (qRaw) {
      const q = JSON.parse(qRaw) as Partial<{ maxW: number; quality: number; fps: number; bitrate: number }>;
      return normalizeStreamTune({
        maxW: q.maxW,
        jpeg: q.quality,
        fps: q.fps,
        bitrateKbps: q.bitrate,
        contentMode: asMode(mode),
      });
    }
  } catch {
    /* ignore */
  }
  return { ...STREAM_TUNE_DEFAULTS };
}

/** Persist tune + keep legacy Quality-dock keys in sync. */
export function saveStreamTune(tune: StreamTune): void {
  const t = normalizeStreamTune(tune);
  try {
    localStorage.setItem(STREAM_TUNE_KEY, JSON.stringify(t));
    localStorage.setItem(
      STREAM_Q_KEY,
      JSON.stringify({ maxW: t.maxW, quality: t.jpeg, fps: t.fps, bitrate: t.bitrateKbps }),
    );
    localStorage.setItem(CONTENT_MODE_KEY, t.contentMode);
  } catch {
    /* private mode / quota */
  }
}

/** Wipe custom tune back to shipped defaults (also clears legacy keys). */
export function resetStreamTune(): StreamTune {
  const t = { ...STREAM_TUNE_DEFAULTS };
  try {
    localStorage.removeItem(STREAM_TUNE_KEY);
    localStorage.setItem(
      STREAM_Q_KEY,
      JSON.stringify({ maxW: t.maxW, quality: t.jpeg, fps: t.fps, bitrate: t.bitrateKbps }),
    );
    localStorage.setItem(CONTENT_MODE_KEY, t.contentMode);
  } catch {
    /* ignore */
  }
  return t;
}

/** True when saved tune differs from defaults (for HUD badge). */
export function streamTuneIsCustom(t: StreamTune): boolean {
  const d = STREAM_TUNE_DEFAULTS;
  return (
    t.maxW !== d.maxW ||
    t.jpeg !== d.jpeg ||
    t.fps !== d.fps ||
    t.bitrateKbps !== d.bitrateKbps ||
    t.contentMode !== d.contentMode ||
    t.jpegCap !== d.jpegCap ||
    Math.abs(t.bitrateHeadroom - d.bitrateHeadroom) > 0.01 ||
    t.minBitrateKbps !== d.minBitrateKbps ||
    t.startBitrateKbps !== d.startBitrateKbps ||
    t.jbBase !== d.jbBase ||
    t.jbMax !== d.jbMax ||
    t.jbMin !== d.jbMin ||
    t.preferDirect !== d.preferDirect
  );
}
