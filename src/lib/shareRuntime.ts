/**
 * Long-lived direct-share hosts. Keeping this outside the Share route means a
 * saved link keeps accepting receivers while the user browses the rest of the
 * desktop app; links remain offline only when GameTracker itself is closed.
 */
import { api, type SavedShare } from "@/lib/api";
import { hostSavedShare, hostShare, type ShareHost, type ShareStats } from "@/lib/fileShare";

type Entry = { saved: SavedShare; host: ShareHost; stats: ShareStats };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let restored = false;

const idle = (total = 0): ShareStats => ({
  state: "waiting", route: "connecting", sentBytes: 0, receivedBytes: 0, totalBytes: total,
  speedBps: 0, peakSpeedBps: 0, rttMs: null, bufferedBytes: 0, etaSeconds: null, peer: null,
});
const publish = () => listeners.forEach((listener) => listener());

function attach(saved: SavedShare, host: ShareHost) {
  entries.set(saved.id, { saved, host, stats: idle(saved.manifest.totalBytes) });
  publish();
}

async function openSaved(saved: SavedShare, signalUrl?: string): Promise<ShareHost> {
  const current = entries.get(saved.id);
  if (current) return current.host;
  const host = await hostSavedShare(saved, {
    signalUrl,
    onStats: (stats) => {
      const entry = entries.get(saved.id);
      if (entry) { entry.stats = stats; publish(); }
    },
  });
  attach(saved, host);
  return host;
}

export const shareRuntime = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot() { return [...entries.values()]; },
  get(id: string) { return entries.get(id); },
  async restore(signalUrl?: string) {
    if (restored) return;
    restored = true;
    const saved = await api.shareList();
    await Promise.all(saved.filter((share) => !share.revoked).map((share) => openSaved(share, signalUrl).catch(() => {})));
  },
  async create(paths: string[], signalUrl?: string) {
    // `hostShare` reports its initial waiting state before its promise resolves.
    // Do not close over a const that has not been initialized yet: doing so made
    // the second share crash with "Cannot access 's' before initialization".
    let created: ShareHost | null = null;
    const host = await hostShare(paths, {
      signalUrl,
      onStats: (stats) => {
        if (!created) return;
        const entry = [...entries.values()].find((value) => value.host === created);
        if (entry) { entry.stats = stats; publish(); }
      },
    });
    created = host;
    attach(host.saved, host);
    return host;
  },
  async open(saved: SavedShare, signalUrl?: string) { return openSaved(saved, signalUrl); },
  async revoke(id: string) {
    entries.get(id)?.host.stop();
    entries.delete(id);
    await api.shareRevoke(id);
    publish();
  },
};
