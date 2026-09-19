// Companion shared-clipboard sync (webview).
//
// A self-contained twin of the desktop engine for the phone/web companion: it
// talks straight to the relay's /clip namespace with the SAME E2E crypto, keeping
// items in memory (the relay is the permanent store — a fresh open streams the
// history back). The Android native service keeps the app present in the
// background only when explicitly enabled; this client runs only while the Notes
// page is visible. Remote desktop approval alone never starts Notes.

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
  b64ToBytes,
} from "@/lib/clipboardCrypto";

const MAX_ITEMS = 300;
const BACKGROUND_OPT_IN = "gt.clip.background.v2";

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
  /** Folder names to show as chips: item memberships ∪ empty-folder entities. */
  tags: string[];
  connected: boolean;
  ready: boolean; // has a secret key configured
  deviceId: string;
  backgroundEnabled: boolean;
  initializeBackground: () => Promise<void>;
  setBackgroundEnabled: (enabled: boolean) => Promise<void>;
  loadImage: (id: string) => Promise<void>;
  init: () => Promise<void>;
  stop: () => void;
  /** Save approved credentials. Remote approval does NOT enable Notes sync. */
  setSecret: (secret: string) => Promise<void>;
  addText: (text: string, tags?: string[]) => Promise<void>;
  addImage: (dataUrl: string, tags?: string[]) => Promise<void>;
  /** Edit a text note in place — bumps it to the top, synced to all devices. */
  editText: (id: string, text: string) => Promise<void>;
  moveToFolder: (id: string, folder: string) => Promise<void>;
  setTags: (id: string, tags: string[]) => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  deleteFolder: (name: string) => Promise<void>;
  copy: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  togglePin: (item: ClipItem) => Promise<void>;
  captureClipboard: () => Promise<string>;
  /** Read an image from the OS clipboard (Android native). Returns a data URL or "". */
  captureClipboardImage: () => Promise<string>;
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
let generation = 0;
let messageQueue = Promise.resolve();
let publishTimer: ReturnType<typeof setTimeout> | undefined;
const imageRequests = new Map<string, AbortController>();
const imageUrls = new Map<string, string>();
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
    .filter((i) => !i.deleted && (i.kind as string) !== "folder")
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.createdUtc.localeCompare(a.createdUtc);
    })
    .slice(0, MAX_ITEMS);
}

/** Folder names: union of (a) folders live notes are filed under and (b) empty
 *  folder entities (`folderEntities`). Alphabetical. */
function folderNames(map: Map<string, ClipItem>, entities: Map<string, string>): string[] {
  const set = new Set<string>();
  for (const i of map.values()) {
    if (i.deleted || (i.kind as string) === "folder") continue;
    const f = (i.folder ?? "").trim();
    if (f) set.add(f);
  }
  for (const name of entities.values()) {
    const n = name.trim();
    if (n) set.add(n);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function tagNames(map: Map<string, ClipItem>): string[] {
  const tags = new Set<string>();
  for (const item of map.values()) for (const tag of item.tags ?? []) if (tag.trim()) tags.add(tag.trim());
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/** Content key for in-memory dedup: identical text / identical image data URL
 *  maps to the same existing note (bumped to the top instead of duplicated). */
function contentKey(kind: string, text?: string | null, image?: string | null): string {
  return kind === "image" ? `image:${image ?? ""}` : `text:${text ?? ""}`;
}

const items = new Map<string, ClipItem>();
/** Empty-folder registry: entity id → folder name. */
const folderEntities = new Map<string, string>();

export const useCompanionClip = create<CompanionClipState>((set, get) => {
  const publish = () => {
    // Coalesce a history replay into small UI batches, not one render per row.
    if (publishTimer !== undefined) return;
    publishTimer = setTimeout(() => {
      publishTimer = undefined;
      const visible = sortItems(items);
      const keep = new Set(visible.map((item) => item.id));
      for (const id of items.keys()) if (!keep.has(id)) {
        items.delete(id);
        releaseImage(id);
      }
      set({ items: visible, tags: tagNames(items) });
    }, 50);
  };

  const releaseImage = (id: string) => {
    imageRequests.get(id)?.abort();
    imageRequests.delete(id);
    const url = imageUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    imageUrls.delete(id);
  };

  const disconnect = () => {
    generation++;
    clearTimeout(retry);
    clearInterval(ping);
    const old = ws;
    ws = undefined; // invalidate callbacks BEFORE close (including synchronous mocks)
    old?.close();
    messageQueue = Promise.resolve();
    for (const id of new Set([...imageUrls.keys(), ...imageRequests.keys()])) releaseImage(id);
    for (const [id, item] of items) if (item.kind === "image") {
      items.set(id, { ...item, imagePath: null, thumbPath: null });
    }
    set({ connected: false });
    publish();
  };

  let nativeQueue = Promise.resolve();
  const provisionBackground = (): Promise<void> => {
    // Serialize toggles/approval/mount calls; the final user's choice wins.
    nativeQueue = nativeQueue.catch(() => {}).then(async () => {
      if (!isTauri()) return;
      const enabled = get().backgroundEnabled;
      const secret = localStorage.getItem("gt.remote.secret") || "";
      if (enabled && !secret) throw new Error("Connect to your PC before enabling background Notes.");
      try {
        await invoke("clipboard_service_start", {
          enabled, secret, deviceId: ensureDeviceId(),
          signalUrl: localStorage.getItem("gt.remote.signal") || DEFAULT_SIGNAL_URL,
          sarvamKey: (localStorage.getItem(LS_SARVAM_KEY) || "").trim(),
        });
        nativeStartError = "";
      } catch (e) {
        nativeStartError = String(e);
        throw e;
      }
    });
    return nativeQueue;
  };

  const ensureDeviceId = () => {
    let deviceId = localStorage.getItem("gt.clip.device") || "";
    if (!deviceId) {
      deviceId = `phone-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem("gt.clip.device", deviceId);
    }
    set({ deviceId });
    return deviceId;
  };

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
  const handle = async (v: any, current: () => boolean) => {
    if (v.t === "synced") return;
    if (v.t !== "item" || !v.itemId || !key) return;

    // Folder entity (empty-folder registry): a content-less kind='folder' row.
    if (v.kind === "folder") {
      if (v.deleted) folderEntities.delete(v.itemId);
      else folderEntities.set(v.itemId, v.folder ?? "");
      publish();
      return;
    }

    if (v.deleted) {
      releaseImage(v.itemId);
      items.delete(v.itemId);
      folderEntities.delete(v.itemId); // a deleted folder entity has no kind field
      publish();
      return;
    }
    const existing = items.get(v.itemId);
    if (v.kind === undefined && v.pinned !== undefined && existing) {
      items.set(v.itemId, { ...existing, pinned: v.pinned });
      publish();
      return;
    }
    // A bare folder move (no content fields).
    if (v.kind === undefined && v.folder !== undefined && existing) {
      const folder = v.folder ?? "";
      items.set(v.itemId, { ...existing, folder, tags: folder ? [folder] : [] });
      publish();
      return;
    }
    if (v.kind === undefined && Array.isArray(v.tags) && existing) {
      items.set(v.itemId, { ...existing, tags: v.tags });
      publish();
      return;
    }
    if (v.kind === undefined) return; // metadata for an evicted row isn't a new empty note
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
        folder: v.folder ?? "",
        tags: Array.isArray(v.tags) ? v.tags : (v.folder ? [v.folder] : []),
        copies: v.copies ?? undefined,
      };
      if (v.kind === "image") {
        // Metadata only. Download encrypted media only after an explicit tap.
        base.imagePath = existing?.imagePath ?? null;
        base.thumbPath = existing?.thumbPath ?? null;
      } else if (v.textCipher) {
        base.text = await decryptText(key, v.textCipher);
      }
      if (!current()) return;
      items.set(v.itemId, base);
      publish();
    } catch {
      /* skip */
    }
  };

  const connect = () => {
    if (!started || ws) return;
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
    const current = () => started && ws === sock;
    let replaying = true;
    let replayRev = lastRev;
    sock.onopen = () => {
      if (!current()) return;
      backoff = 1000;
      set({ connected: true });
      // Full history on a cold start, incremental replay while this cache lives.
      // Never persist a cursor without persisting its corresponding history.
      sock.send(JSON.stringify({ t: "hello", since: lastRev }));
      clearInterval(ping);
      ping = setInterval(() => {
        if (current() && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "ping" }));
      }, 30000);
    };
    sock.onmessage = (ev) => {
      if (!current()) return;
      try {
        const notice = JSON.parse(ev.data as string);
        messageQueue = messageQueue.then(async () => {
          if (!current()) return;
          await handle(notice, current);
          if (!current()) return;
          replayRev = Math.max(replayRev, Number(notice.rev) || 0);
          // Do not advance past a partial replay (live notices can interleave).
          // A reconnect before `synced` must retry the unfinished history.
          if (notice.t === "synced") replaying = false;
          if (!replaying) lastRev = Math.max(lastRev, replayRev);
        }).catch(() => {});
      } catch {
        /* ignore */
      }
    };
    sock.onclose = () => {
      if (!current()) return;
      ws = undefined;
      messageQueue = Promise.resolve();
      set({ connected: false });
      scheduleReconnect();
    };
    sock.onerror = () => {
      if (!current()) return;
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
    const base = (localStorage.getItem("gt.remote.signal") || DEFAULT_SIGNAL_URL).replace(/\/+$/, "");
    if (key && activeSecret === secret && base === wsBase) {
      connect();
      return;
    }
    disconnect();
    const token = generation;
    items.clear();
    folderEntities.clear();
    lastRev = 0;
    key = undefined;
    set({ ready: false, items: [], tags: [] });
    const derived = await deriveKey(secret);
    const space = await deriveClipId(secret);
    if (!started || token !== generation) return;
    wsBase = base;
    httpBase = wsBase.replace(/^ws/, "http");
    key = derived;
    clipId = space;
    activeSecret = secret;
    set({ ready: true, deviceId: ensureDeviceId() });
    connect();
  };

  const addLocal = async (item: ClipItem, cipherPayload: object) => {
    items.set(item.id, item);
    publish();
    if (ready()) ws!.send(JSON.stringify({ t: "add", item: cipherPayload }));
  };

  // Bump an existing in-memory note to the top (fresh timestamp), appending the
  // copy to its history, and re-upload it so every device jumps it to the top.
  const bumpToTop = async (item: ClipItem, now: string, appendCopy = true) => {
    const copies = appendCopy
      ? [...new Set([...(item.copies ?? []), now])].sort()
      : (item.copies ?? []);
    items.set(item.id, { ...item, createdUtc: now, copies });
    publish();
    if (!ready() || !key) return;
    if (item.kind === "image") {
      ws!.send(
        JSON.stringify({
          t: "add",
          item: {
            itemId: item.id,
            deviceId: item.deviceId,
            deviceName: item.deviceName ?? "Phone",
            kind: "image",
            mime: item.mime ?? "image/png",
            size: item.size,
            createdUtc: now,
            pinned: item.pinned,
            folder: item.folder ?? "",
            tags: item.tags ?? [],
            copies,
            hasBlob: true,
          },
        }),
      );
    } else {
      ws!.send(
        JSON.stringify({
          t: "add",
          item: {
            itemId: item.id,
            deviceId: item.deviceId,
            deviceName: item.deviceName ?? "Phone",
            kind: "text",
            mime: "text/plain",
            size: (item.text ?? "").length,
            createdUtc: now,
            pinned: item.pinned,
            folder: item.folder ?? "",
            tags: item.tags ?? [],
            copies,
            textCipher: await encryptText(key, item.text ?? ""),
            hasBlob: false,
          },
        }),
      );
    }
  };

  return {
    items: [],
    tags: [],
    connected: false,
    ready: false,
    deviceId: "",
    backgroundEnabled: localStorage.getItem(BACKGROUND_OPT_IN) === "true",

    initializeBackground: async () => {
      // Also stops legacy auto-enabled services on upgrade. No history is erased.
      await provisionBackground().catch(() => {});
    },

    setBackgroundEnabled: async (enabled) => {
      if (enabled && !localStorage.getItem("gt.remote.secret")) {
        throw new Error("Connect to your PC before enabling background Notes.");
      }
      localStorage.setItem(BACKGROUND_OPT_IN, String(enabled));
      set({ backgroundEnabled: enabled });
      await provisionBackground();
    },

    loadImage: async (id) => {
      const item = items.get(id);
      if (!started || !key || !item || item.kind !== "image" || item.imagePath || imageRequests.has(id)) return;
      if (imageRequests.size >= 2) throw new Error("Please wait for the current images to load.");
      const controller = new AbortController();
      const token = generation;
      const imageKey = key;
      imageRequests.set(id, controller);
      try {
        const response = await fetch(`${httpBase}/clip/blob/${clipId}/${id}`, { signal: controller.signal });
        if (!response.ok) throw new Error("Image download failed. Tap to retry.");
        const raw = await decryptBytes(imageKey, new Uint8Array(await response.arrayBuffer()));
        if (controller.signal.aborted || token !== generation || !items.has(id)) return;
        // Blob URLs avoid retaining a second, base64-expanded copy of every image.
        while (imageUrls.size >= 12) {
          const old = imageUrls.keys().next().value!;
          releaseImage(old);
          const cached = items.get(old);
          if (cached) items.set(old, { ...cached, imagePath: null, thumbPath: null });
        }
        const url = URL.createObjectURL(new Blob([raw as BlobPart], { type: item.mime || "image/png" }));
        imageUrls.set(id, url);
        items.set(id, { ...items.get(id)!, imagePath: url, thumbPath: url });
        publish();
      } finally {
        if (imageRequests.get(id) === controller) imageRequests.delete(id);
      }
    },

    init: async () => {
      if (started) return;
      started = true;
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
      if (started) await startWithSecret?.(s);
      if (get().backgroundEnabled) await provisionBackground().catch(() => {});
    },

    stop: () => {
      started = false;
      disconnect();
    },

    addText: async (text, tags = []) => {
      const t = text.trim();
      if (!t || !key) return;
      const now = new Date().toISOString();
      // Dedup: a re-copy of identical text bumps the existing note to the top.
      const dup = [...items.values()].find(
        (i) => !i.deleted && i.kind === "text" && (i.text ?? "") === t,
      );
      if (dup) {
        await bumpToTop(dup, now);
        return;
      }
      const id = crypto.randomUUID();
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
        folder: tags[0] ?? "",
        tags,
        copies: [now],
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
        folder: tags[0] ?? "",
        tags,
        copies: [now],
        textCipher: await encryptText(key, t),
        hasBlob: false,
      });
    },

    addImage: async (dataUrl, tags = []) => {
      if (!key) return;
      const now = new Date().toISOString();
      // Dedup: an identical image bumps the existing note to the top.
      const dup = [...items.values()].find(
        (i) => !i.deleted && i.kind === "image" && (i.imagePath ?? "") === dataUrl,
      );
      if (dup) {
        await bumpToTop(dup, now);
        return;
      }
      const id = crypto.randomUUID();
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
        folder: tags[0] ?? "",
        tags,
        copies: [now],
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
        folder: tags[0] ?? "",
        tags,
        copies: [now],
        hasBlob: true,
      });
    },

    // Edit bumps the note to the top (fresh timestamp) and re-uploads it, so every
    // device jumps it to the top too.
    editText: async (id, text) => {
      const t = text.trim();
      const cur = items.get(id);
      if (!t || !key || !cur || cur.kind !== "text") return;
      // An edit bumps to the top but isn't a new "copy" — don't add a copy stamp.
      await bumpToTop({ ...cur, text: t, size: t.length }, new Date().toISOString(), false);
    },

    moveToFolder: async (id, folder) => {
      const cur = items.get(id);
      if (!cur) return;
      items.set(id, { ...cur, folder });
      publish();
      if (ready()) ws!.send(JSON.stringify({ t: "folder", itemId: id, folder }));
    },

    setTags: async (id, tags) => {
      const cur = items.get(id);
      if (!cur) return;
      const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
      items.set(id, { ...cur, tags: clean, folder: clean[0] ?? "" });
      publish();
      if (ready()) ws!.send(JSON.stringify({ t: "tags", itemId: id, tags: clean }));
    },

    createFolder: async (name) => {
      const n = name.trim();
      if (!n) return;
      // Converge on an existing entity for this name, else mint a new id.
      let id = [...folderEntities.entries()].find(
        ([, v]) => v.toLowerCase() === n.toLowerCase(),
      )?.[0];
      if (!id) id = `folder-${crypto.randomUUID()}`;
      folderEntities.set(id, n);
      publish();
      const now = new Date().toISOString();
      if (ready()) {
        ws!.send(
          JSON.stringify({
            t: "add",
            item: {
              itemId: id,
              deviceId: get().deviceId,
              deviceName: "Phone",
              kind: "folder",
              size: 0,
              createdUtc: now,
              folder: n,
              hasBlob: false,
            },
          }),
        );
      }
    },

    deleteFolder: async (name) => {
      const n = name.trim().toLowerCase();
      // Unfile members (propagate each move).
      for (const it of [...items.values()]) {
        if ((it.folder ?? "").toLowerCase() === n && (it.kind as string) !== "folder") {
          items.set(it.id, { ...it, folder: "" });
          if (ready()) ws!.send(JSON.stringify({ t: "folder", itemId: it.id, folder: "" }));
        }
      }
      // Tombstone matching folder entities.
      for (const [id, v] of [...folderEntities.entries()]) {
        if (v.toLowerCase() === n) {
          folderEntities.delete(id);
          if (ready()) ws!.send(JSON.stringify({ t: "delete", itemId: id }));
        }
      }
      publish();
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
      releaseImage(id);
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

    // Read an image from the OS clipboard. Android: JNI (content URI → bytes);
    // web: async Clipboard API where the browser allows it. Data URL or "".
    captureClipboardImage: async () => {
      try {
        if (isTauri()) return (await invoke<string>("clipboard_read_image")) || "";
        const nav = navigator as Navigator & {
          clipboard?: Clipboard & { read?: () => Promise<ClipboardItem[]> };
        };
        if (!nav.clipboard?.read) return "";
        for (const entry of await nav.clipboard.read()) {
          const mime = entry.types.find((t) => t.startsWith("image/"));
          if (!mime) continue;
          const blob = await entry.getType(mime);
          return await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onloadend = () => resolve(String(r.result));
            r.onerror = reject;
            r.readAsDataURL(blob);
          });
        }
        return "";
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
          retainedItems: items.size,
          backgroundEnabled: get().backgroundEnabled,
          backoffMs: backoff,
          nativeStartError: nativeStartError || "(none)",
        },
        nativeService: JSON.parse(snapStr)
      };
    },
  };
});
