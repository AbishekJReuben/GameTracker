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
  /**
   * Video pacing: 0 = responsiveness (paint every frame the instant it decodes —
   * lowest latency, uneven cadence when arrival is bursty), 100 = smoothness
   * (hold frames to a clock-synced playout schedule for even cadence, at the cost
   * of that much added delay). Video only — input never rides this.
   */
  pace: number;
  /** Host/DIRECT: recovery keyframe cadence (ms). Long GOP dodges the ~1Hz IDR hitch. */
  wcKeyMs: number;
  /** Host/DIRECT: skip encoding while this many KB sit unsent on the video channel.
   *  Higher = fewer latest-wins skips (smoother NVENC latency) at the cost of
   *  a little more backlog under a congested link. */
  wcBufKB: number;
  /** Host/DIRECT: skip encoding while more than this many frames are in the encoder. */
  wcQueueMax: number;
  /** Guest/RTC: windowed drop % above which the jitter buffer grows. */
  jbGrowAt: number;
  /** Guest/DIRECT: backoff floor before re-attempting DIRECT after a soft failure (s). */
  directRetrySec: number;
  /**
   * Host: let the PC encode H.264 itself (NVENC on the GPU) instead of shipping JPEGs
   * for the browser to re-encode. ON is ~1ms host encode vs ~35ms, but it's the newer
   * path — turn it OFF to fall back to the long-standing JPEG pipeline if the picture
   * misbehaves. No-op on a PC without NVENC (it's already on the JPEG path).
   */
  hostNvenc: boolean;
  /**
   * Guest (Android APK only): decode DIRECT H.264 with native MediaCodec → Surface
   * instead of WebCodecs → canvas. ON is the low-latency path (Moonlight-style).
   * OFF forces WebCodecs even on the APK — useful if MediaCodec misbehaves on a
   * particular SoC. No-op on web / Quest (they only have WebCodecs).
   */
  preferNativeDecode: boolean;
  /**
   * PC sound path. ON = DIRECT: Opus (or raw f32) over the high-priority audio
   * data channel → hold-based phone worklet (~65ms target). OFF = RTC: WebRTC
   * Opus track (NetEQ + host worklet). Flip OFF if DIRECT crackles on a bad link.
   */
  preferDirectAudio: boolean;
  /**
   * RTC audio only: playout delay (ms) the phone asks NetEQ for on the Opus
   * track. 0 = browser adaptive. A modest floor (default 100) stops NetEQ from
   * fighting video congestion into concealment chop; too-low asks pay for it in
   * PLC artifacts. No effect while DIRECT audio is live.
   */
  audioJbMs: number;
  /**
   * RTC audio only: the PC's own playout buffer (ms) feeding the Opus encoder.
   * Sits BEFORE the network, so it adds to whatever NetEQ then does. Lower =
   * less lag but the worklet underruns (crackle) when a game janks the capture
   * thread; the prime/max envelope is derived from it.
   */
  audioHostMs: number;
};

export const STREAM_TUNE_DEFAULTS: StreamTune = {
  maxW: 1920,
  jpeg: 72,
  fps: 40,
  bitrateKbps: 16000,
  contentMode: "text",
  jpegCap: 72,
  bitrateHeadroom: 1.4,
  minBitrateKbps: 1500,
  startBitrateKbps: 8000,
  jbBase: 40,
  jbMax: 120,
  jbMin: 40,
  preferDirect: true,
  pace: 0,
  wcKeyMs: 10000,
  wcBufKB: 384,
  wcQueueMax: 3,
  jbGrowAt: 15,
  directRetrySec: 15,
  hostNvenc: true,
  preferNativeDecode: true,
  preferDirectAudio: true,
  audioJbMs: 100,
  audioHostMs: 90,
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
  // Soft-migrate prior shipped defaults that caused the regressions this pass
  // fixed (host RTC underrun at 55ms; NVENC skip storms at 256KB video buf).
  // Only when the saved value IS the old default — a deliberate custom 55 stays.
  const rawHost = Number(r.audioHostMs);
  const rawBuf = Number(r.wcBufKB);
  const rawQueue = Number(r.wcQueueMax);
  const audioHostMs = clamp(
    rawHost === 55 ? d.audioHostMs : rawHost || d.audioHostMs,
    20,
    200,
  );
  const wcBufKB = clamp(rawBuf === 256 ? d.wcBufKB : rawBuf || d.wcBufKB, 64, 1024);
  const wcQueueMax = clamp(rawQueue === 2 ? d.wcQueueMax : rawQueue || d.wcQueueMax, 1, 6);
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
    // 0 is a meaningful value (the default), so `||` would swallow it — test finite.
    pace: clamp(Number.isFinite(Number(r.pace)) ? Number(r.pace) : d.pace, 0, 100),
    wcKeyMs: clamp(Number(r.wcKeyMs) || d.wcKeyMs, 1000, 30000),
    wcBufKB,
    wcQueueMax,
    jbGrowAt: clamp(Number(r.jbGrowAt) || d.jbGrowAt, 5, 40),
    directRetrySec: clamp(Number(r.directRetrySec) || d.directRetrySec, 5, 120),
    // Same `!== false` shape as preferDirect: absent (an older saved tune) means the
    // default, and only an explicit false turns it off.
    hostNvenc: r.hostNvenc !== false,
    preferNativeDecode: r.preferNativeDecode !== false,
    preferDirectAudio: r.preferDirectAudio !== false,
    // 0 means "auto" (don't touch NetEQ). Finite test — like `pace`.
    audioJbMs: clamp(Number.isFinite(Number(r.audioJbMs)) ? Number(r.audioJbMs) : d.audioJbMs, 0, 400),
    audioHostMs,
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
    t.preferDirect !== d.preferDirect ||
    t.pace !== d.pace ||
    t.wcKeyMs !== d.wcKeyMs ||
    t.wcBufKB !== d.wcBufKB ||
    t.wcQueueMax !== d.wcQueueMax ||
    t.jbGrowAt !== d.jbGrowAt ||
    t.directRetrySec !== d.directRetrySec ||
    t.hostNvenc !== d.hostNvenc ||
    t.preferNativeDecode !== d.preferNativeDecode ||
    t.preferDirectAudio !== d.preferDirectAudio ||
    t.audioJbMs !== d.audioJbMs ||
    t.audioHostMs !== d.audioHostMs
  );
}
