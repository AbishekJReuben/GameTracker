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

import { api } from "./api";
import { Signaling, defaultIceServers, pipeIce, type IceServer } from "./rtc";

interface HostOptions {
  signalUrl: string;
  code: string;
  iceServers?: IceServer[];
  fps?: number;
  onClients?: (n: number) => void;
}

/** Route a stats request path to the matching backend call. */
async function handleData(path: string): Promise<unknown> {
  const [p, query] = path.split("?");
  const params = new URLSearchParams(query ?? "");
  const num = (k: string) => {
    const v = params.get(k);
    return v == null ? undefined : Number(v);
  };
  switch (p) {
    case "/api/dashboard":
      return api.dashboard();
    case "/api/tracking":
      return api.trackingState();
    case "/api/games":
      return api.listGames();
    case "/api/sessions":
      return api.listSessions({ kind: (params.get("kind") as "game" | "app") || null, limit: num("limit") ?? 500 });
    case "/api/music/overview":
      return api.mediaOverview();
    case "/api/music/top":
      return api.mediaTop(num("limit"));
    case "/api/music/recent":
      return api.mediaRecent(num("limit"));
    default:
      throw new Error(`unknown path ${p}`);
  }
}

/** Start hosting. Returns a stop() that tears everything down. */
export function startHost(opts: HostOptions): () => void {
  const fps = opts.fps ?? 12;
  const sig = new Signaling(opts.signalUrl, opts.code, "host");
  let pc: RTCPeerConnection | null = null;
  let frameTimer: number | null = null;
  let stopped = false;

  const teardown = () => {
    if (frameTimer) {
      clearInterval(frameTimer);
      frameTimer = null;
    }
    pc?.close();
    pc = null;
    opts.onClients?.(0);
  };

  const startPeer = async () => {
    teardown(); // reset any prior session
    pc = new RTCPeerConnection({ iceServers: defaultIceServers(opts.iceServers) });
    pipeIce(pc, sig);
    pc.onconnectionstatechange = () => {
      const st = pc?.connectionState;
      if (st === "connected") opts.onClients?.(1);
      if (st === "failed" || st === "disconnected" || st === "closed") teardown();
    };

    const screen = pc.createDataChannel("screen", { ordered: false, maxRetransmits: 0 });
    const control = pc.createDataChannel("control");
    const data = pc.createDataChannel("data");

    screen.onopen = () => {
      frameTimer = window.setInterval(async () => {
        if (screen.readyState !== "open" || screen.bufferedAmount > 512 * 1024) return;
        try {
          const b64 = await api.remoteGrabFrame(1280, 60);
          if (b64 && screen.readyState === "open") screen.send(b64);
        } catch {
          /* transient */
        }
      }, Math.round(1000 / fps));
    };

    control.onmessage = (e) => {
      try {
        api.remoteInject(JSON.parse(e.data as string));
      } catch {
        /* ignore malformed */
      }
    };

    data.onmessage = async (e) => {
      let req: { id: number; path: string };
      try {
        req = JSON.parse(e.data as string);
      } catch {
        return;
      }
      try {
        const result = await handleData(req.path);
        if (data.readyState === "open") data.send(JSON.stringify({ id: req.id, ok: true, data: result }));
      } catch (err) {
        if (data.readyState === "open")
          data.send(JSON.stringify({ id: req.id, ok: false, error: String(err) }));
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sig.send({ type: "offer", sdp: offer.sdp ?? "" });
  };

  sig.onMessage(async (m) => {
    if (stopped) return;
    if (m.type === "peer-joined") {
      await startPeer();
    } else if (m.type === "answer" && pc) {
      await pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
    } else if (m.type === "candidate" && pc) {
      try {
        await pc.addIceCandidate(m.candidate);
      } catch {
        /* ignore */
      }
    } else if (m.type === "peer-left") {
      teardown();
    }
  });

  sig.connect().catch(() => {
    /* signaling unreachable; will be retried by the caller re-mounting */
  });

  return () => {
    stopped = true;
    teardown();
    sig.close();
  };
}
