/**
 * Phone-side WebRTC **guest**. Joins the signaling room by connection code, accepts
 * the host's offer, and exposes:
 *   - request(path)   : id-correlated stats request over the "data" channel
 *   - onStream(cb)    : the inbound screen video track (WebRTC media, hardware-decoded)
 *   - onEvent(cb)     : unsolicited host events (e.g. PC text-field focus)
 *   - onFrame(cb)     : legacy base64 JPEG frames (LAN fallback only)
 *   - sendControl(m)  : input events over the "control" channel
 *
 * The connection is **self-healing**: once it has connected at least once, any drop
 * (peer left, ICE failure, signaling hiccup, or a silently-wedged link caught by
 * the data-channel heartbeat) schedules a reconnect with exponential backoff, so
 * the phone reattaches automatically when the PC comes back — no re-pairing needed.
 */

import { Signaling, defaultIceServers, pipeIce, type IceServer } from "@/lib/rtc";
import audioFeederWorkletUrl from "@/lib/audioFeeder.worklet.js?url";
import {
  feedNativeDecoder,
  getNativeDecoderStats,
  initNativeDecoder,
  nativeDecoderPossible,
  nativeFeedReady,
  probeNativeDecoder,
  resetNativeDecoder,
  teardownNativeDecoder,
} from "./nativeDecoder";
import { isImmersiveActive, onImmersiveActiveChange } from "./runtime";
import { loadStreamTune, resetStreamTune, type StreamTune } from "./streamTune";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
/** "pending" = link up, awaiting host approval; "denied" = host rejected us. */
export type Status = RTCPeerConnectionState | "error" | "pending" | "denied";
type HostEvent = { event: string; [k: string]: unknown };

export type ConnectPhase =
  | "idle"
  | "signaling"
  | "waiting_offer"
  | "negotiating"
  | "authenticating"
  | "pending_approval"
  | "connected"
  | "reconnecting"
  | "denied";

/** Where the auth handshake actually is (independent of the coarse phase). */
export type AuthState = "none" | "sent" | "pending" | "ok" | "denied";

/**
 * Low-level connection diagnostics for the progress UI — the REAL states of the
 * signaling socket, the peer connection, the data channels, and the auth
 * handshake, so a stuck stage shows exactly which layer is wedged.
 */
export type ConnectDetail = {
  /** How long the connection has sat in the current phase (ms). */
  phaseMs: number;
  /** Signaling WebSocket state. */
  sig: string;
  /** RTCPeerConnection connectionState. */
  pc: string;
  /** ICE connection state. */
  ice: string;
  /** ICE gathering state. */
  gather: string;
  /** SDP signaling state (offer/answer machine). */
  sdp: string;
  /** Data-channel readyStates: control / data / video. */
  chCtl: string;
  chData: string;
  chVid: string;
  /** Offers received from the host this session. */
  offers: number;
  /** ICE candidates received from the host. */
  candIn: number;
  /** Auth handshake state + how many times we've asked + ms since the last ask. */
  authState: AuthState;
  authSent: number;
  authAgeMs: number;
  /** Whether a permanent key is saved for this PC. */
  hasSecret: boolean;
  /** Current host session id (short), if any. */
  sid?: string;
  /** Last notable transition (e.g. "offer received", "auth re-sent") + age. */
  lastEvent: string;
  lastEventAgoMs: number;
};

export type ConnectSnapshot = {
  phase: ConnectPhase;
  status: Status;
  attempt: number;
  backoffMs: number;
  iceState?: RTCIceConnectionState;
  job: string;
  detail: ConnectDetail;
};

/** Identity + optional secret key the host uses to authorize this device. */
export interface AuthInfo {
  deviceId: string;
  name: string;
  secret?: string;
}

/** Decode-side WebRTC video telemetry, sampled from `RTCPeerConnection.getStats`. */
export type RtcInboundVideoStats = {
  framesPerSecond: number;
  framesDecoded: number;
  framesDropped: number;
  bytesReceived: number;
  frameWidth: number;
  frameHeight: number;
  jitter: number;
  packetsLost: number;
  freezeCount: number;
  /** Round-trip time (ms) over the active ICE candidate pair (0 if unknown). */
  rttMs: number;
  /** Cumulative seconds frames sat in the receiver jitter buffer (delta / emitted = dwell). */
  jitterBufferDelay: number;
  /** Cumulative frames emitted from the jitter buffer (pairs with jitterBufferDelay). */
  jitterBufferEmittedCount: number;
  /** Cumulative seconds spent decoding (delta / framesDecoded = per-frame decode ms). */
  totalDecodeTime: number;
  /** App-requested jitterBufferTarget currently applied (ms). */
  jitterTargetMs: number;
  /** UA's own minimum delay estimate (ms) — when this ≫ target, A/V sync or network is padding. */
  jitterBufferMinimumMs: number;
  /** Packets received (cumulative). */
  packetsReceived: number;
  /** NACK count (receiver asked for retransmits). */
  nackCount: number;
  /** PLI count (picture loss → keyframe requests). */
  pliCount: number;
  /** FIR count (full intra requests). */
  firCount: number;
  /** Keyframes decoded (cumulative). */
  keyFramesDecoded: number;
  /** Frames rendered (if reported). */
  framesRendered: number;
  at: number;
};

/** Live telemetry for the DIRECT audio path (PCM over data channel). */
export type AudioStats = {
  /** "pcm" = DIRECT data-channel path; "rtc" = classic WebRTC Opus track. */
  mode: "pcm" | "rtc";
  /** Phone-side playout buffer (ms), DIRECT only. */
  bufMs: number;
  /** Target the worklet is steering toward (ms). */
  targetMs: number;
  /** Cumulative underruns this session. */
  underruns: number;
  /** Inbound PCM bitrate (kbps) over the last ~1s, DIRECT only. */
  kbps: number;
};

/** Live telemetry for the WebCodecs direct-video path (data-channel H.264). */
export type WcStats = {
  active: boolean;
  /** Decoded frames per second over the last ~1s window. */
  fps: number;
  /** Inbound video bitrate (kbps) over the last ~1s window. */
  kbps: number;
  frames: number;
  keyFrames: number;
  bytes: number;
  /** Average encoded frame size over the last window (KB). */
  avgFrameKB: number;
  /** Arrival → decoded-frame-out latency, EWMA (includes decoder queueing). */
  decodeMs: number;
  /** Host frame-capture → decoded on phone, clock-synced EWMA (excludes render). */
  e2eMs: number;
  /** Host frame-capture → arrival on phone, clock-synced EWMA (host encode + network). */
  netMs: number;
  /** Frames sitting in the decoder right now. */
  queue: number;
  codec: string;
  /** RTT of the best clock-sync sample (quality of the e2e estimate). */
  clockRttMs: number;
  /** True when Annex-B is decoded by native MediaCodec → Surface (APK only). */
  native?: boolean;
  /** Cumulative artifact events the host reported this session (backpressure skips
   *  + soft-recovery armings). Lets the HUD show "artifacts: N" without parsing
   *  encoder internals. */
  artifacts?: number;
  /** Cumulative clean recoveries (IDRs that closed a soft-recovery window). */
  recovered?: number;
  /** True when the host has an outstanding recovery IDR but is still forwarding
   *  P-frames — the picture may show transient artifacting until the IDR lands. */
  recovering?: boolean;
  /** Cumulative guest-side decode errors that armed a keyframe request. */
  guestErrors?: number;
};

const HEARTBEAT_MS = 5000; // ping cadence
const HEARTBEAT_DEAD_MS = 13000; // no pong within this → treat link as dead
const OFFER_TIMEOUT_MS = 8000; // joined the room but no offer arrived → rejoin
const BACKOFF_MIN = 1500;
const BACKOFF_MAX = 30000;
const WATCHDOG_MS = 3000; // health-check cadence
const HARD_RESET_MS = 60000; // transport down this long → full teardown + rebuild
// First-connection wedges (cold start) get a much shorter fuse: nothing is
// established yet, so a fast clean rebuild beats waiting out the full backstop.
const HARD_RESET_FIRST_MS = 25000;
// Transport connected but the host never answered our auth handshake → rebuild.
// (Auth is also re-SENT every watchdog tick in that window; see startWatchdog.)
const AUTH_STALL_MS = 15000;
// Peer negotiation (offer applied, ICE checking) stuck without ever connecting
// or failing — Chromium can sit in "connecting" limbo after glare with a zombie
// session; don't wait the full hard-reset for that on any connection.
const NEG_STALL_MS = 20000;
// Receiver jitter buffer (ms). This is the dominant phone-side latency term
// (stats HUD: "buffer"). Target ~40ms so glass-to-glass stays near one frame
// of headroom on a LAN/Tailscale link (RTT/2 + buffer + decode ≈ 40–60ms).
//
// IMPORTANT: do NOT grow the buffer off freezeCount. Chromium's ~1Hz HW-H.264
// IDR hitch increments freezeCount even with a fat buffer (we measured 239
// freezes at 258ms dwell) — freeze-driven growth only added latency without
// curing the hitch. Host-side timestamp pacing + bitrate headroom handle IDRs;
// the buffer only reacts to real DROP ratio (late frames discarded).
//
// Never force 0 (Selkies anti-pattern — stutter when the UA wants room).
// Soft-spot defaults; runtime values come from StreamTune (stats Tune panel).
const JITTER_BASE_DEFAULT = 40;
const JITTER_MAX_DEFAULT = 120;
const JITTER_MIN_DEFAULT = 40;
/** Consecutive clean watchdog ticks (3s each) before easing from a raised target. */
const JITTER_CLEAN_TICKS = 2;
// H.264 decode candidates — MUST mirror rtcHost.ts. Baseline first so Android HW
// can enter low-latency mode (Moonlight errata #8); High stays for JPEG→WC fallback.
const WC_CODECS = ["avc1.42C028", "avc1.42E028", "avc1.4d0028", "avc1.640028", "avc1.640034"];
// A soft DIRECT failure (opt-in timeout, flow stall, host encoder hiccup) used to
// latch the path OFF for the whole session — only a page refresh or an app restart
// brought it back. Retry on a backoff instead: DIRECT is where the latency budget
// lives, so RTC is a waiting room, never a destination.
/** Default backoff floor; the Tune panel's "Direct retry" overrides it per device. */
const WC_RETRY_MIN_MS = 15000;
const WC_RETRY_MAX_MS = 120000;
/** Never hold a decoded frame longer than this while pacing (stale > uneven). */
const WC_PACE_MAX_WAIT_MS = 150;
/** Paced frames waiting on the playout clock; beyond this, pacing is losing. */
const WC_PACE_MAX_QUEUE = 6;

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v) || 0));

export class CloudConn {
  private sig: Signaling | null = null;
  private pc: RTCPeerConnection | null = null;
  private chScreen?: RTCDataChannel;
  private chControl?: RTCDataChannel;
  /** Unordered / no-retransmit channel for high-rate pointer moves (see rtcHost). */
  private chMove?: RTCDataChannel;
  private chData?: RTCDataChannel;
  private reqId = 1;
  private pending = new Map<number, Pending>();
  private chunks = new Map<number, { parts: string[]; got: number; n: number }>();
  private frameCb: ((b64: string) => void) | null = null;
  /** Multi-subscriber: Control + Quest VR both need the same stream without clobbering. */
  private streamCbs = new Set<(s: MediaStream) => void>();
  /** Multi-subscriber: Control + ImmersiveScreen both need cursor/focus events. */
  private eventCbs = new Set<(e: HostEvent) => void>();
  private statusCb: ((s: Status) => void) | null = null;
  // A dedicated terminal-denial callback the *app shell* owns for the whole life
  // of the connection. `statusCb` gets reassigned by whichever screen subscribes
  // last (Control overwrites the shell's subscription), so a "denied" arriving
  // while the Control screen is up would otherwise be observed by nobody and the
  // UI would sit on "Reconnecting…" forever. This is never reassigned by screens.
  private deniedCb: (() => void) | null = null;
  private stream: MediaStream | null = null;
  /** Desktop audio — kept OFF the video MediaStream so Chromium never A/V-syncs
   *  (lip-sync delays video to the audio jitter buffer — the classic ~200ms lag
   *  with JB target still reporting 40). See discuss-webrtc "Chromium audio/video
   *  sync leads to unexpected latency". */
  private audioStream: MediaStream | null = null;
  private audioCbs = new Set<(s: MediaStream | null) => void>();
  private lastStatus: Status | null = null;
  private closed = false;
  private connectedOnce = false;
  // True only during the fragile signaling handshake (socket open → offer received).
  // Serializes reconnects so overlapping attempts can't spawn duplicate sockets/PCs
  // that make the host churn. Cleared once we have a live PC (onOffer) or the attempt
  // fails, so it can never wedge reconnection shut.
  private connecting = false;
  private reconnectTimer: number | null = null;
  private backoff = BACKOFF_MIN;
  private hbTimer: number | null = null;
  private lastPong = 0;
  private offerTimer: number | null = null;
  // Auth + resilience state.
  private authed = false; // host approved this device (streaming allowed)
  private denied = false; // host rejected us — stop auto-reconnecting
  private videoReceiver: RTCRtpReceiver | null = null;
  private jbBase = JITTER_BASE_DEFAULT;
  private jbMax = JITTER_MAX_DEFAULT;
  private jbMin = JITTER_MIN_DEFAULT;
  /** Windowed drop RATIO (0–1) above which the jitter buffer grows (Tune: "JB grow at"). */
  private jbGrowAt = 0.15;
  private preferDirect = true;
  /** Android APK: MediaCodec Surface decode when true (Tune: "Phone decoder"). */
  private preferNativeDecode = true;
  /** DIRECT PCM audio over data channel (Tune: "PC sound"). Default ON. */
  private preferDirectAudio = true;
  private jitterTarget = JITTER_BASE_DEFAULT;
  /** Current lower bound for jitterTarget; eases toward jbMin on clean links. */
  private jitterFloor = JITTER_BASE_DEFAULT;
  private jitterCleanTicks = 0;
  private watchdogTimer: number | null = null;
  private lastHealthyAt = Date.now();
  private lastDecoded = -1;
  // Baselines for the WINDOWED drop-ratio (deltas per watchdog tick). Cumulative
  // totals were used before, which meant one early burst of drops kept the ratio
  // (and thus the jitter buffer / latency) elevated for the whole session.
  private winDecoded = 0;
  private winDropped = 0;
  // Decode-stall self-heal state. `sinkActive` = a Control screen has the video
  // mounted and expects frames — the gate that makes stall detection safe (the
  // old blanket decode-stall reconnect was removed because framesDecoded also
  // stalls when the video simply isn't rendered, e.g. on the Stats tab).
  private sinkActive = false;
  private winBytes = 0;
  private stallTicks = 0;
  // Freeze counter baseline — tracked for the HUD only (not used to inflate buffer).
  private winFreezes = 0;
  // Session id of the offer that built the current pc. A later offer with the SAME
  // id is an ICE-restart renegotiation (apply in place); a different id is a new
  // session (full rebuild). Lets a transient network drop re-route sub-second
  // without re-pairing, re-auth, or a decoder reset.
  private currentSid?: string;
  // ---- WebCodecs direct-video path (bypasses the WebRTC jitter buffer). The
  // host ships H.264 over the "video" data channel; we decode with VideoDecoder
  // and hand frames straight to the Control screen's canvas — no playout delay.
  private chVideo?: RTCDataChannel;
  /**
   * DEVICE capability only: null = not probed yet, false = this device has no
   * usable H.264 `VideoDecoder` at all. Never set false for a transient failure —
   * that's what `wcRetryAt` is for, and conflating the two is what pinned sessions
   * on RTC until the user restarted the app.
   */
  private wcSupported: boolean | null = null;
  private wcActive = false;
  private wcRequestedAt = 0; // vmode "wc" sent; frames must arrive or we revert
  /** Earliest time we may re-attempt DIRECT after a soft failure (0 = now). */
  private wcRetryAt = 0;
  /** Backoff floor for DIRECT re-attempts (Tune: "Direct retry"). */
  private wcRetryMin = WC_RETRY_MIN_MS;
  /** Backoff for repeated soft failures, so a hopeless link stops thrashing. */
  private wcRetryBackoff = WC_RETRY_MIN_MS;
  /** Host said "my encoder is gone" — respect it until the next peer session. */
  private wcHostRefused = false;
  private wcDecoder: VideoDecoder | null = null;
  /**
   * Android APK: decode via MediaCodec → Surface (Moonlight/Chiaki pattern) instead
   * of WebCodecs → canvas. Web/Quest keep WebCodecs — browsers don't expose MediaCodec.
   */
  private wcNative = false;
  private wcNativeFrames = 0;
  private wcNativePoll: number | null = null;
  private wcCodec = "";
  /** Coded frame size from the host's codec announce — fed into VideoDecoderConfig
   *  so Android MediaCodec allocates the right buffers up front (avoids a mid-stream
   *  reconfigure that costs a keyframe + several frames of black). */
  private wcCodedW = 0;
  private wcCodedH = 0;
  private wcAwaitKey = true;
  private wcKfReqAt = 0;
  private wcErrors = 0;
  /** Host-reported artifact/recovery counters (capstats → HUD). `-1` means "not
   *  reported yet" so the first real sample doesn't read as a regression. */
  private wcHostArtifacts = -1;
  private wcHostRecovered = -1;
  private wcHostRecovering = false;
  private wcFrameCb: ((f: VideoFrame) => void) | null = null;
  private wcHead: { key: boolean; seq: number; tsMs: number; len: number } | null = null;
  private wcBuf: Uint8Array | null = null;
  private wcGot = 0;
  /** Per-frame bookkeeping keyed by chunk timestamp (µs) for latency stats. */
  private wcMeta = new Map<number, { arrivedAt: number; tsMs: number; bytes: number }>();
  private wcFrames = 0;
  private wcKeys = 0;
  private wcBytes = 0;
  private wcDecMs = 0;
  private wcE2eMs = 0;
  private wcNetMs = 0;
  private wcTimes: number[] = []; // decoded-frame times (fps window)
  private wcByteWin: { at: number; bytes: number }[] = []; // arrival bytes (kbps window)
  private wcLastFrameAt = 0;
  private wcStallTicks = 0;
  /** Playout pacing (Quality dock "Feel"): 0 = paint on decode, >0 = clock-paced. */
  private wcPaceMs = 0;
  private wcPlayQ: { frame: VideoFrame; showAt: number }[] = [];
  private wcPlayTimer: number | null = null;
  /** NTP-style clock samples from the data-channel heartbeat (host perf clock). */
  private clockSamples: { rtt: number; off: number }[] = [];

  // ---- DIRECT audio (PCM over data channel) ---------------------------------
  private chAudio?: RTCDataChannel;
  private audioDirect = false;
  private audioCtx: AudioContext | null = null;
  private audioNode: AudioWorkletNode | null = null;
  private audioWorkletReady = false;
  private audioBytes = 0;
  private audioByteWin: { at: number; bytes: number }[] = [];
  private audioBufMs = 0;
  private audioTargetMs = 40;
  private audioUnderruns = 0;
  private audioStatsTimer: number | null = null;

  private progressListeners = new Set<(s: ConnectSnapshot) => void>();
  private progressPhase: ConnectPhase = "idle";
  private progressJob = "Starting…";
  private reconnectAttempt = 0;
  private reconnectBackoffMs = 0;
  private reconnectAt = 0;
  private iceState?: RTCIceConnectionState;
  // ---- connection diagnostics (surfaced in ConnectSnapshot.detail) ----
  private phaseChangedAt = Date.now();
  private offersReceived = 0;
  private candidatesIn = 0;
  private authState: AuthState = "none";
  private authSentCount = 0;
  private lastAuthSentAt = 0;
  /** First watchdog tick that saw "transport up but auth unanswered" (0 = none). */
  private authStallSince = 0;
  private lastEvent = "created";
  private lastEventAt = Date.now();
  /** 1s UI ticker so phase age / channel states stay live while connecting. */
  private progressTickTimer: number | null = null;
  /** Drop WebCodecs while Quest ImmersiveScreen needs the RTC `<video>` track. */
  private unsubImmersive: (() => void) | null = null;

  /** Record a notable transition for the diagnostics panel. */
  private noteEvent(what: string) {
    this.lastEvent = what;
    this.lastEventAt = Date.now();
  }

  constructor(
    private signalUrl: string,
    private code: string,
    private auth?: AuthInfo,
    private iceServers?: IceServer[],
  ) {
    // Android throttles/suspends timers while the app is backgrounded, so on
    // resume `lastPong` looks ancient and the heartbeat would declare a healthy
    // link dead and force a visible reconnect. Give the link a fresh window and
    // probe it immediately instead.
    document.addEventListener("visibilitychange", this.onVisibility);
    // Flat Quest Control uses WebCodecs like the phone; ImmersiveScreen textures
    // the RTC video element, so enter VR must fall back and exit can re-opt-in.
    this.unsubImmersive = onImmersiveActiveChange((active) => {
      if (active) {
        // Hard: VR owns the <video> element for as long as it's up.
        this.wcFallback("immersive VR needs the RTC video track", true);
      } else {
        // ...but leaving VR must lift that block, or flat Quest Control would
        // stay on RTC for the rest of the session.
        this.wcRetryAt = 0;
        this.wcRetryBackoff = this.wcRetryMin;
        if (this.authState === "ok") void this.maybeStartWc();
      }
    });
    // Apply persisted Tune-panel soft spot (JB + preferDirect) before first connect.
    this.applyStreamTune(loadStreamTune(), false);
  }

  /**
   * Apply guest-side tune knobs (jitter buffer + WebCodecs preference). Host-side
   * capture/bitrate fields travel via the quality message from Control.
   */
  applyStreamTune(tune: StreamTune, reassert = true) {
    // "Feel" slider → one budget spent on both paths: extra jitter-buffer floor on
    // RTC, extra playout slack on DIRECT. 0 leaves both exactly as they shipped.
    const paceMs = Math.round(clampNum(tune.pace, 0, 100) * 0.6);
    this.wcPaceMs = paceMs;
    this.jbGrowAt = clampNum(tune.jbGrowAt, 5, 40) / 100;
    const retryMin = clampNum(tune.directRetrySec, 5, 120) * 1000;
    if (retryMin !== this.wcRetryMin) {
      this.wcRetryMin = retryMin;
      // Moving this slider is an explicit ask, so reset the backoff to the new
      // floor and pull in any wait already in flight — otherwise lowering it
      // wouldn't take effect until the OLD (longer) timer expired.
      this.wcRetryBackoff = retryMin;
      // ...but never pull in a HARD block (VR / Direct off), which parks wcRetryAt
      // at MAX_SAFE_INTEGER and is not a backoff at all.
      if (this.wcRetryAt && this.wcRetryAt !== Number.MAX_SAFE_INTEGER) {
        this.wcRetryAt = Math.min(this.wcRetryAt, Date.now() + retryMin);
      }
    }
    // Fold pace into the effective JB so the adaptation logic below needs no
    // knowledge of it — the Tune panel's own JB knobs still compose on top.
    this.jbBase = tune.jbBase + paceMs;
    this.jbMax = Math.max(tune.jbMax, this.jbBase);
    this.jbMin = tune.jbMin + paceMs;
    const wantDirect = tune.preferDirect;
    if (!wantDirect && this.preferDirect && (this.wcActive || this.wcRequestedAt)) {
      this.wcFallback("Tune: direct path off", true);
    }
    this.preferDirect = wantDirect;
    const wantNative = tune.preferNativeDecode !== false;
    if (wantNative !== this.preferNativeDecode) {
      this.preferNativeDecode = wantNative;
      // Flip takes effect on the next decoder build / keyframe.
      if (this.wcActive) {
        this.wcAwaitKey = true;
        this.wcBuildDecoder();
        this.wcRequestKeyframe();
      }
    } else {
      this.preferNativeDecode = wantNative;
    }
    const wantAudio = tune.preferDirectAudio !== false;
    if (wantAudio !== this.preferDirectAudio) {
      this.preferDirectAudio = wantAudio;
      if (this.authState === "ok") {
        if (wantAudio) void this.maybeStartAudioDirect();
        else this.audioFallback("Tune: direct audio off");
      }
    } else {
      this.preferDirectAudio = wantAudio;
    }
    this.jitterTarget = Math.min(this.jbMax, Math.max(this.jbMin, this.jitterTarget || this.jbBase));
    this.jitterFloor = this.jbBase;
    if (paceMs === 0) this.wcFlushPaceQueue();
    if (reassert) {
      this.applyJitter();
      if (wantDirect) {
        // Turning Direct back on is an explicit ask — clear the backoff so it
        // re-attempts now instead of waiting out a previous failure's timer.
        this.wcRetryAt = 0;
        this.wcRetryBackoff = this.wcRetryMin;
        if (this.authState === "ok" && !this.wcActive) void this.maybeStartWc();
      }
    }
  }

  /** Wipe tune prefs to shipped defaults and re-apply (used when connect is stuck). */
  resetStreamDefaults() {
    const t = resetStreamTune();
    this.applyStreamTune(t, true);
    return t;
  }

  /** Stuck-connect recovery: defaults + force a clean peer rebuild. */
  resetAndRebuild() {
    this.resetStreamDefaults();
    this.forceRebuild("manual tune reset");
  }

  private onVisibility = () => {
    if (document.visibilityState !== "visible" || this.closed) return;
    this.lastPong = Date.now();
    if (this.chData?.readyState === "open") {
      try {
        this.chData.send(JSON.stringify({ ping: Date.now() }));
      } catch {
        /* ignore */
      }
    }
  };

  /** True once the peer link has been established at least one time. */
  get established(): boolean {
    return this.connectedOnce;
  }

  getSnapshot(): ConnectSnapshot {
    const backoffMs =
      this.progressPhase === "reconnecting" && this.reconnectAt > 0
        ? Math.max(0, this.reconnectAt - Date.now())
        : this.reconnectBackoffMs;
    const now = Date.now();
    const pc = this.pc;
    const ch = (c?: RTCDataChannel) => c?.readyState ?? "—";
    const sigState = this.sig?.state ?? "none";
    return {
      phase: this.progressPhase,
      status: this.lastStatus ?? "new",
      attempt: this.reconnectAttempt,
      backoffMs,
      iceState: this.iceState,
      job: this.progressJob,
      detail: {
        phaseMs: now - this.phaseChangedAt,
        sig: sigState,
        pc: pc?.connectionState ?? "none",
        ice: pc?.iceConnectionState ?? "—",
        gather: pc?.iceGatheringState ?? "—",
        sdp: pc?.signalingState ?? "—",
        chCtl: ch(this.chControl),
        chData: ch(this.chData),
        chVid: ch(this.chVideo),
        offers: this.offersReceived,
        candIn: this.candidatesIn,
        authState: this.authState,
        authSent: this.authSentCount,
        authAgeMs: this.lastAuthSentAt ? now - this.lastAuthSentAt : -1,
        hasSecret: !!this.auth?.secret,
        sid: this.currentSid ? this.currentSid.slice(0, 6) : undefined,
        lastEvent: this.lastEvent,
        lastEventAgoMs: now - this.lastEventAt,
      },
    };
  }

  private setProgress(phase: ConnectPhase, job: string) {
    if (phase !== this.progressPhase) this.phaseChangedAt = Date.now();
    this.progressPhase = phase;
    this.progressJob = job;
    this.emitProgress();
  }

  private emitProgress() {
    const snap = this.getSnapshot();
    for (const cb of this.progressListeners) cb(snap);
  }

  onProgress(cb: (s: ConnectSnapshot) => void): () => void {
    this.progressListeners.add(cb);
    cb(this.getSnapshot());
    return () => this.progressListeners.delete(cb);
  }

  /** Record and broadcast the latest connection status, healing terminal drops. */
  private emit(s: Status) {
    this.lastStatus = s;
    if (s === "connected") {
      this.connectedOnce = true;
      this.backoff = BACKOFF_MIN;
      this.lastHealthyAt = Date.now();
      this.clearReconnect();
      this.reconnectAttempt = 0;
      this.reconnectBackoffMs = 0;
      this.reconnectAt = 0;
      this.setProgress("connected", "Connected to your PC");
    } else if (s === "pending") {
      // Only claim "waiting for approval" once the host actually said so —
      // before that, "pending" just means the transport connected while the
      // auth handshake is still in flight (a very different failure mode).
      if (this.authState === "pending") {
        this.setProgress("pending_approval", "Waiting for approval on your PC…");
      } else {
        this.setProgress("authenticating", "Authorizing this device…");
      }
    } else if (s === "denied") {
      this.setProgress("denied", "Access declined on your PC");
    } else if (s === "disconnected" || s === "failed" || s === "closed") {
      if (this.progressPhase !== "reconnecting") {
        this.setProgress(
          this.connectedOnce ? "reconnecting" : this.progressPhase,
          s === "disconnected" ? "Connection lost" : "Connection failed",
        );
      }
    } else if (s === "connecting") {
      if (this.progressPhase !== "negotiating" && this.progressPhase !== "authenticating") {
        this.setProgress("negotiating", "Establishing peer connection…");
      }
    }
    this.statusCb?.(s);
    if (!this.closed && !this.denied && (s === "failed" || s === "closed")) this.scheduleReconnect();
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.denied = false;
    this.reconnectAttempt = 0;
    this.setProgress("idle", "Starting connection…");
    this.startWatchdog();
    this.startProgressTicker();
    await this.openSignaling(true);
  }

  /** While connecting, refresh subscribers every second so the diagnostics
   *  (phase age, channel states) tick live instead of only on transitions. */
  private startProgressTicker() {
    this.stopProgressTicker();
    this.progressTickTimer = window.setInterval(() => {
      if (this.closed || this.progressListeners.size === 0) return;
      if (this.progressPhase !== "connected") this.emitProgress();
    }, 1000);
  }

  private stopProgressTicker() {
    if (this.progressTickTimer !== null) {
      window.clearInterval(this.progressTickTimer);
      this.progressTickTimer = null;
    }
  }

  /**
   * Open (or reopen) the signaling socket and wait for the host's offer. When
   * `throwOnFail` is set (first attempt) a signaling failure propagates so the
   * pairing screen can show it; on reconnects we swallow it and retry instead.
   */
  private async openSignaling(throwOnFail: boolean): Promise<void> {
    if (this.closed) return;
    this.connecting = true;
    this.setProgress("signaling", "Connecting to signaling server…");
    this.stopHeartbeat();
    this.clearOfferTimeout();
    this.pc?.close();
    this.pc = null;
    this.sig?.close();

    const sig = new Signaling(this.signalUrl, this.code, "guest");
    this.sig = sig;
    sig.onMessage(async (m) => {
      if (this.sig !== sig || this.closed) return; // stale socket from a prior attempt
      if (m.type === "offer") await this.onOffer(m.sdp, (m as { sid?: string }).sid);
      else if (m.type === "candidate" && this.pc) {
        this.candidatesIn++;
        try {
          await this.pc.addIceCandidate(m.candidate);
        } catch {
          /* ignore */
        }
      } else if (m.type === "peer-left") {
        // The host's *signaling* socket closed — not the P2P session. While the
        // peer link is healthy, keep streaming; tearing down here caused visible
        // "reconnecting" flaps every time the idle socket died on the way to the
        // signaling server. A truly dead session is caught by the heartbeat.
        if (!this.connectedViaPeer()) {
          this.emit("disconnected");
          this.setProgress("reconnecting", "PC left the room — reconnecting…");
          this.scheduleReconnect();
        }
      } else if (m.type === "room-full") {
        this.setProgress("reconnecting", "Room busy — retrying…");
        this.scheduleReconnect();
      } else if (m.type === "replaced") {
        // The server evicted this socket because a NEWER guest joined the same
        // room. Our own reconnects never see this (the `sig !== this.sig` guard
        // above drops messages to superseded sockets), so a live "replaced"
        // means the user genuinely opened this room in another tab/device.
        // Newest wins: auto-reconnecting from here would evict the newcomer
        // right back and the two tabs would trade the room forever (screen for
        // a second → kicked → reconnect → …). Stand down terminally instead —
        // reuse the `denied` latch, which every reconnect path already respects.
        this.denied = true;
        this.clearReconnect();
        this.clearOfferTimeout();
        this.stopHeartbeat();
        this.lastStatus = "denied";
        this.statusCb?.("denied");
        this.setProgress("denied", "Taken over by another tab or device");
        this.pc?.close();
        this.deniedCb?.();
      }
    });
    sig.onClose(() => {
      if (this.sig === sig && !this.closed && !this.connectedViaPeer()) this.scheduleReconnect();
    });

    try {
      await sig.connect();
      this.setProgress("waiting_offer", "Waiting for your PC…");
      this.armOfferTimeout();
    } catch (e) {
      this.connecting = false;
      this.setProgress("signaling", "Couldn't reach signaling server");
      if (throwOnFail && !this.connectedOnce) throw e;
      this.scheduleReconnect();
    }
  }

  private armOfferTimeout() {
    this.clearOfferTimeout();
    this.offerTimer = window.setTimeout(() => {
      this.offerTimer = null;
      if (!this.closed && !this.connectedViaPeer()) {
        this.connecting = false;
        this.setProgress("reconnecting", "No response from PC — retrying…");
        this.scheduleReconnect();
      }
    }, OFFER_TIMEOUT_MS);
  }

  private clearOfferTimeout() {
    if (this.offerTimer !== null) {
      window.clearTimeout(this.offerTimer);
      this.offerTimer = null;
    }
  }

  private connectedViaPeer(): boolean {
    return this.pc?.connectionState === "connected";
  }

  private scheduleReconnect() {
    if (this.closed || this.denied || this.reconnectTimer !== null || this.connecting) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
    this.reconnectAttempt += 1;
    this.reconnectBackoffMs = wait;
    this.reconnectAt = Date.now() + wait;
    const secs = Math.ceil(wait / 1000);
    this.setProgress(
      "reconnecting",
      this.connectedOnce
        ? `Reconnecting… attempt ${this.reconnectAttempt} (retry in ${secs}s)`
        : `Retrying… attempt ${this.reconnectAttempt} (in ${secs}s)`,
    );
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAt = 0;
      this.openSignaling(false).catch(() => this.scheduleReconnect());
    }, wait);
  }

  private clearReconnect() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async onOffer(sdp: string, sid?: string) {
    this.clearOfferTimeout();
    this.offersReceived++;
    this.noteEvent(sid && sid === this.currentSid ? "ICE-restart offer" : "offer received");
    // ICE-restart renegotiation of the SAME session: apply the new offer to the
    // existing peer connection instead of rebuilding. Keeps the media track, the
    // hardware decoder, and the host's authorization — the screen just re-routes
    // onto a fresh network path with no visible drop. Only when this fails (or the
    // pc is gone/closed) do we fall through to a clean rebuild below.
    if (sid && sid === this.currentSid && this.pc && this.pc.connectionState !== "closed" && this.sig) {
      try {
        await this.pc.setRemoteDescription({ type: "offer", sdp });
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sig.send({ type: "answer", sdp: answer.sdp ?? "" });
        this.noteEvent("answer sent (ICE restart)");
        return;
      } catch {
        /* renegotiation failed — fall through and rebuild the session cleanly */
      }
    }
    this.currentSid = sid;
    this.setProgress("negotiating", "Setting up secure peer connection…");
    this.pc?.close();
    this.stream = null; // new session → new tracks; don't accumulate dead ones
    this.audioStream = null;
    this.stopJitterHold();
    this.videoReceiver = null;
    this.authed = false; // every fresh peer requires re-authorization by the host
    this.authState = "none";
    this.authSentCount = 0;
    this.lastAuthSentAt = 0;
    this.authStallSince = 0;
    this.videoReceiver = null;
    // A new PC restarts inbound-RTP counters from 0, so the old frame count is
    // meaningless — reset it so the jitter-adaptation baseline is correct.
    this.lastDecoded = -1;
    this.winDecoded = 0;
    this.winDropped = 0;
    this.winBytes = 0;
    this.stallTicks = 0;
    this.winFreezes = 0;
    // Fresh session → fresh WebCodecs negotiation (re-probed after auth-ok).
    this.wcReset(true);
    this.audioDirect = false;
    this.teardownAudioPlayer();
    this.audioBytes = 0;
    this.audioByteWin = [];
    this.chAudio = undefined;
    const pc = new RTCPeerConnection({ iceServers: defaultIceServers(this.iceServers), iceCandidatePoolSize: 4 });
    this.pc = pc;
    pipeIce(pc, this.sig!);
    // Guard every handler against firing for a superseded connection. The peer
    // reaching "connected" only means the transport is up — we stay in "pending"
    // (authenticating) until the host sends {event:"auth", state:"ok"}.
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const st = pc.connectionState;
      if (st === "connected") this.emit(this.authed ? "connected" : "pending");
      else this.emit(st);
    };
    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc) return;
      this.iceState = pc.iceConnectionState;
      if (pc.iceConnectionState === "checking") {
        this.setProgress("negotiating", "Finding network path (ICE)…");
      } else if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        this.emitProgress();
      }
      if (pc.iceConnectionState === "failed" && !this.closed) {
        this.setProgress("reconnecting", "Network path failed — retrying…");
        this.scheduleReconnect();
      }
    };
    // The screen arrives as a real media track (hardware-decoded video). The
    // host puts video and audio on SEPARATE signaled streams so Chromium's
    // lip-sync synchronizer never delays video to the audio NetEq buffer.
    // CRITICAL: keep them separate on the guest too — merging into one
    // MediaStream for <video> re-enables A/V sync and was the cause of
    // measured buffer ~200ms while jitterBufferTarget stayed at 40
    // (jitterBufferTarget is only a MINIMUM in Chromium — A/V sync pads above it).
    this.pc.ontrack = (e) => {
      if (this.pc !== pc) return;
      if (e.track.kind === "audio") {
        if (!this.audioStream) this.audioStream = new MediaStream();
        // Replace any prior audio track (ICE restart / renegotiation).
        for (const t of this.audioStream.getAudioTracks()) this.audioStream.removeTrack(t);
        this.audioStream.addTrack(e.track);
        this.emitAudio();
        return;
      }
      if (!this.stream) this.stream = new MediaStream();
      // Video only — never add audio here.
      for (const t of this.stream.getVideoTracks()) this.stream.removeTrack(t);
      this.stream.addTrack(e.track);
      if (e.track.kind === "video") {
        this.videoReceiver = e.receiver;
        this.jitterTarget = this.jbBase;
        this.jitterFloor = this.jbBase;
        this.jitterCleanTicks = 0;
        this.applyJitter();
        this.startJitterHold();
        e.track.onunmute = () => this.emitStream();
        e.track.onmute = () => {
          /* keep listeners; frames may resume after auth */
        };
      }
      this.emitStream();
    };
    this.pc.ondatachannel = (e) => {
      if (this.pc !== pc) return; // superseded before channels arrived
      const ch = e.channel;
      if (ch.label === "screen") {
        this.chScreen = ch;
        ch.onmessage = (ev) => this.frameCb?.(ev.data as string);
      } else if (ch.label === "control") {
        this.chControl = ch;
        // Send the auth handshake as soon as the guest→host channel is open.
        if (ch.readyState === "open") this.sendAuth();
        ch.onopen = () => this.sendAuth();
      } else if (ch.label === "move") {
        this.chMove = ch;
      } else if (ch.label === "video") {
        // WebCodecs direct-video path: H.264 frames as [20-byte header + fragments].
        this.chVideo = ch;
        ch.binaryType = "arraybuffer";
        ch.onmessage = (ev) => this.onWcMsg(ev.data);
      } else if (ch.label === "audio") {
        // DIRECT audio: float32 PCM (or JSON cfg).
        this.chAudio = ch;
        ch.binaryType = "arraybuffer";
        ch.onmessage = (ev) => this.onAudioMsg(ev.data);
      } else if (ch.label === "data") {
        this.chData = ch;
        ch.onmessage = (ev) => this.onData(ev.data as string);
        ch.onopen = () => this.startHeartbeat();
      }
    };
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sig!.send({ type: "answer", sdp: answer.sdp ?? "" });
    this.noteEvent("answer sent");
    // We have a live PC now; the signaling handshake is done. Further recovery is
    // driven by the PC's own state + the data-channel heartbeat, so drop the
    // serialization guard (leaving it set here would wedge reconnection if the PC
    // later got stuck in "disconnected" without ever reaching "connected").
    this.connecting = false;
  }

  /** Ping the host regularly; if pongs stop, tear the link down and rebuild. */
  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastPong = Date.now();
    // Immediate first ping: seeds the clock-sync samples so the wc path's
    // end-to-end latency reading is meaningful within a second of connecting.
    if (this.chData?.readyState === "open") {
      try {
        this.chData.send(JSON.stringify({ ping: Date.now() }));
      } catch {
        /* ignore */
      }
    }
    this.hbTimer = window.setInterval(() => {
      if (this.closed) return;
      // Backgrounded: timers are throttled and pongs may sit unprocessed, so a
      // stale lastPong proves nothing. Skip the dead-check (and keep the window
      // fresh); onVisibility probes the link the moment we're visible again.
      if (document.hidden) {
        this.lastPong = Date.now();
        return;
      }
      if (Date.now() - this.lastPong > HEARTBEAT_DEAD_MS) {
        this.stopHeartbeat();
        this.setProgress("reconnecting", "Link timed out — reconnecting…");
        this.emit("disconnected");
        this.scheduleReconnect();
        return;
      }
      if (this.chData?.readyState === "open") {
        try {
          this.chData.send(JSON.stringify({ ping: Date.now() }));
        } catch {
          /* ignore */
        }
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.hbTimer !== null) {
      window.clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  /**
   * Send the identity + optional secret so the host can authorize this device.
   * Idempotent and safe to REPEAT: the host re-acks an already-authorized
   * session, so the watchdog re-sends this while the handshake is unanswered
   * (a first ask lost around channel-open used to wedge "authorizing" forever).
   */
  private sendAuth() {
    if (this.chControl?.readyState !== "open") return;
    if (this.authState !== "pending") this.setProgress("authenticating", "Authorizing this device…");
    const a = this.auth;
    try {
      this.chControl.send(
        JSON.stringify({
          type: "auth",
          deviceId: a?.deviceId ?? "",
          name: a?.name ?? "Phone",
          secret: a?.secret || undefined,
        }),
      );
      this.authSentCount++;
      this.lastAuthSentAt = Date.now();
      if (this.authState === "none") this.authState = "sent";
      this.noteEvent(this.authSentCount > 1 ? `auth re-sent (×${this.authSentCount})` : "auth sent");
    } catch {
      /* ignore */
    }
  }

  /**
   * Tell the connection whether a screen view is actively consuming the video
   * (the Control screen sets this on mount/unmount). Gates the decode-stall
   * self-heal so it can never fire while the stream is intentionally unwatched.
   */
  setVideoSink(active: boolean) {
    this.sinkActive = active;
    if (!active) this.stallTicks = 0;
    if (!active) this.wcStallTicks = 0;
  }

  // ---- WebCodecs direct-video path ------------------------------------------

  /** Reset all wc state (new session / teardown). `reprobe` re-allows opt-in. */
  private wcReset(reprobe: boolean) {
    const wasActive = this.wcActive;
    this.wcActive = false;
    this.wcRequestedAt = 0;
    this.wcAwaitKey = true;
    this.wcHead = null;
    this.wcBuf = null;
    this.wcGot = 0;
    this.wcMeta.clear();
    this.wcStallTicks = 0;
    this.wcErrors = 0;
    this.chVideo = undefined;
    this.wcFlushPaceQueue();
    this.wcStopNativePoll();
    if (this.wcNative) {
      void teardownNativeDecoder();
      this.wcNative = false;
      this.wcNativeFrames = 0;
    }
    try {
      this.wcDecoder?.close();
    } catch {
      /* already closed */
    }
    this.wcDecoder = null;
    if (reprobe) {
      // A fresh peer session earns a clean slate: new host encoder, new channels,
      // so nothing learned from the last session's failures still applies.
      this.wcRetryAt = 0;
      this.wcRetryBackoff = this.wcRetryMin;
      this.wcHostRefused = false;
      // NOTE: wcSupported is a DEVICE fact — deliberately NOT cleared here. The
      // probe is expensive and its answer can't change within a page load.
    }
    if (wasActive) this.emitEvent({ event: "wc", active: false, native: false });
  }

  /** True when DIRECT is worth attempting right now (capability + policy + backoff). */
  private wcEligible(): boolean {
    if (this.closed || this.denied || this.wcActive || this.wcRequestedAt) return false;
    // Immersive VR textures the RTC `<video>` element — canvas WebCodecs would
    // leave the big screen black. Flat Quest / web / APK all opt in.
    if (isImmersiveActive()) return false;
    if (!this.preferDirect) return false;
    if (this.wcSupported === false) return false; // device genuinely can't decode
    if (this.wcHostRefused) return false; // host has no encoder this session
    if (this.wcRetryAt && Date.now() < this.wcRetryAt) return false;
    return true;
  }

  /** After auth-ok: ask the host to ship PCM over the data channel. */
  private async maybeStartAudioDirect() {
    if (this.closed || this.denied || !this.preferDirectAudio) return;
    if (this.audioDirect) return;
    // Need the channel (or it will arrive shortly — still ask; host queues).
    this.sendControl({ type: "amode", mode: "pcm" });
    await this.ensureAudioPlayer();
  }

  private audioFallback(reason: string) {
    console.warn("[remote] DIRECT audio off — using the WebRTC track:", reason);
    this.audioDirect = false;
    this.teardownAudioPlayer();
    this.sendControl({ type: "amode", mode: "rtc" });
    if (this.audioStream) {
      for (const t of this.audioStream.getAudioTracks()) t.enabled = true;
    }
    this.emitEvent({ event: "amode", mode: "rtc" });
  }

  /** Build (or resume) the lean phone-side PCM worklet. */
  private async ensureAudioPlayer() {
    if (this.audioWorkletReady && this.audioNode) return;
    try {
      if (!this.audioCtx) {
        try {
          this.audioCtx = new AudioContext({ sampleRate: 48000 });
        } catch {
          this.audioCtx = new AudioContext();
        }
      }
      await this.audioCtx.resume().catch(() => {});
      if (!this.audioWorkletReady) {
        await this.audioCtx.audioWorklet.addModule(audioFeederWorkletUrl);
        this.audioWorkletReady = true;
      }
      if (!this.audioNode) {
        const node = new AudioWorkletNode(this.audioCtx, "gt-pcm-feeder", {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        node.connect(this.audioCtx.destination);
        node.port.onmessage = (e) => {
          const s = e.data?.stats;
          if (s) {
            this.audioBufMs = s.bufMs ?? 0;
            this.audioTargetMs = s.targetMs ?? 40;
            this.audioUnderruns = s.underruns ?? 0;
          }
        };
        // Lean envelope — matches near-instant DIRECT video. Lowered from
        // 20/35/100 to 12/18/90 to shave ~17ms of phone-side audio latency
        // (worklet grows adaptively if underruns appear, so the floor is safe).
        node.port.postMessage({
          cfg: { channels: 2, captureRate: this.audioCtx.sampleRate, primeMs: 12, targetMs: 18, maxMs: 90 },
        });
        this.audioNode = node;
        this.startAudioStatsPoll();
      }
    } catch (e) {
      console.warn("[remote] DIRECT audio player failed:", e);
      this.audioFallback("worklet init failed");
    }
  }

  private teardownAudioPlayer() {
    this.stopAudioStatsPoll();
    try {
      this.audioNode?.disconnect();
    } catch {
      /* ignore */
    }
    this.audioNode = null;
    // Keep the AudioContext + loaded module for a fast re-opt-in.
  }

  private startAudioStatsPoll() {
    this.stopAudioStatsPoll();
    this.audioStatsTimer = window.setInterval(() => {
      try {
        this.audioNode?.port.postMessage({ cfg: { stats: true } });
      } catch {
        /* ignore */
      }
    }, 500);
  }

  private stopAudioStatsPoll() {
    if (this.audioStatsTimer !== null) {
      window.clearInterval(this.audioStatsTimer);
      this.audioStatsTimer = null;
    }
  }

  /** One message on the "audio" channel: JSON cfg or a float32 PCM chunk. */
  private onAudioMsg(data: unknown) {
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data) as { cfg?: { sampleRate?: number; channels?: number } };
        if (msg.cfg && this.audioNode) {
          this.audioNode.port.postMessage({
            cfg: {
              channels: msg.cfg.channels ?? 2,
              captureRate: msg.cfg.sampleRate ?? 48000,
              primeMs: 12,
              targetMs: 18,
              maxMs: 90,
            },
          });
        }
      } catch {
        /* ignore */
      }
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    if (!this.audioDirect) {
      // Host started shipping before our ack — latch on and play.
      this.audioDirect = true;
      void this.ensureAudioPlayer().then(() => this.feedAudioChunk(data));
      if (this.audioStream) {
        for (const t of this.audioStream.getAudioTracks()) t.enabled = false;
      }
      this.emitEvent({ event: "amode", mode: "pcm" });
      return;
    }
    this.feedAudioChunk(data);
  }

  private feedAudioChunk(ab: ArrayBuffer) {
    const now = Date.now();
    this.audioBytes += ab.byteLength;
    this.audioByteWin.push({ at: now, bytes: ab.byteLength });
    while (this.audioByteWin.length && now - this.audioByteWin[0].at > 2000) this.audioByteWin.shift();
    if (!this.audioNode) return;
    try {
      this.audioNode.port.postMessage(ab, [ab]);
    } catch {
      /* node torn down */
    }
  }

  /** Mute/unmute DIRECT audio playback (RTC path still uses the <audio> element). */
  setAudioMuted(muted: boolean) {
    if (this.audioCtx) {
      if (muted) this.audioCtx.suspend().catch(() => {});
      else this.audioCtx.resume().catch(() => {});
    }
  }

  /** Live audio-path telemetry for the HUD. */
  audioInfo(): AudioStats {
    const now = Date.now();
    let winBytes = 0;
    for (const b of this.audioByteWin) {
      if (now - b.at <= 1000) winBytes += b.bytes;
    }
    return {
      mode: this.audioDirect ? "pcm" : "rtc",
      bufMs: Math.round(this.audioBufMs),
      targetMs: Math.round(this.audioTargetMs),
      underruns: this.audioUnderruns,
      kbps: this.audioDirect ? Math.round((winBytes * 8) / 1000) : 0,
    };
  }

  /** After auth-ok (and on watchdog retries): probe decode support, opt in. */
  private async maybeStartWc() {
    if (!this.wcEligible()) return;
    if (this.wcSupported == null) {
      this.wcSupported = await this.wcProbeDecoder();
      if (!this.wcSupported) {
        console.warn("[remote] no usable H.264 VideoDecoder — DIRECT unavailable on this device");
        return;
      }
    }
    if (this.closed || this.denied) return;
    this.wcRequestedAt = Date.now();
    this.sendControl({ type: "vmode", mode: "wc" });
  }

  /** Can this device decode ANY codec on the host's ladder? (device fact, cached) */
  private async wcProbeDecoder(): Promise<boolean> {
    // Prefer native MediaCodec on the APK — same silicon WebCodecs uses, but with
    // Moonlight's FEATURE_LowLatency / vendor keys and a Surface present (no canvas).
    if (nativeDecoderPossible() && this.preferNativeDecode) {
      const p = await probeNativeDecoder();
      if (p.available) {
        console.info(
          `[remote] native MediaCodec available (${p.name || "hw"}${p.lowLatency ? ", low-latency" : ""})`,
        );
        return true;
      }
      // Native was preferred but unavailable. Log the bridge's reason so it's
      // visible even if the fallback toast was dismissed — `wcSupported` will
      // then be set by the WebCodecs probe below (or DIRECT is off entirely).
      if (p.detail) console.warn(`[remote] native MediaCodec unavailable: ${p.detail}`);
    }
    try {
      if (typeof VideoDecoder === "undefined") return false;
      for (const hw of ["prefer-hardware", "no-preference"] as const) {
        for (const codec of WC_CODECS) {
          try {
            const r = await VideoDecoder.isConfigSupported({
              codec,
              optimizeForLatency: true,
              hardwareAcceleration: hw,
            });
            if (r.supported) return true;
          } catch {
            /* try next */
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Drop back to the WebRTC track. `hard` means "don't come back on your own"
   * (the user switched Direct off, or VR needs the video element) — everything
   * else is a SOFT failure that re-arms on a backoff, because a transient stall
   * used to cost the whole session its latency budget until an app restart.
   */
  private wcFallback(reason: string, hard = false) {
    if (!this.wcActive && !this.wcRequestedAt) return;
    const wasActive = this.wcActive;
    this.wcActive = false;
    this.wcRequestedAt = 0;
    this.wcAwaitKey = true;
    this.wcFlushPaceQueue();
    this.wcStopNativePoll();
    if (this.wcNative) {
      void teardownNativeDecoder();
      this.wcNative = false;
    }
    try {
      this.wcDecoder?.close();
    } catch {
      /* ignore */
    }
    this.wcDecoder = null;
    if (hard) {
      this.wcRetryAt = Number.MAX_SAFE_INTEGER;
      console.warn("[remote] DIRECT off — using the WebRTC track:", reason);
    } else {
      this.wcRetryAt = Date.now() + this.wcRetryBackoff;
      console.warn(
        `[remote] DIRECT off — using the WebRTC track: ${reason} (retrying in ${Math.round(this.wcRetryBackoff / 1000)}s)`,
      );
      this.wcRetryBackoff = Math.min(this.wcRetryBackoff * 2, WC_RETRY_MAX_MS);
    }
    this.sendControl({ type: "vmode", mode: "rtc" });
    if (wasActive) this.emitEvent({ event: "wc", active: false, native: false });
  }

  /** Build (or rebuild) the VideoDecoder / native MediaCodec for the host codec. */
  private wcBuildDecoder(): boolean {
    // Safety net for hosts that ship NVENC frames without a prior codec JSON
    // (pre-announce bug): Constrained Baseline matches what NVENC emits; the
    // in-band SPS is what the decoder actually keys off of once configured.
    if (!this.wcCodec) this.wcCodec = WC_CODECS[0];
    if (!this.wcCodec) return false;

    // Android APK: MediaCodec → Surface (Moonlight/Chiaki). Init is async; the
    // feed path buffers on awaitKey until __GT_DECODER__ is ready.
    if (nativeDecoderPossible() && this.preferNativeDecode) {
      const w = this.wcCodedW > 0 ? this.wcCodedW : 1920;
      const h = this.wcCodedH > 0 ? this.wcCodedH : 1080;
      this.wcNative = true;
      this.wcAwaitKey = true;
      this.wcStartNativePoll();
      void (async () => {
        const p = await probeNativeDecoder();
        if (!p.available) {
          this.wcNative = false;
          this.wcStopNativePoll();
          // Surface the bridge's own reason so "MediaCodec unavailable" stops
          // being a mystery — the detail string carries which decoder was
          // considered, what configure attempt failed, or whether the bridge
          // even loaded. Visible in the transient toast above the viewport.
          const detail = p.detail ? ` (${p.detail})` : "";
          this.emitEvent({
            event: "decoder",
            state: "fallback",
            reason: `MediaCodec unavailable — using WebCodecs${detail}`,
          });
          if (!this.wcBuildWebCodecsDecoder()) this.wcFallback("no native or WebCodecs decoder");
          return;
        }
        const ok = await initNativeDecoder(w, h);
        if (!ok) {
          console.warn("[remote] native MediaCodec init failed — WebCodecs fallback");
          this.wcNative = false;
          this.wcStopNativePoll();
          const detail = p.detail ? ` (${p.detail})` : "";
          this.emitEvent({
            event: "decoder",
            state: "fallback",
            reason: `MediaCodec failed to start — using WebCodecs${detail}`,
          });
          if (!this.wcBuildWebCodecsDecoder()) this.wcFallback("native init failed");
          return;
        }
        void resetNativeDecoder();
        if (this.wcActive) this.emitEvent({ event: "wc", active: true, native: true });
        this.emitEvent({ event: "decoder", state: "native", name: p.name || "hw" });
        console.info(`[remote] DIRECT via native MediaCodec (${p.name || "hw"})`);
        this.wcRequestKeyframe();
      })();
      return true;
    }

    return this.wcBuildWebCodecsDecoder();
  }

  /** WebCodecs path — used on discovery web / Quest and as Android fallback. */
  private wcBuildWebCodecsDecoder(): boolean {
    try {
      this.wcDecoder?.close();
    } catch {
      /* ignore */
    }
    const dec = new VideoDecoder({
      output: (frame) => this.onWcFrameOut(frame),
      error: (e) => {
        console.warn("[remote] wc decoder error:", e);
        this.wcErrors++;
        if (this.wcDecoder === dec) this.wcDecoder = null;
        try {
          dec.close();
        } catch {
          /* ignore */
        }
        this.wcAwaitKey = true;
        if (this.wcErrors > 4) this.wcFallback("repeated decoder errors");
        else this.wcRequestKeyframe();
      },
    });
    const cfg: VideoDecoderConfig = {
      codec: this.wcCodec,
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
      ...(this.wcCodedW > 0 && this.wcCodedH > 0
        ? { codedWidth: this.wcCodedW, codedHeight: this.wcCodedH }
        : {}),
    };
    (cfg as VideoDecoderConfig & { avc?: { format: string } }).avc = { format: "annexb" };
    try {
      dec.configure(cfg);
    } catch {
      try {
        dec.configure({
          codec: this.wcCodec,
          optimizeForLatency: true,
          ...(this.wcCodedW > 0 && this.wcCodedH > 0
            ? { codedWidth: this.wcCodedW, codedHeight: this.wcCodedH }
            : {}),
        });
      } catch (e2) {
        console.warn("[remote] wc decoder configure failed:", e2);
        try {
          dec.close();
        } catch {
          /* ignore */
        }
        this.wcFallback("decoder configure failed");
        return false;
      }
    }
    this.wcDecoder = dec;
    this.wcNative = false;
    this.wcAwaitKey = true;
    return true;
  }

  private wcStartNativePoll() {
    if (this.wcNativePoll !== null) return;
    this.wcNativePoll = window.setInterval(() => {
      void this.wcPollNativeStats();
    }, 250);
  }

  private wcStopNativePoll() {
    if (this.wcNativePoll !== null) {
      window.clearInterval(this.wcNativePoll);
      this.wcNativePoll = null;
    }
  }

  /** Last native-decoder error string we surfaced as a toast — used to dedupe
   *  the poll so a sticky `lastError` from a recovered configure attempt can't
   *  spam the "decoder error" message every tick. */
  private wcLastNativeError = "";

  /** Pull decode-ms / frame count from Kotlin (Surface path has no VideoFrame). */
  private async wcPollNativeStats() {
    if (!this.wcNative || !this.wcActive) return;
    const st = await getNativeDecoderStats();
    if (!st) return;
    if (st.decodeMs > 0) {
      this.wcDecMs = this.wcDecMs === 0 ? st.decodeMs : this.wcDecMs * 0.7 + st.decodeMs * 0.3;
    }
    if (st.frames > this.wcNativeFrames) {
      const delta = Math.min(8, st.frames - this.wcNativeFrames);
      this.wcNativeFrames = st.frames;
      const perfNow = performance.now();
      for (let i = 0; i < delta; i++) this.wcTimes.push(perfNow);
      while (this.wcTimes.length && perfNow - this.wcTimes[0] > 1000) this.wcTimes.shift();
      // Approximate e2e = net+enc (at arrival) + native decode.
      if (this.wcNetMs > 0 && this.wcDecMs > 0) {
        const e2e = this.wcNetMs + this.wcDecMs;
        this.wcE2eMs = this.wcE2eMs === 0 ? e2e : this.wcE2eMs * 0.85 + e2e * 0.15;
      }
    }
    // Only surface a decoder error when the codec is NOT producing frames. The
    // Java bridge's `lastError` is sticky across the progressive-configure
    // ladder: attempt 0 may log a configure failure that attempt 1 recovered
    // from, and that stale string would otherwise re-toast every poll tick
    // even though frames are decoding fine on the Surface. Dedupe by string so
    // a genuine persistent fault is announced once, not every 500ms.
    if (st.error && st.error !== this.wcLastNativeError) {
      this.wcLastNativeError = st.error;
      if (st.frames === 0) {
        console.warn("[remote] native decoder:", st.error);
        this.emitEvent({ event: "decoder", state: "error", reason: st.error });
      }
    } else if (!st.error) {
      // Codec cleared its error (healthy) — allow a future different error to
      // re-announce.
      this.wcLastNativeError = "";
    }
  }

  private wcRequestKeyframe() {
    const now = Date.now();
    if (now - this.wcKfReqAt < 1000) return;
    this.wcKfReqAt = now;
    this.sendControl({ type: "vkf" });
  }

  /** One message on the "video" channel: JSON config, frame header, or fragment. */
  private onWcMsg(data: unknown) {
    // Config (string JSON): sent on activation and every encoder reconfigure.
    if (typeof data === "string") {
      try {
        const cfg = JSON.parse(data) as { codec?: string; w?: number; h?: number };
        if (cfg && typeof cfg.codec === "string" && cfg.codec) {
          const w = typeof cfg.w === "number" && cfg.w > 0 ? Math.round(cfg.w) : this.wcCodedW;
          const h = typeof cfg.h === "number" && cfg.h > 0 ? Math.round(cfg.h) : this.wcCodedH;
          const sizeChanged = w !== this.wcCodedW || h !== this.wcCodedH;
          if (cfg.codec !== this.wcCodec || (!this.wcDecoder && !this.wcNative) || sizeChanged) {
            this.wcCodec = cfg.codec;
            this.wcCodedW = w;
            this.wcCodedH = h;
            this.wcBuildDecoder();
          }
        }
      } catch {
        /* malformed config */
      }
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    // Header: 'G' 'V' flags 0 | seq u32 | tsMs f64 | len u32 (little-endian).
    if (!this.wcHead) {
      if (data.byteLength !== 20) return; // desync — wait for the next header
      const dv = new DataView(data);
      if (dv.getUint8(0) !== 0x47 || dv.getUint8(1) !== 0x56) return;
      const len = dv.getUint32(16, true);
      if (len === 0 || len > 16_000_000) return;
      this.wcHead = {
        key: (dv.getUint8(2) & 1) === 1,
        seq: dv.getUint32(4, true),
        tsMs: dv.getFloat64(8, true),
        len,
      };
      this.wcBuf = new Uint8Array(len);
      this.wcGot = 0;
      return;
    }
    // Payload fragment (ordered reliable channel → simple append).
    const head = this.wcHead;
    const buf = this.wcBuf!;
    const chunk = new Uint8Array(data);
    const room = head.len - this.wcGot;
    buf.set(chunk.subarray(0, Math.min(chunk.length, room)), this.wcGot);
    this.wcGot += chunk.length;
    if (this.wcGot < head.len) return;
    this.wcHead = null;
    this.wcBuf = null;
    this.wcFeedFrame(head, buf);
  }

  /** A complete encoded frame arrived — account for it and hand it to the decoder. */
  private wcFeedFrame(head: { key: boolean; seq: number; tsMs: number; len: number }, bytes: Uint8Array) {
    const now = Date.now();
    if (!this.wcActive) {
      this.wcActive = true;
      this.wcRequestedAt = 0;
      this.emitEvent({ event: "wc", active: true, native: this.wcNative });
    }
    this.wcLastFrameAt = now;
    // Backgrounded (NOT PiP — a PiP window counts as visible): skip decoding to
    // save battery; resync off a fresh keyframe when the app comes back.
    if (document.hidden && !head.key) {
      this.wcAwaitKey = true;
      return;
    }
    this.wcBytes += head.len;
    this.wcByteWin.push({ at: now, bytes: head.len });
    while (this.wcByteWin.length && now - this.wcByteWin[0].at > 2000) this.wcByteWin.shift();
    if (head.key) this.wcKeys++;
    // A delta frame without its reference chain is garbage — wait for a keyframe.
    if (this.wcAwaitKey && !head.key) {
      this.wcRequestKeyframe();
      return;
    }

    // ---- native MediaCodec path (APK) ----------------------------------------
    if (this.wcNative) {
      if (!nativeFeedReady()) {
        // Bridge still attaching — hold for a keyframe once JS interface is up.
        if (head.key) this.wcAwaitKey = true;
        this.wcRequestKeyframe();
        return;
      }
      if (head.key) this.wcAwaitKey = false;
      const tsUs = Math.round(head.tsMs * 1000);
      // Net+enc at arrival (e2e completed when Kotlin reports decode).
      const clk = this.bestClock();
      if (clk) {
        const capturedAtGuest = head.tsMs - clk.off;
        const net = now - capturedAtGuest;
        if (net > -50 && net < 5000) {
          this.wcNetMs = this.wcNetMs === 0 ? net : this.wcNetMs * 0.85 + net * 0.15;
        }
      }
      if (!feedNativeDecoder(tsUs, head.key, bytes)) {
        this.wcAwaitKey = true;
        this.wcRequestKeyframe();
        return;
      }
      this.wcFrames++;
      return;
    }

    // ---- WebCodecs path (web / Quest / Android fallback) ---------------------
    if (!this.wcDecoder && !this.wcBuildDecoder()) return;
    if (this.wcNative) {
      // Build flipped us onto native mid-frame — retry via native branch next key.
      this.wcAwaitKey = true;
      this.wcRequestKeyframe();
      return;
    }
    if (head.key) this.wcAwaitKey = false;
    const tsUs = Math.round(head.tsMs * 1000);
    this.wcMeta.set(tsUs, { arrivedAt: now, tsMs: head.tsMs, bytes: head.len });
    if (this.wcMeta.size > 120) {
      const first = this.wcMeta.keys().next().value;
      if (first !== undefined) this.wcMeta.delete(first);
    }
    try {
      this.wcDecoder!.decode(
        new EncodedVideoChunk({ type: head.key ? "key" : "delta", timestamp: tsUs, data: bytes }),
      );
      this.wcFrames++;
    } catch (e) {
      console.warn("[remote] wc decode submit failed:", e);
      this.wcAwaitKey = true;
      this.wcRequestKeyframe();
    }
  }

  /** Decoded frame out: update latency stats and deliver to the render sink. */
  private onWcFrameOut(frame: VideoFrame) {
    const now = Date.now();
    const meta = this.wcMeta.get(frame.timestamp);
    let capturedAtGuest = 0;
    if (meta) {
      this.wcMeta.delete(frame.timestamp);
      const dec = now - meta.arrivedAt;
      this.wcDecMs = this.wcDecMs === 0 ? dec : this.wcDecMs * 0.85 + dec * 0.15;
      const clk = this.bestClock();
      if (clk) {
        // Host perf clock ≈ guest Date clock + off  ⇒  host ts in guest time.
        capturedAtGuest = meta.tsMs - clk.off;
        const e2e = now - capturedAtGuest;
        const net = meta.arrivedAt - capturedAtGuest;
        // Measured BEFORE pacing on purpose: these feed the playout target below,
        // and folding our own added delay back in would ratchet it upward.
        if (e2e > -50 && e2e < 5000) this.wcE2eMs = this.wcE2eMs === 0 ? e2e : this.wcE2eMs * 0.85 + e2e * 0.15;
        if (net > -50 && net < 5000) this.wcNetMs = this.wcNetMs === 0 ? net : this.wcNetMs * 0.85 + net * 0.15;
      }
    }
    const perfNow = performance.now();
    this.wcTimes.push(perfNow);
    while (this.wcTimes.length && perfNow - this.wcTimes[0] > 1000) this.wcTimes.shift();
    // Responsiveness (pace 0): paint the instant it decodes — the shipped path.
    if (this.wcPaceMs <= 0 || !capturedAtGuest) {
      this.wcDeliver(frame);
      return;
    }
    // Smoothness: rebuild the HOST's capture cadence on the guest. Every frame is
    // shown at capture-time + a constant budget, so an irregular arrival pattern
    // (bursty JPEG→canvas→encode) stops translating into an irregular display.
    // Only a CONSTANT offset can do this — pacing off arrival time just re-prints
    // the jitter one step later.
    const showAt = capturedAtGuest + this.wcE2eMs + this.wcPaceMs;
    const wait = showAt - now;
    if (wait <= 1 || wait > WC_PACE_MAX_WAIT_MS) {
      // Already late, or the estimate drifted absurdly far — show it now.
      this.wcDeliver(frame);
      return;
    }
    this.wcPlayQ.push({ frame, showAt });
    if (this.wcPlayQ.length > WC_PACE_MAX_QUEUE) {
      // Backlog means the budget is too small for this link; draining beats
      // accumulating delay we can never pay back.
      this.wcFlushPaceQueue();
      return;
    }
    this.wcPlayDrain();
  }

  /** Hand a frame to the render sink (sink owns it and must close() it). */
  private wcDeliver(frame: VideoFrame) {
    if (this.wcFrameCb) {
      try {
        this.wcFrameCb(frame);
        return;
      } catch {
        /* fall through to close */
      }
    }
    frame.close();
  }

  /** Release paced frames whose playout time has come, in capture order. */
  private wcPlayDrain = () => {
    if (this.wcPlayTimer !== null) {
      window.clearTimeout(this.wcPlayTimer);
      this.wcPlayTimer = null;
    }
    const now = Date.now();
    while (this.wcPlayQ.length && this.wcPlayQ[0].showAt <= now) {
      this.wcDeliver(this.wcPlayQ.shift()!.frame);
    }
    if (this.wcPlayQ.length) {
      this.wcPlayTimer = window.setTimeout(this.wcPlayDrain, Math.max(1, this.wcPlayQ[0].showAt - Date.now()));
    }
  };

  /** Paint everything queued right now (pace off / teardown / backlog). */
  private wcFlushPaceQueue() {
    if (this.wcPlayTimer !== null) {
      window.clearTimeout(this.wcPlayTimer);
      this.wcPlayTimer = null;
    }
    while (this.wcPlayQ.length) this.wcDeliver(this.wcPlayQ.shift()!.frame);
  }

  /** Best (lowest-RTT) clock-offset sample from the recent heartbeat window. */
  private bestClock(): { off: number; rtt: number } | null {
    if (this.clockSamples.length === 0) return null;
    let best = this.clockSamples[0];
    for (const s of this.clockSamples) if (s.rtt < best.rtt) best = s;
    return best;
  }

  /**
   * Register the render sink for direct-video frames (Control's canvas). The
   * sink takes ownership of each VideoFrame and must close() it after drawing.
   */
  onWcFrame(cb: ((f: VideoFrame) => void) | null): () => void {
    this.wcFrameCb = cb;
    return () => {
      if (this.wcFrameCb === cb) this.wcFrameCb = null;
    };
  }

  /** Live wc-path telemetry for the HUD (null when the path isn't active). */
  wcInfo(): WcStats | null {
    if (!this.wcActive) return null;
    const now = Date.now();
    // Self-trim the fps window so a stalled flow reads 0, not the last value.
    const perfNow = performance.now();
    while (this.wcTimes.length && perfNow - this.wcTimes[0] > 1000) this.wcTimes.shift();
    let winBytes = 0;
    let winFrames = 0;
    for (const b of this.wcByteWin) {
      if (now - b.at <= 1000) {
        winBytes += b.bytes;
        winFrames++;
      }
    }
    const clk = this.bestClock();
    return {
      active: true,
      fps: this.wcTimes.length,
      kbps: Math.round((winBytes * 8) / 1000),
      frames: this.wcFrames,
      keyFrames: this.wcKeys,
      bytes: this.wcBytes,
      avgFrameKB: winFrames > 0 ? Math.round(winBytes / winFrames / 102.4) / 10 : 0,
      decodeMs: Math.round(this.wcDecMs * 10) / 10,
      e2eMs: Math.round(this.wcE2eMs),
      netMs: Math.round(this.wcNetMs),
      queue: this.wcNative ? 0 : (this.wcDecoder?.decodeQueueSize ?? 0),
      codec: this.wcCodec,
      clockRttMs: clk ? Math.round(clk.rtt) : 0,
      native: this.wcNative,
      artifacts: this.wcHostArtifacts >= 0 ? this.wcHostArtifacts : undefined,
      recovered: this.wcHostRecovered >= 0 ? this.wcHostRecovered : undefined,
      recovering: this.wcHostRecovering,
      guestErrors: this.wcErrors,
    };
  }

  /** Apply the current jitter-buffer target to the inbound video receiver. */
  private applyJitter() {
    const rx = this.videoReceiver as unknown as {
      jitterBufferTarget?: number;
      playoutDelayHint?: number;
      jitterBufferDelayHint?: number;
    } | null;
    if (!rx) return;
    // Chromium treats jitterBufferTarget as a MINIMUM (w3c/webrtc-extensions#199),
    // not a cap. Re-asserting it (plus the legacy hints) keeps the UA from
    // drifting upward after underruns when A/V sync is disabled. Never force 0.
    try {
      rx.jitterBufferTarget = this.jitterTarget;
    } catch {
      /* unsupported */
    }
    try {
      rx.playoutDelayHint = this.jitterTarget / 1000;
    } catch {
      /* unsupported */
    }
    try {
      rx.jitterBufferDelayHint = this.jitterTarget / 1000;
    } catch {
      /* unsupported */
    }
  }

  /** Re-assert the lean JB hint every 250ms so Chromium doesn't ratchet upward. */
  private jitterHoldTimer: number | null = null;
  private startJitterHold() {
    this.stopJitterHold();
    this.jitterHoldTimer = window.setInterval(() => {
      if (this.closed || !this.videoReceiver) return;
      this.applyJitter();
    }, 250);
  }
  private stopJitterHold() {
    if (this.jitterHoldTimer != null) {
      window.clearInterval(this.jitterHoldTimer);
      this.jitterHoldTimer = null;
    }
  }

  /**
   * Force a clean teardown + rebuild NOW (bypasses the `connecting` guard and the
   * reconnect backoff). Used by the hard-reset backstop and the stage-stall
   * deadlines — the recoveries that fire when the normal event-driven paths
   * (ICE failed, heartbeat death) never trigger.
   */
  private forceRebuild(reason: string) {
    this.lastHealthyAt = Date.now();
    this.connecting = false;
    this.backoff = BACKOFF_MIN;
    this.clearReconnect();
    this.noteEvent(`rebuild: ${reason}`);
    console.warn("[remote] forcing session rebuild:", reason);
    // Cold-start / auth / negotiation wedges: wipe experimental Tune values that
    // may have broken the handshake (extreme JB / bitrate / etc.) so the retry
    // lands on known-good defaults.
    if (
      reason.includes("stalled") ||
      reason.includes("unanswered") ||
      reason.includes("no transport") ||
      reason.includes("authorization")
    ) {
      try {
        this.resetStreamDefaults();
        this.noteEvent("tune reset → defaults");
      } catch {
        /* ignore */
      }
    }
    this.setProgress("reconnecting", "Connection stalled — rebuilding…");
    this.emit("disconnected");
    this.openSignaling(false).catch(() => this.scheduleReconnect());
  }

  /**
   * Health watchdog: auto-recovers from wedged links the soft reconnect can't (the
   * Wi‑Fi-switch case), and adapts the receiver jitter buffer to the decoder so
   * fewer frames are dropped.
   */
  private startWatchdog() {
    this.stopWatchdog();
    this.lastHealthyAt = Date.now();
    this.watchdogTimer = window.setInterval(async () => {
      if (this.closed || this.denied) return;
      const transportUp = this.pc?.connectionState === "connected";
      const connected = transportUp && this.authed;
      // Transport being up counts as healthy for the hard-reset timer even while
      // we're still "pending" (awaiting the host's approval) — otherwise the link
      // would tear down and rebuild every HARD_RESET_MS while the user is reading
      // the approval prompt on the PC, and each rebuild races the approval (which
      // was surfacing as a spurious "access refused"). The decode-stall check below
      // still requires full authorization.
      if (transportUp) this.lastHealthyAt = Date.now();
      // Backgrounded: timers throttle and getStats is meaningless — skip checks.
      if (document.hidden) return;
      // Hard reset — the ultimate backstop: if the transport hasn't been "connected"
      // for the reset window, force a clean rebuild. Bypasses the `connecting` guard
      // so a PC wedged in "disconnected"/"connecting" (never firing "failed")
      // recovers. Cold starts (never connected yet) get a much shorter fuse: there's
      // nothing established to protect, and the old 60s wait read as "app is broken,
      // restart it".
      const resetAfter = this.connectedOnce ? HARD_RESET_MS : HARD_RESET_FIRST_MS;
      if (Date.now() - this.lastHealthyAt > resetAfter) {
        this.forceRebuild("no transport for too long");
        return;
      }
      // Peer negotiation stall: an offer was applied but the pc never reaches
      // "connected" OR "failed" (ICE limbo after glare with a zombie session from
      // a killed app — the classic cold-start "Peer connection takes forever").
      // Event-driven recovery never fires for this state, so deadline it.
      if (!transportUp && this.progressPhase === "negotiating" && Date.now() - this.phaseChangedAt > NEG_STALL_MS) {
        this.forceRebuild("peer negotiation stalled");
        return;
      }
      // Auth-handshake stall: transport is up but the host never answered our
      // auth (the ask or the verdict got lost around channel-open / a superseded
      // prompt). This used to wedge FOREVER — transportUp keeps the hard-reset
      // timer fed, and nothing ever re-sent the handshake. Now: re-ask every tick
      // (the host re-acks idempotently) and rebuild if it stays unanswered.
      // `authState === "pending"` is excluded — that's a real approval prompt
      // open on the PC, which legitimately takes as long as the user takes.
      if (transportUp && !this.authed && !this.denied && this.authState !== "pending") {
        if (!this.authStallSince) this.authStallSince = Date.now();
        this.sendAuth();
        if (Date.now() - this.authStallSince > AUTH_STALL_MS) {
          this.authStallSince = 0;
          this.forceRebuild("authorization unanswered");
          return;
        }
      } else if (this.authState !== "pending") {
        this.authStallSince = 0;
      }
      if (!connected) return;
      // WebCodecs-path health. Opt-in that never produced frames (old host, codec
      // mismatch) reverts to the track; a live path that stops flowing while a
      // screen is actually watching first asks for a keyframe, then reverts.
      // Sitting on RTC while DIRECT is possible → re-attempt. RTC is a waiting
      // room, not a destination: every tick we're on it, we're paying the jitter
      // buffer this whole path exists to avoid.
      if (this.wcEligible()) void this.maybeStartWc();
      if (this.wcRequestedAt && !this.wcActive && Date.now() - this.wcRequestedAt > 6000) {
        this.wcFallback("no direct-video frames after opt-in");
      }
      if (this.wcActive && this.sinkActive && !document.hidden) {
        if (Date.now() - this.wcLastFrameAt > WATCHDOG_MS * 1.5) {
          this.wcStallTicks++;
          if (this.wcStallTicks === 2) this.wcRequestKeyframe();
          else if (this.wcStallTicks >= 4) {
            this.wcStallTicks = 0;
            this.wcFallback("direct-video flow stalled");
          }
        } else {
          this.wcStallTicks = 0;
          // A clean stretch on DIRECT clears the debt from earlier wobbles, so a
          // link that settles down doesn't inherit a 2-minute backoff.
          this.wcRetryBackoff = this.wcRetryMin;
        }
      }
      // Adaptive jitter buffer only. There is deliberately NO decode-stall reconnect:
      // `framesDecoded` stalls whenever the video isn't being *rendered* (e.g. the
      // user is on the Home/Library tab, not Control), which used to trigger a
      // spurious rebuild every ~10s → the connect→reconnect loop. Genuinely dead
      // links are caught by the data-channel heartbeat and ICE-"failed" instead.
      const st = await this.videoStats().catch(() => null);
      if (!st) return;
      if (st.framesDecoded > this.lastDecoded) this.lastDecoded = st.framesDecoded;
      // Windowed drop ratio: only what happened since the LAST tick. RTP counters
      // are cumulative and reset with a new receiver, so guard against wrap/reset.
      if (st.framesDecoded < this.winDecoded || st.framesDropped < this.winDropped) {
        this.winDecoded = 0;
        this.winDropped = 0;
      }
      const dDecoded = st.framesDecoded - this.winDecoded;
      const dDropped = st.framesDropped - this.winDropped;
      this.winDecoded = st.framesDecoded;
      this.winDropped = st.framesDropped;

      // --- Decode-stall self-heal (the "raised resolution → frozen stream" fix).
      // A mid-stream resolution INCREASE can wedge the phone's hardware H.264
      // decoder: RTP bytes keep arriving but framesDecoded stops advancing, and
      // no quality change recovers it — only a fresh decoder does. Detection is
      // tightly gated (video mounted + page visible + real bytes flowing + zero
      // decodes) so it can't fire when the stream is merely unwatched. Two-stage
      // recovery: first ask the host to rebuild its encoder/track in place
      // (fixes a wedged HOST encoder cheaply, ~6s); if frames still don't decode
      // (~12s) rebuild the whole peer session — a new receiver + decoder, which
      // is exactly what a manual disconnect/reconnect did. Immersive VR is
      // excluded (off-DOM video + different visibility); flat Quest matches APK.
      const dBytes = st.bytesReceived >= this.winBytes ? st.bytesReceived - this.winBytes : 0;
      this.winBytes = st.bytesReceived;
      if (this.sinkActive && !isImmersiveActive() && dDecoded === 0 && dBytes > 30_000) {
        this.stallTicks++;
        if (this.stallTicks === 2) {
          this.sendControl({ type: "vreset" });
        } else if (this.stallTicks >= 4) {
          this.stallTicks = 0;
          this.connecting = false;
          this.backoff = BACKOFF_MIN;
          this.clearReconnect();
          this.setProgress("reconnecting", "Video stalled — rebuilding the stream…");
          this.emit("disconnected");
          this.openSignaling(false).catch(() => this.scheduleReconnect());
          return;
        }
      } else if (dDecoded > 0) {
        this.stallTicks = 0;
      }

      const total = dDecoded + dDropped;
      // Need a handful of frames in the window for the ratio to mean anything
      // (a static screen decodes ~1 keep-alive per second).
      if (total < 5) return;

      // Track freezes for the HUD only — IDR hitches inflate freezeCount even
      // with a huge buffer, so we never grow jitterTarget off them.
      if (st.freezeCount < this.winFreezes) this.winFreezes = 0;
      this.winFreezes = st.freezeCount;

      const ratio = dDropped / total;
      const prev = this.jitterTarget;
      if (ratio > this.jbGrowAt) {
        // Real late-frame drops: nudge up a little (capped lean).
        this.jitterCleanTicks = 0;
        this.jitterTarget = Math.min(this.jbMax, this.jitterTarget + 20);
      } else if (ratio < 0.05) {
        // Clean: snap back toward the low-latency base quickly.
        this.jitterCleanTicks++;
        if (this.jitterCleanTicks >= JITTER_CLEAN_TICKS) {
          this.jitterTarget = Math.max(this.jbMin, this.jitterTarget - 20);
        }
      } else {
        this.jitterCleanTicks = 0;
        // Mid-band: drift toward BASE so a temporary bump doesn't stick.
        if (this.jitterTarget > this.jbBase) {
          this.jitterTarget = Math.max(this.jbBase, this.jitterTarget - 10);
        }
      }
      // Keep the floor pinned to the lean base (no earned-lower floor — 40ms is
      // already the target latency budget).
      this.jitterFloor = this.jbBase;
      if (this.jitterTarget !== prev) this.applyJitter();
    }, WATCHDOG_MS);
  }

  private stopWatchdog() {
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private onData(raw: string) {
    let msg: {
      id?: number;
      ok?: boolean;
      data?: unknown;
      error?: string;
      pong?: number;
      event?: string;
      c?: number;
      i?: number;
      n?: number;
      s?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.pong === "number") {
      const now = Date.now();
      this.lastPong = now;
      // Clock sync: `t` is the host's perf clock at pong time; midpoint of our
      // send/receive maps it onto our Date clock (best sample = lowest RTT).
      const t = (msg as { t?: number }).t;
      if (typeof t === "number") {
        const rtt = now - msg.pong;
        if (rtt >= 0 && rtt < 5000) {
          this.clockSamples.push({ rtt, off: t - (msg.pong + now) / 2 });
          if (this.clockSamples.length > 8) this.clockSamples.shift();
        }
      }
      return;
    }
    if (typeof msg.event === "string") {
      // Auth handshake result from the host gates the "connected" status.
      if (msg.event === "auth") {
        const state = (msg as { state?: string }).state;
        if (state === "ok") {
          this.authState = "ok";
          this.authStallSince = 0;
          this.noteEvent("auth ok");
          this.authed = true;
          this.emit("connected");
          // Host just started capture on the existing track — nudge subscribers to
          // re-attach so the first-approval path doesn't stick on "Waking…".
          this.emitStream();
          // Opt in to the WebCodecs direct-video path when this device can decode
          // H.264 itself (bypasses the receiver jitter buffer entirely).
          void this.maybeStartWc();
          // Same for DIRECT audio — closes the lag behind near-instant video.
          void this.maybeStartAudioDirect();
        } else if (state === "pending") {
          this.authState = "pending";
          this.authStallSince = 0;
          this.noteEvent("host prompt open (approval pending)");
          this.emit("pending");
        } else if (state === "denied") {
          this.authState = "denied";
          this.noteEvent("auth denied");
          this.denied = true;
          this.clearReconnect();
          this.emit("denied");
          this.pc?.close();
          this.deniedCb?.();
        }
      }
      // Host revoked the wc path — resume the WebRTC track. `permanent` means the
      // host has no usable encoder at all; anything else is a fault it expects to
      // recover from, so we re-ask on the backoff rather than stranding the whole
      // session on RTC. Hosts before v3.9.24 send no flag — treat those as
      // retryable too; the backoff caps the cost of asking a hopeless host.
      if (msg.event === "vmode" && (msg as { mode?: string }).mode === "rtc") {
        const permanent = (msg as { permanent?: boolean }).permanent === true;
        if (permanent) {
          this.wcHostRefused = true;
          this.wcReset(false);
        } else {
          // Route through wcFallback so the retry timer + backoff get armed.
          this.wcFallback("host encoder fault", false);
        }
      }
      if (msg.event === "amode") {
        const mode = (msg as { mode?: string }).mode;
        if (mode === "pcm") {
          this.audioDirect = true;
          void this.ensureAudioPlayer();
          // Mute the RTC audio track so we don't double-play.
          if (this.audioStream) {
            for (const t of this.audioStream.getAudioTracks()) t.enabled = false;
          }
        } else if (mode === "rtc") {
          this.audioDirect = false;
          this.teardownAudioPlayer();
          if (this.audioStream) {
            for (const t of this.audioStream.getAudioTracks()) t.enabled = true;
          }
        }
      }
      this.emitEvent(msg as HostEvent);
      return;
    }
    // Chunked response (large payloads split by the host): reassemble by id.
    if (typeof msg.c === "number" && typeof msg.i === "number" && typeof msg.n === "number") {
      const cid = msg.c;
      let acc = this.chunks.get(cid);
      if (!acc) {
        acc = { parts: new Array(msg.n).fill(""), got: 0, n: msg.n };
        this.chunks.set(cid, acc);
      }
      if (acc.parts[msg.i] === "" && typeof msg.s === "string") {
        acc.parts[msg.i] = msg.s;
        acc.got++;
      }
      if (acc.got >= acc.n) {
        this.chunks.delete(cid);
        try {
          this.resolveResponse(JSON.parse(acc.parts.join("")));
        } catch {
          /* malformed reassembly */
        }
      }
      return;
    }
    if (typeof msg.id !== "number") return;
    this.resolveResponse(msg as { id: number; ok?: boolean; data?: unknown; error?: string });
  }

  private resolveResponse(msg: { id: number; ok?: boolean; data?: unknown; error?: string }) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error ?? "request failed"));
  }

  request<T>(path: string, body?: any, timeoutMs = 8000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.chData || this.chData.readyState !== "open") {
        reject(new Error("Not connected yet."));
        return;
      }
      const id = this.reqId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.chData.send(JSON.stringify({ id, path, body }));
      window.setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("Request timed out."));
        }
      }, timeoutMs);
    });
  }

  onFrame(cb: (b64: string) => void) {
    this.frameCb = cb;
  }
  private emitStream() {
    if (!this.stream) return;
    for (const cb of this.streamCbs) {
      try {
        cb(this.stream);
      } catch {
        /* ignore subscriber errors */
      }
    }
  }
  private emitAudio() {
    for (const cb of this.audioCbs) {
      try {
        cb(this.audioStream);
      } catch {
        /* ignore */
      }
    }
  }
  /** Subscribe to the inbound screen video stream (fires immediately if present). */
  onStream(cb: (s: MediaStream) => void): () => void {
    this.streamCbs.add(cb);
    if (this.stream) cb(this.stream);
    return () => {
      this.streamCbs.delete(cb);
    };
  }
  /**
   * Desktop audio track — separate from {@link onStream} on purpose so the
   * <video> element never shares a MediaStream with audio (A/V sync lag).
   */
  onAudioStream(cb: (s: MediaStream | null) => void): () => void {
    this.audioCbs.add(cb);
    cb(this.audioStream);
    return () => {
      this.audioCbs.delete(cb);
    };
  }
  private emitEvent(e: HostEvent) {
    for (const cb of this.eventCbs) {
      try {
        cb(e);
      } catch {
        /* ignore subscriber errors */
      }
    }
  }
  /** Subscribe to unsolicited host events (e.g. `{event:"focus", textField}`). */
  onEvent(cb: (e: HostEvent) => void): () => void {
    this.eventCbs.add(cb);
    return () => {
      this.eventCbs.delete(cb);
    };
  }
  /** Returns true when the message was handed to the open control channel. */
  sendControl(msg: unknown): boolean {
    if (this.chControl?.readyState !== "open") return false;
    try {
      this.chControl.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Send over the lossy move channel when it's open; falls back to the reliable
   * control channel (older hosts don't create "move"). Only for messages where
   * the next update supersedes a lost one (absolute pointer moves).
   */
  sendMove(msg: unknown): boolean {
    if (this.chMove?.readyState === "open") {
      try {
        this.chMove.send(JSON.stringify(msg));
        return true;
      } catch {
        /* fall through to reliable */
      }
    }
    return this.sendControl(msg);
  }
  /**
   * Snapshot the inbound video RTP stats (decode-side fps, bytes, resolution,
   * jitter, packet loss, dropped/frozen frames) so the phone's debug HUD can tell
   * whether the bottleneck is the host, the network, or the decoder.
   */
  async videoStats(): Promise<RtcInboundVideoStats | null> {
    if (!this.pc) return null;
    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      return null;
    }
    let inbound: any = null;
    let rtt = 0;
    report.forEach((s: any) => {
      if (s.type === "inbound-rtp" && s.kind === "video") inbound = s;
      // RTT of the nominated (active) candidate pair — the network leg of latency.
      if (s.type === "candidate-pair" && s.nominated && typeof s.currentRoundTripTime === "number") {
        rtt = s.currentRoundTripTime;
      }
    });
    if (!inbound) return null;
    return {
      framesPerSecond: inbound.framesPerSecond ?? 0,
      framesDecoded: inbound.framesDecoded ?? 0,
      framesDropped: inbound.framesDropped ?? 0,
      bytesReceived: inbound.bytesReceived ?? 0,
      frameWidth: inbound.frameWidth ?? 0,
      frameHeight: inbound.frameHeight ?? 0,
      jitter: inbound.jitter ?? 0,
      packetsLost: inbound.packetsLost ?? 0,
      freezeCount: inbound.freezeCount ?? 0,
      rttMs: Math.round(rtt * 1000),
      jitterBufferDelay: inbound.jitterBufferDelay ?? 0,
      jitterBufferEmittedCount: inbound.jitterBufferEmittedCount ?? 0,
      totalDecodeTime: inbound.totalDecodeTime ?? 0,
      jitterTargetMs: this.jitterTarget,
      jitterBufferMinimumMs:
        (inbound.jitterBufferEmittedCount ?? 0) > 0
          ? Math.round(((inbound.jitterBufferMinimumDelay ?? 0) / inbound.jitterBufferEmittedCount) * 1000)
          : 0,
      packetsReceived: inbound.packetsReceived ?? 0,
      nackCount: inbound.nackCount ?? 0,
      pliCount: inbound.pliCount ?? 0,
      firCount: inbound.firCount ?? 0,
      keyFramesDecoded: inbound.keyFramesDecoded ?? 0,
      framesRendered: inbound.framesRendered ?? 0,
      at: Date.now(),
    };
  }
  onStatus(cb: (s: Status) => void) {
    this.statusCb = cb;
    // Fire immediately with the last known state: by the time the Control screen
    // subscribes, the peer connection has usually already reached "connected"
    // (it was established during pairing), so no further state-change event fires.
    if (this.lastStatus) cb(this.lastStatus);
  }
  /**
   * App-shell subscription for a terminal denial (host rejected this device). Owned
   * by CompanionApp for the connection's whole life — unlike `onStatus`, screens
   * never reassign it — so the app can always drop back to pairing even if the
   * denial arrives while the Control screen holds the status subscription.
   */
  onDenied(cb: () => void) {
    this.deniedCb = cb;
    if (this.denied) cb();
  }
  close() {
    this.closed = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.unsubImmersive?.();
    this.unsubImmersive = null;
    // Tell the host we're leaving on purpose so it stops capturing immediately
    // (it no longer tears down on signaling-level "peer-left" alone).
    // Send on BOTH channels and give the stack a tick to flush — closing the PC
    // in the same turn used to drop the bye, leaving the host on a zombie
    // "liveSession" that blocked the next offer.
    try {
      const bye = JSON.stringify({ type: "bye" });
      if (this.chControl?.readyState === "open") this.chControl.send(bye);
      if (this.chData?.readyState === "open") this.chData.send(bye);
    } catch {
      /* ignore */
    }
    this.clearReconnect();
    this.clearOfferTimeout();
    this.stopHeartbeat();
    this.stopWatchdog();
    this.stopProgressTicker();
    this.stopJitterHold();
    // Drop the sink FIRST: wcReset flushes the pace queue, and on teardown those
    // frames should just be closed, not painted into a dying canvas.
    this.wcFrameCb = null;
    this.wcReset(false);
    this.audioDirect = false;
    this.teardownAudioPlayer();
    try {
      this.audioCtx?.close();
    } catch {
      /* ignore */
    }
    this.audioCtx = null;
    this.audioWorkletReady = false;
    this.clockSamples = [];
    // Defer PC/sig close one macrotask so the bye can leave the socket.
    const pc = this.pc;
    const sig = this.sig;
    this.pc = null;
    this.sig = null;
    this.stream = null;
    this.audioStream = null;
    this.streamCbs.clear();
    this.audioCbs.clear();
    this.eventCbs.clear();
    window.setTimeout(() => {
      try {
        pc?.close();
      } catch {
        /* ignore */
      }
      try {
        sig?.close();
      } catch {
        /* ignore */
      }
    }, 50);
  }
}
