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
  /** Fired when ControlTab creates/destroys the WebRTC RemoteLink. */
  onControlReady?: (link: RemoteLink | null) => void;
  /** Extra overlay rendered when connected (optional; Quest may render ImmersiveScreen itself). */
  renderOverlay?: () => ReactNode;
};

let runtime: CompanionRuntime = {};

export function setCompanionRuntime(r: CompanionRuntime) {
  runtime = r;
}

export function getCompanionRuntime(): CompanionRuntime {
  return runtime;
}
