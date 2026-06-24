import { useEffect, useState } from "react";
import { api, type LauncherCapability } from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { SteamSyncPanel } from "./SteamSyncPanel";
import { GogSyncPanel } from "./GogSyncPanel";
import { LocalLauncherPanel } from "./LocalLauncherPanel";

const LOCAL_PLATFORMS = new Set(["epic", "riot", "ubisoft", "rockstar"]);

export function LauncherSyncSection() {
  const [caps, setCaps] = useState<LauncherCapability[]>([]);

  useEffect(() => {
    if (!isTauri()) return;
    api.launcherCapabilities().then(setCaps).catch(() => setCaps([]));
  }, []);

  const localCaps = caps.filter((c) => LOCAL_PLATFORMS.has(c.id));

  return (
    <div className="space-y-6">
      <p className="text-sm text-ink-dim">
        Connect launchers to import games and sync official stats where APIs exist. Steam and GOG
        support full online library import plus playtime and achievements. Epic, Riot, Ubisoft, and
        Rockstar only expose <span className="text-ink-soft">installed titles on this PC</span> — no
        public user APIs for cloud libraries or achievements.
      </p>

      <SteamSyncPanel />
      <GogSyncPanel />

      {localCaps.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-700 uppercase tracking-wide text-ink-faint">Local installs</h3>
          {localCaps.map((c) => (
            <LocalLauncherPanel
              key={c.id}
              platform={c.id}
              library={c.library}
              playtime={c.playtime}
              achievements={c.achievements}
              notes={c.notes}
            />
          ))}
        </div>
      )}
    </div>
  );
}
