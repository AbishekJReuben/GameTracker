/**
 * A `RemoteLink` abstracts the screen+control transport for the Control screen so
 * the same UI works whether frames arrive over the LAN WebSocket or the cloud
 * WebRTC data channel.
 */

import { remoteWsUrl } from "@/lib/remoteClient";
import type { CloudConn } from "./cloud";

export type ControlMsg =
  | { type: "move"; x: number; y: number }
  | { type: "down"; button?: string }
  | { type: "up"; button?: string }
  | { type: "scroll"; dy: number }
  | { type: "text"; value: string }
  | { type: "key"; name: string };

export interface RemoteLink {
  onFrame(cb: (frame: Blob) => void): void;
  onStatus(cb: (connected: boolean) => void): void;
  send(msg: ControlMsg): void;
  close(): void;
}

/** LAN transport: /screen (JPEG frames) + /control WebSockets, with auto-reconnect. */
export function makeWsLink(): RemoteLink {
  let screenWs: WebSocket | null = null;
  let controlWs: WebSocket | null = null;
  let frameCb: ((b: Blob) => void) | null = null;
  let statusCb: ((c: boolean) => void) | null = null;
  let alive = true;
  let retry: number | undefined;

  const connectScreen = () => {
    if (!alive) return;
    const ws = new WebSocket(remoteWsUrl("/screen"));
    ws.binaryType = "arraybuffer";
    screenWs = ws;
    ws.onopen = () => statusCb?.(true);
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) frameCb?.(new Blob([ev.data], { type: "image/jpeg" }));
    };
    ws.onclose = () => {
      statusCb?.(false);
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
    onStatus(cb) {
      statusCb = cb;
    },
    send(msg) {
      if (controlWs?.readyState === WebSocket.OPEN) controlWs.send(JSON.stringify(msg));
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

/** Cloud transport: frames + control over an established WebRTC connection. */
export function makeRtcLink(conn: CloudConn): RemoteLink {
  let frameCb: ((b: Blob) => void) | null = null;
  conn.onFrame((b64) => {
    if (frameCb) frameCb(new Blob([base64ToBytes(b64)], { type: "image/jpeg" }));
  });
  return {
    onFrame(cb) {
      frameCb = cb;
    },
    onStatus(cb) {
      conn.onStatus((s) => cb(s === "connected"));
    },
    send(msg) {
      conn.sendControl(msg);
    },
    close() {
      // The CloudConn is owned by CompanionApp; closing it happens on disconnect.
    },
  };
}
