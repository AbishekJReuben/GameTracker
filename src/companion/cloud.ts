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
type Status = RTCPeerConnectionState | "error";
type HostEvent = { event: string; [k: string]: unknown };

const HEARTBEAT_MS = 5000; // ping cadence
const HEARTBEAT_DEAD_MS = 13000; // no pong within this → treat link as dead
const BACKOFF_MIN = 1500;
const BACKOFF_MAX = 30000;

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

  constructor(private signalUrl: string, private code: string, private iceServers?: IceServer[]) {}

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
      this.clearReconnect();
    }
    this.statusCb?.(s);
    if (!this.closed && (s === "failed" || s === "closed")) this.scheduleReconnect();
  }

  async connect(): Promise<void> {
    this.closed = false;
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
        this.emit("disconnected");
        this.scheduleReconnect();
      } else if (m.type === "room-full") this.emit("error");
    });
    sig.onClose(() => {
      if (this.sig === sig && !this.closed && !this.connectedViaPeer()) this.scheduleReconnect();
    });

    try {
      await sig.connect();
      // Our join makes the host emit its offer; we answer in onOffer().
    } catch (e) {
      if (throwOnFail && !this.connectedOnce) throw e;
      this.scheduleReconnect();
    }
  }

  private connectedViaPeer(): boolean {
    return this.pc?.connectionState === "connected";
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer !== null) return;
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
    this.pc = new RTCPeerConnection({ iceServers: defaultIceServers(this.iceServers) });
    pipeIce(this.pc, this.sig!);
    this.pc.onconnectionstatechange = () => this.pc && this.emit(this.pc.connectionState);
    // ICE can wedge without a connectionState change; nudge a reconnect on failure.
    this.pc.oniceconnectionstatechange = () => {
      const st = this.pc?.iceConnectionState;
      if (st === "failed" && !this.closed) this.scheduleReconnect();
    };
    // The screen now arrives as a real media track (hardware-decoded video).
    this.pc.ontrack = (e) => {
      this.stream = e.streams[0] ?? new MediaStream([e.track]);
      this.streamCb?.(this.stream);
    };
    this.pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === "screen") {
        this.chScreen = ch;
        ch.onmessage = (ev) => this.frameCb?.(ev.data as string);
      } else if (ch.label === "control") {
        this.chControl = ch;
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
      if (Date.now() - this.lastPong > HEARTBEAT_DEAD_MS) {
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
  onStatus(cb: (s: Status) => void) {
    this.statusCb = cb;
    // Fire immediately with the last known state: by the time the Control screen
    // subscribes, the peer connection has usually already reached "connected"
    // (it was established during pairing), so no further state-change event fires.
    if (this.lastStatus) cb(this.lastStatus);
  }
  close() {
    this.closed = true;
    this.clearReconnect();
    this.stopHeartbeat();
    this.pc?.close();
    this.pc = null;
    this.sig?.close();
    this.sig = null;
    this.stream = null;
  }
}
