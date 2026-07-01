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
import { api } from "./api";
import { Signaling, defaultIceServers, pipeIce, type IceServer } from "./rtc";

interface HostOptions {
  signalUrl: string;
  code: string;
  iceServers?: IceServer[];
  fps?: number;
  onClients?: (n: number) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
  let videoSender: RTCRtpSender | null = null;
  let focusTimer: number | null = null;
  let lastTextField = false;
  let sigBackoff = 1000;
  let sigRetry: number | null = null;

  // Live stream-quality state; the guest re-tunes it over the control channel.
  const quality = { maxW: 1600, jpeg: 70, fps: opts.fps ?? 30 };

  const stopCapture = () => {
    try {
      api.remoteStopCapture();
    } catch {
      /* not on desktop / already stopped */
    }
  };

  const applyBitrate = () => {
    if (!videoSender) return;
    const p = videoSender.getParameters();
    if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
    p.encodings[0].maxBitrate = bitrateFor(quality);
    p.encodings[0].maxFramerate = quality.fps;
    videoSender.setParameters(p).catch(() => {});
  };

  const teardownPeer = () => {
    if (focusTimer) {
      clearInterval(focusTimer);
      focusTimer = null;
    }
    stopCapture();
    videoTrack?.stop();
    videoTrack = null;
    videoSender = null;
    dataCh = null;
    pc?.close();
    pc = null;
    lastTextField = false;
    opts.onClients?.(0);
  };

  /**
   * Build a WebRTC video track fed by Rust-captured JPEG frames: the capture
   * thread streams frames over a binary channel → we decode + draw to a canvas →
   * `captureStream()` hands it to WebRTC, which hardware-encodes H.264/VP9 with
   * inter-frame compression and adaptive bitrate.
   */
  const buildVideoTrack = async (): Promise<MediaStreamTrack | null> => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const cctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (buf) => {
      const bytes = buf as unknown as ArrayBuffer;
      createImageBitmap(new Blob([bytes], { type: "image/jpeg" }))
        .then((bmp) => {
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          cctx?.drawImage(bmp, 0, 0);
          bmp.close?.();
        })
        .catch(() => {});
    };
    try {
      await api.remoteStartCapture(ch, quality.maxW, quality.fps, quality.jpeg);
    } catch {
      return null;
    }
    // No fps arg → a frame is captured on every canvas draw, so the delivered rate
    // tracks the Rust capture thread exactly and live fps changes take effect
    // without re-creating the track (the encoder ceiling is set via setParameters).
    const stream = canvas.captureStream?.();
    const track = stream?.getVideoTracks?.()[0] ?? null;
    if (track) {
      try {
        (track as MediaStreamTrack & { contentHint: string }).contentHint = "text";
      } catch {
        /* not supported */
      }
    }
    return track;
  };

  const startPeer = async () => {
    teardownPeer(); // reset any prior session
    if (!sig) return;
    pc = new RTCPeerConnection({ iceServers: defaultIceServers(opts.iceServers) });
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
    const control = pc.createDataChannel("control");
    const data = pc.createDataChannel("data");
    dataCh = data;

    videoTrack = await buildVideoTrack();
    if (videoTrack) {
      const stream = new MediaStream([videoTrack]);
      videoSender = pc.addTrack(videoTrack, stream);
    }

    control.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string);
        // The `quality` message re-tunes the capture + encoder; not an input event.
        if (msg && msg.type === "quality") {
          if (typeof msg.maxW === "number") quality.maxW = clamp(msg.maxW, 320, 3840);
          if (typeof msg.quality === "number") quality.jpeg = clamp(msg.quality, 20, 95);
          if (typeof msg.fps === "number") quality.fps = clamp(msg.fps, 1, 60);
          try {
            api.remoteSetCaptureQuality(quality.maxW, quality.fps, quality.jpeg);
          } catch {
            /* ignore */
          }
          applyBitrate();
          return;
        }
        api.remoteInject(msg);
      } catch {
        /* ignore malformed */
      }
    };

    data.onmessage = async (e) => {
      let req: { id?: number; path?: string; body?: any; ping?: number };
      try {
        req = JSON.parse(e.data as string);
      } catch {
        return;
      }
      // Heartbeat: bounce a pong so the guest can detect a silently-dead link.
      if (typeof req.ping === "number") {
        if (data.readyState === "open") data.send(JSON.stringify({ pong: req.ping }));
        return;
      }
      if (typeof req.id !== "number" || typeof req.path !== "string") return;
      const id = req.id;
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
    // phone so it can pop its keyboard automatically.
    data.onopen = () => {
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
        teardownPeer();
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
