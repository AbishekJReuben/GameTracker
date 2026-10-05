import { useEffect } from "react";
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { api } from "@/lib/api";
import { getHostStreamLog } from "@/lib/rtcHost";
import { useRemoteHost } from "@/store/remote";
import { RemoteHostManager } from "./RemoteHostManager";
import { RemoteApprovalModal } from "./RemoteApprovalModal";

/**
 * The whole UI of the remote-host process (`--remote-host`, see hostproc.rs):
 * the WebRTC host plus the device-approval prompt, in a window of its own that
 * stays hidden except while a phone is waiting for approval. Because it lives in
 * a separate process with its own WebView2, a crash of the main app — or of its
 * window — doesn't end a remote session.
 *
 * It reports the live session (connected phones, stream stats, the stream log)
 * to Rust every second; the main app's Remote page reads that back.
 */
export default function RemoteHostApp() {
  const pending = useRemoteHost((s) => !!s.pendingApproval);

  // Publish live status for the main app.
  useEffect(() => {
    let n = 0;
    const id = window.setInterval(() => {
      const s = useRemoteHost.getState();
      const info: Record<string, unknown> = { cloudClients: s.cloudClients, stats: s.hostStats };
      // The log is the big part: every 5 s is plenty for "Copy stream log".
      if (n++ % 5 === 0) info.log = getHostStreamLog();
      void api.remoteHostPublish(info).catch(() => {});
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // Show the window only while a device waits for approval.
  useEffect(() => {
    const win = getCurrentWindow();
    void (async () => {
      try {
        if (pending) {
          await win.center();
          await win.setAlwaysOnTop(true);
          await win.show();
          await win.setFocus();
        } else {
          await win.hide();
          await win.setAlwaysOnTop(false);
          await win.setPosition(new LogicalPosition(-32000, -32000));
        }
      } catch {
        /* window API unavailable */
      }
    })();
  }, [pending]);

  return (
    <div className="h-full bg-bg-base text-ink">
      <RemoteHostManager />
      <RemoteApprovalModal />
      {!pending && (
        <div className="grid h-full place-items-center p-6 text-center text-sm text-ink-dim">
          Remote desktop is running in the background.
        </div>
      )}
    </div>
  );
}
