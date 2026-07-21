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
  /** Folder/list label for the notes view ("" = unfiled). */
  folder?: string;
  /** Every UTC timestamp this exact content was copied/added (dedup history).
   *  Shown on the app screens; usually a single entry. */
  copies?: string[];
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
  folder?: string;
  copies?: string[];
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
  /** Edit a text note in place; the sync engine re-uploads it under the same id. */
  updateText: (id: string, text: string) =>
    invoke<ClipItem>("clipboard_update_text", { id, text }),
  setFolder: (id: string, folder: string, propagate = true) =>
    invoke<void>("clipboard_set_folder", { id, folder, propagate }),
  folders: () => invoke<string[]>("clipboard_folders"),
  /** Create an empty folder that syncs to every device. */
  createFolder: (name: string) => invoke<void>("clipboard_create_folder", { name }),
  /** Delete a folder everywhere (its notes move to unfiled). */
  deleteFolder: (name: string) => invoke<void>("clipboard_delete_folder", { name }),
  /** Apply a remote folder entity (kind='folder' notice) locally. */
  applyFolder: (args: {
    id: string;
    name: string;
    createdUtc?: string;
    deviceId?: string;
    deviceName?: string | null;
    deleted?: boolean;
  }) => invoke<void>("clipboard_apply_folder", args),
  /** One-time retroactive dedup; returns tombstoned loser ids to propagate. */
  dedupe: () => invoke<string[]>("clipboard_dedupe"),
  copy: (id: string) => invoke<void>("clipboard_copy", { id }),
  imageB64: (id: string) => invoke<string | null>("clipboard_image_b64", { id }),
  clearAll: () => invoke<void>("clipboard_clear_all"),
  configure: (enabled: boolean, overlay: boolean, autoCapture: boolean) =>
    invoke<void>("clipboard_configure", { enabled, overlay, autoCapture }),
  /** Rust-side runtime log (watcher + overlay window + apply_settings). */
  diagnostics: () => invoke<string[]>("clipboard_diagnostics"),
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
