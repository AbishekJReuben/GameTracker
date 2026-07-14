/**
 * A `RemoteLink` abstracts the screen+control transport for the Control screen so
 * the same UI works whether frames arrive over the LAN WebSocket or the cloud
 * WebRTC data channel.
 */

import { remoteWsUrl } from "@/lib/remoteClient";
import type { CloudConn, ConnectSnapshot, RtcInboundVideoStats } from "./cloud";

export type ControlMsg =
  | { type: "move"; x: number; y: number }
  | { type: "moverel"; dx: number; dy: number }
  | { type: "click"; x?: number; y?: number; button?: string }
  | { type: "down"; button?: string }
  | { type: "up"; button?: string }
  | { type: "scroll"; dx?: number; dy: number }
  | { type: "text"; value: string }
  | { type: "key"; name: string }
  | { type: "keydown"; name: string }
  | { type: "keyup"; name: string }
  | { type: "monitor"; index: number }
  /** Ask the desktop host to start (or keep) an aux WebRTC room for this monitor. */
  | { type: "auxHost"; monitor: number }
  | { type: "auxStop"; monitor: number }
  // Virtual-gamepad stream: a physical controller attached to the phone. `buttons`
  // is an XInput-style bitmask; sticks are -1..1 (Y flipped to up-positive),
  // triggers 0..1. `gamepadprobe` asks the host if ViGEmBus is installed;
  // `gamepadstop` releases + unplugs the virtual controller.
  | {
      type: "gamepad";
      buttons: number;
      lx: number;
      ly: number;
      rx: number;
      ry: number;
      lt: number;
      rt: number;
    }
  | { type: "gamepadprobe" }
  | { type: "gamepadstop" };

/** Content-optimization mode: tune the pipeline for crisp text or smooth video. */
export type ContentMode = "auto" | "text" | "video";

/** Live stream-quality knobs the phone pushes to the desktop. `bitrate` (kbps) caps
 * the WebRTC encoder directly; 0/undefined means auto (derived from resolution/fps). */
export type QualitySettings = { maxW: number; quality: number; fps: number; mode?: ContentMode; bitrate?: number };

export interface RemoteLink {
  /** Deliver a raw tile wire-frame (LAN fallback; see capture.rs `TileEncoder`). */
  onFrame(cb: (frame: Uint8Array) => void): void;
  /** Deliver the inbound screen as a WebRTC media stream (cloud video-track path). */
  onStream(cb: (stream: MediaStream) => void): void | (() => void);
  /** Unsolicited host events (e.g. PC text-field focus). */
  onEvent(cb: (e: { event: string; [k: string]: unknown }) => void): void | (() => void);
  onStatus(cb: (connected: boolean) => void): void;
  /** Granular connect/reconnect progress (cloud WebRTC only). */
  onProgress?(cb: (s: ConnectSnapshot) => void): () => void;
  send(msg: ControlMsg): void;
  /** Re-tune the live screen stream (resolution / JPEG quality / frame rate). */
  setQuality(q: QualitySettings): void;
  /** Decode-side WebRTC video telemetry for the debug HUD (cloud only). */
  netStats(): Promise<RtcInboundVideoStats | null>;
  close(): void;
}

/** LAN transport: /screen (JPEG frames) + /control WebSockets, with auto-reconnect. */
export function makeWsLink(): RemoteLink {
  let screenWs: WebSocket | null = null;
  let controlWs: WebSocket | null = null;
  let frameCb: ((b: Uint8Array) => void) | null = null;
  let statusCb: ((c: boolean) => void) | null = null;
  let alive = true;
  let connected = false;
  let quality: QualitySettings | null = null;
  let retry: number | undefined;

  const setConnected = (c: boolean) => {
    connected = c;
    statusCb?.(c);
  };

  const connectScreen = () => {
    if (!alive) return;
    const ws = new WebSocket(remoteWsUrl("/screen"));
    ws.binaryType = "arraybuffer";
    screenWs = ws;
    ws.onopen = () => {
      setConnected(true);
      // Re-apply the chosen quality on every (re)connect.
      if (quality) ws.send(JSON.stringify({ type: "quality", ...quality }));
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) frameCb?.(new Uint8Array(ev.data));
    };
    ws.onclose = () => {
      setConnected(false);
      if (alive) retry = window.setTimeout(connectScreen, 1500);
    };
    ws.onerror = () => ws.close();
  };
  const connectControl = () => {
    if (!alive) return;
    const ws = new WebSocket(remoteWsUrl("/control"));
    controlWs = ws;
    ws.onclose = () => {
      if (alive) window.setTimeout(connectControl, 1500);
    };
    ws.onerror = () => ws.close();
  };

  connectScreen();
  connectControl();

  return {
    onFrame(cb) {
      frameCb = cb;
    },
    onStream() {
      /* LAN uses JPEG frames over onFrame, not a media stream. */
    },
    onEvent() {
      /* LAN has no focus events. */
    },
    onStatus(cb) {
      statusCb = cb;
      cb(connected); // Report current state immediately (socket may already be open).
    },
    send(msg) {
      if (controlWs?.readyState === WebSocket.OPEN) controlWs.send(JSON.stringify(msg));
    },
    setQuality(q) {
      quality = q;
      if (screenWs?.readyState === WebSocket.OPEN) screenWs.send(JSON.stringify({ type: "quality", ...q }));
    },
    async netStats() {
      return null; // LAN path has no WebRTC media stats.
    },
    close() {
      alive = false;
      if (retry) window.clearTimeout(retry);
      screenWs?.close();
      controlWs?.close();
    },
  };
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const arr = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** Cloud transport: video stream + control over an established WebRTC connection. */
export function makeRtcLink(conn: CloudConn): RemoteLink {
  let frameCb: ((b: Uint8Array) => void) | null = null;
  conn.onFrame((b64) => {
    if (frameCb) frameCb(base64ToBytes(b64));
  });
  // Last absolute move sent via the LOSSY channel and not yet re-anchored. Button
  // events are position-dependent, so before any click/down/up we re-send that
  // move on the RELIABLE control channel — same-stream ordering then guarantees
  // the host's cursor is at the finger's position when the button event lands,
  // even if every lossy packet in between was dropped.
  let unanchoredMove: ControlMsg | null = null;
  return {
    onFrame(cb) {
      frameCb = cb;
    },
    onStream(cb) {
      return conn.onStream(cb);
    },
    onEvent(cb) {
      return conn.onEvent(cb);
    },
    onStatus(cb) {
      conn.onStatus((s) => cb(s === "connected"));
    },
    onProgress(cb) {
      return conn.onProgress(cb);
    },
    send(msg) {
      // Absolute pointer moves are idempotent and superseded by the next one, so
      // they ride the unordered/no-retransmit "move" channel: a dropped packet
      // never delays fresher input, and a burst of moves can't head-of-line
      // block clicks/keys behind a stale retransmit on the control stream.
      // (Relative moves would double-apply if re-anchored — they stay reliable,
      // as does everything else.)
      if (msg.type === "move") {
        unanchoredMove = msg;
        conn.sendMove(msg);
        return;
      }
      if (unanchoredMove && (msg.type === "click" || msg.type === "down" || msg.type === "up")) {
        conn.sendControl(unanchoredMove);
        unanchoredMove = null;
      }
      conn.sendControl(msg);
    },
    setQuality(q) {
      // The host intercepts `quality` messages on the control channel and re-tunes
      // its capture loop; they never reach the input injector.
      conn.sendControl({ type: "quality", ...q });
    },
    netStats() {
      return conn.videoStats();
    },
    close() {
      // The CloudConn is owned by CompanionApp; closing it happens on disconnect.
    },
  };
}
