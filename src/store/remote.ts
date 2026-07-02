import { create } from "zustand";
import type { HostLiveStats } from "@/lib/rtcHost";

/**
 * Live state for the app-wide WebRTC host (see components/RemoteHostManager).
 * Kept separate from the main app store so the host can run regardless of which
 * route is mounted, and the Remote page can just read the connected-phone count
 * and the live session telemetry.
 */
interface RemoteHostState {
  cloudClients: number;
  setCloudClients: (n: number) => void;
  /** Live capture + link telemetry while a phone is attached (null when idle). */
  hostStats: HostLiveStats | null;
  setHostStats: (s: HostLiveStats | null) => void;
}

export const useRemoteHost = create<RemoteHostState>((set) => ({
  cloudClients: 0,
  setCloudClients: (n) => set({ cloudClients: n }),
  hostStats: null,
  setHostStats: (s) => set({ hostStats: s }),
}));
