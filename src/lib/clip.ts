// Desktop clipboard command wrappers + shared types.
//
// These call the Rust commands directly (NOT through the companion-proxying
// `api.ts`) — the shared clipboard talks to the local store + the relay, never to
// a remote desktop's `invoke`. The companion has its own path (native service /
// relay), so everything here is guarded to the desktop webview.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "./tauri";
import { isCompanion } from "./remoteClient";

export type ClipKind = "text" | "image";

export interface ClipItem {
  id: string;
  kind: ClipKind;
  text?: string | null;
  imagePath?: string | null;
  thumbPath?: string | null;
  mime?: string | null;
  size: number;
  createdUtc: string;
  deviceId: string;
  deviceName?: string | null;
  source: string;
  pinned: boolean;
  deleted?: boolean;
  synced?: boolean;
}

export interface ClipAddInput {
  kind: ClipKind;
  text?: string | null;
  imageBase64?: string | null;
  mime?: string | null;
  source?: string | null;
  // Present only when applying a remote item (keeps its identity, no re-upload):
  id?: string;
  createdUtc?: string;
  deviceId?: string;
  deviceName?: string | null;
  pinned?: boolean;
}

/** True on the desktop app (where the Rust clipboard commands exist). */
export function clipDesktop(): boolean {
  return isTauri() && !isCompanion();
}

export const clip = {
  deviceInfo: () =>
    invoke<{ deviceId: string; deviceName: string }>("clipboard_device_info"),
  list: (beforeUtc?: string, limit = 50) =>
    invoke<ClipItem[]>("clipboard_list", { beforeUtc: beforeUtc ?? null, limit }),
  pinned: () => invoke<ClipItem[]>("clipboard_pinned"),
  unsynced: (limit = 100) => invoke<ClipItem[]>("clipboard_unsynced", { limit }),
  markSynced: (id: string) => invoke<void>("clipboard_mark_synced", { id }),
  add: (input: ClipAddInput, remote = false) =>
    invoke<ClipItem>("clipboard_add", { input, remote }),
  delete: (id: string, propagate = true) =>
    invoke<void>("clipboard_delete", { id, propagate }),
  setPinned: (id: string, pinned: boolean) =>
    invoke<void>("clipboard_set_pinned", { id, pinned }),
  copy: (id: string) => invoke<void>("clipboard_copy", { id }),
  imageB64: (id: string) => invoke<string | null>("clipboard_image_b64", { id }),
  clearAll: () => invoke<void>("clipboard_clear_all"),
  configure: (enabled: boolean, overlay: boolean, autoCapture: boolean) =>
    invoke<void>("clipboard_configure", { enabled, overlay, autoCapture }),
  overlaySetPos: (x: number, y: number) =>
    invoke<void>("clipboard_overlay_set_pos", { x, y }),
  speechToText: (audioBase64: string, mime?: string, language?: string) =>
    invoke<string>("speech_to_text", {
      audioBase64,
      mime: mime ?? null,
      language: language ?? null,
    }),
};

/** Local file path → asset URL the webview can load (thumbnails/full images).
 *  Already-usable URLs (data:/blob:/http, e.g. companion in-memory images) pass
 *  through unchanged. */
export function clipAssetUrl(path?: string | null): string | undefined {
  if (!path) return undefined;
  if (/^(data:|blob:|https?:)/.test(path)) return path;
  return convertFileSrc(path);
}
