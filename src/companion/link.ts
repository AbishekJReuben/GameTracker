/**
 * Transport dispatch for the companion screens. In "lan" mode data comes from the
 * desktop's HTTP server over Tailscale/LAN; in "cloud" mode it comes over the
 * WebRTC data channel (P2P, brokered by the signaling server). Screens call
 * `apiGet`/`mediaUrl` and don't care which.
 */

import { remoteGet, remotePost, remoteMediaUrl } from "@/lib/remoteClient";
import type { CloudConn } from "./cloud";

type Mode = "lan" | "cloud";

let mode: Mode = "lan";
let conn: CloudConn | null = null;

export function setLanMode() {
  mode = "lan";
  conn = null;
}
export function setCloudMode(c: CloudConn) {
  mode = "cloud";
  conn = c;
}
export function activeMode(): Mode {
  return mode;
}
export function cloudConn(): CloudConn | null {
  return conn;
}

export async function apiGet<T>(path: string): Promise<T> {
  if (mode === "cloud" && conn) return conn.request<T>(path);
  return remoteGet<T>(path);
}

export async function apiPost<T>(path: string, body?: any): Promise<T> {
  if (mode === "cloud" && conn) return conn.request<T>(path, body);
  return remotePost<T>(path, body);
}

/** Synchronous artwork URL — LAN only (cloud needs the async `loadMedia`). */
export function mediaUrl(p: string | null | undefined): string | null {
  return mode === "cloud" ? null : remoteMediaUrl(p);
}

// Cache resolved artwork by absolute path so a grid of covers is fetched once.
const mediaCache = new Map<string, Promise<string | null>>();

// A whole library's worth of covers would otherwise fire hundreds of requests at
// once and swamp the single data channel — starving stats/control traffic. Gate
// cloud media fetches to a few in flight so covers stream in and the link stays
// snappy for everything else.
const MEDIA_CONCURRENCY = 6;
let mediaInFlight = 0;
const mediaQueue: (() => void)[] = [];

function pumpMediaQueue() {
  while (mediaInFlight < MEDIA_CONCURRENCY && mediaQueue.length > 0) {
    const next = mediaQueue.shift()!;
    next();
  }
}

function fetchMediaGated(path: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const run = () => {
      mediaInFlight++;
      conn!
        .request<string | null>(`/media?path=${encodeURIComponent(path)}`)
        .catch(() => null)
        .then((url) => {
          mediaInFlight--;
          pumpMediaQueue();
          resolve(url);
        });
    };
    mediaQueue.push(run);
    pumpMediaQueue();
  });
}

/**
 * Resolve artwork to a loadable URL, working over both transports:
 *  - LAN: a direct `/media?path=` URL.
 *  - Cloud: fetch the bytes over the data channel as a base64 data URL (cached,
 *    concurrency-gated so a big grid streams in without swamping the channel).
 */
export function loadMedia(p: string | null | undefined): Promise<string | null> {
  if (!p) return Promise.resolve(null);
  if (mode === "cloud" && conn) {
    let hit = mediaCache.get(p);
    if (!hit) {
      hit = fetchMediaGated(p);
      mediaCache.set(p, hit);
    }
    return hit;
  }
  return Promise.resolve(remoteMediaUrl(p));
}
