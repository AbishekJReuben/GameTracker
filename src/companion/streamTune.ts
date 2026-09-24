/**
 * Tunable streaming knobs for A/B soft-spot hunting from the companion stats HUD.
 * Persisted in localStorage so APK / web / Quest flat share the same experiment
 * values. Host-side fields ride the existing `quality` control message.
 */

import type { ContentMode } from "./links";

export const STREAM_TUNE_KEY = "gt.remote.streamTune";
/** Picture-in-picture stream (Tune "Lighter picture-in-picture"): the window is a
 *  few hundred px wide on a phone, so this is still sharp there. */
export const PIP_MAX_W = 960;
export const PIP_MAX_FPS = 30;
export const PIP_MAX_KBPS = 4000;
/** Legacy keys kept in sync so the Quality dock + tune panel stay aligned. */
export const STREAM_Q_KEY = "gt.remote.streamQ";
export const CONTENT_MODE_KEY = "gt.remote.contentMode";

export type StreamTune = {
  /** Capture max width (px). */
  maxW: number;
  /** Intermediate JPEG sharpness before H.264 (host caps via jpegCap). */
  jpeg: number;
  fps: number;
  /** Balance congestion across frame rate and per-frame quality instead of
   * collapsing bitrate/detail at the first radio stall. */
  adaptiveFps: boolean;
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
  /** Host/DIRECT: byte CEILING for unsent video-channel data (KB). Standing
   *  latency is actually capped by ~50 ms of the live encode bitrate on the host
   *  (see `wcBufBudget` in rtcHost) — this KB value only bites on fast links.
   *  Higher = fewer latest-wins skips under congestion; lower = less headroom. */
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
  /** Experimental NVENC subpath: bounded host IPC and small reliable fragments. */
  nvencFast: boolean;
  /**
   * Guest (Android APK only): decode DIRECT H.264 with native MediaCodec → Surface
   * instead of WebCodecs → canvas. ON is the low-latency path (Moonlight-style).
   * OFF forces WebCodecs even on the APK — useful if MediaCodec misbehaves on a
   * particular SoC. No-op on web / Quest (they only have WebCodecs).
   */
  preferNativeDecode: boolean;
  /**
   * Guest: while the stream is in picture-in-picture, ask the PC for a light
   * stream (≤960 px wide, ≤30 fps; a manual bitrate capped at 4 Mb/s). The PiP
   * window is a few hundred pixels wide, so full 1080p60 was decoded and sent for
   * nothing. The full stream comes back the moment PiP closes. OFF = unchanged.
   */
  pipLite: boolean;
  /**
   * Guest capability opt-in: when this device's decoder lists H.264 High, ask the
   * PC for Constrained High + CABAC instead of Constrained Baseline — 12–24 % fewer
   * bits for the same picture (research R3). A High stream that fails to decode
   * falls back to Baseline for the rest of the app run. OFF = always Baseline.
   */
  h264High: boolean;
  /**
   * Guest opt-in for reference-frame invalidation (research R4). When the PC has
   * to drop a frame to a backed-up link, it tells NVENC to stop predicting from it
   * and carries on from the last frame this phone got — instead of a blurry IDR
   * and a frozen picture until it lands. Costs a 4-frame reference buffer in the
   * decoder. "auto" = only decoders known to handle it at full speed (Qualcomm,
   * as Moonlight does); "on" = any decoder; "off" = never.
   */
  rfi: "auto" | "on" | "off";
  /**
   * Native codec (research R8). "auto" = H.264, switching to HEVC only while the
   * link holds the stream under ~8 Mb/s (HEVC needs 27–54 % fewer bits for the same
   * picture but costs this phone ~4 ms more decode); back to H.264 above ~12 Mb/s.
   * "h264" / "hevc" force one (HEVC only when this device decodes it in hardware).
   */
  codec: "auto" | "h264" | "hevc";
  /**
   * APK only (research R9 A/B): where MediaCodec paints. "texture" (default) is a
   * TextureView composited inside the app window — the fix for Android 16's WebView
   * burn-in. "surface" is a SurfaceView under a see-through window: its frames go
   * straight to the display compositor (can be a hardware overlay, ~1 frame sooner)
   * but brings the translucent window back. Experimental; compare and keep the one
   * that looks right on this device.
   */
  videoLayer: "texture" | "surface";
  /**
   * PC sound path. ON = DIRECT: Opus (or raw f32) over the high-priority,
   * time-bounded audio channel → adaptive phone worklet (~65ms target). OFF = RTC: WebRTC
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
  /**
   * Host/DIRECT: drive the encode bitrate from what the PHONE actually receives
   * and how much standing delay the link is carrying, instead of from the local
   * send-queue depth alone. The queue-depth controller reads a normal
   * bandwidth-delay product as congestion, and because its own budget shrinks
   * with the bitrate it can ratchet all the way down and never climb back
   * (only a settings change reset it). ON also re-probes for headroom whenever
   * the link is provably clean, so a good network is actually used. OFF is the
   * long-standing controller, byte for byte.
   */
  abrV2: boolean;
  /**
   * Smart bitrate only (research R7): also watch the delay GRADIENT (GCC's
   * trendline over each frame's arrival spacing), so a queue that is starting to
   * build is caught in ~0.25–0.5 s instead of waiting for ~110 ms of standing
   * delay (~0.5–1 s). It only acts once there is a real standing queue (30 ms),
   * which keeps big frames on a clean link from reading as congestion.
   */
  abrGradient: boolean;
  /**
   * DIRECT audio only: the STUDIO wire — 10ms Opus frames carrying one
   * redundant copy of the previous frame, over an UNORDERED, zero-retransmit
   * channel, with pitch-aware gap repair on the phone. A single lost packet
   * costs nothing (the next one still contains it), and nothing can ever be
   * held up waiting for a retransmit. OFF keeps the 20ms ordered/time-bounded
   * wire. No effect while PC sound is on the RTC track.
   */
  audioStudio: boolean;
  /**
   * Host/NVENC: encoder preset 1..4 (P1..P4). Measured on an RTX 4070 Ti at 1080p:
   * P2 encodes as fast as P1 (~1.2ms) with ~+2.7dB PSNR at the same bitrate, so it
   * is the default; P3/P4 add ~0.6–0.8ms for a further ~0.2dB. A change rebuilds
   * the encoder session (one fresh keyframe).
   */
  encPreset: number;
  /**
   * Host/NVENC: rate-control passes. 0 = single pass (default), 1 = two-pass at
   * quarter resolution, 2 = two-pass at full resolution. Two-pass holds frame sizes
   * tighter to the budget (steadier wire, fewer bursts) but measured lower PSNR at
   * equal bitrate on desktop content because it under-spends — opt-in.
   */
  encMultipass: number;
  /**
   * Host: which transport carries DIRECT frames. "auto" = the SCTP video channel
   * while the link is clean (≈5–10 ms faster), the RTP carrier (lib/carrier.ts) as
   * soon as packets are lost (SCTP turns loss into long stalls; RTP recovers it).
   * "sctp" / "rtp" force one. Needs a carrier-capable host and browser.
   */
  videoTransport: "auto" | "sctp" | "rtp";
};

export const STREAM_TUNE_DEFAULTS: StreamTune = {
  maxW: 1920,
  jpeg: 72,
  fps: 60,
  adaptiveFps: true,
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
  wcKeyMs: 30000,
  wcBufKB: 384,
  wcQueueMax: 3,
  jbGrowAt: 15,
  directRetrySec: 15,
  hostNvenc: true,
  nvencFast: false,
  preferNativeDecode: true,
  pipLite: true,
  h264High: true,
  rfi: "auto",
  codec: "auto",
  videoLayer: "texture",
  preferDirectAudio: true,
  audioJbMs: 100,
  audioHostMs: 90,
  abrV2: true,
  abrGradient: true,
  audioStudio: true,
  encPreset: 2,
  encMultipass: 0,
  videoTransport: "auto",
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
  const rawFps = Number(r.fps);
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
    // The native NVENC/MediaCodec path is comfortably inside a 16ms budget;
    // migrate the former shipped 40fps value so existing installs benefit too.
    fps: clamp(rawFps === 40 ? d.fps : rawFps || d.fps, 10, 60),
    adaptiveFps: r.adaptiveFps !== false,
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
    // Experiments must never turn on for existing installs or malformed prefs.
    nvencFast: r.nvencFast === true,
    preferNativeDecode: r.preferNativeDecode !== false,
    pipLite: r.pipLite !== false,
    h264High: r.h264High !== false,
    rfi: r.rfi === "on" || r.rfi === "off" ? r.rfi : "auto",
    codec: r.codec === "h264" || r.codec === "hevc" ? r.codec : "auto",
    videoLayer: r.videoLayer === "surface" ? "surface" : "texture",
    preferDirectAudio: r.preferDirectAudio !== false,
    abrV2: r.abrV2 !== false,
    abrGradient: r.abrGradient !== false,
    audioStudio: r.audioStudio !== false,
    // 0 means "auto" (don't touch NetEQ). Finite test — like `pace`.
    audioJbMs: clamp(Number.isFinite(Number(r.audioJbMs)) ? Number(r.audioJbMs) : d.audioJbMs, 0, 400),
    audioHostMs,
    encPreset: Math.round(clamp(Number(r.encPreset) || d.encPreset, 1, 4)),
    // 0 is meaningful (single pass) — finite test, like `pace`.
    encMultipass: Math.round(
      clamp(Number.isFinite(Number(r.encMultipass)) ? Number(r.encMultipass) : d.encMultipass, 0, 2),
    ),
    videoTransport: r.videoTransport === "sctp" || r.videoTransport === "rtp" ? r.videoTransport : "auto",
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
    t.adaptiveFps !== d.adaptiveFps ||
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
    t.nvencFast !== d.nvencFast ||
    t.preferNativeDecode !== d.preferNativeDecode ||
    t.pipLite !== d.pipLite ||
    t.h264High !== d.h264High ||
    t.rfi !== d.rfi ||
    t.codec !== d.codec ||
    t.videoLayer !== d.videoLayer ||
    t.preferDirectAudio !== d.preferDirectAudio ||
    t.audioJbMs !== d.audioJbMs ||
    t.audioHostMs !== d.audioHostMs ||
    t.abrV2 !== d.abrV2 ||
    t.abrGradient !== d.abrGradient ||
    t.audioStudio !== d.audioStudio ||
    t.encPreset !== d.encPreset ||
    t.videoTransport !== d.videoTransport ||
    t.encMultipass !== d.encMultipass
  );
}
