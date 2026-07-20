// Desktop shared-clipboard sync engine (webview).
//
// Runs in the always-alive main window (which keeps running while hidden to the
// tray), so no TLS/WebSocket/AEAD crate is needed on the desktop Rust side and the
// E2E crypto is shared with the companion webview. It:
//   - holds one push-based WebSocket to the relay's /clip namespace,
//   - encrypts locally-captured items (from the `clipboard://item` event) and
//     uploads them (text inline, images as blobs over HTTP),
//   - applies remote items into the local store (decrypt → invoke commands),
//   - flushes any backlog on (re)connect and pings to survive idle proxies.
//
// Battery-light: server push (no polling), connectivity-driven reconnect backoff.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { clip, type ClipItem } from "./clip";
import {
  deriveKey,
  clipId as deriveClipId,
  encryptText,
  decryptText,
  encryptBytes,
  decryptBytes,
  bytesToB64,
  b64ToBytes,
} from "./clipboardCrypto";

type Notice = {
  t: string;
  rev?: number;
  itemId?: string;
  deviceId?: string;
  deviceName?: string | null;
  kind?: "text" | "image";
  mime?: string | null;
  size?: number;
  createdUtc?: string;
  textCipher?: string | null;
  hasBlob?: boolean;
  deleted?: boolean;
  pinned?: boolean;
};

class ClipSyncManager {
  private ws?: WebSocket;
  private key?: CryptoKey;
  private clipId = "";
  private deviceId = "";
  private wsBase = "";
  private httpBase = "";
  private started = false;
  private lastRev = 0;
  private backoff = 1000;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private unlisteners: UnlistenFn[] = [];
  private onChange?: () => void;
  // Diagnostic surface — surfaced by diagnostics() so the user can copy a full
  // report from Settings instead of staring at "Turning on…".
  private startedAt: number | null = null;
  private lastWsState: "none" | "connecting" | "open" | "closed" = "none";
  private lastError: string | null = null;
  private lastEvent: string | null = null;
  private reconnects = 0;

  /** Start (idempotent). Reads secret/signal URL from settings; no-op if the
   *  feature is off or no secret is configured yet. */
  async start(onChange?: () => void): Promise<void> {
    this.onChange = onChange;
    if (this.started) return;
    let settings: Record<string, string>;
    try {
      settings = await invoke<Record<string, string>>("get_settings");
    } catch {
      return;
    }
    if (settings.clipboard_enabled !== "true") return;
    const secret = settings.remote_secret_code || "";
    const base = settings.remote_signal_url || "wss://discovery.chilloutgamestudio.com";
    if (!secret) return;

    this.wsBase = base.replace(/\/+$/, "");
    this.httpBase = this.wsBase.replace(/^ws/, "http");
    try {
      const info = await clip.deviceInfo();
      this.deviceId = info.deviceId;
      this.key = await deriveKey(secret);
      this.clipId = await deriveClipId(secret);
    } catch {
      return;
    }
    this.lastRev = Number(localStorage.getItem(`gt.clip.rev.${this.clipId}`) || 0);
    this.started = true;
    this.startedAt = Date.now();
    this.reconnects = 0;
    this.lastError = null;
    this.lastEvent = "started";

    this.unlisteners.push(
      await listen<ClipItem>("clipboard://item", (e) => void this.uploadItem(e.payload)),
    );
    this.unlisteners.push(
      await listen<string>("clipboard://delete", (e) => this.sendDelete(e.payload)),
    );
    this.connect();
  }

  stop(): void {
    this.started = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.unlisteners.forEach((f) => f());
    this.unlisteners = [];
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
  }

  /** Restart to pick up a settings change (enable/secret/url). */
  async restart(onChange?: () => void): Promise<void> {
    this.stop();
    await this.start(onChange ?? this.onChange);
  }

  private connect(): void {
    if (!this.started) return;
    const url = `${this.wsBase}/clip/ws?clip=${this.clipId}&device=${encodeURIComponent(this.deviceId)}`;
    this.lastWsState = "connecting";
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.lastError = `WebSocket ctor threw: ${e instanceof Error ? e.message : String(e)}`;
      this.lastWsState = "closed";
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.lastWsState = "open";
      this.lastError = null;
      this.lastEvent = "connected";
      ws.send(JSON.stringify({ t: "hello", since: this.lastRev }));
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "ping" }));
      }, 30000);
    };
    ws.onmessage = (ev) => {
      try {
        void this.handleMsg(JSON.parse(ev.data as string) as Notice);
      } catch (e) {
        this.lastError = `malformed message: ${e instanceof Error ? e.message : String(e)}`;
      }
    };
    ws.onclose = (ev) => {
      this.lastWsState = "closed";
      this.lastEvent = `closed (code=${ev.code}, reason="${ev.reason || ""}")`;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // The browser gives no detail on WS error; pair this with the close code
      // that follows. Common cause: the relay URL is wrong/unreachable, or the
      // signaling server isn't running.
      this.lastError = "WebSocket error (relay unreachable or wrong URL?)";
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private scheduleReconnect(): void {
    clearInterval(this.pingTimer);
    if (!this.started) return;
    this.reconnects++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  private bumpRev(rev?: number): void {
    if (rev && rev > this.lastRev) {
      this.lastRev = rev;
      localStorage.setItem(`gt.clip.rev.${this.clipId}`, String(rev));
    }
  }

  private async handleMsg(v: Notice): Promise<void> {
    if (v.t === "synced") {
      this.bumpRev(v.rev);
      await this.flushBacklog();
      return;
    }
    if (v.t !== "item" || !v.itemId) return;
    this.bumpRev(v.rev);

    // Our own items echoed back on a catch-up — already local, skip the work.
    if (v.deviceId && v.deviceId === this.deviceId && !v.deleted) return;

    if (v.deleted) {
      await clip.delete(v.itemId, false).catch(() => {});
      this.onChange?.();
      return;
    }
    // A bare pin update (no content fields).
    if (v.kind === undefined && v.pinned !== undefined) {
      await clip.setPinned(v.itemId, v.pinned).catch(() => {});
      this.onChange?.();
      return;
    }
    if (!this.key) return;
    try {
      if (v.kind === "image" && v.hasBlob) {
        const bytes = await this.fetchBlob(v.itemId);
        if (!bytes) return;
        const raw = await decryptBytes(this.key, bytes);
        await clip.add(
          {
            kind: "image",
            imageBase64: bytesToB64(raw),
            id: v.itemId,
            createdUtc: v.createdUtc,
            deviceId: v.deviceId ?? undefined,
            deviceName: v.deviceName ?? null,
            source: v.deviceName ? "android" : "remote",
            pinned: v.pinned ?? false,
          },
          true,
        );
      } else if (v.textCipher) {
        const text = await decryptText(this.key, v.textCipher);
        await clip.add(
          {
            kind: "text",
            text,
            id: v.itemId,
            createdUtc: v.createdUtc,
            deviceId: v.deviceId ?? undefined,
            deviceName: v.deviceName ?? null,
            source: v.deviceName ? "android" : "remote",
            pinned: v.pinned ?? false,
          },
          true,
        );
      }
      this.onChange?.();
    } catch {
      /* decrypt/apply failure — skip this item */
    }
  }

  private ready(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !!this.key;
  }

  private async uploadItem(item: ClipItem): Promise<void> {
    if (!this.ready() || !this.key) return;
    try {
      if (item.kind === "image") {
        const b64 = await clip.imageB64(item.id);
        if (!b64) return;
        const cipher = await encryptBytes(this.key, b64ToBytes(b64));
        const ok = await this.putBlob(item.id, cipher);
        if (!ok) return;
        this.ws!.send(
          JSON.stringify({
            t: "add",
            item: {
              itemId: item.id,
              deviceId: item.deviceId,
              deviceName: item.deviceName,
              kind: "image",
              mime: item.mime,
              size: item.size,
              createdUtc: item.createdUtc,
              pinned: item.pinned,
              hasBlob: true,
            },
          }),
        );
      } else {
        const cipher = await encryptText(this.key, item.text ?? "");
        this.ws!.send(
          JSON.stringify({
            t: "add",
            item: {
              itemId: item.id,
              deviceId: item.deviceId,
              deviceName: item.deviceName,
              kind: "text",
              mime: item.mime,
              size: item.size,
              createdUtc: item.createdUtc,
              pinned: item.pinned,
              textCipher: cipher,
              hasBlob: false,
            },
          }),
        );
      }
      await clip.markSynced(item.id).catch(() => {});
    } catch {
      /* leave unsynced; retried on next flush */
    }
  }

  private sendDelete(id: string): void {
    if (this.ready()) this.ws!.send(JSON.stringify({ t: "delete", itemId: id }));
  }

  sendPin(id: string, pinned: boolean): void {
    if (this.ready()) this.ws!.send(JSON.stringify({ t: "pin", itemId: id, pinned }));
  }

  private async flushBacklog(): Promise<void> {
    try {
      const items = await clip.unsynced(100);
      for (const it of items) await this.uploadItem(it);
    } catch {
      /* ignore */
    }
  }

  private async putBlob(itemId: string, cipher: Uint8Array): Promise<boolean> {
    try {
      const res = await fetch(`${this.httpBase}/clip/blob/${this.clipId}/${itemId}`, {
        method: "PUT",
        body: cipher as BodyInit,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async fetchBlob(itemId: string): Promise<Uint8Array | null> {
    try {
      const res = await fetch(`${this.httpBase}/clip/blob/${this.clipId}/${itemId}`);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  /** Snapshot of the sync engine state for the Settings "Copy logs" report. */
  diagnostics(): Record<string, string> {
    const uptimeMs = this.startedAt ? Date.now() - this.startedAt : 0;
    return {
      started: String(this.started),
      uptimeSec: String(Math.round(uptimeMs / 1000)),
      wsState: this.lastWsState,
      relayUrl: this.wsBase || "(not configured)",
      clipId: this.clipId || "(not derived)",
      deviceId: this.deviceId || "(unknown)",
      hasKey: String(!!this.key),
      lastRev: String(this.lastRev),
      reconnects: String(this.reconnects),
      backoffMs: String(this.backoff),
      lastEvent: this.lastEvent ?? "(none)",
      lastError: this.lastError ?? "(none)",
    };
  }
}

export const clipSync = new ClipSyncManager();
