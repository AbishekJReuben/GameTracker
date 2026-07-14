/**
 * Quest client: same CompanionApp shell + ControlScreen as Android, with
 * Quest-specific device name, Enter VR hand-off, and ImmersiveScreen overlay.
 * FlatScreen / QuestPairing stay on disk but are unused here.
 */

import { useEffect, useState } from "react";
import { CompanionApp } from "@/companion/CompanionApp";
import { setCompanionRuntime } from "@/companion/runtime";
import type { RemoteLink } from "@/companion/links";
import { questDeviceName } from "./device";
import { ImmersiveScreen } from "./ImmersiveScreen";
import { ImmersiveSession } from "./xr/session";

export function QuestApp() {
  const [vrSupported, setVrSupported] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [mode, setMode] = useState<"pointer" | "gamepad">("pointer");
  const [link, setLink] = useState<RemoteLink | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  // Module-level runtime must be set during render (before CompanionApp mounts
  // / auto-connects) so the headset device name and VR hooks are live.
  // immersiveActive gates WebCodecs off only while ImmersiveScreen is up —
  // flat Quest Control uses the same DIRECT path as the phone APK / web.
  setCompanionRuntime({
    deviceName: questDeviceName,
    vrSupported,
    onEnterVr: () => setImmersive(true),
    vrMode: mode,
    onVrModeChange: setMode,
    immersiveActive: immersive,
    onControlReady: (l) => {
      setLink(l);
      if (!l) setStream(null);
    },
  });

  useEffect(() => {
    ImmersiveSession.isSupported().then(setVrSupported);
  }, []);

  // Multi-subscriber onStream — share the track with ImmersiveScreen without
  // clobbering Control's binder (single-callback used to wipe it on first open).
  useEffect(() => {
    if (!link) {
      setStream(null);
      return;
    }
    return link.onStream(setStream) ?? undefined;
  }, [link]);

  // Leaving the Control tab (or disconnect) clears the link — exit VR too.
  useEffect(() => {
    if (!link && immersive) setImmersive(false);
  }, [link, immersive]);

  return (
    <>
      <CompanionApp />
      {immersive && link && stream && (
        <ImmersiveScreen link={link} stream={stream} mode={mode} onExit={() => setImmersive(false)} />
      )}
    </>
  );
}
