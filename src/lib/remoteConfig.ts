/**
 * Baked-in configuration for the "connect from anywhere" (cloud) path.
 *
 * The cloud path uses WebRTC: the phone and PC exchange a handshake through a small
 * **signaling server**, then connect **directly peer-to-peer** for the actual screen
 * and control traffic (so the heavy stream never flows through the signaling host).
 *
 * The signaling server runs on the user's own PC and is exposed to the internet at a
 * stable hostname through a **Cloudflare Tunnel**. Because that hostname is compiled
 * into both the desktop app and the phone companion, the "From anywhere" screens are
 * pre-filled — the user never pastes a URL.
 *
 * To repoint at a different signaling host, change DEFAULT_SIGNAL_URL here (and the
 * matching `signal_url` default in src-tauri/src/db/settings.rs), then rebuild.
 * The Cloudflare Tunnel must map this hostname to http://localhost:SIGNAL_PORT.
 */

/** Default signaling server (WebRTC rendezvous), tunnelled from the PC. */
export const DEFAULT_SIGNAL_URL = "wss://discovery.chilloutgamestudio.com";

/** Local port the signaling server binds; the Cloudflare Tunnel's origin target. */
export const SIGNAL_PORT = 8080;

/**
 * Per-monitor pop-out tabs join a sibling signaling room so each display can
 * stream independently (`code~m0` = monitor 0, `code~m1` = monitor 1, …).
 *
 * EVERY pop-out gets its own sibling room — including monitor 0. The bare code
 * is reserved for the primary session: mapping a pop-out onto it would drop a
 * second host + second guest into the primary room, and the signaling server's
 * same-role eviction would then make the two sessions kick each other out in an
 * endless connect→evict→reconnect loop (both tabs flashing the screen for a
 * second, forever).
 */
export function auxMonitorRoom(code: string, monitor: number): string {
  const base = code.trim().toUpperCase();
  if (!Number.isFinite(monitor) || monitor < 0) return base;
  return `${base}~m${monitor}`;
}
