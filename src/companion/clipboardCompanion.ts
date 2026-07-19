// Companion shared-clipboard sync (webview).
//
// A self-contained twin of the desktop engine for the phone/web companion: it
// talks straight to the relay's /clip namespace with the SAME E2E crypto, keeping
// items in memory (the relay is the permanent store — a fresh open streams the
// history back). The Android native service keeps the app present in the
// background; this runs the actual sync while the companion is open (which is also
// the only time Android lets us read the OS clipboard).

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";
import { DEFAULT_SIGNAL_URL } from "@/lib/remoteConfig";
import type { ClipItem } from "@/lib/clip";
import {
  deriveKey,
  clipId as deriveClipId,
  encryptText,
  decryptText,
  encryptBytes,
  decryptBytes,
  bytesToB64,
  b64ToBytes,
} from "@/lib/clipboardCrypto";

const MAX_ITEMS = 300;

interface CompanionClipState {
  items: ClipItem[];
  connected: boolean;
  ready: boolean; // has a secret key configured
  deviceId: string;
  init: () => Promise<void>;
  stop: () => void;
  addText: (text: string) => Promise<void>;
  addImage: (dataUrl: string) => Promise<void>;
  copy: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  togglePin: (item: ClipItem) => Promise<void>;
  captureClipboard: () => Promise<string>;
}

let ws: WebSocket | undefined;
let key: CryptoKey | undefined;
let clipId = "";
let wsBase = "";
let httpBase = "";
let lastRev = 0;
let backoff = 1000;
let retry: ReturnType<typeof setTimeout> | undefined;
let ping: ReturnType<typeof setInterval> | undefined;
let started = false;

function sortItems(map: Map<string, ClipItem>): ClipItem[] {
  return [...map.values()]
    .filter((i) => !i.deleted)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.createdUtc.localeCompare(a.createdUtc);
    })
    .slice(0, MAX_ITEMS);
}

const items = new Map<string, ClipItem>();

export const useCompanionClip = create<CompanionClipState>((set, get) => {
  const publish = () => set({ items: sortItems(items) });

  const ready = () => !!ws && ws.readyState === WebSocket.OPEN && !!key;

  const putBlob = async (id: string, cipher: Uint8Array) => {
    try {
      const r = await fetch(`${httpBase}/clip/blob/${clipId}/${id}`, {
        method: "PUT",
        body: cipher as BodyInit,
      });
      return r.ok;
    } catch {
      return false;
    }
  };
  const fetchBlob = async (id: string): Promise<Uint8Array | null> => {
    try {
      const r = await fetch(`${httpBase}/clip/blob/${clipId}/${id}`);
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    } catch {
      return null;
    }
  };

  const handle = async (v: any) => {
    if (v.t === "synced") {
      if (v.rev > lastRev) lastRev = v.rev;
      localStorage.setItem(`gt.clip.rev.${clipId}`, String(lastRev));
      return;
    }
    if (v.t !== "item" || !v.itemId || !key) return;
    if (v.rev > lastRev) lastRev = v.rev;
    localStorage.setItem(`gt.clip.rev.${clipId}`, String(lastRev));

    if (v.deleted) {
      items.delete(v.itemId);
      publish();
      return;
    }
    const existing = items.get(v.itemId);
    if (v.kind === undefined && v.pinned !== undefined && existing) {
      items.set(v.itemId, { ...existing, pinned: v.pinned });
      publish();
      return;
    }
    // Our own items already local — just keep pin state fresh.
    if (v.deviceId === get().deviceId && existing) return;

    try {
      const base: ClipItem = {
        id: v.itemId,
        kind: v.kind ?? "text",
        text: null,
        imagePath: null,
        thumbPath: null,
        mime: v.mime ?? null,
        size: v.size ?? 0,
        createdUtc: v.createdUtc ?? new Date().toISOString(),
        deviceId: v.deviceId ?? "",
        deviceName: v.deviceName ?? null,
        source: v.deviceName ? "desktop" : "remote",
        pinned: v.pinned ?? false,
      };
      if (v.kind === "image" && v.hasBlob) {
        const bytes = await fetchBlob(v.itemId);
        if (bytes) {
          const raw = await decryptBytes(key, bytes);
          const url = `data:${v.mime ?? "image/png"};base64,${bytesToB64(raw)}`;
          base.imagePath = url;
          base.thumbPath = url;
        }
      } else if (v.textCipher) {
        base.text = await decryptText(key, v.textCipher);
      }
      items.set(v.itemId, base);
      publish();
    } catch {
      /* skip */
    }
  };

  const connect = () => {
    if (!started) return;
    let sock: WebSocket;
    try {
      sock = new WebSocket(
        `${wsBase}/clip/ws?clip=${clipId}&device=${encodeURIComponent(get().deviceId)}`,
      );
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      backoff = 1000;
      set({ connected: true });
      sock.send(JSON.stringify({ t: "hello", since: lastRev }));
      clearInterval(ping);
      ping = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "ping" }));
      }, 30000);
    };
    sock.onmessage = (ev) => {
      try {
        void handle(JSON.parse(ev.data as string));
      } catch {
        /* ignore */
      }
    };
    sock.onclose = () => {
      set({ connected: false });
      scheduleReconnect();
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    };
  };

  const scheduleReconnect = () => {
    clearInterval(ping);
    if (!started) return;
    clearTimeout(retry);
    retry = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };

  const addLocal = async (item: ClipItem, cipherPayload: object) => {
    items.set(item.id, item);
    publish();
    if (ready()) ws!.send(JSON.stringify({ t: "add", item: cipherPayload }));
  };

  return {
    items: [],
    connected: false,
    ready: false,
    deviceId: "",

    init: async () => {
      if (started) return;
      const secret = localStorage.getItem("gt.remote.secret") || "";
      if (!secret) {
        set({ ready: false });
        return;
      }
      wsBase = (localStorage.getItem("gt.remote.signal") || DEFAULT_SIGNAL_URL).replace(/\/+$/, "");
      httpBase = wsBase.replace(/^ws/, "http");
      key = await deriveKey(secret);
      clipId = await deriveClipId(secret);
      lastRev = Number(localStorage.getItem(`gt.clip.rev.${clipId}`) || 0);
      let deviceId = localStorage.getItem("gt.clip.device") || "";
      if (!deviceId) {
        deviceId = `phone-${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem("gt.clip.device", deviceId);
      }
      started = true;
      set({ ready: true, deviceId });
      connect();
    },

    stop: () => {
      started = false;
      clearTimeout(retry);
      clearInterval(ping);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = undefined;
      set({ connected: false });
    },

    addText: async (text) => {
      const t = text.trim();
      if (!t || !key) return;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const item: ClipItem = {
        id,
        kind: "text",
        text: t,
        imagePath: null,
        thumbPath: null,
        mime: "text/plain",
        size: t.length,
        createdUtc: now,
        deviceId: get().deviceId,
        deviceName: "Phone",
        source: "android",
        pinned: false,
      };
      await addLocal(item, {
        itemId: id,
        deviceId: item.deviceId,
        deviceName: "Phone",
        kind: "text",
        mime: "text/plain",
        size: t.length,
        createdUtc: now,
        pinned: false,
        textCipher: await encryptText(key, t),
        hasBlob: false,
      });
    },

    addImage: async (dataUrl) => {
      if (!key) return;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const raw = b64ToBytes(dataUrl);
      const cipher = await encryptBytes(key, raw);
      const ok = await putBlob(id, cipher);
      if (!ok) return;
      const item: ClipItem = {
        id,
        kind: "image",
        text: null,
        imagePath: dataUrl,
        thumbPath: dataUrl,
        mime: "image/png",
        size: raw.length,
        createdUtc: now,
        deviceId: get().deviceId,
        deviceName: "Phone",
        source: "android",
        pinned: false,
      };
      await addLocal(item, {
        itemId: id,
        deviceId: item.deviceId,
        deviceName: "Phone",
        kind: "image",
        mime: "image/png",
        size: raw.length,
        createdUtc: now,
        pinned: false,
        hasBlob: true,
      });
    },

    copy: async (id) => {
      const it = items.get(id);
      if (!it) return;
      if (it.kind === "text" && it.text) {
        if (isTauri()) await invoke("clipboard_write", { text: it.text }).catch(() => {});
        else await navigator.clipboard?.writeText(it.text).catch(() => {});
      }
    },

    remove: async (id) => {
      items.delete(id);
      set({ items: sortItems(items) });
      if (ready()) ws!.send(JSON.stringify({ t: "delete", itemId: id }));
    },

    togglePin: async (item) => {
      const pinned = !item.pinned;
      const cur = items.get(item.id);
      if (cur) items.set(item.id, { ...cur, pinned });
      set({ items: sortItems(items) });
      if (ready()) ws!.send(JSON.stringify({ t: "pin", itemId: item.id, pinned }));
    },

    // Read the current OS clipboard (Android: JNI; web: navigator). Returns text.
    captureClipboard: async () => {
      try {
        if (isTauri()) return await invoke<string>("clipboard_read");
        return (await navigator.clipboard?.readText()) || "";
      } catch {
        return "";
      }
    },
  };
});
