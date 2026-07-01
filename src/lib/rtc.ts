/**
 * Shared WebRTC helpers for GameTracker Remote's "connect from anywhere" mode.
 *
 * Both peers run in a webview and use the browser-native RTCPeerConnection, so
 * there's no native WebRTC dependency. They meet through the signaling server
 * (a room keyed by a short connection code) to exchange SDP + ICE, then talk
 * peer-to-peer over data channels:
 *   - "screen"  : host → guest, base64 JPEG frames
 *   - "control" : guest → host, input events (JSON)
 *   - "data"    : request/response for stats (JSON, id-correlated)
 *
 * The desktop app is the **host** (it has the screen + input); the phone is the
 * **guest**. The host creates the channels and the offer.
 */

export type Role = "host" | "guest";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Default ICE servers: a free public STUN. TURN can be appended by the caller. */
export function defaultIceServers(extra?: IceServer[]): RTCIceServer[] {
  const base: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  return extra && extra.length ? [...base, ...(extra as RTCIceServer[])] : base;
}

type SignalMsg =
  | { type: "peer-joined"; role?: string }
  | { type: "peer-left" }
  | { type: "room-full" }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: RTCIceCandidateInit };

/** Thin wrapper over the signaling WebSocket for one room. */
export class Signaling {
  private ws: WebSocket | null = null;
  private handlers: ((m: SignalMsg) => void)[] = [];
  private openResolvers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];

  constructor(private url: string, private room: string, private role: Role) {}

  connect(): Promise<void> {
    const base = this.url.replace(/^http/i, "ws").replace(/\/+$/, "");
    const u = `${base}/ws?room=${encodeURIComponent(this.room)}&role=${this.role}`;
    this.ws = new WebSocket(u);
    this.ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(typeof ev.data === "string" ? ev.data : "") as SignalMsg;
        this.handlers.forEach((h) => h(m));
      } catch {
        /* ignore non-JSON */
      }
    };
    this.ws.onclose = () => this.closeHandlers.forEach((h) => h());
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("no socket"));
      this.ws.onopen = () => {
        this.openResolvers.forEach((r) => r());
        resolve();
      };
      this.ws.onerror = () => reject(new Error("Couldn't reach the signaling server."));
    });
  }

  onMessage(h: (m: SignalMsg) => void) {
    this.handlers.push(h);
  }

  /** Fires when the signaling socket closes (used to auto-reconnect). */
  onClose(h: () => void) {
    this.closeHandlers.push(h);
  }

  send(m: SignalMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

/** Wire a peer connection's ICE candidates out through signaling. */
export function pipeIce(pc: RTCPeerConnection, sig: Signaling) {
  pc.onicecandidate = (e) => {
    if (e.candidate) sig.send({ type: "candidate", candidate: e.candidate.toJSON() });
  };
}
