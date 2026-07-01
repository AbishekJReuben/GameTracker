/**
 * Transport dispatch for the companion screens. In "lan" mode data comes from the
 * desktop's HTTP server over Tailscale/LAN; in "cloud" mode it comes over the
 * WebRTC data channel (P2P, brokered by the signaling server). Screens call
 * `apiGet`/`mediaUrl` and don't care which.
 */

import { remoteGet, remoteMediaUrl } from "@/lib/remoteClient";
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

/** Artwork isn't proxied over the cloud data channel (v1) — LAN only. */
export function mediaUrl(p: string | null | undefined): string | null {
  return mode === "cloud" ? null : remoteMediaUrl(p);
}
