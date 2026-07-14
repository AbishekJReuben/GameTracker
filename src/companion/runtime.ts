/**
 * Optional host-specific hooks for CompanionApp (Android APK vs Quest browser).
 * Quest sets these before mounting CompanionApp so the shared shell can show
 * Enter VR, use a headset device name, and hand the Control link to ImmersiveScreen.
 */

import type { ReactNode } from "react";
import type { RemoteLink } from "./links";

export type CompanionRuntime = {
  /** Friendly device name for auth. Default: deviceName() from device.ts */
  deviceName?: () => string;
  /** Quest: WebXR available — show Enter VR on Control. */
  vrSupported?: boolean;
  onEnterVr?: () => void;
  /** Quest: pointer vs virtual-pad mode for the next immersive session. */
  vrMode?: "pointer" | "gamepad";
  onVrModeChange?: (mode: "pointer" | "gamepad") => void;
  /**
   * Quest: true while ImmersiveScreen (WebXR) is live. Flat Quest Control must
   * stay off this flag so it can use the same WebCodecs / stall-heal path as
   * the phone; immersive needs the RTC `<video>` track as a WebGL texture.
   */
  immersiveActive?: boolean;
  /** Fired when ControlTab creates/destroys the WebRTC RemoteLink. */
  onControlReady?: (link: RemoteLink | null) => void;
  /** Extra overlay rendered when connected (optional; Quest may render ImmersiveScreen itself). */
  renderOverlay?: () => ReactNode;
};

let runtime: CompanionRuntime = {};
const immersiveListeners = new Set<(active: boolean) => void>();

export function setCompanionRuntime(r: CompanionRuntime) {
  const was = !!runtime.immersiveActive;
  runtime = r;
  const now = !!r.immersiveActive;
  if (was !== now) {
    for (const cb of immersiveListeners) cb(now);
  }
}

export function getCompanionRuntime(): CompanionRuntime {
  return runtime;
}

/** True while Quest WebXR ImmersiveScreen is covering the flat Control UI. */
export function isImmersiveActive(): boolean {
  return !!runtime.immersiveActive;
}

/** Subscribe to immersive enter/exit (CloudConn uses this to flip video path). */
export function onImmersiveActiveChange(cb: (active: boolean) => void): () => void {
  immersiveListeners.add(cb);
  return () => {
    immersiveListeners.delete(cb);
  };
}
