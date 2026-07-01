import { useEffect, useMemo, useState } from "react";
import { BarChart3, Headphones, MonitorSmartphone, LogOut, Globe, Network } from "lucide-react";
import { clearRemote, remoteBase } from "@/lib/remoteClient";
import { Pairing, type Connected } from "./Pairing";
import { setCloudMode, setLanMode } from "./link";
import { makeRtcLink, makeWsLink, type RemoteLink } from "./links";
import { StatsScreen } from "./screens/Stats";
import { MusicScreen } from "./screens/MusicView";
import { ControlScreen } from "./screens/Control";

type Tab = "stats" | "music" | "control";

const TABS: { id: Tab; label: string; icon: typeof BarChart3 }[] = [
  { id: "stats", label: "Stats", icon: BarChart3 },
  { id: "music", label: "Music", icon: Headphones },
  { id: "control", label: "Control", icon: MonitorSmartphone },
];

export function CompanionApp() {
  const [conn, setConn] = useState<Connected | null>(null);
  const [tab, setTab] = useState<Tab>("stats");

  const onConnected = (c: Connected) => {
    if (c.mode === "cloud") setCloudMode(c.conn);
    else setLanMode();
    setConn(c);
    setTab("stats");
  };

  if (!conn) return <Pairing onConnected={onConnected} />;

  const disconnect = () => {
    if (conn.mode === "cloud") conn.conn.close();
    else clearRemote();
    setLanMode();
    setConn(null);
  };

  const subtitle =
    conn.mode === "cloud"
      ? "Cloud · peer-to-peer"
      : remoteBase().replace(/^https?:\/\//, "");

  const isControlTab = tab === "control";

  return (
    <div className="flex h-[100dvh] flex-col bg-bg-base text-ink">
      {!isControlTab && (
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="font-display text-lg font-800 accent-text">GameTracker</div>
            <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
              {conn.mode === "cloud" ? <Globe className="h-3 w-3" /> : <Network className="h-3 w-3" />}
              {subtitle}
            </div>
          </div>
          <button onClick={disconnect} className="btn btn-ghost h-9" title="Disconnect">
            <LogOut className="h-4 w-4" /> Disconnect
          </button>
        </header>
      )}

      <main className={`min-h-0 flex-1 ${isControlTab ? "" : "overflow-y-auto"}`}>
        {tab === "stats" && <StatsScreen />}
        {tab === "music" && <MusicScreen />}
        {/* Mounted only on the Control tab so screen capture runs only while viewed. */}
        {tab === "control" && (
          <ControlTab
            conn={conn}
            onNavigate={(targetTab: Tab) => setTab(targetTab)}
            onDisconnect={disconnect}
          />
        )}
      </main>

      {!isControlTab && (
        <nav className="grid grid-cols-3 border-t border-line bg-bg-900/70 backdrop-blur">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-700 transition ${
                  active ? "text-accent-3" : "text-ink-dim"
                }`}
              >
                <t.icon className="h-5 w-5" />
                {t.label}
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}

/**
 * Builds the screen/control transport for the active connection and tears it down
 * when the Control tab is left — LAN opens its screen WebSocket, cloud reuses the
 * already-connected WebRTC data channels.
 */
function ControlTab({
  conn,
  onNavigate,
  onDisconnect,
}: {
  conn: Connected;
  onNavigate: (t: Tab) => void;
  onDisconnect: () => void;
}) {
  const link: RemoteLink = useMemo(
    () => (conn.mode === "cloud" ? makeRtcLink(conn.conn) : makeWsLink()),
    [conn],
  );
  useEffect(() => () => link.close(), [link]);
  return <ControlScreen link={link} onNavigate={onNavigate} onDisconnect={onDisconnect} />;
}
