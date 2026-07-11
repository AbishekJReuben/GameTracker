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

/**
 * Default ICE servers: several public STUN endpoints for reliable candidate
 * gathering, plus a public **TURN relay** so the link still forms when a direct
 * P2P path can't (symmetric NAT / CGNAT / restrictive firewalls) — the same
 * relay-fallback strategy AnyDesk/Chrome-Remote-Desktop use to "never drop".
 * Without TURN, hard NATs simply fail to connect or flap. Extra servers (e.g. a
 * private TURN) can be appended by the caller.
 */
export function defaultIceServers(extra?: IceServer[]): RTCIceServer[] {
  const base: RTCIceServer[] = [
    // Cloudflare's STUN is fast and highly available; Google's are the usual
    // fallbacks. More reflexive servers = a better chance of a direct P2P path
    // (which is lower-latency and drops far less than a relayed one).
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
    // Open Relay Project — free public TURN (UDP/TCP/TLS) with static creds. Used
    // only as a last resort when a direct candidate pair can't be established.
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  ];
  return extra && extra.length ? [...base, ...(extra as RTCIceServer[])] : base;
}

type SignalMsg =
  | { type: "peer-joined"; role?: string }
  | { type: "peer-left" }
  | { type: "room-full" }
  // `sid` tags the offer's session so the guest can tell an ICE-restart
  // renegotiation of the *current* session (apply in place, keep auth+decoder)
  // apart from a brand-new session (full rebuild). Absent on legacy hosts.
  | { type: "offer"; sdp: string; sid?: string }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: RTCIceCandidateInit }
  | { type: "ping" };

/** Thin wrapper over the signaling WebSocket for one room. */
export class Signaling {
  private ws: WebSocket | null = null;
  private handlers: ((m: SignalMsg) => void)[] = [];
  private openResolvers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private pingTimer: number | null = null;

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
    this.ws.onclose = () => {
      this.stopPing();
      this.closeHandlers.forEach((h) => h());
    };
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("no socket"));
      this.ws.onopen = () => {
        // Keep the socket (and any proxy in between) from idling out: once the
        // WebRTC link is up nothing else flows here, and cloud proxies commonly
        // kill WebSockets after ~60s of silence — which used to cascade into a
        // full session rebuild. The relayed ping is ignored by the other peer.
        this.startPing();
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

  private startPing() {
    this.stopPing();
    this.pingTimer = window.setInterval(() => this.send({ type: "ping" }), 20000);
  }

  private stopPing() {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  close() {
    this.stopPing();
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
