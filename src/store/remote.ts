import { create } from "zustand";

/**
 * Live state for the app-wide WebRTC host (see components/RemoteHostManager).
 * Kept separate from the main app store so the host can run regardless of which
 * route is mounted, and the Remote page can just read the connected-phone count.
 */
interface RemoteHostState {
  cloudClients: number;
  setCloudClients: (n: number) => void;
}

export const useRemoteHost = create<RemoteHostState>((set) => ({
  cloudClients: 0,
  setCloudClients: (n) => set({ cloudClients: n }),
}));
