import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { clipDesktop } from "@/lib/clip";
import { clipSync } from "@/lib/clipboardSync";
import { useClipboard } from "@/store/clipboard";

/** The old overlay kept its draft and size in this WebView's localStorage. The new
 *  panel has its own WebView and keeps them in the database. Runs once. */
async function moveOverlayState() {
  const copy = async (from: string, to: string) => {
    const value = localStorage.getItem(from);
    if (value === null) return;
    const settings = await invoke<Record<string, string>>("get_settings");
    if (!settings[to]) await invoke("set_setting", { key: to, value });
    localStorage.removeItem(from);
  };
  await copy("gt.clip.draft.overlay", "notes_draft").catch(() => {});
  await copy("gt.clip.overlaySize", "notes_panel_size").catch(() => {});
}

/** Mount once on the desktop main window (which stays alive in the tray). Runs the
 *  always-on relay sync; the store refreshes whenever a remote item lands.
 *
 *  The relay WebSocket lives HERE, in the main window. The floating overlay is a
 *  SEPARATE webview with its own (never-started) `clipSync`, so it can't read the
 *  real connection state directly — that's why its status pill used to read "Off".
 *  We broadcast the live diagnostics over a Tauri event (which reaches every
 *  window) so the overlay can mirror the true status. */
export function ClipSyncEngine() {
  useEffect(() => {
    if (!clipDesktop()) return;
    void clipSync.start();
    const publish = () => {
      const d = clipSync.diagnostics();
      const items = useClipboard.getState().items;
      const deviceCount = new Set(items.map((i) => i.deviceId)).size;
      void emit("clipboard://sync-status", { ...d, deviceCount });
      // The floating Notes process reads this from disk, so it keeps working
      // whatever happens to this one.
      void invoke("clipboard_publish_status", { status: { ...d, deviceCount } }).catch(() => {});
    };
    void moveOverlayState();
    publish();
    const timer = window.setInterval(publish, 2000);
    return () => {
      window.clearInterval(timer);
      clipSync.stop();
    };
  }, []);
  return null;
}
