/**
 * "Remote only" setup mode — one policy shared by every client.
 *
 * The Windows installer always lays down the full app; the setup type the user
 * picks there only seeds this flag (see `seed_install_mode` in src-tauri/lib.rs).
 * When it's on, the app presents itself as a bare remote-control tool: every
 * surface except Remote and Settings is hidden on the desktop, the phone, the
 * browser and Quest. Nothing is actually turned off — tracking, the music
 * logger and the hardware monitor all keep recording, so flipping back to the
 * full app in Settings restores an unbroken history.
 *
 * The PC's Settings page is the only place the mode can be changed. It lives in
 * the backend DB (not localStorage) so the installer can seed it and so the
 * companion clients can read it over `/api/settings` on either transport.
 */

/** Backend settings key holding the mode. "true" = remote only. */
export const REMOTE_ONLY_KEY = "remote_only";

/** Desktop routes that survive remote-only mode. Clipboard is part of the same
 *  remote/companion stack (shared relay + secret), so it's a first-class feature
 *  here alongside Remote — not hidden away when the app is set up remote-only. */
export const REMOTE_ONLY_ROUTES = ["/remote", "/clipboard", "/share", "/settings"] as const;

/** Companion tab ids that survive remote-only mode. */
export const REMOTE_ONLY_TABS = ["control", "clipboard", "settings"] as const;

/** Read the mode out of a `/api/settings` map (absent/unset → full app). */
export function readRemoteOnly(settings: Record<string, string> | undefined | null): boolean {
  return settings?.[REMOTE_ONLY_KEY] === "true";
}

/** Whether a desktop route may be shown/reached in the current mode. */
export function routeAllowed(pathname: string, remoteOnly: boolean): boolean {
  if (!remoteOnly) return true;
  return REMOTE_ONLY_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

/** Whether a companion tab may be shown/reached in the current mode. */
export function tabAllowed(tab: string, remoteOnly: boolean): boolean {
  if (!remoteOnly) return true;
  return (REMOTE_ONLY_TABS as readonly string[]).includes(tab);
}
