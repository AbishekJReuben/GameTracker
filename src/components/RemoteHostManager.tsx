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
  const cfg = useRef({ on: false, url: "", code: "" });
  const stopRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    let alive = true;

    const restart = (on: boolean, url: string, code: string) => {
      stopRef.current?.();
      stopRef.current = null;
      setCloudClients(0);
      if (on && url && code) {
        stopRef.current = startHost({ signalUrl: url, code, onClients: (n) => alive && setCloudClients(n) });
      }
    };

    const poll = async () => {
      try {
        const s = await api.remoteStatus();
        const on = !!s.cloudEnabled;
        const url = s.signalUrl ?? "";
        const code = s.code ?? "";
        const c = cfg.current;
        if (on !== c.on || url !== c.url || code !== c.code) {
          cfg.current = { on, url, code };
          restart(on, url, code);
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
    };
  }, [setCloudClients]);

  return null;
}
