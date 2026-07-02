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

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
/** "pending" = link up, awaiting host approval; "denied" = host rejected us. */
type Status = RTCPeerConnectionState | "error" | "pending" | "denied";
type HostEvent = { event: string; [k: string]: unknown };

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
  at: number;
};

const HEARTBEAT_MS = 5000; // ping cadence
const HEARTBEAT_DEAD_MS = 13000; // no pong within this → treat link as dead
const OFFER_TIMEOUT_MS = 8000; // joined the room but no offer arrived → rejoin
const BACKOFF_MIN = 1500;
const BACKOFF_MAX = 30000;
const WATCHDOG_MS = 3000; // health-check cadence
const HARD_RESET_MS = 60000; // unhealthy this long → full teardown + rebuild
const STALL_MS = 10000; // authorized+connected but no decoded frames → rebuild
// Receiver jitter buffer (ms): the old 20ms was so tight that late frames were
// dropped (≈30% on Android). A larger buffer trades a little latency for far
// fewer drops; it adapts up when the decoder falls behind and eases back.
const JITTER_BASE = 120;
const JITTER_MAX = 300;

export class CloudConn {
  private sig: Signaling | null = null;
  private pc: RTCPeerConnection | null = null;
  private chScreen?: RTCDataChannel;
  private chControl?: RTCDataChannel;
  private chData?: RTCDataChannel;
  private reqId = 1;
  private pending = new Map<number, Pending>();
  private chunks = new Map<number, { parts: string[]; got: number; n: number }>();
  private frameCb: ((b64: string) => void) | null = null;
  private streamCb: ((s: MediaStream) => void) | null = null;
  private eventCb: ((e: HostEvent) => void) | null = null;
  private statusCb: ((s: Status) => void) | null = null;
  private stream: MediaStream | null = null;
  private lastStatus: Status | null = null;
  private closed = false;
  private connectedOnce = false;
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
  private watchdogTimer: number | null = null;
  private lastHealthyAt = Date.now();
  private lastDecoded = -1;
  private lastDecodeAdvanceAt = Date.now();

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

  /** Record and broadcast the latest connection status, healing terminal drops. */
  private emit(s: Status) {
    this.lastStatus = s;
    if (s === "connected") {
      this.connectedOnce = true;
      this.backoff = BACKOFF_MIN; // reset backoff on success
      this.lastHealthyAt = Date.now();
      this.clearReconnect();
    }
    this.statusCb?.(s);
    if (!this.closed && !this.denied && (s === "failed" || s === "closed")) this.scheduleReconnect();
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.denied = false;
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
    this.stopHeartbeat();
    this.clearOfferTimeout();
    this.pc?.close();
    this.pc = null;
    this.sig?.close();

    const sig = new Signaling(this.signalUrl, this.code, "guest");
    this.sig = sig;
    sig.onMessage(async (m) => {
      if (this.sig !== sig || this.closed) return; // stale socket from a prior attempt
      if (m.type === "offer") await this.onOffer(m.sdp);
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
          this.scheduleReconnect();
        }
      } else if (m.type === "room-full") {
        // The room briefly still holds our stale socket (the signaling server now
        // evicts same-role zombies, but a race is possible). Retry instead of
        // dead-ending — this is what made a Wi‑Fi switch require a new code before.
        this.scheduleReconnect();
      }
    });
    sig.onClose(() => {
      if (this.sig === sig && !this.closed && !this.connectedViaPeer()) this.scheduleReconnect();
    });

    try {
      await sig.connect();
      // Our join makes the host emit its offer; we answer in onOffer(). If the
      // host never sends one (e.g. it thinks a previous session is still live),
      // don't hang forever — rejoin, which makes the host re-announce us.
      this.armOfferTimeout();
    } catch (e) {
      if (throwOnFail && !this.connectedOnce) throw e;
      this.scheduleReconnect();
    }
  }

  private armOfferTimeout() {
    this.clearOfferTimeout();
    this.offerTimer = window.setTimeout(() => {
      this.offerTimer = null;
      if (!this.closed && !this.connectedViaPeer()) this.scheduleReconnect();
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
    if (this.closed || this.denied || this.reconnectTimer !== null) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSignaling(false).catch(() => this.scheduleReconnect());
    }, wait);
  }

  private clearReconnect() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async onOffer(sdp: string) {
    this.clearOfferTimeout();
    this.pc?.close(); // a fresh offer supersedes any prior/wedged session
    this.stream = null; // new session → new tracks; don't accumulate dead ones
    this.authed = false; // every fresh peer requires re-authorization by the host
    this.videoReceiver = null;
    const pc = new RTCPeerConnection({ iceServers: defaultIceServers(this.iceServers) });
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
    // ICE can wedge without a connectionState change; nudge a reconnect on failure.
    pc.oniceconnectionstatechange = () => {
      if (this.pc === pc && pc.iceConnectionState === "failed" && !this.closed) this.scheduleReconnect();
    };
    // The screen now arrives as a real media track (hardware-decoded video). The
    // host sends video and audio in separate streams (so the receiver never
    // delays video to lip-sync with the audio jitter buffer); merge the tracks
    // into one local stream for the single <video> element.
    this.pc.ontrack = (e) => {
      if (this.pc !== pc) return;
      if (!this.stream) this.stream = new MediaStream();
      this.stream.addTrack(e.track);
      // Shrink the receiver jitter buffer: screen control wants minimal latency, so
      // trade a little jitter resilience for responsiveness. Not 0 (that stutters at
      // high resolution) — a small target keeps the decoder from buffering ahead.
      if (e.track.kind === "video") {
        this.videoReceiver = e.receiver;
        this.jitterTarget = JITTER_BASE;
        this.applyJitter();
      }
      this.streamCb?.(this.stream);
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

  /** Apply the current jitter-buffer target to the inbound video receiver. */
  private applyJitter() {
    const rx = this.videoReceiver as unknown as { jitterBufferTarget?: number; playoutDelayHint?: number } | null;
    if (!rx) return;
    try {
      rx.jitterBufferTarget = this.jitterTarget; // ms (modern Chromium)
    } catch {
      /* unsupported */
    }
    try {
      rx.playoutDelayHint = this.jitterTarget / 1000; // seconds (legacy name)
    } catch {
      /* unsupported */
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
      const connected = this.pc?.connectionState === "connected" && this.authed;
      if (connected) this.lastHealthyAt = Date.now();
      // Backgrounded: timers throttle and getStats is meaningless — skip checks.
      if (document.hidden) {
        this.lastDecodeAdvanceAt = Date.now();
        return;
      }
      // Hard reset: unhealthy for too long → tear down and rebuild from scratch.
      if (Date.now() - this.lastHealthyAt > HARD_RESET_MS) {
        this.lastHealthyAt = Date.now();
        this.backoff = BACKOFF_MIN;
        this.clearReconnect();
        this.openSignaling(false).catch(() => this.scheduleReconnect());
        return;
      }
      if (!connected) return;
      // Decode-stall + adaptive jitter: sample inbound video stats.
      const st = await this.videoStats().catch(() => null);
      if (!st) return;
      if (st.framesDecoded > this.lastDecoded) {
        this.lastDecoded = st.framesDecoded;
        this.lastDecodeAdvanceAt = Date.now();
      } else if (Date.now() - this.lastDecodeAdvanceAt > STALL_MS) {
        // Connected + approved but no new frames for 10s → the stream is wedged.
        this.lastDecodeAdvanceAt = Date.now();
        this.emit("disconnected");
        this.openSignaling(false).catch(() => this.scheduleReconnect());
        return;
      }
      // Adapt the jitter buffer to the observed drop rate.
      const total = st.framesDecoded + st.framesDropped;
      const ratio = total > 0 ? st.framesDropped / total : 0;
      const prev = this.jitterTarget;
      if (ratio > 0.15) this.jitterTarget = Math.min(JITTER_MAX, this.jitterTarget + 40);
      else if (ratio < 0.03) this.jitterTarget = Math.max(JITTER_BASE, this.jitterTarget - 20);
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
        } else if (state === "pending") {
          this.emit("pending");
        } else if (state === "denied") {
          this.denied = true;
          this.clearReconnect();
          this.emit("denied");
          this.pc?.close();
        }
      }
      this.eventCb?.(msg as HostEvent);
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

  request<T>(path: string, body?: any): Promise<T> {
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
      }, 8000);
    });
  }

  onFrame(cb: (b64: string) => void) {
    this.frameCb = cb;
  }
  /** Subscribe to the inbound screen video stream (fires immediately if present). */
  onStream(cb: (s: MediaStream) => void) {
    this.streamCb = cb;
    if (this.stream) cb(this.stream);
  }
  /** Subscribe to unsolicited host events (e.g. `{event:"focus", textField}`). */
  onEvent(cb: (e: HostEvent) => void) {
    this.eventCb = cb;
  }
  sendControl(msg: unknown) {
    if (this.chControl?.readyState === "open") this.chControl.send(JSON.stringify(msg));
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
    report.forEach((s: any) => {
      if (s.type === "inbound-rtp" && s.kind === "video") inbound = s;
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
    this.pc?.close();
    this.pc = null;
    this.sig?.close();
    this.sig = null;
    this.stream = null;
  }
}
