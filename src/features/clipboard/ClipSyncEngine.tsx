import { useEffect } from "react";
import { clipDesktop } from "@/lib/clip";
import { clipSync } from "@/lib/clipboardSync";
import { useClipboard } from "@/store/clipboard";

/** Mount once on the desktop main window (which stays alive in the tray). Runs the
 *  always-on relay sync; the store refreshes whenever a remote item lands. */
export function ClipSyncEngine() {
  useEffect(() => {
    if (!clipDesktop()) return;
    clipSync.start(() => useClipboard.getState().refresh());
    return () => clipSync.stop();
  }, []);
  return null;
}
