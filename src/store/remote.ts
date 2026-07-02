import { create } from "zustand";
import type { ApprovalDecision, ApprovalRequest, HostLiveStats } from "@/lib/rtcHost";

/**
 * Live state for the app-wide WebRTC host (see components/RemoteHostManager).
 * Kept separate from the main app store so the host can run regardless of which
 * route is mounted, and the Remote page can just read the connected-phone count
 * and the live session telemetry.
 */
export interface PendingApproval {
  request: ApprovalRequest;
  /** Resolves the host's onApprovalRequest promise with the user's choice. */
  resolve: (decision: ApprovalDecision) => void;
}

interface RemoteHostState {
  cloudClients: number;
  setCloudClients: (n: number) => void;
  /** Live capture + link telemetry while a phone is attached (null when idle). */
  hostStats: HostLiveStats | null;
  setHostStats: (s: HostLiveStats | null) => void;
  /** An untrusted device awaiting the desktop approval prompt (null when none). */
  pendingApproval: PendingApproval | null;
  setPendingApproval: (p: PendingApproval | null) => void;
  /** Resolve the current prompt and clear it. */
  resolveApproval: (decision: ApprovalDecision) => void;
}

export const useRemoteHost = create<RemoteHostState>((set, get) => ({
  cloudClients: 0,
  setCloudClients: (n) => set({ cloudClients: n }),
  hostStats: null,
  setHostStats: (s) => set({ hostStats: s }),
  pendingApproval: null,
  setPendingApproval: (p) => {
    // A superseding request auto-denies any previous, unanswered one.
    const prev = get().pendingApproval;
    if (prev && prev !== p) prev.resolve({ kind: "deny" });
    set({ pendingApproval: p });
  },
  resolveApproval: (decision) => {
    const p = get().pendingApproval;
    if (p) p.resolve(decision);
    set({ pendingApproval: null });
  },
}));
