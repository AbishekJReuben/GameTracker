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
  | { kind: "deny" };

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
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const CONTENT_NUM: Record<string, number> = { auto: 0, text: 1, video: 2 };
/** Video-track content hint + bitrate-degradation preference per content mode. */
function trackTuning(mode: string): { hint: string; degrade: RTCDegradationPreference } {
  if (mode === "text") return { hint: "detail", degrade: "maintain-resolution" };
  if (mode === "video") return { hint: "motion", degrade: "maintain-framerate" };
  return { hint: "text", degrade: "balanced" };
}

/** Map the phone's quality knobs to a WebRTC encoder bitrate ceiling (bps). */
function bitrateFor(q: { maxW: number; jpeg: number; fps: number }): number {
  const h = Math.round((q.maxW * 9) / 16);
  const px = q.maxW * h;
  const bpp = 0.06 * (q.jpeg / 70); // ~0.06 bits/pixel at "quality 70"
  return Math.round(clamp(px * q.fps * bpp, 500_000, 40_000_000));
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
  let audioNode: ScriptProcessorNode | null = null;
  let focusTimer: number | null = null;
  let lastTextField = false;
  let sigBackoff = 1000;
  let sigRetry: number | null = null;
  // Timestamp of the last message from the phone (input, quality, or heartbeat
  // ping — the guest pings every 5s while alive). Used to tell a *live* session
  // apart from a zombie one when signaling-level join/leave notices arrive.
  let lastGuestMsg = 0;

  // Live stream-quality state; the guest re-tunes it over the control channel.
  // `bitrate` is kbps (0 = auto: derive from resolution/fps via bitrateFor).
  const quality = { maxW: 1600, jpeg: 70, fps: opts.fps ?? 30, mode: "auto" as string, bitrate: 0 };

  const stopCapture = () => {
    try {
      api.remoteStopCapture();
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
    const capBps = quality.bitrate > 0 ? quality.bitrate * 1000 : bitrateFor(quality);
    const p = sender.getParameters();
    if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
    p.encodings[0].maxBitrate = capBps;
    p.encodings[0].maxFramerate = quality.fps;
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

  // Rapid focus re-checks right after a click, so the phone hears about a newly
  // focused PC text field within ~100ms (fast enough that the tap's transient
  // user-activation on the phone can still raise the soft keyboard).
  const pokeFocus = () => {
    let n = 0;
    const tick = async () => {
      if (!dataCh || dataCh.readyState !== "open") return;
      try {
        const active = await api.remoteTextfieldActive();
        if (active !== lastTextField) {
          lastTextField = active;
          dataCh.send(JSON.stringify({ event: "focus", textField: active }));
        }
      } catch {
        /* ignore */
      }
      if (++n < 4) window.setTimeout(tick, 90);
    };
    window.setTimeout(tick, 40);
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
    const pushFrame = () => {
      if (!writer || pendingWrites > 2) return;
      try {
        const vf = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
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
        jobs.push({ y, p: createImageBitmap(new Blob([jpg], { type: "image/jpeg" })) });
      }
      const bmps = await Promise.all(jobs.map((j) => j.p));
      bmps.forEach((bmp, i) => {
        cctx?.drawImage(bmp, 0, jobs[i].y);
        bmp.close?.();
      });
    };

    const drawFull = async (bytes: ArrayBuffer) => {
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
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
    const start = () => api.remoteStartCapture(ch, quality.maxW, quality.fps, quality.jpeg);
    return { track, start };
  };

  /**
   * Build a WebRTC **audio** track fed by Rust WASAPI-loopback PCM: float32 frames
   * stream over a binary channel into a small jitter buffer, and a ScriptProcessor
   * pulls from it into a `MediaStreamAudioDestinationNode` whose track we add to the
   * peer connection. Underruns emit silence (no glitchy repeats); we cap the buffer
   * so audio can't drift far behind the screen.
   */
  const buildAudioTrack = async (): Promise<{ track: MediaStreamTrack; start: () => Promise<void> } | null> => {
    // Interleaved float32 chunks + a read head, acting as a bounded jitter buffer.
    let chunks: Float32Array[] = [];
    let head = 0;
    let avail = 0;
    // WASAPI shared-mode loopback is 48 kHz stereo in practice; we build the graph
    // eagerly (for the offer) at that assumption and correct the channel count when
    // capture actually starts. Capture is DEFERRED until the guest is authorized.
    let channels = 2;

    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (buf) => {
      const f32 = new Float32Array(buf as unknown as ArrayBuffer);
      chunks.push(f32);
      avail += f32.length;
      // Keep at most ~400ms of audio buffered (drop oldest) so it stays in sync.
      const cap = (audioCtx?.sampleRate ?? 48000) * channels * 0.4;
      while (avail > cap && chunks.length > 1) {
        avail -= chunks[0].length - head;
        chunks.shift();
        head = 0;
      }
    };

    try {
      audioCtx = new AudioContext({ sampleRate: 48000 });
    } catch {
      audioCtx = new AudioContext();
    }
    audioCtx.resume().catch(() => {}); // webview autoplay policy may suspend it
    const dest = audioCtx.createMediaStreamDestination();
    const FRAME = 2048;

    const pullInterleaved = (need: number): Float32Array => {
      const out = new Float32Array(need);
      let got = 0;
      while (got < need && chunks.length) {
        const c = chunks[0];
        const take = Math.min(need - got, c.length - head);
        out.set(c.subarray(head, head + take), got);
        got += take;
        head += take;
        avail -= take;
        if (head >= c.length) {
          chunks.shift();
          head = 0;
        }
      }
      return out; // remainder stays zero (silence) on underrun
    };

    const node = audioCtx.createScriptProcessor(FRAME, 0, channels);
    node.onaudioprocess = (e) => {
      const out = e.outputBuffer;
      const inter = pullInterleaved(FRAME * channels);
      for (let c = 0; c < channels; c++) {
        const od = out.getChannelData(c);
        for (let i = 0; i < FRAME; i++) od[i] = inter[i * channels + c];
      }
    };
    node.connect(dest);
    audioNode = node;
    const track = dest.stream.getAudioTracks()[0] ?? null;
    if (!track) return null;
    const start = async () => {
      const fmt = await api.remoteStartAudio(ch);
      if (fmt) channels = Math.max(1, Math.min(2, fmt.channels));
    };
    return { track, start };
  };

  const startPeer = async () => {
    teardownPeer(); // reset any prior session
    if (!sig) return;
    // Access gate: the screen/audio capture and input injection stay off until the
    // guest is authorized (trusted device, correct secret, or user approval).
    let authorized = false;
    let startVideoCapture: (() => Promise<void>) | null = null;
    let startAudioCapture: (() => Promise<void>) | null = null;
    // Capture-stall watchdog bookkeeping (restart capture if it wedges).
    let lastProduced = -1;
    let zeroSince = 0;

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
      if (dataCh?.readyState === "open") dataCh.send(JSON.stringify({ event: "auth", state: "ok" }));
    };

    pc = new RTCPeerConnection({ iceServers: defaultIceServers(opts.iceServers) });
    // Capture this session's connection so async handlers (auth/approval) can tell
    // whether they're still the live session after an await. A superseded session's
    // late-resolving approval must NOT send its verdict over the *current* session's
    // channels — that was denying a freshly-connected phone before its own prompt
    // even appeared (and the phone treats "denied" as fatal, giving up entirely).
    const myPc = pc;
    pipeIce(pc, sig);
    pc.onconnectionstatechange = () => {
      const st = pc?.connectionState;
      if (st === "connected") {
        opts.onClients?.(1);
        applyBitrate();
      }
      // Don't tear down on transient "disconnected" — WebRTC/ICE may recover, and
      // the guest re-joins (→ peer-joined) to rebuild if it can't. Only a hard
      // failure/close ends the session.
      if (st === "failed" || st === "closed") teardownPeer();
    };

    // Screen now rides a real video track (added before the offer so no
    // renegotiation is needed). control = input, data = stats + events + heartbeat.
    // Channels are created before the offer so no renegotiation is needed.
    // control = input, data = stats + events + heartbeat.
    const control = pc.createDataChannel("control");
    const data = pc.createDataChannel("data");
    dataCh = data;

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
    const a = await buildAudioTrack();
    if (a) {
      audioTrack = a.track;
      pc.addTrack(audioTrack, new MediaStream([audioTrack]));
      startAudioCapture = a.start;
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
          teardownPeer();
          return;
        }
        // Auth handshake: the guest sends this on connect. Decide access, and (if
        // the device isn't already trusted) ask the desktop UI to approve it.
        if (msg && msg.type === "auth") {
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
          // Bail if this session was replaced while the prompt was open. The store
          // auto-denies a superseded request, but that verdict belongs to the OLD
          // session — forwarding it here would kill the new, healthy one.
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
          return;
        }
        // The `quality` message re-tunes the capture + encoder; not an input event.
        if (msg && msg.type === "quality") {
          if (typeof msg.maxW === "number") quality.maxW = clamp(msg.maxW, 320, 3840);
          if (typeof msg.quality === "number") quality.jpeg = clamp(msg.quality, 20, 95);
          if (typeof msg.fps === "number") quality.fps = clamp(msg.fps, 1, 120);
          if (typeof msg.bitrate === "number") quality.bitrate = msg.bitrate <= 0 ? 0 : clamp(msg.bitrate, 500, 40000);
          if (msg.mode === "auto" || msg.mode === "text" || msg.mode === "video") quality.mode = msg.mode;
          try {
            api.remoteSetCaptureQuality(quality.maxW, quality.fps, quality.jpeg, CONTENT_NUM[quality.mode] ?? 0);
          } catch {
            /* ignore */
          }
          applyContentHint();
          applyBitrate();
          return;
        }
        // Everything else is an input event — never inject before authorization.
        if (!authorized) return;
        api.remoteInject(msg);
        // A click can move focus into (or out of) a PC text field. Poll focus a few
        // times right after so the phone learns to pop its keyboard with minimal
        // lag — while the tap's user-activation is still fresh on the phone.
        if (msg && (msg.type === "click" || msg.type === "up")) pokeFocus();
      } catch {
        /* ignore malformed */
      }
    };
    control.onmessage = onControlMsg;

    data.onmessage = async (e) => {
      let req: { id?: number; path?: string; body?: any; ping?: number };
      try {
        req = JSON.parse(e.data as string);
      } catch {
        return;
      }
      lastGuestMsg = Date.now();
      // Heartbeat: bounce a pong so the guest can detect a silently-dead link.
      if (typeof req.ping === "number") {
        if (data.readyState === "open") data.send(JSON.stringify({ pong: req.ping }));
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
    const readSendStats = async (): Promise<{ kbps: number; fps: number; rtt: number }> => {
      if (!pc) return { kbps: 0, fps: 0, rtt: 0 };
      let report: RTCStatsReport;
      try {
        report = await pc.getStats();
      } catch {
        return { kbps: 0, fps: 0, rtt: 0 };
      }
      let out: any = null;
      let rtt = 0;
      report.forEach((s: any) => {
        if (s.type === "outbound-rtp" && s.kind === "video") out = s;
        if (s.type === "candidate-pair" && s.nominated && typeof s.currentRoundTripTime === "number") rtt = s.currentRoundTripTime;
      });
      let kbps = 0;
      if (out) {
        const now = out.timestamp ?? Date.now();
        if (lastSend && now > lastSend.at) kbps = Math.round(((out.bytesSent - lastSend.bytes) * 8) / (now - lastSend.at));
        lastSend = { bytes: out.bytesSent, at: now };
      }
      return { kbps, fps: Math.round(out?.framesPerSecond ?? 0), rtt: Math.round(rtt * 1000) };
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
        // Every ~500ms, forward host capture stats (produced fps, capture/scale/
        // encode ms, frame bytes, native/out resolution) to both the phone HUD and
        // the desktop Remote page's live session panel.
        if (++statsTick % 2 === 0) {
          let cs: RemoteCaptureStats | null = null;
          try {
            cs = await api.remoteCaptureStats();
            if (data.readyState === "open") data.send(JSON.stringify({ event: "capstats", stats: cs, at: Date.now() }));
          } catch {
            /* ignore */
          }
          // Capture-stall watchdog: if we're authorized and connected but the Rust
          // capture stops producing frames (internal error / device change), restart
          // it in place so the session self-heals without a full rebuild.
          if (cs && authorized && pc?.connectionState === "connected") {
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
          if (opts.onStats) {
            const link = await readSendStats();
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
    sig.send({ type: "offer", sdp: offer.sdp ?? "" });
  };

  // Keep a signaling socket alive for the whole host lifetime, reconnecting with
  // backoff. The guest re-joins on its own drops, which lands here as peer-joined
  // and rebuilds the peer — so recovery is automatic on both sides.
  const connectSignaling = () => {
    if (stopped) return;
    sig = new Signaling(opts.signalUrl, opts.code, "host");
    sig.onMessage(async (m) => {
      if (stopped) return;
      if (m.type === "peer-joined") {
        // A "peer-joined" can be an echo of a guest that's *already* attached:
        // when our own signaling socket drops and reconnects, the server
        // re-announces every peer in the room. Rebuilding then would kill a
        // healthy session. The guest heartbeats every 5s, so "connected +
        // recent traffic" means the live link doesn't need a new offer. A guest
        // that genuinely rejoined has stopped pinging (it closed its peer
        // connection first), so its join passes this check — at worst after its
        // ~8s offer-timeout retry.
        const liveSession = pc?.connectionState === "connected" && Date.now() - lastGuestMsg < 8000;
        if (!liveSession) await startPeer();
      } else if (m.type === "answer" && pc) {
        await pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
      } else if (m.type === "candidate" && pc) {
        try {
          await pc.addIceCandidate(m.candidate);
        } catch {
          /* ignore */
        }
      } else if (m.type === "peer-left") {
        // Only the guest's *signaling* socket closed. If the peer link is live,
        // keep serving — the phone tells us directly (bye / heartbeat silence /
        // ICE failure) when the session itself ends.
        if (pc?.connectionState !== "connected") teardownPeer();
      }
    });
    sig.onClose(() => {
      if (stopped) return;
      scheduleSignalingRetry();
    });
    sig
      .connect()
      .then(() => {
        sigBackoff = 1000; // reset backoff on a good connect
      })
      .catch(() => {
        scheduleSignalingRetry();
      });
  };

  const scheduleSignalingRetry = () => {
    if (stopped || sigRetry !== null) return;
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
    teardownPeer();
    sig?.close();
    sig = null;
  };
}
