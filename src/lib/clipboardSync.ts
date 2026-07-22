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
  kind?: "text" | "image" | "folder";
  mime?: string | null;
  size?: number;
  createdUtc?: string;
  textCipher?: string | null;
  hasBlob?: boolean;
  deleted?: boolean;
  pinned?: boolean;
  folder?: string | null;
  tags?: string[] | null;
  copies?: string[] | null;
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
  /** Cap the reconnect backoff low: clipboard sync needs near-real-time delivery,
   *  so a dropped link must recover within seconds. 30s (the old cap) felt broken
   *  — a transient network blip parked the engine for half a minute. */
  private static readonly MAX_BACKOFF_MS = 5000;
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
  /** Result of the last HTTP probe of the relay's /health endpoint, with the
   *  HTTP status (or -1 for a network failure). Helps distinguish "server down"
   *  from "WS upgrade rejected" from "DNS broken". */
  private lastHealthStatus = -1;
  private lastHealthAt: number | null = null;
  private healthTimer?: ReturnType<typeof setInterval>;
  /** Bound handlers so add/removeEventListener match. */
  private onlineHandler = () => this.forceReconnect("browser online event");
  private visibilityHandler = () => {
    if (document.visibilityState === "visible") this.forceReconnect("tab/window became visible");
  };

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
    this.unlisteners.push(
      await listen<[string, string]>("clipboard://folder", (e) =>
        this.sendFolder(e.payload[0], e.payload[1]),
      ),
    );
    this.unlisteners.push(
      await listen<[string, string[]]>("clipboard://tags", (e) =>
        this.sendTags(e.payload[0], e.payload[1]),
      ),
    );
    // Reconnect immediately when the network comes back or the window becomes
    // visible — don't wait out the (now short) backoff for events the user can
    // already see should work. This is the JS twin of the Android service's
    // ConnectivityManager callback.
    window.addEventListener("online", this.onlineHandler);
    document.addEventListener("visibilitychange", this.visibilityHandler);
    // Probe the relay's /health endpoint every 30s so the diagnostics report
    // can distinguish "relay unreachable" (HTTP -1) from "up but WS failing"
    // (HTTP 200 but socket never opens). Cheap HEAD that doubles as a wake-up.
    this.probeHealth();
    this.healthTimer = setInterval(() => this.probeHealth(), 30000);
    this.connect();
  }

  stop(): void {
    this.started = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    window.removeEventListener("online", this.onlineHandler);
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    this.unlisteners.forEach((f) => f());
    this.unlisteners = [];
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
  }

  /** Drop any pending reconnect and try again right now (used by online /
   *  visibility events and by the user tapping "Retry" in the UI). Resets the
   *  backoff so a freshly-recovered link doesn't sit idle. */
  forceReconnect(reason: string): void {
    if (!this.started) return;
    this.backoff = 1000;
    clearTimeout(this.retryTimer);
    this.lastEvent = `force reconnect (${reason})`;
    // If a socket is mid-handshake, let it fail through onclose; otherwise
    // connect immediately.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    } else {
      this.connect();
    }
  }

  /** HEAD/GET the relay's /health endpoint. Stores the result so the diagnostics
   *  report shows whether the relay is reachable at all (separate from the WS). */
  private async probeHealth(): Promise<void> {
    if (!this.httpBase) return;
    try {
      const res = await fetch(`${this.httpBase}/health`, { method: "GET", cache: "no-store" });
      this.lastHealthStatus = res.status;
      this.lastHealthAt = Date.now();
    } catch {
      this.lastHealthStatus = -1;
      this.lastHealthAt = Date.now();
    }
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
    this.backoff = Math.min(this.backoff * 2, ClipSyncManager.MAX_BACKOFF_MS);
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
      await this.dedupeOnce();
      return;
    }
    if (v.t !== "item" || !v.itemId) return;
    this.bumpRev(v.rev);

    // Folder entity (empty-folder registry). Apply regardless of origin — a bare
    // registry row has no content to duplicate.
    if (v.kind === "folder") {
      await clip
        .applyFolder({
          id: v.itemId,
          name: v.folder ?? "",
          createdUtc: v.createdUtc,
          deviceId: v.deviceId ?? undefined,
          deviceName: v.deviceName ?? null,
          deleted: v.deleted ?? false,
        })
        .catch(() => {});
      this.onChange?.();
      return;
    }

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
    // A bare folder move (no content fields).
    if (v.kind === undefined && v.folder !== undefined) {
      await clip.setTags(v.itemId, v.folder ? [v.folder] : [], false).catch(() => {});
      this.onChange?.();
      return;
    }
    if (v.kind === undefined && Array.isArray(v.tags)) {
      await clip.setTags(v.itemId, v.tags, false).catch(() => {});
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
            folder: v.folder ?? "",
            tags: v.tags ?? (v.folder ? [v.folder] : []),
            copies: v.copies ?? undefined,
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
            folder: v.folder ?? "",
            tags: v.tags ?? (v.folder ? [v.folder] : []),
            copies: v.copies ?? undefined,
          },
          true,
        );
      }
      this.onChange?.();
    } catch {
      /* decrypt/apply failure — skip this item */
    }
  }

  /** Run the one-time retroactive dedup (merge pre-existing duplicate notes) once
   *  the link is up, then propagate the tombstoned losers over the relay. Guarded
   *  by a localStorage flag so it runs a single time per device. */
  private async dedupeOnce(): Promise<void> {
    const flag = `gt.clip.deduped.v1.${this.clipId}`;
    if (localStorage.getItem(flag)) return;
    try {
      const losers = await clip.dedupe();
      for (const id of losers) this.sendDelete(id);
      // Survivors were marked unsynced by the merge — re-upload their merged
      // copy history now.
      await this.flushBacklog();
      localStorage.setItem(flag, String(Date.now()));
      this.onChange?.();
    } catch {
      /* try again on the next reconnect */
    }
  }

  private ready(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !!this.key;
  }

  private async uploadItem(item: ClipItem): Promise<void> {
    if (!this.ready() || !this.key) return;
    // Folder entity (empty-folder registry) — a plaintext, content-less row that
    // rides the same relay pipeline as clips (kind='folder', name in `folder`).
    if ((item.kind as string) === "folder") {
      this.ws!.send(
        JSON.stringify({
          t: "add",
          item: {
            itemId: item.id,
            deviceId: item.deviceId,
            deviceName: item.deviceName,
            kind: "folder",
            size: 0,
            createdUtc: item.createdUtc,
            folder: item.folder ?? "",
            hasBlob: false,
          },
        }),
      );
      await clip.markSynced(item.id).catch(() => {});
      return;
    }
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
              folder: item.folder ?? "",
              tags: item.tags ?? [],
              copies: item.copies ?? [],
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
              folder: item.folder ?? "",
              tags: item.tags ?? [],
              copies: item.copies ?? [],
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

  sendFolder(id: string, folder: string): void {
    if (this.ready()) this.ws!.send(JSON.stringify({ t: "folder", itemId: id, folder }));
  }

  sendTags(id: string, tags: string[]): void {
    if (this.ready()) this.ws!.send(JSON.stringify({ t: "tags", itemId: id, tags }));
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
    const healthAge = this.lastHealthAt ? Math.round((Date.now() - this.lastHealthAt) / 1000) : -1;
    const health =
      this.lastHealthStatus === -1
        ? "unreachable (network/DNS failure or server down)"
        : this.lastHealthStatus === 200
          ? "ok (200)"
          : `HTTP ${this.lastHealthStatus}`;
    return {
      started: String(this.started),
      uptimeSec: String(Math.round(uptimeMs / 1000)),
      wsState: this.lastWsState,
      relayUrl: this.wsBase || "(not configured)",
      relayHealth: health,
      relayHealthAgeSec: String(healthAge),
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
