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
import { isQuestBrowser } from "./device";

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

export type ConnectSnapshot = {
  phase: ConnectPhase;
  status: Status;
  attempt: number;
  backoffMs: number;
  iceState?: RTCIceConnectionState;
  job: string;
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

const HEARTBEAT_MS = 5000; // ping cadence
const HEARTBEAT_DEAD_MS = 13000; // no pong within this → treat link as dead
const OFFER_TIMEOUT_MS = 8000; // joined the room but no offer arrived → rejoin
const BACKOFF_MIN = 1500;
const BACKOFF_MAX = 30000;
const WATCHDOG_MS = 3000; // health-check cadence
const HARD_RESET_MS = 60000; // transport down this long → full teardown + rebuild
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
const JITTER_BASE = 40;
const JITTER_MAX = 120;
const JITTER_MIN = 40;
/** Consecutive clean watchdog ticks (3s each) before easing from a raised target. */
const JITTER_CLEAN_TICKS = 2;

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
  private jitterTarget = JITTER_BASE;
  /** Current lower bound for jitterTarget; eases toward JITTER_MIN on clean links. */
  private jitterFloor = JITTER_BASE;
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
  private progressListeners = new Set<(s: ConnectSnapshot) => void>();
  private progressPhase: ConnectPhase = "idle";
  private progressJob = "Starting…";
  private reconnectAttempt = 0;
  private reconnectBackoffMs = 0;
  private reconnectAt = 0;
  private iceState?: RTCIceConnectionState;

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
    return {
      phase: this.progressPhase,
      status: this.lastStatus ?? "new",
      attempt: this.reconnectAttempt,
      backoffMs,
      iceState: this.iceState,
      job: this.progressJob,
    };
  }

  private setProgress(phase: ConnectPhase, job: string) {
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
      this.setProgress("pending_approval", "Waiting for approval on your PC…");
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
    await this.openSignaling(true);
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
    this.videoReceiver = null;
    // A new PC restarts inbound-RTP counters from 0, so the old frame count is
    // meaningless — reset it so the jitter-adaptation baseline is correct.
    this.lastDecoded = -1;
    this.winDecoded = 0;
    this.winDropped = 0;
    this.winBytes = 0;
    this.stallTicks = 0;
    this.winFreezes = 0;
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
        this.jitterTarget = JITTER_BASE;
        this.jitterFloor = JITTER_BASE;
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

  /** Send the identity + optional secret so the host can authorize this device. */
  private sendAuth() {
    if (this.chControl?.readyState !== "open") return;
    this.setProgress("authenticating", "Authorizing this device…");
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
      // for HARD_RESET_MS, force a clean rebuild. Bypasses the `connecting` guard so
      // a PC wedged in "disconnected"/"connecting" (never firing "failed") recovers.
      if (Date.now() - this.lastHealthyAt > HARD_RESET_MS) {
        this.lastHealthyAt = Date.now();
        this.connecting = false;
        this.backoff = BACKOFF_MIN;
        this.clearReconnect();
        this.setProgress("reconnecting", "Connection stalled — rebuilding…");
        this.emit("disconnected");
        this.openSignaling(false).catch(() => this.scheduleReconnect());
        return;
      }
      if (!connected) return;
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
      // is exactly what a manual disconnect/reconnect did. Quest is excluded:
      // its immersive sessions consume the video off-DOM and page visibility
      // semantics differ, so the gate can't be trusted there.
      const dBytes = st.bytesReceived >= this.winBytes ? st.bytesReceived - this.winBytes : 0;
      this.winBytes = st.bytesReceived;
      if (this.sinkActive && !isQuestBrowser() && dDecoded === 0 && dBytes > 30_000) {
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
      if (ratio > 0.15) {
        // Real late-frame drops: nudge up a little (capped lean).
        this.jitterCleanTicks = 0;
        this.jitterTarget = Math.min(JITTER_MAX, this.jitterTarget + 20);
      } else if (ratio < 0.05) {
        // Clean: snap back toward the low-latency base quickly.
        this.jitterCleanTicks++;
        if (this.jitterCleanTicks >= JITTER_CLEAN_TICKS) {
          this.jitterTarget = Math.max(JITTER_MIN, this.jitterTarget - 20);
        }
      } else {
        this.jitterCleanTicks = 0;
        // Mid-band: drift toward BASE so a temporary bump doesn't stick.
        if (this.jitterTarget > JITTER_BASE) {
          this.jitterTarget = Math.max(JITTER_BASE, this.jitterTarget - 10);
        }
      }
      // Keep the floor pinned to the lean base (no earned-lower floor — 40ms is
      // already the target latency budget).
      this.jitterFloor = JITTER_BASE;
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
      this.lastPong = Date.now();
      return;
    }
    if (typeof msg.event === "string") {
      // Auth handshake result from the host gates the "connected" status.
      if (msg.event === "auth") {
        const state = (msg as { state?: string }).state;
        if (state === "ok") {
          this.authed = true;
          this.emit("connected");
          // Host just started capture on the existing track — nudge subscribers to
          // re-attach so the first-approval path doesn't stick on "Waking…".
          this.emitStream();
        } else if (state === "pending") {
          this.emit("pending");
        } else if (state === "denied") {
          this.denied = true;
          this.clearReconnect();
          this.emit("denied");
          this.pc?.close();
          this.deniedCb?.();
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
    // Tell the host we're leaving on purpose so it stops capturing immediately
    // (it no longer tears down on signaling-level "peer-left" alone).
    try {
      if (this.chControl?.readyState === "open") this.chControl.send(JSON.stringify({ type: "bye" }));
    } catch {
      /* ignore */
    }
    this.clearReconnect();
    this.clearOfferTimeout();
    this.stopHeartbeat();
    this.stopWatchdog();
    this.stopJitterHold();
    this.pc?.close();
    this.pc = null;
    this.sig?.close();
    this.sig = null;
    this.stream = null;
    this.audioStream = null;
    this.streamCbs.clear();
    this.audioCbs.clear();
    this.eventCbs.clear();
  }
}
