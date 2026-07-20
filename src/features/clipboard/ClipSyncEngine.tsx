import { useEffect } from "react";
import { emit } from "@tauri-apps/api/event";
import { clipDesktop } from "@/lib/clip";
import { clipSync } from "@/lib/clipboardSync";
import { useClipboard } from "@/store/clipboard";

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
    clipSync.start(() => useClipboard.getState().refresh());
    const publish = () => {
      const d = clipSync.diagnostics();
      const items = useClipboard.getState().items;
      const deviceCount = new Set(items.map((i) => i.deviceId)).size;
      void emit("clipboard://sync-status", { ...d, deviceCount });
    };
    publish();
    const timer = window.setInterval(publish, 2000);
    return () => {
      window.clearInterval(timer);
      clipSync.stop();
    };
  }, []);
  return null;
}
