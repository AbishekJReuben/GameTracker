import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { startHost } from "@/lib/rtcHost";
import { useRemoteHost } from "@/store/remote";

/**
 * Headless: runs the WebRTC "from anywhere" host for the whole app lifetime, not
 * just while the Remote page is open. This is what lets the phone auto-reconnect
 * after a PC restart or when the desktop is minimized to the tray — the host is
 * always listening in the signaling room as long as cloud access is enabled.
 *
 * Polls the backend for {cloudEnabled, signalUrl, code} and (re)starts the host
 * whenever any of them change. The connected-phone count is published to the
 * remote store so the Remote page can display it.
 */
export function RemoteHostManager() {
  const setCloudClients = useRemoteHost((s) => s.setCloudClients);
  const setHostStats = useRemoteHost((s) => s.setHostStats);
  const setPendingApproval = useRemoteHost((s) => s.setPendingApproval);
  // Track every value that affects the host: enabling/disabling cloud, the room
  // code, OR a rotated permanent key all require a host restart to take effect.
  // The secret is forwarded to authorized companions so their shared clipboard
  // can derive its encryption key without the user typing the permanent key.
  const cfg = useRef({ on: false, url: "", code: "", secret: "" });
  const stopRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    let alive = true;

    const restart = (on: boolean, url: string, code: string, secret: string) => {
      stopRef.current?.();
      stopRef.current = null;
      setCloudClients(0);
      setHostStats(null);
      if (on && url && code) {
        stopRef.current = startHost({
          signalUrl: url,
          code,
          clipboardSecret: secret || undefined,
          onClients: (n) => alive && setCloudClients(n),
          onStats: (s) => alive && setHostStats(s),
          // An untrusted device raises the app-wide approval prompt; the modal
          // (RemoteApprovalModal) resolves this promise with the user's choice.
          onApprovalRequest: (request) =>
            new Promise((resolve) => setPendingApproval({ request, resolve })),
        });
      }
    };

    const poll = async () => {
      try {
        const s = await api.remoteStatus();
        const on = !!s.cloudEnabled;
        const url = s.signalUrl ?? "";
        const code = s.code ?? "";
        const secret = s.secretCode ?? "";
        const c = cfg.current;
        if (on !== c.on || url !== c.url || code !== c.code || secret !== c.secret) {
          cfg.current = { on, url, code, secret };
          restart(on, url, code, secret);
        }
      } catch {
        /* transient poll error */
      }
    };

    poll();
    const id = window.setInterval(poll, 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
      stopRef.current?.();
      stopRef.current = null;
      setHostStats(null);
    };
  }, [setCloudClients, setHostStats, setPendingApproval]);

  return null;
}
