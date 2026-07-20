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

/** LocalStorage key for the user's Sarvam STT key on the phone. Seeded from the PC
 *  over the trusted channel (see CompanionApp) or entered in companion Settings. */
export const LS_SARVAM_KEY = "gt.sarvam.key";
export const LS_SARVAM_LANG = "gt.sarvam.lang";

/** Companion speech-to-text: record → this → Sarvam (native ureq, runtime key).
 *  Mirrors the desktop mic. Returns "" if no key is set or transcription fails. */
export async function companionTranscribe(audioB64: string, mime: string): Promise<string> {
  const apiKey = (localStorage.getItem(LS_SARVAM_KEY) || "").trim();
  if (!apiKey) throw new Error("Add a Sarvam API key in Settings to use voice-to-text.");
  const language = (localStorage.getItem(LS_SARVAM_LANG) || "").trim() || undefined;
  if (isTauri()) {
    return await invoke<string>("speech_to_text", { audioBase64: audioB64, mime, language, apiKey });
  }
  // Web companion (no Tauri): call Sarvam directly. Best-effort; may be CORS-limited.
  const form = new FormData();
  form.append("model", "saaras:v3");
  form.append("mode", "transcribe");
  if (language) form.append("language_code", language);
  const bin = b64ToBytes(audioB64);
  form.append("file", new Blob([bin as BlobPart], { type: mime }), "audio");
  const r = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: { "api-subscription-key": apiKey },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  return (j as { transcript?: string }).transcript ?? "";
}

interface CompanionClipState {
  items: ClipItem[];
  connected: boolean;
  ready: boolean; // has a secret key configured
  deviceId: string;
  init: () => Promise<void>;
  stop: () => void;
  /** Inject a secret received from the host (post-approval) and (re)connect.
   *  Idempotent — a no-op if this secret is already active. */
  setSecret: (secret: string) => Promise<void>;
  addText: (text: string) => Promise<void>;
  addImage: (dataUrl: string) => Promise<void>;
  copy: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  togglePin: (item: ClipItem) => Promise<void>;
  captureClipboard: () => Promise<string>;
  diagnostics: () => Promise<any>;
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
// The secret the current key was derived from. Lets setSecret no-op when the
// host re-pushes the same secret on every reconnect.
let activeSecret = "";
// Filled in by the store's init() — the live-secret path (host pushed a secret
// post-approval) calls this to (re)derive the key + relay space and connect.
let startWithSecret: ((secret: string) => Promise<void>) | null = null;
// Last error from provisioning the native Android service (surfaced in
// diagnostics so a JNI/bridge failure is visible instead of silent).
let nativeStartError = "";

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
      // The phone keeps history only in memory (no local SQLite like the desktop),
      // so ask for the FULL history (since=0) on connect — otherwise `since=lastRev`
      // skips everything copied before this session and "old history can't be seen".
      // The relay streams oldest→newest; we dedupe into a Map and keep the newest
      // MAX_ITEMS, so memory stays bounded regardless of how much history exists.
      sock.send(JSON.stringify({ t: "hello", since: 0 }));
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

  // Derive the key + relay space from a secret, remember it, and connect. Shared
  // by the first-run init() and the live-secret path (host pushed it post-auth).
  startWithSecret = async (secret: string) => {
    wsBase = (localStorage.getItem("gt.remote.signal") || DEFAULT_SIGNAL_URL).replace(/\/+$/, "");
    httpBase = wsBase.replace(/^ws/, "http");
    key = await deriveKey(secret);
    clipId = await deriveClipId(secret);
    activeSecret = secret;
    lastRev = Number(localStorage.getItem(`gt.clip.rev.${clipId}`) || 0);
    let deviceId = localStorage.getItem("gt.clip.device") || "";
    if (!deviceId) {
      deviceId = `phone-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem("gt.clip.device", deviceId);
    }
    started = true;
    set({ ready: true, deviceId });
    connect();

    // Provision + (re)start the native Android foreground service with this
    // config. This is THE auto-start path: the host pushes the secret on every
    // approved connect, so the background service always ends up configured
    // (hasKey/relayHost set) without the user ever visiting the Clipboard screen.
    // Previously only the "Turn on floating widget" button did this, which left
    // the service running with empty prefs — connected to nothing, silently.
    if (isTauri()) {
      try {
        await invoke("clipboard_service_start", {
          enabled: true,
          secret,
          deviceId,
          signalUrl: wsBase,
          sarvamKey: (localStorage.getItem(LS_SARVAM_KEY) || "").trim(),
        });
        nativeStartError = "";
      } catch (e) {
        nativeStartError = e instanceof Error ? e.message : String(e);
        console.warn("clipboard: native service provisioning failed:", nativeStartError);
      }
    }
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
      
      if (isTauri()) {
        try {
          const snapStr = await invoke<string>("clipboard_service_snapshot");
          if (snapStr && snapStr !== "{}") {
            const snap = JSON.parse(snapStr);
            if (snap.items && Array.isArray(snap.items)) {
              for (const e of snap.items) {
                if (!items.has(e.id)) {
                  items.set(e.id, {
                    id: e.id,
                    kind: "text",
                    text: e.text,
                    imagePath: null,
                    thumbPath: null,
                    mime: "text/plain",
                    size: e.text.length,
                    createdUtc: new Date(e.createdAtMs).toISOString(),
                    deviceId: get().deviceId + "-native",
                    deviceName: "Phone",
                    source: "android",
                    pinned: false,
                  });
                }
              }
              publish();
            }
          }
        } catch {}
      }

      const secret = localStorage.getItem("gt.remote.secret") || "";
      if (!secret) {
        set({ ready: false });
        return;
      }
      await startWithSecret?.(secret);
    },

    setSecret: async (secret) => {
      const s = (secret || "").trim();
      if (!s) return;
      // Remember it so a re-open of the Clipboard tab (or an app restart before
      // the host re-approves) can still sync.
      localStorage.setItem("gt.remote.secret", s);
      // Already running with THIS secret — nothing to do.
      if (started && key && activeSecret === s) return;
      // Tear down any prior session (different/empty secret) then start fresh.
      if (started) {
        started = false;
        clearTimeout(retry);
        clearInterval(ping);
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        ws = undefined;
      }
      await startWithSecret?.(s);
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

    diagnostics: async () => {
      const snapStr = isTauri() ? await invoke<string>("clipboard_service_snapshot").catch(() => "{}") : "{}";
      return {
        webview: {
          started,
          connected: get().connected,
          wsState: ws ? ws.readyState : -1,
          relayUrl: wsBase,
          clipId,
          deviceId: get().deviceId,
          hasKey: !!key,
          lastRev,
          backoffMs: backoff,
          nativeStartError: nativeStartError || "(none)",
        },
        nativeService: JSON.parse(snapStr)
      };
    },
  };
});
