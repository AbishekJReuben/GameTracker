/**
 * Remote client used by the companion phone app to talk to the desktop's remote
 * server over Tailscale/LAN. Stores the paired base URL + bearer token, and
 * exposes typed GET helpers, media-URL rewriting, and WebSocket URLs for the
 * live/screen/control channels.
 */

const LS_BASE = "gt.remote.base";
const LS_TOKEN = "gt.remote.token";

let base = localStorage.getItem(LS_BASE) ?? "";
let token = localStorage.getItem(LS_TOKEN) ?? "";

/** True when this bundle is running as the phone companion (set by its shell/build). */
export function isCompanion(): boolean {
  return (
    typeof window !== "undefined" &&
    (!!(window as unknown as { __GT_COMPANION__?: boolean }).__GT_COMPANION__ ||
      import.meta.env?.VITE_APP_TARGET === "companion")
  );
}

export function remotePaired(): boolean {
  return !!base && !!token;
}
export function remoteBase(): string {
  return base;
}

function normBase(input: string): string {
  let b = input.trim();
  if (!/^https?:\/\//i.test(b)) {
    // Bare host: assume TLS for domain names (the Cloudflare-tunnelled endpoint),
    // plain http for a raw LAN/Tailscale IP address.
    const host = b.split("/")[0].split(":")[0];
    const isIp = /^[0-9.]+$/.test(host);
    b = `${isIp ? "http" : "https"}://${b}`;
  }
  return b.replace(/\/+$/, "");
}

function persist() {
  localStorage.setItem(LS_BASE, base);
  localStorage.setItem(LS_TOKEN, token);
}

export function clearRemote() {
  base = "";
  token = "";
  localStorage.removeItem(LS_BASE);
  localStorage.removeItem(LS_TOKEN);
}

/** Exchange the pairing PIN for a bearer token and remember the connection. */
export async function pair(address: string, pin: string): Promise<{ name: string; version: string }> {
  const b = normBase(address);
  const res = await fetch(`${b}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: pin.trim() }),
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? "Wrong PIN — check the code on your PC." : `Pairing failed (${res.status}).`);
  }
  const data = (await res.json()) as { token: string; name: string; version: string };
  base = b;
  token = data.token;
  persist();
  return { name: data.name, version: data.version };
}

/** Authenticated GET returning JSON. Clears the session on 401 so the UI re-pairs. */
export async function remoteGet<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    clearRemote();
    throw new Error("Session expired — pair again.");
  }
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return (await res.json()) as T;
}

/** Rewrite an absolute local media path to a URL the phone can load. */
export function remoteMediaUrl(absPath: string | null | undefined): string | null {
  if (!absPath) return null;
  if (/^https?:\/\//i.test(absPath)) return absPath;
  return `${base}/media?path=${encodeURIComponent(absPath)}`;
}

/** ws:// URL for a channel (live | screen | control), token in the query. */
export function remoteWsUrl(path: "/ws" | "/screen" | "/control"): string {
  const wsBase = base.replace(/^http/i, "ws");
  return `${wsBase}${path}?token=${encodeURIComponent(token)}`;
}
