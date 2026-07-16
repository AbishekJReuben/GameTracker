/**
 * Desktop-side WebRTC **host**. Runs inside the desktop app's webview (which stays
 * alive even when minimized to tray). When cloud mode is on it waits in a signaling
 * room for the phone (guest) to join, establishes a peer connection, and then serves
 * three data channels directly over the P2P link:
 *   - "screen"  : pushes base64 JPEG frames (from the `remote_grab_frame` command)
 *   - "control" : receives input events → `remote_inject`
 *   - "data"    : answers stats requests (id-correlated JSON)
 *
 * The screen/input pixels come from Rust; the WebRTC transport is entirely browser
 * native, so there's no native WebRTC dependency.
 */

import { Channel } from "@tauri-apps/api/core";
import { api, type RemoteCaptureStats } from "./api";
import { Signaling, defaultIceServers, pipeIce, type IceServer } from "./rtc";
import { auxMonitorRoom } from "./remoteConfig";
import { AUDIO_HDR_BYTES, audioPacket } from "./audioWire";
// Bundled as a same-origin asset (CSP default-src 'self' blocks blob:/data: modules).
import audioFeederWorkletUrl from "./audioFeeder.worklet.js?url";

/** Live host telemetry for the desktop Remote page (published each ~1s). */
export interface HostLiveStats {
  /** Rust capture-pipeline stats (produced fps, capture/scale/encode ms, bytes…). */
  capture: RemoteCaptureStats | null;
  /** Outbound WebRTC send bitrate (kbps) and encoder fps, from getStats. */
  sendKbps: number;
  sendFps: number;
  /** Round-trip time (ms) over the peer link, if the browser reports it. */
  rttMs: number;
  /** Live PeerConnection state ("connected", "connecting", …). */
  connState: string;
  /** Content mode in force (0 auto / 1 text / 2 video). */
  content: number;
  /** Encoder bitrate ceiling currently applied to the video sender (kbps). */
  encoderMaxKbps: number;
}

/** What the desktop approval prompt resolves to for an untrusted device. */
export type ApprovalDecision =
  | { kind: "temporary"; durationSecs: number }
  | { kind: "permanent" }
  | { kind: "deny" }
  // A pending prompt that was auto-dismissed because a *newer* request replaced it
  // (e.g. the phone's link flapped and reconnected). This is NOT a user refusal —
  // the host must stay silent (no "denied" to the phone), otherwise the phone,
  // which treats "denied" as terminal, drops to pairing showing "access declined"
  // even though nobody on the PC ever chose. The live session drives its own prompt.
  | { kind: "superseded" };

/** A device asking to connect that isn't trusted yet (needs the prompt). */
export interface ApprovalRequest {
  deviceId: string;
  name: string;
}

interface HostOptions {
  signalUrl: string;
  code: string;
  iceServers?: IceServer[];
  fps?: number;
  onClients?: (n: number) => void;
  /** Push live capture + link telemetry to the desktop UI while a phone is attached. */
  onStats?: (s: HostLiveStats | null) => void;
  /** Ask the desktop UI to approve an untrusted device; resolves the user's choice. */
  onApprovalRequest?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /**
   * When set, this host instance serves only that monitor via the lightweight aux
   * capture path (multi-monitor pop-out tabs). Primary hosts leave this unset.
   */
  fixedMonitor?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---- WebCodecs direct-video path ("wc") ------------------------------------
// H.264 candidates for the data-channel video path. Baseline first: NVENC now
// ships Constrained Baseline so Android HW can enter low-latency mode (Moonlight
// errata #8). High stays on the ladder for the JPEG→WebCodecs fallback encoder.
const WC_CODECS = ["avc1.42C028", "avc1.42E028", "avc1.4d0028", "avc1.640028", "avc1.640034"];
/** Fragment size for encoded frames on the SCTP channel (< 64KB interop limit). */
const WC_FRAG = 61440;
/** Skip encoding new frames while this many bytes sit unsent in the channel —
 *  a backlog can only become latency, and the next frame supersedes this one. */
const WC_MAX_BUFFERED = 262144;
/** Recovery keyframe cadence (ms). Transport is reliable, so keyframes are only
 *  for decoder recovery/joins — long GOPs also avoid Chromium's ~1Hz IDR hitch. */
const WC_KEY_INTERVAL_MS = 10000;

// ---- DIRECT audio ("amode: pcm") -------------------------------------------
// Raw float32 PCM costs sampleRate × channels × 4 = 384 KB/s ≈ 3.1 Mbps at 48k
// stereo. Measured on a phone link: that was 4.1 Mbps of the budget with 1.9 MB
// (five SECONDS) of backlog sitting in the audio data channel, arriving in
// bursts the worklet could only trim-then-starve on — the "robotic" sound. Opus
// carries the same audio for ~4% of that, and it is what WebRTC itself uses.
/** Opus target bitrate — transparent for game/desktop audio at stereo 48k. */
const AUDIO_OPUS_BPS = 128_000;
/** Opus frame size (µs). 10ms halves the algorithmic delay of the 20ms default;
 *  at this bitrate the extra per-packet overhead is irrelevant. */
const AUDIO_OPUS_FRAME_US = 10_000;
/** Sample rates libopus encodes natively. Chromium won't resample into the
 *  encoder and a decoder config must name one of these too, so a capture at any
 *  other rate (rare — WASAPI shared mode is 48k almost everywhere) uses raw PCM. */
const AUDIO_OPUS_RATES = [8000, 12000, 16000, 24000, 48000];
/** Never leave more than this much wall-clock audio queued in the channel.
 *  SCTP has no "drop the stale stuff" knob, so refusing to enqueue is the only
 *  backpressure available — and stale audio is worthless by definition. */
const AUDIO_MAX_BUF_MS = 250;

const CONTENT_NUM: Record<string, number> = { auto: 0, text: 1, video: 2 };
/** Video-track content hint + bitrate-degradation preference per content mode. */
function trackTuning(mode: string): { hint: string; degrade: RTCDegradationPreference } {
  if (mode === "text") return { hint: "detail", degrade: "maintain-resolution" };
  // Default / video: keep frame rate under pressure — smoothness beats crispness
  // for remote control (a soft frame is better than a hitch).
  if (mode === "video") return { hint: "motion", degrade: "maintain-framerate" };
  return { hint: "motion", degrade: "maintain-framerate" };
}

/** Intermediate JPEG quality for the Rust→canvas feed. The phone re-encodes via
 *  WebRTC H.264 anyway, so q=100 just burns CPU/IPC (395KB frames) without a
 *  visible win. Cap defaults to 72; the Tune panel can raise/lower it. */
function jpegForRtc(q: number, cap = 72): number {
  return Math.min(Math.max(20, q), Math.max(40, cap));
}

/**
 * Best-effort SDP hint: raise the encoder's INITIAL bandwidth estimate so the
 * first seconds of a session aren't a blurry 300kbps ramp-up. Chromium reads
 * `x-google-start-bitrate` (kbps) from the video fmtp lines of the description
 * applied via setRemoteDescription on the sending side — i.e. the guest's answer
 * here. Some Chromium versions ignore it, which is harmless; BWE still converges
 * on its own within seconds either way, this only skips the cold start. Guarded:
 * any parse failure returns the SDP untouched. RTX (`apt=`) fmtp lines are
 * skipped — the hint belongs on real codec payloads only.
 */
function boostStartBitrate(sdp: string, startKbps: number, minKbps = 2500): string {
  try {
    const lines = sdp.split("\r\n");
    const mline = lines.find((l) => l.startsWith("m=video"));
    if (!mline) return sdp;
    const pts = new Set(mline.trim().split(" ").slice(3));
    let inVideo = false;
    return lines
      .map((l) => {
        if (l.startsWith("m=")) inVideo = l.startsWith("m=video");
        if (!inVideo) return l;
        const fm = /^a=fmtp:(\S+) (.+)$/.exec(l);
        if (fm && pts.has(fm[1]) && !fm[2].includes("apt=")) {
          let params = fm[2];
          if (!params.includes("x-google-start-bitrate")) {
            params += `;x-google-start-bitrate=${startKbps}`;
          }
          // Floor so GCC can't collapse the screen share to ~200kbps (seen as
          // decode 19fps / bitrate 208k while host still produces 60).
          if (!params.includes("x-google-min-bitrate")) {
            params += `;x-google-min-bitrate=${minKbps}`;
          }
          return `a=fmtp:${fm[1]} ${params}`;
        }
        return l;
      })
      .join("\r\n");
  } catch {
    return sdp;
  }
}

/** Map the phone's quality knobs to a WebRTC encoder bitrate ceiling (bps). */
function bitrateFor(q: { maxW: number; jpeg: number; fps: number }): number {
  const h = Math.round((q.maxW * 9) / 16);
  const px = q.maxW * h;
  // 0.10 bpp @ quality 70 — matched to native.rs. Baseline+CAVLC + desktop/webcam
  // need more than the old 0.06 (talking-head) figure or the picture macroblocks.
  const bpp = 0.1 * (q.jpeg / 70);
  return Math.round(clamp(px * q.fps * bpp, 2_000_000, 40_000_000));
}

/** Route a stats or action request path to the matching backend call. */
async function handleData(path: string, body?: any): Promise<unknown> {
  const [urlPath, query] = path.split("?");
  const params = new URLSearchParams(query ?? "");
  const num = (k: string) => {
    const v = params.get(k);
    return v == null ? undefined : Number(v);
  };
  const bool = (k: string) => {
    const v = params.get(k);
    return v === "true";
  };

  const parts = urlPath.split("/");

  // GET endpoints
  if (urlPath === "/api/dashboard") return api.dashboard();
  if (urlPath === "/api/tracking") return api.trackingState();
  if (urlPath === "/api/apps") return api.appsOverview();
  if (urlPath === "/api/games") return api.listGames();
  if (urlPath === "/api/games/achievements/steam/overview") return api.steamAchievementsOverview();
  if (urlPath === "/api/catalog") return api.catalogAnalytics();
  if (urlPath === "/api/insights") {
    const year = num("year") ?? new Date().getFullYear();
    const kind = (params.get("kind") as any) || "game";
    return api.insights(year, kind);
  }
  if (urlPath === "/api/hourofday") return api.hourOfDay((params.get("kind") as any) || "game");
  if (urlPath === "/api/tags") return api.tagAnalytics();
  if (urlPath === "/api/tags/list") return api.listTags();
  if (urlPath === "/api/sessions") {
    return api.listSessions({
      kind: (params.get("kind") as any) || null,
      gameId: params.get("gameId") || undefined,
      fromUtc: params.get("fromUtc") || undefined,
      limit: num("limit") ?? 500,
    });
  }
  if (urlPath === "/api/heatmap") return api.heatmap(num("days") ?? 140, (params.get("kind") as any) || "game");
  if (urlPath === "/api/music/overview") return api.mediaOverview();
  if (urlPath === "/api/music/top") return api.mediaTop(num("limit") ?? 10);
  if (urlPath === "/api/music/recent") return api.mediaRecent(num("limit") ?? 16);
  if (urlPath === "/api/music/timeline") return api.mediaTimeline(params.get("fromUtc"), params.get("toUtc"));
  if (urlPath === "/api/music/insights") return api.mediaInsights();
  if (urlPath === "/api/music/heatmap") return api.mediaHeatmap(num("days") ?? 140);
  if (urlPath === "/api/music/hourofday") return api.mediaHourOfDay();
  if (urlPath === "/api/playlists") return api.playlistsList();
  if (urlPath === "/api/monitors") return api.remoteListMonitors();
  if (urlPath === "/media") {
    const p = params.get("path");
    return p ? api.remoteReadMedia(p) : null;
  }
  if (urlPath === "/api/system/specs") return api.systemSpecs();
  if (urlPath === "/api/system/live") return api.systemLive();
  if (urlPath === "/api/system/history") return api.systemHistory(num("minutes") ?? 60);
  if (urlPath === "/api/settings") return api.getSettings();
  // Online game panels (mirrors the desktop GameDetail): live stats, reviews, Twitch.
  if (urlPath === "/api/steam/reviews") {
    const appId = num("appId");
    return appId ? api.fetchSteamReviews(appId) : [];
  }
  if (urlPath === "/api/twitch") {
    const name = params.get("name");
    return name ? api.fetchTwitchLive(name) : null;
  }

  // GET endpoints with IDs
  if (parts.length === 4 && parts[1] === "api" && parts[2] === "games") {
    const id = parts[3];
    return api.getGame(id);
  }
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "games" && parts[4] === "stats") {
    const id = parts[3];
    return api.getGameStats(id);
  }
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "games" && parts[4] === "screenshots") {
    const id = parts[3];
    return api.listScreenshots(id);
  }
  if (parts.length === 6 && parts[1] === "api" && parts[2] === "games" && parts[4] === "achievements" && parts[5] === "steam") {
    const id = parts[3];
    return api.steamGameAchievements(id, bool("refresh"));
  }
  if (parts.length === 6 && parts[1] === "api" && parts[2] === "games" && parts[4] === "achievements" && parts[5] === "gog") {
    const id = parts[3];
    return api.gogGameAchievements(id, bool("refresh"));
  }
  if (parts.length === 4 && parts[1] === "api" && parts[2] === "playlists") {
    const id = parts[3];
    return api.playlistGet(id);
  }
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "games" && parts[4] === "metacritic") {
    const id = parts[3];
    return api.fetchMetacriticReviews(id, params.get("slug"));
  }

  // POST / write actions
  if (urlPath === "/api/tracking/pause") {
    return api.setPaused(body.paused);
  }
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "games" && parts[4] === "launch") {
    const id = parts[3];
    return api.launchGame(id);
  }
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "games" && parts[4] === "status") {
    const id = parts[3];
    return api.setGameStatus(id, body.status);
  }
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "games" && parts[4] === "save") {
    return api.saveGame(body.game);
  }
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "games" && parts[4] === "delete") {
    const id = parts[3];
    return api.deleteGame(id);
  }
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "screenshots" && parts[4] === "delete") {
    const id = parts[3];
    return api.deleteScreenshot(id);
  }
  if (urlPath === "/api/music/stop") {
    return api.stopMediaPlay();
  }
  if (urlPath === "/api/playlists/create") {
    return api.playlistCreate(body.name);
  }
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "playlists" && parts[4] === "rename") {
    const id = parts[3];
    return api.playlistRename(id, body.name);
  }
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "playlists" && parts[4] === "delete") {
    const id = parts[3];
    return api.playlistDelete(id);
  }
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "playlists" && parts[4] === "add_tracks") {
    const id = parts[3];
    return api.playlistAddTracks(id, body.tracks);
  }
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "playlists" && parts[4] === "remove_track") {
    const id = parts[3];
    return api.playlistRemoveTrack(id, body.vid);
  }
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "playlists" && parts[4] === "reorder") {
    const id = parts[3];
    return api.playlistReorder(id, body.vids);
  }
  // Kick off a background live-stats refresh; the phone re-polls /stats for the
  // result (the desktop's game://stats event doesn't cross the data channel).
  if (parts.length === 6 && parts[1] === "api" && parts[2] === "games" && parts[4] === "stats" && parts[5] === "refresh") {
    return api.refreshGameStats(parts[3]);
  }
  // "Get data" enrichment — cover + Steam/Wikipedia info (+ HowLongToBeat for
  // games). These are slow network calls, so fire-and-forget on the host and let
  // the phone's periodic /api/games/:id poll pick up the enriched fields; awaiting
  // here would blow the data-channel request timeout.
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "games" && parts[4] === "enrich") {
    const id = parts[3];
    const name = String(body?.name ?? "Unknown");
    const isApp = !!body?.isApp;
    void (async () => {
      try {
        if (isApp) {
          await api.fetchAppInfo(id, name, true);
        } else {
          await api.fetchCover(id, name);
          await api.fetchGameInfo(id, name, false);
          await api.fetchHltb(id, name, true);
        }
      } catch {
        /* best-effort */
      }
    })();
    return { started: true };
  }
  // Resolve this game's full OST now (fire-and-forget; re-poll the game for the
  // filled-in themeTrackIds/Titles).
  if (parts.length === 5 && parts[1] === "api" && parts[2] === "games" && parts[4] === "ost") {
    void api.fetchFullOst(parts[3]).catch(() => {});
    return { started: true };
  }

  throw new Error(`unknown path ${path}`);
}

/** Start hosting. Returns a stop() that tears everything down. */
export function startHost(opts: HostOptions): () => void {
  let stopped = false;
  let sig: Signaling | null = null;
  let pc: RTCPeerConnection | null = null;
  let dataCh: RTCDataChannel | null = null;
  let videoTrack: MediaStreamTrack | null = null;
  let videoWriter: WritableStreamDefaultWriter<VideoFrame> | null = null;
  let videoSender: RTCRtpSender | null = null;
  let audioTrack: MediaStreamTrack | null = null;
  let audioCtx: AudioContext | null = null;
  let audioNode: AudioWorkletNode | null = null;
  let focusTimer: number | null = null;
  let lastTextField = false;
  let lastCursorKind = "";
  let sigBackoff = 1000;
  let sigRetry: number | null = null;
  // Set when the signaling server evicted us because ANOTHER host joined our
  // room ("replaced"). Newest wins: reconnecting would evict the newcomer right
  // back and the two hosts would trade the room forever, flapping every guest.
  let hostReplaced = false;
  // Timestamp of the last message from the phone (input, quality, or heartbeat
  // ping — the guest pings every 5s while alive). Used to tell a *live* session
  // apart from a zombie one when signaling-level join/leave notices arrive.
  let lastGuestMsg = 0;
  /**
   * Set on guest bye / signaling peer-left. Cleared when we send a fresh offer.
   * Without this, an immediate reconnect hits `liveSession` (old PC still
   * "connected" + recent heartbeat) and the host skips `startPeer` — guest hangs
   * on "Waiting for your PC…" until a refresh. Host-only signaling echoes must
   * NOT set this (no peer-left), so healthy sessions survive our own socket blips.
   */
  let guestNeedsOffer = true;
  /** Pop-out monitor hosts spawned from the primary (monitor index → stop). */
  const auxStops = new Map<number, () => void>();

  const ensureAuxHost = (monitor: number) => {
    if (opts.fixedMonitor != null || stopped) return;
    if (auxStops.has(monitor)) return;
    const stop = startHost({
      signalUrl: opts.signalUrl,
      code: auxMonitorRoom(opts.code, monitor),
      iceServers: opts.iceServers,
      fps: opts.fps,
      fixedMonitor: monitor,
      onApprovalRequest: opts.onApprovalRequest,
    });
    auxStops.set(monitor, stop);
  };

  // Live stream-quality state; the guest re-tunes it over the control channel.
  // `bitrate` is kbps (0 = auto: derive from resolution/fps via bitrateFor).
  // Host-pipeline extras (jpegCap / headroom / min / start) come from the phone's
  // Tune panel via the `quality` message — defaults match the shipped soft spot.
  const quality = {
    maxW: 1600,
    jpeg: 70,
    fps: opts.fps ?? 30,
    mode: "auto" as string,
    bitrate: 0,
    jpegCap: 72,
    bitrateHeadroom: 1.4,
    minBitrateKbps: 1500,
    startBitrateKbps: 8000,
    // "Feel" slider (0 = responsiveness, 100 = smoothness). Host-side it only
    // widens the latest-wins skip thresholds — the guest does the actual pacing.
    pace: 0,
    // DIRECT-path knobs from the Tune panel; `pace` scales the last two on top.
    wcKeyMs: WC_KEY_INTERVAL_MS,
    wcBufKB: WC_MAX_BUFFERED / 1024,
    wcQueueMax: 2,
    // Let Rust encode natively (NVENC). The phone can turn this off to fall back to
    // the long-standing JPEG→canvas→WebCodecs path.
    hostNvenc: true,
    // RTC audio: this worklet's playout target (ms) before the Opus encoder.
    // DIRECT audio diverts upstream of the worklet, so this only shapes the
    // classic track. Prime/max are derived (see audioEnvelope).
    audioHostMs: 55,
  };

  /**
   * Host worklet envelope derived from the Tune target. 8/11 and 30/11 are
   * exactly the shipped 40 : 55 : 150 ratios, so leaving the slider at its 55ms
   * default reproduces the long-standing envelope to the millisecond — this
   * knob can only change behaviour when someone actually moves it. (The worklet
   * clamps maxMs to 300, which only bites past ~110ms.)
   */
  const audioEnvelope = (targetMs: number) => ({
    primeMs: Math.max(10, Math.round((targetMs * 8) / 11)),
    targetMs,
    maxMs: Math.round((targetMs * 30) / 11),
  });

  // Adaptive bitrate for the DIRECT path. Phone Wi-Fi can jump; when the video
  // channel backs up we shed bitrate so frames keep flowing (FPS stays up, blocks
  // stay mild) instead of skipping half the frames into a 14-fps slideshow. Eases
  // back toward the Tune target when the channel drains. VIDEO ONLY — never touches
  // input. `adaptKbps` is what Rust actually encodes at; `quality.bitrate` is the cap.
  let adaptKbps = 0;
  let adaptCleanTicks = 0;
  let lastAdaptPush = 0;

  /** Target ceiling from the Tune panel (or auto curve). */
  const targetKbps = () =>
    quality.bitrate > 0 ? quality.bitrate : Math.round(bitrateFor(quality) / 1000);

  /** Push the live encode bitrate to Rust (+ WebCodecs) when adapt moved enough. */
  const pushAdaptBitrate = (force = false) => {
    const tgt = targetKbps();
    if (adaptKbps <= 0) adaptKbps = tgt;
    const now = Date.now();
    if (!force && now - lastAdaptPush < 400) return;
    lastAdaptPush = now;
    const kbps = Math.round(clamp(adaptKbps, Math.max(1500, quality.minBitrateKbps), tgt));
    adaptKbps = kbps;
    try {
      api.remoteSetCaptureQuality(
        quality.maxW,
        quality.fps,
        jpegForRtc(quality.jpeg, quality.jpegCap),
        CONTENT_NUM[quality.mode] ?? 0,
        kbps,
      );
    } catch {
      /* not on desktop */
    }
    // Keep the canvas/WebCodecs encoder (fallback path) on the same budget.
    applyBitrate();
  };

  /**
   * Shed or restore bitrate from the video-channel backlog. Called from the
   * send path (on skip) and the capstats tick (periodic).
   */
  // When the send path last had to skip a frame (backpressure). Ease-back holds
  // off for a few seconds after this so the bitrate doesn't climb straight back
  // into the overshoot that caused the skip — that climb-skip-climb sawtooth is
  // what reads as "the stream hitches every couple of seconds" in motion scenes.
  let lastSkipAt = 0;

  const adaptFromBuffer = (buffered: number, maxBuffered: number, skippedThisFrame: boolean) => {
    const tgt = targetKbps();
    if (adaptKbps <= 0) adaptKbps = tgt;
    const fill = maxBuffered > 0 ? buffered / maxBuffered : 0;
    if (skippedThisFrame || fill > 0.55) {
      // Network can't drain. A hard skip cuts deeper (~15%) than a merely-filling
      // channel (~8%) so one visible hitch sheds enough to end the burst instead
      // of rationing it out over several. Floor at 1.5 Mbps / Tune min so we
      // don't spiral into unreadable mush.
      if (skippedThisFrame) lastSkipAt = Date.now();
      const cut = skippedThisFrame ? 0.85 : 0.92;
      adaptKbps = Math.max(Math.max(1500, quality.minBitrateKbps), Math.round(adaptKbps * cut));
      adaptCleanTicks = 0;
      pushAdaptBitrate();
    } else if (fill < 0.12 && Date.now() - lastSkipAt > 3000) {
      adaptCleanTicks++;
      // ~1.2s of a drained channel → ease 5% back toward the Tune target.
      if (adaptCleanTicks >= 3 && adaptKbps < tgt) {
        adaptKbps = Math.min(tgt, Math.round(adaptKbps * 1.05 + 50));
        adaptCleanTicks = 0;
        pushAdaptBitrate();
      }
    } else {
      adaptCleanTicks = 0;
    }
  };

  // When set, composited frames are diverted from the WebRTC generator track into
  // the WebCodecs encoder → "video" data channel (the guest opted in with
  // {type:"vmode",mode:"wc"}). Owned by the current peer session (startPeer).
  let wcSink: ((canvas: HTMLCanvasElement) => void) | null = null;
  /** Tear down the current session's WebCodecs encoder (set by startPeer). */
  let wcStop: (() => void) | null = null;
  /**
   * Set by startPeer while the guest is on DIRECT. When Rust is encoding natively
   * (NVENC), frames arrive already H.264 and go straight out this sink — the canvas,
   * the JPEG decode and the WebCodecs encoder are all bypassed. Null ⇒ Rust must send
   * JPEG (the RTC track needs real pixels to composite).
   */
  let nativeSink: ((payload: Uint8Array<ArrayBuffer>, key: boolean, w?: number, h?: number) => void) | null = null;
  /** True once Rust has told us (via the frame container) that it's encoding natively. */
  let nativeActive = false;

  const stopCapture = () => {
    try {
      if (opts.fixedMonitor != null) api.remoteStopAuxCapture(opts.fixedMonitor);
      else api.remoteStopCapture();
    } catch {
      /* not on desktop / already stopped */
    }
  };

  // The cap actually applied to the sender (bps), surfaced in HostLiveStats so
  // the Remote page shows the phone's bitrate knob taking effect.
  let appliedCapBps = 0;
  const applyBitrate = () => {
    if (!videoSender) return;
    const sender = videoSender;
    // A manual bitrate (kbps) from the phone overrides the auto estimate.
    const steadyBps = quality.bitrate > 0 ? quality.bitrate * 1000 : bitrateFor(quality);
    // Chromium's HW H.264 encoder inserts a large IDR ~every 1s at ≥720p (see
    // Flashphoner / discuss-webrtc). Without headroom the RTP pacer queues behind
    // that spike → a visible hitch every second while data-channel input stays
    // smooth. Leave ~40% above the steady-state estimate so IDRs clear promptly
    // (Tune panel can change bitrateHeadroom).
    const capBps = Math.round(steadyBps * quality.bitrateHeadroom);
    const p = sender.getParameters();
    if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
    p.encodings[0].maxBitrate = capBps;
    p.encodings[0].maxFramerate = quality.fps;
    // Chromium accepts minBitrate on encodings even though it isn't in the W3C
    // IDL — floor BWE so screen share can't collapse to ~200kbps. Best-effort.
    const minBps = Math.min(Math.round(capBps * 0.25), 3_000_000);
    (p.encodings[0] as RTCRtpEncodingParameters & { minBitrate?: number }).minBitrate = Math.max(
      quality.minBitrateKbps * 1000,
      minBps,
    );
    // Bias the transport toward the screen video: bandwidth allocation over the
    // other channels and DSCP marking on networks that honor it.
    p.encodings[0].priority = "high";
    p.encodings[0].networkPriority = "high";
    // Under bandwidth pressure: text mode keeps resolution (readability), video
    // mode keeps frame rate (smoothness). See mst-content-hint / degradationPreference.
    p.degradationPreference = trackTuning(quality.mode).degrade;
    sender
      .setParameters(p)
      .then(() => {
        appliedCapBps = capBps;
      })
      .catch((err) => {
        // Retry with only the bitrate cap: maxFramerate/degradationPreference can
        // be the unsupported part, and one bad field rejects the whole call.
        console.warn("[remote] setParameters failed, retrying bitrate-only:", err);
        try {
          const p2 = sender.getParameters();
          if (p2.encodings && p2.encodings.length > 0) {
            p2.encodings[0].maxBitrate = capBps;
            sender
              .setParameters(p2)
              .then(() => {
                appliedCapBps = capBps;
              })
              .catch((e2) => console.warn("[remote] bitrate-only setParameters failed:", e2));
          }
        } catch (e2) {
          console.warn("[remote] setParameters retry threw:", e2);
        }
      });
  };

  /** Apply the content-mode hint to the live video track (sharp text vs motion). */
  const applyContentHint = () => {
    if (!videoTrack) return;
    try {
      (videoTrack as MediaStreamTrack & { contentHint: string }).contentHint = trackTuning(quality.mode).hint;
    } catch {
      /* not supported */
    }
  };

  // Rapid focus re-checks right after a click, so the guest can latch its
  // Surface Keyboard / IME during the same user-gesture window. Quest caret
  // detection can lag, so we probe longer/faster than a single poll.
  const pokeFocus = () => {
    let n = 0;
    const tick = async () => {
      if (!dataCh || dataCh.readyState !== "open") return;
      try {
        const active = await api.remoteTextfieldActive();
        if (active !== lastTextField) {
          lastTextField = active;
          dataCh.send(JSON.stringify({ event: "focus", textField: active }));
        } else if (active) {
          // Re-assert true so a guest that missed the edge still locks on.
          dataCh.send(JSON.stringify({ event: "focus", textField: true }));
        }
        const kind = await api.remoteCursorKind();
        if (kind !== lastCursorKind) {
          lastCursorKind = kind;
          dataCh.send(JSON.stringify({ event: "cursor", kind }));
        }
      } catch {
        /* ignore */
      }
      if (++n < 10) window.setTimeout(tick, 80);
    };
    window.setTimeout(tick, 16);
  };

  const stopAudio = () => {
    try {
      api.remoteStopAudio();
    } catch {
      /* not on desktop / already stopped */
    }
    try {
      audioNode?.disconnect();
    } catch {
      /* ignore */
    }
    audioNode = null;
    audioCtx?.close().catch(() => {});
    audioCtx = null;
    audioTrack?.stop();
    audioTrack = null;
  };

  const teardownPeer = () => {
    if (focusTimer) {
      clearInterval(focusTimer);
      focusTimer = null;
    }
    wcStop?.();
    wcStop = null;
    stopCapture();
    stopAudio();
    videoWriter?.close().catch(() => {});
    videoWriter = null;
    videoTrack?.stop();
    videoTrack = null;
    videoSender = null;
    appliedCapBps = 0;
    dataCh = null;
    pc?.close();
    pc = null;
    lastTextField = false;
    lastCursorKind = "";
    opts.onClients?.(0);
    opts.onStats?.(null);
  };

  /**
   * Build a WebRTC video track fed by Rust-captured JPEG frames: the capture
   * thread streams frames over a binary channel → we decode + draw to a canvas →
   * each finished frame is pushed straight into the encoder, which
   * hardware-encodes with inter-frame compression and adaptive bitrate.
   */
  const buildVideoTrack = async (): Promise<{ track: MediaStreamTrack; start: () => Promise<void> } | null> => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const cctx = canvas.getContext("2d", { alpha: false, desynchronized: true });

    // Prefer an insertable-streams track (MediaStreamTrackGenerator): we hand each
    // composited frame to WebRTC the moment it's drawn, instead of letting
    // `captureStream()` sample the canvas on the compositor's vsync — that sampling
    // adds up to a display frame of latency and throttles when the window is
    // hidden/minimized to tray. Falls back to captureStream where unsupported.
    type GenTrack = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
    const GenCtor = (window as unknown as { MediaStreamTrackGenerator?: new (init: { kind: "video" }) => GenTrack })
      .MediaStreamTrackGenerator;
    let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
    let genTrack: GenTrack | null = null;
    if (GenCtor) {
      try {
        genTrack = new GenCtor({ kind: "video" });
        writer = genTrack.writable.getWriter();
      } catch {
        genTrack = null;
        writer = null;
      }
    }
    videoWriter = writer;
    // If the encoder ever falls behind, drop instead of queueing: a queued frame
    // is already stale, and backpressure here would turn into growing latency.
    let pendingWrites = 0;
    // Pace MediaStreamTrackGenerator timestamps to the target fps. JPEG decode
    // latency varies frame-to-frame; stamping with wall-clock-at-draw made the
    // encoder see irregular inter-frame gaps, which the phone's de-jitter buffer
    // treated as network jitter and periodically "corrected" (smooth → hitch →
    // smooth). A monotonic cadence + explicit duration keeps playout even.
    let nextTsUs = 0;
    const pushFrame = () => {
      // Direct WebCodecs path active: the guest decodes H.264 off the data
      // channel, so feeding the WebRTC track too would double-encode every frame.
      // Native NVENC owns the channel while `nativeActive` — don't also run the
      // canvas WebCodecs encoder or two independent H.264 streams interleave.
      if (wcSink) {
        if (nativeActive) return;
        try {
          wcSink(canvas);
        } catch {
          /* encoder mid-reconfigure */
        }
        return;
      }
      if (!writer || pendingWrites > 2) return;
      try {
        const fps = Math.max(1, quality.fps);
        const durUs = Math.round(1_000_000 / fps);
        const nowUs = Math.round(performance.now() * 1000);
        if (nextTsUs === 0 || nextTsUs < nowUs - durUs * 4) {
          // First frame, or we fell far behind a stall — resync to wall clock.
          nextTsUs = nowUs;
        }
        const ts = nextTsUs;
        nextTsUs += durUs;
        const vf = new VideoFrame(canvas, { timestamp: ts, duration: durUs });
        pendingWrites++;
        writer
          .write(vf)
          .catch(() => {})
          .finally(() => pendingWrites--);
      } catch {
        /* canvas not drawable yet */
      }
    };
    // Composite a "GS" strip container (parallel-encoded horizontal bands): decode
    // every strip, then draw them all in one synchronous batch so `captureStream`
    // never samples a half-updated canvas (avoids tearing between bands).
    const drawStrips = async (u8: Uint8Array) => {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const w = dv.getUint16(3, true);
      const h = dv.getUint16(5, true);
      const count = u8[7];
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const jobs: { y: number; p: Promise<ImageBitmap> }[] = [];
      let off = 8;
      for (let i = 0; i < count && off + 8 <= u8.length; i++) {
        const y = dv.getUint16(off, true);
        const len = dv.getUint32(off + 4, true);
        off += 8;
        const jpg = u8.slice(off, off + len);
        off += len;
        // Our encoder emits plain sRGB JPEGs with no ICC profile — skip the color
        // conversion pass for a faster decode.
        jobs.push({ y, p: createImageBitmap(new Blob([jpg], { type: "image/jpeg" }), { colorSpaceConversion: "none" }) });
      }
      const bmps = await Promise.all(jobs.map((j) => j.p));
      bmps.forEach((bmp, i) => {
        cctx?.drawImage(bmp, 0, jobs[i].y);
        bmp.close?.();
      });
    };

    const drawFull = async (bytes: ArrayBuffer) => {
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }), { colorSpaceConversion: "none" });
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      cctx?.drawImage(bmp, 0, 0);
      bmp.close?.();
    };

    // Latest-wins decode: if a frame is still decoding when the next arrives,
    // keep only the newest and drop the rest. Decoding a backlog can only ever
    // ADD latency — every queued frame is already stale — and it also guarantees
    // frames hit the canvas in arrival order (parallel async decodes could
    // finish out of order and paint an old frame over a newer one).
    let decoding = false;
    let newestPending: ArrayBuffer | null = null;
    const pump = (bytes: ArrayBuffer) => {
      decoding = true;
      const u8 = new Uint8Array(bytes);
      // "GS" = parallel-strip container; anything else is a plain full-frame JPEG.
      const p = u8.length >= 8 && u8[0] === 0x47 && u8[1] === 0x53 ? drawStrips(u8) : drawFull(bytes);
      p.then(pushFrame)
        .catch(() => {})
        .finally(() => {
          decoding = false;
          if (newestPending) {
            const next = newestPending;
            newestPending = null;
            pump(next);
          }
        });
    };

    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (buf) => {
      const bytes = buf as unknown as ArrayBuffer;
      // Native container ('G' 'N' | flags | rsv | w u16 | h u16 | Annex-B): Rust
      // encoded this with NVENC, so there is nothing to do but forward it. This is
      // the whole point of the native path — no JPEG decode, no canvas, no
      // re-encode, none of the ~27ms round trip those cost.
      const u8 = new Uint8Array(bytes);
      if (u8.length > 8 && u8[0] === 0x47 && u8[1] === 0x4e) {
        nativeActive = true;
        // Little-endian u16 width/height live in the GN header — pass them so
        // the first native frame can announce a codec+size to the guest before
        // any Annex-B lands (without that JSON the guest never builds a
        // VideoDecoder and sits on "Waking your screen…" forever).
        const nw = u8[4] | (u8[5] << 8);
        const nh = u8[6] | (u8[7] << 8);
        nativeSink?.(u8.subarray(8), (u8[2] & 1) === 1, nw, nh);
        return;
      }
      nativeActive = false;
      if (decoding) {
        newestPending = bytes;
        return;
      }
      pump(bytes);
    };
    // Generator path: frames are pushed explicitly, so delivery tracks the Rust
    // capture thread exactly. Fallback captureStream() with no fps arg does the
    // same via draw-sampling (encoder fps ceiling is set via setParameters).
    let track: MediaStreamTrack | null = genTrack;
    if (!track) {
      const stream = canvas.captureStream?.();
      track = stream?.getVideoTracks?.()[0] ?? null;
    }
    if (!track) return null;
    try {
      (track as MediaStreamTrack & { contentHint: string }).contentHint = trackTuning(quality.mode).hint;
    } catch {
      /* not supported */
    }
    // Capture is DEFERRED: the track is added to the offer immediately (so no
    // renegotiation), but the Rust screen capture only starts once the guest is
    // authorized. Until then the track carries no frames, so the phone sees nothing.
    //
    // NOTE: a native `getDisplayMedia` fast path was tried here (GPU capture +
    // encode, zero JPEG/IPC overhead) but reverted — WebView2's
    // `--auto-select-desktop-capture-source` flag did not reliably match the screen
    // source, so the OS "Choose what to share" picker popped up on the host every
    // connection. The Rust DXGI pipeline (persistent duplication + GPU downscale +
    // parallel encode) needs no picker and is already heavily optimized.
    const start = () =>
      opts.fixedMonitor != null
        ? api.remoteStartAuxCapture(opts.fixedMonitor, ch, quality.maxW, quality.fps, jpegForRtc(quality.jpeg, quality.jpegCap))
        : api.remoteStartCapture(ch, quality.maxW, quality.fps, jpegForRtc(quality.jpeg, quality.jpegCap));
    return { track, start };
  };

  /**
   * Build a WebRTC **audio** track fed by Rust WASAPI-loopback PCM: float32 chunks
   * are transferred (zero-copy) into an **AudioWorklet** that jitter-buffers,
   * drift-resamples, and writes them into a `MediaStreamAudioDestinationNode`
   * whose track we add to the peer connection.
   *
   * The worklet replaced a ScriptProcessorNode on purpose (crackle fix):
   * ScriptProcessor runs its callback on the MAIN thread, so whenever a game
   * loaded the machine — or the webview was busy decoding/compositing video
   * frames — the callback missed its deadline and the phone heard crackling.
   * `AudioWorkletProcessor.process()` runs on the dedicated real-time audio
   * rendering thread, which page/game load can't jank. The buffering/resampling
   * logic lives in `audioFeeder.worklet.js`; the main thread's only remaining
   * job is forwarding chunks. **Do not move this back to ScriptProcessor.**
   *
   * DIRECT audio (phone `{type:"amode",mode:"pcm"}`) bypasses the worklet + WebRTC
   * track: PCM rides the "audio" data channel to a lean worklet on the phone —
   * closes the lag gap after NVENC made video near-instant while Opus+NetEQ stayed
   * ~150–250ms behind.
   */
  const buildAudioTrack = async (): Promise<{
    track: MediaStreamTrack;
    start: () => Promise<void>;
    setDirectSink: (ch: RTCDataChannel | null) => void;
    /** Negotiate the wire codec against the guest's advertised decode support. */
    setDirectCodec: (codecs: string[]) => Promise<"opus" | "f32">;
    stats: () => { codec: "opus" | "f32"; dropped: number };
    format: () => { sampleRate: number; channels: number } | null;
  } | null> => {
    try {
      audioCtx = new AudioContext({ sampleRate: 48000 });
    } catch {
      audioCtx = new AudioContext();
    }
    audioCtx.resume().catch(() => {}); // webview autoplay policy may suspend it
    try {
      await audioCtx.audioWorklet.addModule(audioFeederWorkletUrl);
    } catch (e) {
      console.warn("[remote] audio worklet failed to load — desktop audio disabled:", e);
      audioCtx.close().catch(() => {});
      audioCtx = null;
      return null;
    }
    const ctx = audioCtx;
    const dest = ctx.createMediaStreamDestination();
    const node = new AudioWorkletNode(ctx, "gt-pcm-feeder", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(dest);
    audioNode = node;
    // RTC path: wider than the phone DIRECT defaults — absorbs IPC jitter from
    // the Tauri channel under game load. Defaults to 40/55/150 (a leaner 30/40
    // experiment caused audible underrun chop): this worklet feeds the Opus
    // track, which sits behind NetEQ's ~150ms+ anyway, so 15ms shaved here is
    // inaudible latency-wise while the underruns it causes are very audible.
    // The Tune panel can move it ("RTC aud buf") for A/B hunting.
    try {
      node.port.postMessage({
        cfg: { channels: 2, captureRate: ctx.sampleRate, ...audioEnvelope(quality.audioHostMs) },
      });
    } catch {
      /* ignore */
    }

    let directSink: RTCDataChannel | null = null;
    let liveFmt: { sampleRate: number; channels: number } | null = null;

    // ---- DIRECT audio codec (negotiated per guest) --------------------------
    /** Wire format in use: Opus packets (headered) or raw interleaved float32. */
    let audioCodec: "opus" | "f32" = "f32";
    let audioEnc: AudioEncoder | null = null;
    /** Format the live encoder was configured for. A capture-device change can
     *  hand us a new mix rate mid-session; encoding AudioData at a rate the
     *  encoder wasn't built for is garbage, so this forces a rebuild. */
    let audioEncRate = 0;
    let audioEncCh = 0;
    let audioSeq = 0;
    let audioTsUs = 0;
    /** Chunks refused because the channel was already full (HUD "A-drop"). */
    let audioDropped = 0;
    /** What the guest told us it can decode; replayed when the format changes. */
    let guestAudioCodecs: string[] = [];

    /** Bytes/sec the live DIRECT format costs on the wire. */
    const audioBytesPerSec = () => {
      if (audioCodec === "opus") return AUDIO_OPUS_BPS / 8;
      const f = liveFmt ?? { sampleRate: 48000, channels: 2 };
      return f.sampleRate * f.channels * 4;
    };

    /** True when the channel already holds > AUDIO_MAX_BUF_MS of audio. */
    const audioChBacked = () => {
      const sink = directSink;
      if (!sink) return true;
      const cap = Math.max(8192, Math.round((audioBytesPerSec() * AUDIO_MAX_BUF_MS) / 1000));
      return sink.bufferedAmount > cap;
    };

    const sendDirectRaw = (ab: ArrayBuffer) => {
      const sink = directSink;
      if (!sink || sink.readyState !== "open") return;
      if (audioChBacked()) {
        audioDropped++;
        return;
      }
      try {
        sink.send(ab);
      } catch {
        /* channel torn down */
      }
    };

    /** Ship one Opus packet: shared 8-byte header + payload. The header makes
     *  the stream self-describing, so a guest can never feed Opus bytes to its
     *  PCM worklet (or vice versa) across a format switch. */
    const sendOpusChunk = (chunk: EncodedAudioChunk) => {
      const sink = directSink;
      if (!sink || sink.readyState !== "open") return;
      if (audioChBacked()) {
        audioDropped++;
        return;
      }
      const buf = audioPacket(audioSeq++, chunk.byteLength);
      chunk.copyTo(new Uint8Array(buf, AUDIO_HDR_BYTES));
      try {
        sink.send(buf);
      } catch {
        /* channel torn down */
      }
    };

    const closeAudioEncoder = () => {
      const enc = audioEnc;
      audioEnc = null;
      audioEncRate = 0;
      audioEncCh = 0;
      if (!enc) return;
      try {
        if (enc.state !== "closed") enc.close();
      } catch {
        /* already gone */
      }
    };

    /** Fall back to raw PCM mid-session (encoder fault) without dropping sound. */
    const revertAudioToRaw = (why: string, e?: unknown) => {
      if (audioCodec === "f32") return;
      console.warn(`[remote] DIRECT audio → raw PCM: ${why}`, e ?? "");
      closeAudioEncoder();
      audioCodec = "f32";
      startCfgBurst();
    };

    /** Build the Opus encoder for the live capture format. Null ⇒ use raw PCM. */
    const buildOpusEncoder = async (rate: number, channels: number): Promise<AudioEncoder | null> => {
      if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return null;
      if (!AUDIO_OPUS_RATES.includes(rate)) return null;
      const cfg = {
        codec: "opus",
        sampleRate: rate,
        numberOfChannels: channels,
        bitrate: AUDIO_OPUS_BPS,
        opus: {
          frameDuration: AUDIO_OPUS_FRAME_US,
          // The audio channel is unreliable by design (maxRetransmits: 0), so
          // let Opus carry its own redundancy: in-band FEC + a loss hint lets
          // the decoder reconstruct a dropped packet instead of clicking.
          useinbandfec: true,
          packetlossperc: 10,
          complexity: 5,
        },
      } as unknown as AudioEncoderConfig;
      try {
        const sup = await AudioEncoder.isConfigSupported(cfg);
        if (!sup?.supported) return null;
      } catch {
        return null;
      }
      try {
        const enc = new AudioEncoder({
          output: (chunk) => sendOpusChunk(chunk),
          error: (e) => revertAudioToRaw("Opus encoder error", e),
        });
        enc.configure(cfg);
        return enc;
      } catch (e) {
        console.warn("[remote] DIRECT audio: Opus configure failed — raw PCM:", e);
        return null;
      }
    };

    /** Encode one PCM chunk. False ⇒ caller degrades this session to raw PCM. */
    const encodeDirectAudio = (ab: ArrayBuffer): boolean => {
      const enc = audioEnc;
      const fmt = liveFmt;
      if (!enc || !fmt || enc.state !== "configured") return false;
      // The capture format moved out from under the encoder (device change) —
      // degrade to raw rather than encode AudioData it wasn't built for. The
      // next `start()` re-negotiates Opus at the new rate.
      if (fmt.sampleRate !== audioEncRate || fmt.channels !== audioEncCh) return false;
      const src = new Float32Array(ab);
      const frames = Math.floor(src.length / fmt.channels);
      if (frames <= 0) return true; // empty chunk — nothing to do, stay on Opus
      try {
        const ad = new AudioData({
          format: "f32", // Rust ships interleaved float32
          sampleRate: fmt.sampleRate,
          numberOfFrames: frames,
          numberOfChannels: fmt.channels,
          timestamp: audioTsUs,
          data: src.subarray(0, frames * fmt.channels),
        });
        audioTsUs += Math.round((frames * 1_000_000) / fmt.sampleRate);
        enc.encode(ad);
        ad.close();
        return true;
      } catch (e) {
        console.warn("[remote] DIRECT audio encode failed:", e);
        return false;
      }
    };

    /**
     * Negotiate the DIRECT audio codec against what the guest can decode, and
     * (re)build the encoder. Old guests advertise nothing → raw f32, which is
     * byte-for-byte what they already expect. Returns the codec now in use.
     */
    const setDirectCodec = async (codecs: string[]): Promise<"opus" | "f32"> => {
      guestAudioCodecs = codecs;
      const fmt = liveFmt;
      if (!codecs.includes("opus") || !fmt) {
        // No Opus (or the capture format isn't known yet — `start()` re-runs us).
        closeAudioEncoder();
        audioCodec = "f32";
        return audioCodec;
      }
      // Already encoding this exact format — nothing to do.
      if (audioEnc && audioCodec === "opus" && audioEncRate === fmt.sampleRate && audioEncCh === fmt.channels) {
        return audioCodec;
      }
      const enc = await buildOpusEncoder(fmt.sampleRate, fmt.channels);
      closeAudioEncoder();
      if (!enc) {
        audioCodec = "f32";
        return audioCodec;
      }
      audioEnc = enc;
      audioEncRate = fmt.sampleRate;
      audioEncCh = fmt.channels;
      audioSeq = 0;
      audioTsUs = 0;
      audioCodec = "opus";
      console.info(
        `[remote] DIRECT audio via Opus @ ${Math.round(AUDIO_OPUS_BPS / 1000)}kbps ` +
          `(${fmt.sampleRate}Hz ×${fmt.channels}) — was ${Math.round((fmt.sampleRate * fmt.channels * 4 * 8) / 1000)}kbps raw`,
      );
      return audioCodec;
    };

    // The audio channel is partially reliable (maxRetransmits: 0) so the one-shot
    // format JSON can be lost in transit. Repeat it for a short burst after a sink
    // attaches (and after every capture-format change) so at least one copy lands.
    // NOT forever: companion builds without cfg dedupe forward every repeat to
    // their worklet, which resets the adaptive latency target each time — a
    // bounded burst right when the format is announced avoids that.
    let cfgTimer: number | null = null;
    let cfgBurstUntil = 0;
    const stopCfgBurst = () => {
      if (cfgTimer !== null) {
        window.clearInterval(cfgTimer);
        cfgTimer = null;
      }
    };
    const sendDirectCfg = () => {
      if (!directSink || directSink.readyState !== "open" || !liveFmt || Date.now() > cfgBurstUntil) {
        stopCfgBurst();
        return;
      }
      try {
        directSink.send(
          JSON.stringify({
            cfg: { sampleRate: liveFmt.sampleRate, channels: liveFmt.channels, codec: audioCodec },
          }),
        );
      } catch {
        /* ignore */
      }
    };
    const startCfgBurst = () => {
      stopCfgBurst();
      cfgBurstUntil = Date.now() + 10_000;
      sendDirectCfg();
      if (directSink && directSink.readyState === "open") cfgTimer = window.setInterval(sendDirectCfg, 2000);
    };

    // DIRECT → data channel (Opus, or a raw copy); RTC → worklet (transfer).
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (buf) => {
      const ab = buf as unknown as ArrayBuffer;
      if (directSink && directSink.readyState === "open") {
        if (audioCodec === "opus") {
          // sendOpusChunk() ships the packets from the encoder's output callback.
          if (encodeDirectAudio(ab)) return;
          revertAudioToRaw("encode failed mid-session");
        }
        sendDirectRaw(ab.slice(0));
        return;
      }
      try {
        node.port.postMessage(ab, [ab]);
      } catch {
        /* node torn down */
      }
    };

    const track = dest.stream.getAudioTracks()[0] ?? null;
    if (!track) return null;
    // Capture is DEFERRED until the guest is authorized (same as video). The
    // graph is built eagerly at 48k stereo for the offer; once capture starts we
    // tell the worklet the REAL mix format (WASAPI loopback runs at the render
    // endpoint's rate — often 44.1k or 96/192k) and it re-primes if it differs.
    const start = async () => {
      const fmt = await api.remoteStartAudio(ch);
      const channels = fmt ? Math.max(1, Math.min(2, fmt.channels)) : 2;
      const captureRate =
        fmt && fmt.sampleRate > 8000 && fmt.sampleRate <= 384000 ? fmt.sampleRate : ctx.sampleRate;
      liveFmt = { sampleRate: captureRate, channels };
      try {
        node.port.postMessage({
          cfg: { channels, captureRate, ...audioEnvelope(quality.audioHostMs) },
        });
      } catch {
        /* node torn down */
      }
      // The real capture format is only known now, and Opus needs it to build —
      // a guest that opted into DIRECT before capture started got raw PCM, so
      // re-negotiate against its advertised codecs and announce the result.
      if (directSink) {
        await setDirectCodec(guestAudioCodecs);
        startCfgBurst();
      }
    };
    return {
      track,
      start,
      setDirectSink: (sink) => {
        directSink = sink;
        if (sink) {
          startCfgBurst();
        } else {
          stopCfgBurst();
          // Back to the RTC track: drop the encoder so a later re-opt-in starts
          // from a clean timestamp/sequence base.
          closeAudioEncoder();
          audioCodec = "f32";
          audioSeq = 0;
          audioTsUs = 0;
        }
      },
      setDirectCodec,
      stats: () => ({ codec: audioCodec, dropped: audioDropped }),
      format: () => liveFmt,
    };
  };

  const startPeer = async () => {
    teardownPeer(); // reset any prior session
    if (!sig) return;
    // Access gate: the screen/audio capture and input injection stay off until the
    // guest is authorized (trusted device, correct secret, or user approval).
    let authorized = false;
    // True while an auth decision is in flight (checkAuth call or approval prompt).
    // Guests RE-SEND their auth every few seconds until answered (the first ask can
    // be lost around channel-open) — this guard keeps a retry from stacking a
    // second checkAuth/prompt on top of the one already running.
    let authBusy = false;
    let startVideoCapture: (() => Promise<void>) | null = null;
    let startAudioCapture: (() => Promise<void>) | null = null;
    let setAudioDirectSink: ((ch: RTCDataChannel | null) => void) | null = null;
    let setAudioDirectCodec: ((codecs: string[]) => Promise<"opus" | "f32">) | null = null;
    let audioStats: (() => { codec: "opus" | "f32"; dropped: number }) | null = null;
    /** Live capture format — re-posting the worklet envelope must not change it
     *  (a framing change makes the worklet drop its buffer and re-prime). */
    let audioFormat: (() => { sampleRate: number; channels: number } | null) | null = null;
    let audioDirect = false;
    // Capture-stall watchdog bookkeeping (restart capture if it wedges).
    let lastProduced = -1;
    let zeroSince = 0;
    // Encoder-stall watchdog bookkeeping (see below): counts consecutive 500ms
    // ticks where Rust produces frames but the WebRTC encoder sends none.
    let encStallTicks = 0;
    let stallProduced = -1;
    let stallProducedAt = 0;
    // Guest-requested video resets ("vreset", sent when ITS decoder sees bytes
    // but no decoded frames). Rate-limited so a misbehaving guest can't make the
    // host thrash the encoder.
    let lastVresetAt = 0;

    // Self-heal for a wedged WebRTC VIDEO ENCODER. Raising the stream resolution
    // resizes the canvas, and some hardware H.264 encoders never recover from the
    // mid-stream size increase: the track keeps accepting frames but the encoder
    // outputs nothing, so the guest freezes on the last frame — and lowering the
    // resolution again doesn't help because the encoder itself is dead. Rebuild
    // the canvas + generator track and swap it in with `replaceTrack` (no
    // renegotiation, keeps the session/auth), then restart the Rust feed.
    const rebuildVideoPipeline = async () => {
      if (pc !== myPc || !videoSender || !authorized) return;
      console.warn("[remote] video encoder stalled — rebuilding the video track in place");
      stopCapture();
      videoWriter?.close().catch(() => {});
      videoWriter = null;
      try {
        videoTrack?.stop();
      } catch {
        /* ignore */
      }
      const v = await buildVideoTrack();
      if (!v || pc !== myPc) return;
      videoTrack = v.track;
      startVideoCapture = v.start;
      try {
        await videoSender.replaceTrack(v.track);
      } catch (e) {
        console.warn("[remote] replaceTrack failed:", e);
        return;
      }
      applyContentHint();
      applyBitrate();
      try {
        await v.start();
      } catch (e) {
        console.warn("[remote] capture restart after rebuild failed:", e);
      }
    };

    const authorize = async () => {
      if (authorized) return;
      authorized = true;
      try {
        await startVideoCapture?.();
      } catch (e) {
        console.warn("[remote] start capture failed:", e);
      }
      try {
        await startAudioCapture?.();
      } catch {
        /* audio is optional */
      }
      // First-approval path: the guest already attached an empty track before
      // capture started. Force a keyframe (and a mute flip) so receivers that
      // painted black don't sit forever on "Waking your screen…".
      try {
        const sender = videoSender as (RTCRtpSender & { generateKeyFrame?: () => Promise<void> }) | null;
        await sender?.generateKeyFrame?.();
      } catch {
        /* optional API */
      }
      try {
        if (videoTrack) {
          videoTrack.enabled = false;
          videoTrack.enabled = true;
        }
      } catch {
        /* ignore */
      }
      if (dataCh?.readyState === "open") dataCh.send(JSON.stringify({ event: "auth", state: "ok" }));
    };

    // Pre-gather a small candidate pool so a reconnect/ICE-restart has paths ready
    // to try immediately instead of waiting on a fresh gathering round.
    pc = new RTCPeerConnection({ iceServers: defaultIceServers(opts.iceServers), iceCandidatePoolSize: 4 });
    // Capture this session's connection so async handlers (auth/approval) can tell
    // whether they're still the live session after an await. A superseded session's
    // late-resolving approval must NOT send its verdict over the *current* session's
    // channels — that was denying a freshly-connected phone before its own prompt
    // even appeared (and the phone treats "denied" as fatal, giving up entirely).
    const myPc = pc;
    // Unique id for THIS peer session. Sent with every offer so the guest can tell
    // an in-place ICE restart (re-route the same live session) from a fresh session.
    const sessionId = Math.random().toString(36).slice(2);
    let iceRestartTimer: number | null = null;
    let deadTimer: number | null = null;
    let restartAttempts = 0;
    const clearRecoveryTimers = () => {
      if (iceRestartTimer) {
        clearTimeout(iceRestartTimer);
        iceRestartTimer = null;
      }
      if (deadTimer) {
        clearTimeout(deadTimer);
        deadTimer = null;
      }
    };

    // Re-route a live-but-degraded session without tearing it down: restartIce()
    // re-gathers candidates and picks a new network path while DTLS, the media
    // tracks, the encoder, and the app-level auth all stay up. This is the
    // AnyDesk-style "the link hiccuped but never dropped" recovery — sub-second and
    // invisible, versus a full rebuild (new offer + re-auth + capture restart).
    const doIceRestart = async () => {
      if (pc !== myPc || !sig || myPc.connectionState === "closed") return;
      try {
        myPc.restartIce();
        const offer = await myPc.createOffer({ iceRestart: true });
        if (pc !== myPc) return; // superseded while awaiting
        await myPc.setLocalDescription(offer);
        sig.send({ type: "offer", sdp: offer.sdp ?? "", sid: sessionId });
      } catch (e) {
        console.warn("[remote] ICE restart failed:", e);
      }
    };

    pipeIce(pc, sig);
    pc.onconnectionstatechange = () => {
      const st = pc?.connectionState;
      if (st === "connected") {
        opts.onClients?.(1);
        applyBitrate();
        restartAttempts = 0;
        clearRecoveryTimers();
      }
      // Transient "disconnected": give ICE a moment to self-heal, then force an ICE
      // restart to re-route — without tearing anything down.
      if (st === "disconnected" && !iceRestartTimer && pc === myPc) {
        iceRestartTimer = window.setTimeout(() => {
          iceRestartTimer = null;
          const s = myPc.connectionState;
          if (s === "disconnected" || s === "failed") {
            restartAttempts++;
            void doIceRestart();
          }
        }, 1200);
      }
      // Hard ICE failure: try an in-place restart first (cheap, keeps the session);
      // only if repeated restarts don't recover within a grace window do we tear the
      // session down — by then the guest's own watchdog is rebuilding anyway.
      if (st === "failed" && pc === myPc) {
        if (restartAttempts < 3) {
          restartAttempts++;
          void doIceRestart();
          if (!deadTimer) {
            deadTimer = window.setTimeout(() => {
              deadTimer = null;
              if (pc === myPc && myPc.connectionState !== "connected") teardownPeer();
            }, 8000);
          }
        } else {
          teardownPeer();
        }
      }
      if (st === "closed") {
        clearRecoveryTimers();
        teardownPeer();
      }
    };

    // Screen now rides a real video track (added before the offer so no
    // renegotiation is needed). control = input, data = stats + events + heartbeat.
    // Channels are created before the offer so no renegotiation is needed.
    // control = input, data = stats + events + heartbeat.
    const control = pc.createDataChannel("control");
    // High-rate pointer moves ride a separate UNORDERED, NO-RETRANSMIT channel:
    // a lost absolute move is superseded by the next one ~16ms later anyway, so
    // retransmitting it only delays fresher input — and on the ordered control
    // stream a lost move head-of-line blocks the clicks/keys queued behind it.
    // The guest anchors a reliable move before every button event (see links.ts),
    // so click positions never depend on the lossy stream.
    const move = pc.createDataChannel("move", { ordered: false, maxRetransmits: 0 });
    const data = pc.createDataChannel("data");
    dataCh = data;
    // Reliable+ordered channel for the WebCodecs direct-video path. Created up
    // front (no renegotiation); carries nothing until the guest opts in.
    const videoCh = pc.createDataChannel("video");
    videoCh.binaryType = "arraybuffer";
    // DIRECT audio: raw float32 PCM. Created up front (no renegotiation); idle
    // until the guest opts in with `{type:"amode",mode:"pcm"}`.
    //
    // Ordered but UNRELIABLE (maxRetransmits: 0 → SCTP partial reliability,
    // RFC 8831): a lost PCM chunk is skipped via FORWARD TSN instead of being
    // retransmitted. Live audio must never wait — on a fully reliable channel a
    // single lost packet head-of-line blocked every chunk behind it for RTT+,
    // and since all channels share one SCTP association, video saturating the
    // link under high motion turned into bursty audio delivery → underrun
    // fade-in/fade-out chop ("robotic" sound). A skipped 10ms chunk is a gap
    // the phone worklet's gain ramp conceals; ordering is still preserved for
    // the messages that do arrive, so no resequencing is needed guest-side.
    const audioCh = pc.createDataChannel("audio", { ordered: true, maxRetransmits: 0 });
    audioCh.binaryType = "arraybuffer";

    // ---- WebCodecs direct-video encoder (bypasses the receiver jitter buffer).
    // The phone's dominant latency term was Chromium's video jitter buffer:
    // `jitterBufferTarget` is only a MINIMUM, and the UA's own estimate (fed by
    // the bursty JPEG→canvas arrival cadence) pinned playout ~170-260ms behind.
    // Encoding H.264 ourselves and shipping it over a data channel lets the guest
    // decode + present each frame the moment it arrives — Moonlight-style — while
    // the WebRTC track stays negotiated as an instant fallback.
    let wcEncoder: VideoEncoder | null = null;
    let wcCodec = "";
    let wcHw: HardwareAcceleration = "prefer-hardware";
    let wcW = 0;
    let wcH = 0;
    let wcBps = 0;
    let wcFps = 0;
    let wcSeq = 0;
    let wcForceKey = false;
    let wcLastKeyAt = 0;
    let wcEncMs = 0; // EWMA encode latency (frame submit → encoded chunk out)
    let wcFrames = 0;
    let wcBytes = 0;
    let wcKeys = 0;
    let wcSkipped = 0;
    let wcErrors = 0; // transient encoder faults; enough of them → wcDead
    let wcDead = false; // hard failure this session — don't retry until a new peer

    const wcTargetBps = () => (quality.bitrate > 0 ? quality.bitrate * 1000 : bitrateFor(quality));

    /** Ship one encoded frame: 20-byte header, then ≤WC_FRAG fragments. The payload is
     *  a view (not a copy) so the native path can forward Rust's bytes as-is. */
    // `Uint8Array<ArrayBuffer>` (not the default `ArrayBufferLike`): RTCDataChannel.send
    // won't take a possibly-SharedArrayBuffer-backed view.
    const wcSendBytes = (payload: Uint8Array<ArrayBuffer>, key: boolean, tsMs: number): boolean => {
      if (videoCh.readyState !== "open") return false;
      const head = new ArrayBuffer(20);
      const dv = new DataView(head);
      dv.setUint8(0, 0x47); // 'G'
      dv.setUint8(1, 0x56); // 'V'
      dv.setUint8(2, key ? 1 : 0);
      dv.setUint8(3, 0);
      dv.setUint32(4, wcSeq++ >>> 0, true);
      dv.setFloat64(8, tsMs, true); // host perf.now() ms at capture
      dv.setUint32(16, payload.byteLength, true);
      try {
        videoCh.send(head);
        for (let off = 0; off < payload.byteLength; off += WC_FRAG) {
          videoCh.send(payload.subarray(off, Math.min(off + WC_FRAG, payload.byteLength)));
        }
      } catch {
        // A partial frame is as harmful as a dropped one for an H.264 P-frame
        // chain. The native caller holds deltas and requests an IDR before it
        // resumes delivery.
        return false;
      }
      wcFrames++;
      wcBytes += payload.byteLength;
      if (key) {
        wcKeys++;
        wcLastKeyAt = performance.now();
      }
      return true;
    };

    const wcSend = (chunk: EncodedVideoChunk) => {
      const payload = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(payload);
      wcSendBytes(new Uint8Array(payload), chunk.type === "key", chunk.timestamp / 1000);
    };

    // ---- native path: Rust already produced the H.264 ------------------------
    // Nothing to encode here — forward the Annex-B frame straight to the guest.
    // Latest-wins still applies: a channel backlog can only ever become latency.
    //
    // First frame MUST announce a codec string on the video channel. The guest
    // builds its VideoDecoder from that JSON; without it every Annex-B frame is
    // dropped and the phone sits on "Waking your screen…" until the 6s opt-in
    // watchdog falls back to RTC. The canvas/WebCodecs path announces during
    // configure — the native path never touches the canvas, so we do it here.
    let nativeAnnounced = false;
    let nativeConfigW = 0;
    let nativeConfigH = 0;
    // HARD gate — set ONLY when the decoder truly cannot make progress on a P-frame:
    // a config/announce change, a channel that dropped mid-frame (partial access unit),
    // or a guest-reported decode stall. While set, P-frames are dropped until the next
    // IDR re-establishes a clean reference chain. NEVER set this for backpressure or
    // the periodic safety-net IDR — those request a recovery keyframe but keep frames
    // flowing (transient artifacts beat a frozen stream under high motion).
    let nativeAwaitKey = false;
    // SOFT recovery — an IDR has been requested but P-frames are still being forwarded.
    // Used by the HUD to surface "artifacting, recovering" without freezing the picture.
    let nativeRecovering = false;
    // A recovery IDR is wanted but the channel is backed up RIGHT NOW. Requesting it
    // mid-burst is counterproductive: the IDR costs ~2 P-frames of budget (2-frame
    // VBV), lands on a full pipe, and gets skipped by the same backpressure that
    // armed it — leaving the guest artifacting forever while NVENC burns budget on
    // IDRs nobody receives. Defer the request until the channel drains instead.
    let nativeRecoveryPending = false;
    let nativeRecoveryPendingAt = 0; // when the deferral started (time-caps the wait)
    let nativeKeyRequestAt = 0;
    let nativeArtifactEvents = 0; // count of soft-recovery armings (HUD "artifacts")
    let nativeRecoveredEvents = 0; // count of clean IDR arrivals that closed a recovery
    const requestNativeKeyframe = () => {
      const now = performance.now();
      // Coalesce capture-rate calls while Rust's atomic request is still pending.
      if (now - nativeKeyRequestAt < 250) return;
      nativeKeyRequestAt = now;
      try {
        void api.remoteRequestKeyframe();
      } catch {
        /* not on desktop / no native encoder */
      }
    };
    /** Arm soft recovery: get an IDR on the way while P-frames keep flowing so the
     *  stream never freezes. Transient artifacting is expected until the IDR lands.
     *  `defer` postpones the actual encoder request until the channel has drained —
     *  used by the backpressure path so the recovery IDR isn't itself skipped. */
    const armNativeRecovery = (defer = false) => {
      if (!nativeRecovering) {
        nativeRecovering = true;
        nativeArtifactEvents++;
      }
      if (defer) {
        if (!nativeRecoveryPending) nativeRecoveryPendingAt = performance.now();
        nativeRecoveryPending = true;
      } else {
        requestNativeKeyframe();
      }
    };
    nativeSink = (payload, key, w = 0, h = 0) => {
      if (videoCh.readyState !== "open") return;
      if (!nativeAnnounced || w !== nativeConfigW || h !== nativeConfigH) {
        nativeAnnounced = true;
        nativeConfigW = w;
        nativeConfigH = h;
        const codec = "avc1.42C028"; // Constrained Baseline — matches NVENC output
        try {
          videoCh.send(JSON.stringify({ codec, w, h }));
        } catch {
          /* guest resyncs from the next announce / keyframe */
        }
        // A decoder configuration/resize genuinely cannot decode a P-frame sent under
        // the old SPS — HARD-gate until the IDR arrives.
        if (!key) nativeAwaitKey = true;
        requestNativeKeyframe();
      }
      // The native path previously ignored `wcKeyMs`, so a decoder fault could live
      // forever. Its periodic IDR is the final safety net for corruption the guest
      // cannot report explicitly. This is a SOFT recovery — keep forwarding so motion
      // scenes don't stall waiting for the IDR to land.
      if (!key && performance.now() - wcLastKeyAt >= quality.wcKeyMs) {
        armNativeRecovery();
      }
      const pace = clamp(quality.pace, 0, 100) / 100;
      const maxBuffered = quality.wcBufKB * 1024 * (1 + pace);
      const buffered = videoCh.bufferedAmount;
      // HARD gate: only set on a true reference-chain break (config/resize/partial AU).
      if (nativeAwaitKey && !key) {
        // Gated frames never reach the send path below, so a deferred recovery
        // request must be able to fire from here too — otherwise a keyframe shed
        // at the 4× ceiling would leave nobody asking for the next one until the
        // guest's own 1s vkf timer noticed.
        if (nativeRecoveryPending && buffered < maxBuffered * 0.5) {
          nativeRecoveryPending = false;
          requestNativeKeyframe();
        }
        return;
      }
      if (!key) {
        if (buffered > maxBuffered) {
          // Backpressure: skip THIS frame (latest-wins) but do NOT gate subsequent
          // P-frames — that was the high-motion freeze. The dropped P-frame may cause
          // a brief artifact on the guest; arm a DEFERRED recovery IDR to clean it up
          // once the channel drains (an IDR requested mid-burst just feeds the burst).
          wcSkipped++;
          armNativeRecovery(true);
          adaptFromBuffer(buffered, maxBuffered, true);
          return;
        }
      } else if (buffered > maxBuffered * 4) {
        // Keyframes are the recovery mechanism — dropping one wedges the guest until
        // the next IDR, which is exactly the "stuck every couple seconds" loop. Let
        // them jump the normal ceiling; only a truly dead channel (4× the budget,
        // several seconds of backlog) may shed one, and then the gates stay armed so
        // the NEXT IDR is still awaited rather than the stream resuming corrupt.
        wcSkipped++;
        armNativeRecovery(true);
        adaptFromBuffer(buffered, maxBuffered, true);
        return;
      }
      adaptFromBuffer(buffered, maxBuffered, false);
      // Stamped on arrival rather than at capture: the host and Rust don't share a
      // clock, and now that a frame is ~30KB instead of 334KB the IPC hop it folds
      // into the measurement is small (it lands in `net+enc`, never unaccounted).
      if (!wcSendBytes(payload, key, performance.now())) {
        // Channel threw mid-frame — the guest received a partial access unit, which
        // IS a true reference-chain break for H.264. HARD-gate until the IDR lands.
        nativeAwaitKey = true;
        armNativeRecovery();
        return;
      }
      if (key) {
        // The IDR is CONFIRMED on the wire (send succeeded) — only now may it close
        // the soft-recovery window and the hard gate. Clearing these before the
        // backpressure check (the old order) let a skipped IDR mark the stream
        // healthy while the guest never received it: the guest kept vkf-ing, each
        // vkf re-armed the hard gate, and the picture froze in a loop.
        if (nativeRecovering) {
          nativeRecoveredEvents++;
          nativeRecovering = false;
        }
        nativeRecoveryPending = false;
        nativeAwaitKey = false;
      } else if (
        nativeRecoveryPending &&
        (buffered < maxBuffered * 0.5 || performance.now() - nativeRecoveryPendingAt > 600)
      ) {
        // The burst that deferred the recovery has drained (or hovered near-full
        // long enough that waiting further just prolongs the artifacting) —
        // request the IDR now; keyframes may jump the ceiling, so it WILL go out.
        nativeRecoveryPending = false;
        requestNativeKeyframe();
      }
    };

    /**
     * Stop the wc path. `notifyGuest` asks the phone to fall back to the track.
     * `permanent` tells it not to bother asking again this session (no encoder at
     * all) — omit it for transient faults so the guest's retry can bring DIRECT
     * back instead of stranding the session on RTC's jitter buffer.
     */
    const wcTeardown = (notifyGuest: boolean, permanent = false) => {
      wcSink = null;
      // Rust must go back to JPEG: the RTC track we're falling back to composites a
      // canvas, and a canvas cannot be fed an H.264 bitstream. Keep `nativeSink`
      // installed — a later DIRECT re-opt-in (guest retry after RTC fallback) only
      // flips CAP_NATIVE_OK; if we null the sink here those GN frames go nowhere
      // and the phone sits on "Waking your screen…" again.
      nativeActive = false;
      nativeAnnounced = false;
      nativeConfigW = 0;
      nativeConfigH = 0;
      nativeAwaitKey = true;
      nativeRecovering = false;
      nativeRecoveryPending = false;
      try {
        api.remoteSetCaptureNative(false);
      } catch {
        /* not on desktop */
      }
      try {
        wcEncoder?.close();
      } catch {
        /* already closed */
      }
      wcEncoder = null;
      wcW = 0;
      wcH = 0;
      if (notifyGuest && dataCh?.readyState === "open") {
        try {
          dataCh.send(JSON.stringify({ event: "vmode", mode: "rtc", permanent }));
        } catch {
          /* ignore */
        }
      }
    };
    wcStop = () => wcTeardown(false);

    /** Encode one composited canvas frame (called from pushFrame via wcSink). */
    const wcEncodeFrame = (canvas: HTMLCanvasElement) => {
      const enc = wcEncoder;
      if (!enc || enc.state === "closed" || videoCh.readyState !== "open") return;
      const w = canvas.width;
      const h = canvas.height;
      if (w < 2 || h < 2) return;
      const bps = wcTargetBps();
      // (Re)configure on size/bitrate/fps changes. Cheap (no encoder rebuild) and
      // the next frame is forced to a keyframe so the guest resyncs instantly.
      if (w !== wcW || h !== wcH || bps !== wcBps || quality.fps !== wcFps) {
        try {
          enc.configure({
            codec: wcCodec,
            width: w,
            height: h,
            bitrate: bps,
            framerate: quality.fps,
            latencyMode: "realtime",
            hardwareAcceleration: wcHw,
            avc: { format: "annexb" },
          });
        } catch (e) {
          // Configure is per size/bitrate/fps, so a rejection here is about THIS
          // shape, not the encoder as a whole — dropping the Res slider can make
          // the very next attempt succeed. Stay retryable.
          wcErrors++;
          const permanent = wcErrors > 3;
          if (permanent) wcDead = true;
          console.warn(
            `[remote] wc encoder configure failed at ${w}×${h} (${wcErrors})${permanent ? " — DIRECT off for this session" : " — will retry"}:`,
            e,
          );
          wcTeardown(true, permanent);
          return;
        }
        wcW = w;
        wcH = h;
        wcBps = bps;
        wcFps = quality.fps;
        wcForceKey = true;
        try {
          videoCh.send(JSON.stringify({ codec: wcCodec, w, h }));
        } catch {
          /* guest resyncs from the next keyframe's in-band SPS/PPS */
        }
      }
      // Latest-wins: a backlog in the channel or the encoder can only ever AGE the
      // stream — skip this frame and let the next one carry the fresher pixels.
      // The "Feel" slider widens how much backlog is tolerated before skipping:
      // dropped frames are what make motion look choppy, so smoothness buys
      // evenness by accepting staleness the responsive end refuses. The Tune
      // panel sets the base ceilings; pace scales them from there.
      const pace = clamp(quality.pace, 0, 100) / 100;
      const maxBuffered = quality.wcBufKB * 1024 * (1 + pace);
      const maxQueue = quality.wcQueueMax + Math.round(pace * 2);
      if (videoCh.bufferedAmount > maxBuffered || enc.encodeQueueSize > maxQueue) {
        wcSkipped++;
        return;
      }
      const key = wcForceKey || performance.now() - wcLastKeyAt > quality.wcKeyMs;
      wcForceKey = false;
      const vf = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
      try {
        enc.encode(vf, { keyFrame: key });
      } catch {
        wcSkipped++;
      } finally {
        vf.close();
      }
    };

    /** Guest opted in: pick a codec, build the encoder, divert the frame feed. */
    const wcActivate = async () => {
      if (wcSink || wcDead || pc !== myPc) return;
      // Let Rust encode with NVENC if it can. When it does, frames arrive already
      // H.264 and `nativeSink` ships them — the canvas/JPEG/WebCodecs chain below is
      // never touched. We still build the WebCodecs encoder underneath as a live
      // safety net: if NVENC faults mid-session Rust silently reverts to JPEG, and
      // the canvas path has to be ready to carry the stream.
      let nativeOk = false;
      try {
        nativeOk = quality.hostNvenc && (await api.remoteSetCaptureNative(true));
      } catch {
        /* not on desktop */
      }
      if (pc !== myPc || wcSink) return; // superseded while awaiting
      if (typeof VideoEncoder === "undefined") {
        // No WebCodecs encoder here. That's only fatal if Rust can't encode either.
        if (nativeOk) {
          // Announce immediately — native frames may already be in flight, and the
          // guest refuses to build a decoder until it sees a codec string.
          try {
            videoCh.send(JSON.stringify({ codec: WC_CODECS[0] }));
          } catch {
            /* guest picks it up from the first-frame announce in nativeSink */
          }
          nativeAnnounced = true;
          return;
        }
        wcDead = true;
        wcTeardown(true, true);
        return;
      }
      // Probe at 4K60 so a codec accepted here always covers the live resolution.
      let picked = "";
      let pickedHw: HardwareAcceleration = "prefer-hardware";
      for (const hw of ["prefer-hardware", "no-preference"] as HardwareAcceleration[]) {
        for (const codec of WC_CODECS) {
          try {
            const r = await VideoEncoder.isConfigSupported({
              codec,
              width: 3840,
              height: 2160,
              bitrate: 12_000_000,
              framerate: 60,
              latencyMode: "realtime",
              hardwareAcceleration: hw,
              avc: { format: "annexb" },
            });
            if (r.supported) {
              picked = codec;
              pickedHw = hw;
              break;
            }
          } catch {
            /* try next */
          }
        }
        if (picked) break;
      }
      if (pc !== myPc || wcSink) return; // superseded while probing
      if (!picked) {
        // Nothing on the H.264 ladder encodes here. Only fatal if Rust can't encode
        // natively either — with NVENC up, DIRECT is perfectly healthy without a
        // webview encoder (we just have no canvas fallback if NVENC later dies).
        if (nativeOk) {
          try {
            videoCh.send(JSON.stringify({ codec: WC_CODECS[0] }));
          } catch {
            /* first-frame announce in nativeSink covers this */
          }
          nativeAnnounced = true;
          return;
        }
        wcDead = true;
        wcTeardown(true, true);
        return;
      }
      wcCodec = picked;
      wcHw = pickedHw;
      // Tell the guest the codec NOW. On the NVENC path the canvas never paints, so
      // wcEncodeFrame's configure-time announce never runs — without this the phone
      // drops every frame and shows "Waking your screen…" until the opt-in timeout.
      if (nativeOk) {
        try {
          videoCh.send(JSON.stringify({ codec: picked }));
          nativeAnnounced = true;
        } catch {
          /* nativeSink's first-frame announce is the backup */
        }
      }
      wcEncoder = new VideoEncoder({
        output: (chunk) => {
          const ms = performance.now() - chunk.timestamp / 1000;
          wcEncMs = wcEncMs === 0 ? ms : wcEncMs * 0.9 + ms * 0.1;
          wcSend(chunk);
        },
        error: (e) => {
          // A single encoder fault used to kill DIRECT for the whole session.
          // Drop to RTC so the screen keeps moving, but stay retryable — the
          // guest re-asks on its backoff and we rebuild. Only give up for good
          // once the encoder proves it's reliably broken.
          wcErrors++;
          const permanent = wcErrors > 3;
          if (permanent) wcDead = true;
          console.warn(
            `[remote] wc encoder error (${wcErrors}) — falling back to the RTC track${permanent ? " for this session" : ", will retry"}:`,
            e,
          );
          wcTeardown(true, permanent);
        },
      });
      wcW = 0; // force configure on the first frame
      wcH = 0;
      wcForceKey = true;
      wcSink = wcEncodeFrame;
    };

    // Video and audio ride SEPARATE media streams on purpose: receivers only
    // lip-sync tracks grouped in the same signaled stream, and that sync makes
    // video wait for the audio jitter buffer. For screen control the freshest
    // frame beats A/V alignment; the phone re-merges them locally for playback.
    const v = await buildVideoTrack();
    if (v) {
      videoTrack = v.track;
      videoSender = pc.addTrack(videoTrack, new MediaStream([videoTrack]));
      startVideoCapture = v.start;
    }
    // Aux pop-out hosts skip desktop audio — the primary session already carries it.
    if (opts.fixedMonitor == null) {
      const a = await buildAudioTrack();
      if (a) {
        audioTrack = a.track;
        pc.addTrack(audioTrack, new MediaStream([audioTrack]));
        startAudioCapture = a.start;
        setAudioDirectSink = a.setDirectSink;
        setAudioDirectCodec = a.setDirectCodec;
        audioStats = a.stats;
        audioFormat = a.format;
      }
    }

    // Prefer H.264 for the screen: hardware encode on the PC and hardware decode
    // on virtually every phone — lower per-frame latency and CPU than software
    // VP8/VP9 at high resolutions. Other codecs stay in the list as fallbacks, so
    // negotiation still succeeds if either end lacks H.264.
    if (videoSender) {
      try {
        const caps = RTCRtpReceiver.getCapabilities("video");
        const h264 = caps?.codecs.filter((c) => /h264/i.test(c.mimeType)) ?? [];
        if (caps && h264.length) {
          const rest = caps.codecs.filter((c) => !/h264/i.test(c.mimeType));
          pc.getTransceivers()
            .find((t) => t.sender === videoSender)
            ?.setCodecPreferences([...h264, ...rest]);
        }
      } catch {
        /* keep default codec order */
      }
    }

    const onControlMsg = async (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string);
        lastGuestMsg = Date.now();
        // Explicit goodbye from the phone (user tapped Disconnect): tear down now
        // instead of waiting ~30s for ICE to notice the peer is gone.
        if (msg && msg.type === "bye") {
          guestNeedsOffer = true;
          teardownPeer();
          return;
        }
        // Auth handshake: the guest sends this on connect. Decide access, and (if
        // the device isn't already trusted) ask the desktop UI to approve it.
        // IDEMPOTENT: guests retry the handshake until they hear a verdict, so an
        // already-authorized session re-acks "ok" instead of staying silent (a lost
        // "ok" used to wedge the phone in "authorizing" until an app restart).
        if (msg && msg.type === "auth") {
          if (authorized) {
            if (dataCh?.readyState === "open") dataCh.send(JSON.stringify({ event: "auth", state: "ok" }));
            return;
          }
          if (authBusy) {
            // A decision is already in flight — restate "pending" so the retrying
            // guest knows it was heard, but never stack a second prompt.
            if (dataCh?.readyState === "open") dataCh.send(JSON.stringify({ event: "auth", state: "pending" }));
            return;
          }
          authBusy = true;
          try {
            const deviceId = String(msg.deviceId ?? "");
            const name = String(msg.name ?? "Phone");
            const secret = typeof msg.secret === "string" ? msg.secret : undefined;
            let level: string;
            try {
              level = await api.remoteCheckAuth(deviceId, name, secret);
            } catch {
              level = "none";
            }
            if (pc !== myPc) return; // session superseded/torn down while we awaited
            if (level !== "none") {
              await authorize();
              return;
            }
            // Untrusted → prompt the user on the desktop.
            if (dataCh?.readyState === "open") dataCh.send(JSON.stringify({ event: "auth", state: "pending" }));
            const decision: ApprovalDecision = opts.onApprovalRequest
              ? await opts.onApprovalRequest({ deviceId, name })
              : { kind: "deny" };
            // A superseded prompt (the store auto-dismissed it because a newer request
            // arrived) is never a refusal — stay completely silent so we don't send a
            // terminal "denied" to a phone that's still waiting. The newer session runs
            // its own prompt and decides. This is the primary guard against "access
            // denied before the PC user chose".
            if (decision.kind === "superseded") return;
            // Bail if this session was replaced while the prompt was open — any verdict
            // now belongs to the OLD session; forwarding it would disturb the new one.
            if (pc !== myPc) return;
            if (decision.kind === "deny") {
              if (dataCh?.readyState === "open") dataCh.send(JSON.stringify({ event: "auth", state: "denied" }));
              teardownPeer();
            } else {
              try {
                await api.remoteGrant(
                  deviceId,
                  name,
                  decision.kind,
                  decision.kind === "temporary" ? decision.durationSecs : undefined,
                );
              } catch {
                /* grant persistence best-effort */
              }
              await authorize();
            }
          } finally {
            authBusy = false;
          }
          return;
        }
        // Guest video-reset request: its decoder is receiving bytes but decoding
        // nothing. Rebuild the canvas + generator track + Rust feed in place
        // (replaceTrack keeps the session/auth) — a fresh encoder emits a fresh
        // keyframe/SPS, which un-wedges a stalled HOST-side pipeline.
        if (msg && msg.type === "vreset") {
          const now = Date.now();
          if (authorized && now - lastVresetAt > 4000) {
            lastVresetAt = now;
            nativeAwaitKey = true;
            // On the native path the canvas/generator track isn't in the picture at
            // all — the equivalent un-wedge is a fresh IDR + SPS from Rust.
            try {
              void api.remoteRequestKeyframe();
            } catch {
              /* not on desktop / no native encoder */
            }
            void rebuildVideoPipeline();
          }
          return;
        }
        // Video-mode negotiation: "wc" = guest can decode H.264 off the data
        // channel (WebCodecs) — no receiver jitter buffer; "rtc" = revert to the
        // WebRTC track (guest decoder failed or the path underperformed there).
        if (msg && msg.type === "vmode") {
          // Guests only ask for "wc" after the auth-ok event, so `authorized` is
          // normally already true; an unauthorized ask is simply ignored (the
          // guest's own timeout then reverts it to the track).
          if (msg.mode === "wc") {
            if (authorized) void wcActivate();
          } else {
            wcTeardown(false);
          }
          return;
        }
        // Audio-mode: "pcm" = DIRECT float32 over the data channel (lean phone
        // worklet); "rtc" = classic Opus track. Mirrors vmode for the sound path.
        if (msg && msg.type === "amode") {
          if (msg.mode === "pcm" && authorized) {
            audioDirect = true;
            // The guest advertises what it can DECODE, in preference order. An
            // older APK sends no list at all → raw f32, byte-for-byte what it
            // expects. Codec selection must finish before the sink is attached,
            // otherwise the first chunks go out in a format the guest hasn't
            // been told about yet.
            const codecs = Array.isArray(msg.codecs)
              ? (msg.codecs as unknown[]).map((c) => String(c))
              : [];
            void (async () => {
              const codec = (await setAudioDirectCodec?.(codecs)) ?? "f32";
              if (pc !== myPc) return; // session replaced while negotiating
              setAudioDirectSink?.(audioCh);
              if (audioTrack) audioTrack.enabled = false;
              if (dataCh?.readyState === "open") {
                try {
                  dataCh.send(JSON.stringify({ event: "amode", mode: "pcm", codec }));
                } catch {
                  /* ignore */
                }
              }
            })();
          } else {
            audioDirect = false;
            setAudioDirectSink?.(null);
            if (audioTrack) audioTrack.enabled = true;
            if (dataCh?.readyState === "open") {
              try {
                dataCh.send(JSON.stringify({ event: "amode", mode: "rtc" }));
              } catch {
                /* ignore */
              }
            }
          }
          return;
        }
        // Guest lost decode sync (error/reconfigure) — resync with a keyframe.
        // Both encoders run an infinite GOP, so without this the guest would wait out
        // the whole keyframe interval staring at nothing.
        if (msg && msg.type === "vkf") {
          wcForceKey = true;
          nativeAwaitKey = true;
          try {
            void api.remoteRequestKeyframe();
          } catch {
            /* not on desktop / no native encoder */
          }
          return;
        }
        // Multi-monitor pop-out: spin up (or keep) an aux host for that display.
        if (msg && msg.type === "auxHost" && typeof msg.monitor === "number") {
          ensureAuxHost(msg.monitor);
          return;
        }
        if (msg && msg.type === "auxStop" && typeof msg.monitor === "number") {
          auxStops.get(msg.monitor)?.();
          auxStops.delete(msg.monitor);
          return;
        }
        // The `quality` message re-tunes the capture + encoder; not an input event.
        if (msg && msg.type === "quality") {
          if (opts.fixedMonitor != null) return; // aux quality is fixed at start
          const prevMaxW = quality.maxW;
          if (typeof msg.maxW === "number") quality.maxW = clamp(msg.maxW, 320, 3840);
          if (typeof msg.quality === "number") quality.jpeg = clamp(msg.quality, 20, 95);
          if (typeof msg.fps === "number") quality.fps = clamp(msg.fps, 1, 120);
          if (typeof msg.bitrate === "number") quality.bitrate = msg.bitrate <= 0 ? 0 : clamp(msg.bitrate, 500, 40000);
          if (msg.mode === "auto" || msg.mode === "text" || msg.mode === "video") quality.mode = msg.mode;
          if (typeof msg.jpegCap === "number") quality.jpegCap = clamp(msg.jpegCap, 40, 95);
          if (typeof msg.bitrateHeadroom === "number") quality.bitrateHeadroom = clamp(msg.bitrateHeadroom, 1.0, 2.5);
          if (typeof msg.minBitrateKbps === "number") quality.minBitrateKbps = clamp(msg.minBitrateKbps, 500, 8000);
          if (typeof msg.startBitrateKbps === "number") quality.startBitrateKbps = clamp(msg.startBitrateKbps, 1000, 20000);
          if (typeof msg.pace === "number") quality.pace = clamp(msg.pace, 0, 100);
          if (typeof msg.wcKeyMs === "number") quality.wcKeyMs = clamp(msg.wcKeyMs, 1000, 30000);
          if (typeof msg.wcBufKB === "number") quality.wcBufKB = clamp(msg.wcBufKB, 64, 1024);
          if (typeof msg.wcQueueMax === "number") quality.wcQueueMax = clamp(msg.wcQueueMax, 1, 6);
          // RTC audio buffer: re-post the envelope so the slider is audible on
          // the live worklet without a reconnect. The worklet only resets its
          // adaptive target when the BASE actually changes, so re-sending an
          // unchanged value is a genuine no-op (quality messages repeat on every
          // connect and twice more after).
          if (typeof msg.audioHostMs === "number") {
            const want = clamp(msg.audioHostMs, 20, 200);
            if (want !== quality.audioHostMs) {
              quality.audioHostMs = want;
              const fmt = audioFormat?.();
              try {
                audioNode?.port.postMessage({
                  cfg: {
                    channels: fmt?.channels ?? 2,
                    captureRate: fmt?.sampleRate ?? audioCtx?.sampleRate ?? 48000,
                    ...audioEnvelope(quality.audioHostMs),
                  },
                });
              } catch {
                /* node torn down */
              }
            }
          }
          // Explicit Tune bitrate change resets the adaptive ceiling so a raise
          // isn't stuck under a previous network-shed floor.
          adaptKbps = targetKbps();
          adaptCleanTicks = 0;
          // Native encode on/off takes effect live — the whole point is to A/B it (or
          // escape a bad picture) without reconnecting. Only meaningful while DIRECT
          // is up; wcActivate reads `quality.hostNvenc` when it isn't.
          if (typeof msg.hostNvenc === "boolean" && msg.hostNvenc !== quality.hostNvenc) {
            quality.hostNvenc = msg.hostNvenc;
            if (wcSink || nativeActive) {
              try {
                void api.remoteSetCaptureNative(quality.hostNvenc);
              } catch {
                /* not on desktop */
              }
              // Turning it OFF hands the stream to a different encoder mid-GOP, so the
              // guest's decoder needs a fresh keyframe from whoever takes over.
              wcForceKey = true;
              if (!quality.hostNvenc) {
                nativeActive = false;
                // No webview encoder to hand off to (a host with NVENC but no
                // WebCodecs): DIRECT has nothing left to produce frames, so drop to
                // the RTC track now rather than let the guest stare at a dead channel
                // until its stall watchdog fires ~12s later.
                if (!wcSink) wcTeardown(true);
              }
            }
          }
          try {
            api.remoteSetCaptureQuality(
              quality.maxW,
              quality.fps,
              jpegForRtc(quality.jpeg, quality.jpegCap),
              CONTENT_NUM[quality.mode] ?? 0,
              // The native encoder needs a real bitrate, not a JPEG quality. Prefer
              // the adaptive value (phone-network shed) when it's running; else the
              // Tune target / auto curve.
              adaptKbps > 0 ? adaptKbps : quality.bitrate,
            );
          } catch {
            /* ignore */
          }
          applyContentHint();
          applyBitrate();
          // Resolution changes resize the canvas mid-stream, which makes some
          // hardware encoders hiccup. Ask for a fresh keyframe once frames at the
          // new size start flowing; a still-wedged encoder is then caught by the
          // encoder-stall watchdog (rebuildVideoPipeline).
          if (quality.maxW !== prevMaxW) {
            window.setTimeout(() => {
              const sender = videoSender as (RTCRtpSender & { generateKeyFrame?: () => Promise<void> }) | null;
              sender?.generateKeyFrame?.().catch(() => {});
            }, 700);
          }
          return;
        }
        // Controller-mode probe: the phone asks whether this PC can create a
        // virtual gamepad (ViGEmBus installed). Answer over the data channel so the
        // phone can prompt the user to install the driver if not. Not an input event.
        if (msg && msg.type === "gamepadprobe") {
          let ok = false;
          try {
            ok = await api.remoteGamepadAvailable();
          } catch {
            ok = false;
          }
          if (dataCh?.readyState === "open")
            dataCh.send(JSON.stringify({ event: "gamepad", available: ok }));
          return;
        }
        // Everything else is an input event — never inject before authorization.
        if (!authorized) return;
        if (opts.fixedMonitor != null) api.remoteInjectOn(opts.fixedMonitor, msg);
        else api.remoteInject(msg);
        // A click can move focus into (or out of) a PC text field. Poll focus a few
        // times right after so the phone learns to pop its keyboard with minimal
        // lag — while the tap's user-activation is still fresh on the phone.
        if (msg && (msg.type === "click" || msg.type === "up")) pokeFocus();
      } catch {
        /* ignore malformed */
      }
    };
    control.onmessage = onControlMsg;
    // Lossy pointer-move stream feeds the same handler (auth gate included).
    move.onmessage = onControlMsg;

    data.onmessage = async (e) => {
      let req: { id?: number; path?: string; body?: any; ping?: number };
      try {
        req = JSON.parse(e.data as string);
      } catch {
        return;
      }
      lastGuestMsg = Date.now();
      // Heartbeat: bounce a pong so the guest can detect a silently-dead link.
      // `t` (host perf clock) lets the guest sync clocks (NTP-style midpoint) and
      // turn per-frame host timestamps into a real end-to-end latency reading.
      if (typeof req.ping === "number") {
        if (data.readyState === "open") data.send(JSON.stringify({ pong: req.ping, t: performance.now() }));
        return;
      }
      if (typeof req.id !== "number" || typeof req.path !== "string") return;
      const id = req.id;
      // Don't answer stats/data requests until the device is authorized.
      if (!authorized) {
        if (data.readyState === "open") data.send(JSON.stringify({ id, ok: false, error: "awaiting approval" }));
        return;
      }
      // Responses can exceed the SCTP max message size (e.g. base64 cover art).
      // Split anything large into ordered chunks the guest reassembles by id.
      const respond = (payloadObj: unknown) => {
        if (data.readyState !== "open") return;
        const payload = JSON.stringify(payloadObj);
        const MAX = 15000;
        if (payload.length <= MAX) {
          data.send(payload);
          return;
        }
        const total = Math.ceil(payload.length / MAX);
        for (let i = 0; i < total; i++) {
          data.send(JSON.stringify({ c: id, i, n: total, s: payload.slice(i * MAX, (i + 1) * MAX) }));
        }
      };
      try {
        const result = await handleData(req.path, req.body);
        respond({ id, ok: true, data: result });
      } catch (err) {
        respond({ id, ok: false, error: String(err) });
      }
    };

    // Watch the PC's focused control; when a text field gains focus, tell the
    // phone so it can pop its keyboard automatically. Also push capture telemetry
    // so the phone's debug HUD can show where the frame-rate bottleneck is.
    let statsTick = 0;
    let lastSend: { bytes: number; at: number } | null = null;
    // Read outbound video RTP stats (send bitrate/fps) + RTT so the desktop Remote
    // page can show a live session panel.
    const readSendStats = async (): Promise<{
      kbps: number;
      fps: number;
      rtt: number;
      keyFramesEncoded: number;
      framesEncoded: number;
      nackCount: number;
      pliCount: number;
      firCount: number;
      qpAvg: number;
      codec: string;
      bytesSent: number;
    }> => {
      const empty = {
        kbps: 0,
        fps: 0,
        rtt: 0,
        keyFramesEncoded: 0,
        framesEncoded: 0,
        nackCount: 0,
        pliCount: 0,
        firCount: 0,
        qpAvg: 0,
        codec: "",
        bytesSent: 0,
      };
      if (!pc) return empty;
      let report: RTCStatsReport;
      try {
        report = await pc.getStats();
      } catch {
        return empty;
      }
      let out: any = null;
      let codecId = "";
      let rtt = 0;
      const codecs = new Map<string, string>();
      report.forEach((s: any) => {
        if (s.type === "codec" && s.mimeType) codecs.set(s.id, String(s.mimeType).replace(/^video\//i, ""));
        if (s.type === "outbound-rtp" && s.kind === "video") {
          out = s;
          codecId = s.codecId ?? "";
        }
        if (s.type === "candidate-pair" && s.nominated && typeof s.currentRoundTripTime === "number") {
          rtt = s.currentRoundTripTime;
        }
      });
      let kbps = 0;
      if (out) {
        const now = out.timestamp ?? Date.now();
        if (lastSend && now > lastSend.at) kbps = Math.round(((out.bytesSent - lastSend.bytes) * 8) / (now - lastSend.at));
        lastSend = { bytes: out.bytesSent, at: now };
      }
      const framesEncoded = out?.framesEncoded ?? 0;
      const qpSum = out?.qpSum ?? 0;
      return {
        kbps,
        fps: Math.round(out?.framesPerSecond ?? 0),
        rtt: Math.round(rtt * 1000),
        keyFramesEncoded: out?.keyFramesEncoded ?? 0,
        framesEncoded,
        nackCount: out?.nackCount ?? 0,
        pliCount: out?.pliCount ?? 0,
        firCount: out?.firCount ?? 0,
        qpAvg: framesEncoded > 0 ? Math.round(qpSum / framesEncoded) : 0,
        codec: codecs.get(codecId) ?? "",
        bytesSent: out?.bytesSent ?? 0,
      };
    };
    data.onopen = () => {
      // If authorization somehow completed before this channel opened, make sure
      // the guest still learns it's allowed (otherwise it stays "pending").
      if (authorized && data.readyState === "open") data.send(JSON.stringify({ event: "auth", state: "ok" }));
      focusTimer = window.setInterval(async () => {
        try {
          const active = await api.remoteTextfieldActive();
          if (active !== lastTextField) {
            lastTextField = active;
            if (data.readyState === "open") data.send(JSON.stringify({ event: "focus", textField: active }));
          }
        } catch {
          /* ignore */
        }
        // Mirror the live desktop cursor shape so the phone's on-screen cursor
        // follows the PC (hand over links, I-beam over text, resize arrows…).
        try {
          const kind = await api.remoteCursorKind();
          if (kind !== lastCursorKind) {
            lastCursorKind = kind;
            if (data.readyState === "open") data.send(JSON.stringify({ event: "cursor", kind }));
          }
        } catch {
          /* ignore */
        }
        // Every ~500ms, forward host capture stats (produced fps, capture/scale/
        // encode ms, frame bytes, native/out resolution) to both the phone HUD and
        // the desktop Remote page's live session panel.
        if (++statsTick % 2 === 0) {
          let cs: RemoteCaptureStats | null = null;
          // `remote_capture_stats` reports the PRIMARY pipeline only, so aux
          // (pop-out) hosts skip it — forwarding it would show the phone the
          // wrong display's telemetry.
          if (opts.fixedMonitor == null) {
            try {
              cs = await api.remoteCaptureStats();
            } catch {
              /* ignore */
            }
          }
          // Primary hosts always read the outbound link stats — the encoder-stall
          // watchdog needs them even when no desktop UI is subscribed. One read
          // feeds the phone HUD, the stall watchdog, and the desktop panel.
          const link =
            opts.fixedMonitor == null || opts.onStats
              ? await readSendStats()
              : {
                  kbps: 0,
                  fps: 0,
                  rtt: 0,
                  keyFramesEncoded: 0,
                  framesEncoded: 0,
                  nackCount: 0,
                  pliCount: 0,
                  firCount: 0,
                  qpAvg: 0,
                  codec: "",
                  bytesSent: 0,
                };
          if (cs && opts.fixedMonitor == null && data.readyState === "open") {
            // Periodic adapt even when no frames were skipped this tick — a slow
            // drain (fill 0.2–0.5) still wants a gentle shed before it hits the wall.
            if (nativeActive || wcSink) {
              const pace = clamp(quality.pace, 0, 100) / 100;
              const maxBuf = quality.wcBufKB * 1024 * (1 + pace);
              adaptFromBuffer(videoCh.bufferedAmount, maxBuf, false);
            }
            try {
              data.send(
                JSON.stringify({
                  event: "capstats",
                  stats: cs,
                  rtc: {
                    sendKbps: link.kbps,
                    sendFps: link.fps,
                    rtt: link.rtt,
                    keyFrames: link.keyFramesEncoded,
                    framesEnc: link.framesEncoded,
                    nack: link.nackCount,
                    pli: link.pliCount,
                    fir: link.firCount,
                    qp: link.qpAvg,
                    codec: link.codec,
                    encMaxKbps: Math.round(appliedCapBps / 1000),
                    jpegQ: jpegForRtc(quality.jpeg, quality.jpegCap),
                    content: quality.mode,
                  },
                  // DIRECT-path telemetry (all cumulative except encMs/buf). Live
                  // whenever EITHER encoder is feeding the video channel: `nativeSink`
                  // (Rust/NVENC) or `wcSink` (webview WebCodecs).
                  wc:
                    wcSink || nativeActive
                      ? {
                          on: true,
                          // `native` tells the HUD which encoder produced these
                          // numbers — "H264 enc 1.2ms" is only believable with it.
                          native: nativeActive,
                          codec: nativeActive ? "NVENC/H264" : wcCodec,
                          // On the native path the webview never encodes, so wcEncMs
                          // would sit at 0 forever; report Rust's real NVENC time.
                          encMs: nativeActive
                            ? Math.round((cs?.encodeMs ?? 0) * 10) / 10
                            : Math.round(wcEncMs * 10) / 10,
                          frames: wcFrames,
                          bytes: wcBytes,
                          keys: wcKeys,
                          skipped: wcSkipped,
                          bufKB: Math.round(videoCh.bufferedAmount / 1024),
                          kbpsMax: Math.round((adaptKbps > 0 ? adaptKbps : wcTargetBps() / 1000)),
                          adaptKbps: Math.round(adaptKbps),
                          targetKbps: targetKbps(),
                          // Artifact / recovery telemetry for the HUD. The host is the
                          // single source of truth: it knows every backpressure skip,
                          // every soft-recovery arming, and every clean IDR that closed
                          // one. `recovering` flips true the moment a soft recovery is
                          // armed and false when the IDR lands — the phone shows
                          // "artifacting, recovering" while this is true.
                          artifacts: nativeArtifactEvents,
                          recovered: nativeRecoveredEvents,
                          recovering: nativeRecovering,
                        }
                      : { on: false },
                  // Audio path telemetry for the phone HUD. `codec` says whether
                  // DIRECT is paying 128kbps (Opus) or ~3.1Mbps (raw f32), and
                  // `dropped` counts chunks the backpressure guard refused —
                  // a climbing count means the link can't even carry the audio.
                  audio: {
                    mode: audioDirect ? "pcm" : "rtc",
                    chBufKB: Math.round((audioCh.bufferedAmount || 0) / 1024),
                    codec: audioStats?.().codec ?? "f32",
                    dropped: audioStats?.().dropped ?? 0,
                  },
                  at: Date.now(),
                }),
              );
            } catch {
              /* ignore */
            }
          }
          // Capture-stall watchdog: if we're authorized and connected but the Rust
          // capture stops producing frames (internal error / device change), restart
          // it in place so the session self-heals without a full rebuild.
          // PRIMARY host only: `remote_capture_stats` reports the primary pipeline
          // (aux pipelines don't write those counters), so an aux host watching it
          // would misread the primary's idle counter as "my capture wedged" and
          // call remoteStopCapture() — killing the PRIMARY session's screen from a
          // pop-out tab, over and over.
          if (cs && authorized && opts.fixedMonitor == null && pc?.connectionState === "connected") {
            if (cs.producedFrames === lastProduced) {
              if (!zeroSince) zeroSince = Date.now();
              else if (Date.now() - zeroSince > 5000) {
                zeroSince = 0;
                lastProduced = -1;
                try {
                  api.remoteStopCapture();
                  await startVideoCapture?.();
                } catch {
                  /* retry next tick */
                }
              }
            } else {
              lastProduced = cs.producedFrames;
              zeroSince = 0;
            }
          }
          // Encoder-stall watchdog: Rust producing frames at a real rate while the
          // WebRTC encoder sends 0 fps for ~5s means the encoder wedged (classic
          // trigger: a mid-stream resolution increase). Rebuild the track in place.
          if (cs && authorized && opts.fixedMonitor == null && pc?.connectionState === "connected") {
            const now = Date.now();
            let producedRate = 0;
            if (stallProduced >= 0 && now > stallProducedAt) {
              producedRate = ((cs.producedFrames - stallProduced) * 1000) / (now - stallProducedAt);
            }
            stallProduced = cs.producedFrames;
            stallProducedAt = now;
            // wc mode intentionally starves the WebRTC encoder (frames go out the
            // data channel instead) — 0 RTP fps is healthy then, not a stall.
            if (producedRate > 3 && link.fps === 0 && !wcSink) {
              encStallTicks++;
              if (encStallTicks >= 10) {
                encStallTicks = -30; // ~15s cooldown before it may fire again
                void rebuildVideoPipeline();
              }
            } else if (encStallTicks > 0) {
              encStallTicks = 0;
            } else if (encStallTicks < 0) {
              encStallTicks++; // count the cooldown back up to 0
            }
          }
          if (opts.onStats) {
            opts.onStats({
              capture: cs,
              sendKbps: link.kbps,
              sendFps: link.fps,
              rttMs: link.rtt,
              connState: pc?.connectionState ?? "unknown",
              content: CONTENT_NUM[quality.mode] ?? 0,
              encoderMaxKbps: Math.round(appliedCapBps / 1000),
            });
          }
        }
      }, 250);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sig.send({ type: "offer", sdp: offer.sdp ?? "", sid: sessionId });
  };

  // Keep a signaling socket alive for the whole host lifetime, reconnecting with
  // backoff. The guest re-joins on its own drops, which lands here as peer-joined
  // and rebuilds the peer — so recovery is automatic on both sides.
  const connectSignaling = () => {
    if (stopped || hostReplaced) return;
    const mySig = new Signaling(opts.signalUrl, opts.code, "host");
    sig = mySig;
    mySig.onMessage(async (m) => {
      // Drop events from superseded sockets — a message delivered to an old
      // socket right as we swap in a new one must not drive current state.
      if (stopped || sig !== mySig) return;
      if (m.type === "replaced") {
        // Another host instance took over this room. Every monitor pop-out now
        // has its own room, so a live collision means a second app instance is
        // hosting the same code — stand down (newest wins) instead of fighting.
        console.warn("[remote] another host took over the signaling room — standing down");
        hostReplaced = true;
        teardownPeer();
        return;
      }
      if (m.type === "peer-joined") {
        // A "peer-joined" can be an echo of a guest that's *already* attached:
        // when our own signaling socket drops and reconnects, the server
        // re-announces every peer in the room. Rebuilding then would kill a
        // healthy session. BUT: after an explicit bye / peer-left the guest is
        // gone even if ICE hasn't noticed yet — `guestNeedsOffer` forces a new
        // offer so immediate reconnect doesn't hang waiting for one.
        const liveSession =
          !guestNeedsOffer &&
          pc?.connectionState === "connected" &&
          Date.now() - lastGuestMsg < 8000;
        if (!liveSession) {
          guestNeedsOffer = false;
          await startPeer();
        }
      } else if (m.type === "answer" && pc) {
        // Munge the guest's answer so the video encoder starts near its working
        // bitrate instead of ramping up from Chromium's ~300kbps default.
        await pc.setRemoteDescription({
          type: "answer",
          sdp: boostStartBitrate(m.sdp, quality.startBitrateKbps, Math.min(quality.minBitrateKbps, 4000)),
        });
      } else if (m.type === "candidate" && pc) {
        try {
          await pc.addIceCandidate(m.candidate);
        } catch {
          /* ignore */
        }
      } else if (m.type === "peer-left") {
        // Guest signaling socket closed. Always mark that the next join needs a
        // fresh offer — keeping a zombie PC "live" across an immediate reconnect
        // is what stranded phones on auth / "Waiting for PC".
        guestNeedsOffer = true;
        // If the peer link is already dead, tear capture down now; if ICE is
        // still connected, leave it until bye / ICE failure / the next join
        // rebuilds (startPeer → teardownPeer).
        if (pc?.connectionState !== "connected") teardownPeer();
      }
    });
    mySig.onClose(() => {
      if (stopped || sig !== mySig) return;
      scheduleSignalingRetry();
    });
    mySig
      .connect()
      .then(() => {
        sigBackoff = 1000; // reset backoff on a good connect
      })
      .catch(() => {
        scheduleSignalingRetry();
      });
  };

  const scheduleSignalingRetry = () => {
    if (stopped || hostReplaced || sigRetry !== null) return;
    const wait = sigBackoff;
    sigBackoff = Math.min(sigBackoff * 2, 30000);
    sigRetry = window.setTimeout(() => {
      sigRetry = null;
      try {
        sig?.close();
      } catch {
        /* ignore */
      }
      connectSignaling();
    }, wait);
  };

  connectSignaling();

  return () => {
    stopped = true;
    if (sigRetry !== null) {
      clearTimeout(sigRetry);
      sigRetry = null;
    }
    for (const stop of auxStops.values()) stop();
    auxStops.clear();
    teardownPeer();
    sig?.close();
    sig = null;
  };
}
