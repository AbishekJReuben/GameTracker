/**
 * Stable per-install device identity for the remote auth handshake. The id is a
 * random uuid kept in localStorage so the PC can recognise this phone across
 * reconnects (and remember it as a trusted device).
 */

const LS_DEVICE_ID = "gt.remote.deviceId";

export function deviceId(): string {
  let id = localStorage.getItem(LS_DEVICE_ID);
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(LS_DEVICE_ID, id);
  }
  return id;
}

/** Best-effort friendly device name shown in the PC's approval prompt. */
export function deviceName(): string {
  const ua = navigator.userAgent || "";
  const m = ua.match(/Android[^;]*;\s*([^);]+?)\s*(?:Build|\))/i);
  const model = m?.[1]?.trim();
  return model && model.length > 1 ? model : "Android phone";
}
