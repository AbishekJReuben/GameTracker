import { useEffect } from "react";
import { useSettings } from "@/lib/queries";
import { DEFAULT_SIGNAL_URL } from "@/lib/remoteConfig";
import { shareRuntime } from "@/lib/shareRuntime";

/** Starts non-revoked permanent links once per desktop-app lifetime. */
export function ShareHostManager() {
  const { data: settings } = useSettings();
  useEffect(() => {
    if (!settings) return;
    void shareRuntime.restore(settings.remote_signal_url || DEFAULT_SIGNAL_URL);
  }, [settings]);
  return null;
}
