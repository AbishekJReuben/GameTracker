import { useState } from "react";
import { BarChart3, Headphones, MonitorSmartphone, LogOut } from "lucide-react";
import { clearRemote, remoteBase, remotePaired } from "@/lib/remoteClient";
import { Pairing } from "./Pairing";
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
  const [paired, setPaired] = useState(remotePaired());
  const [tab, setTab] = useState<Tab>("stats");

  if (!paired) {
    return <Pairing onPaired={() => setPaired(true)} />;
  }

  const unpair = () => {
    clearRemote();
    setPaired(false);
  };

  return (
    <div className="flex h-[100dvh] flex-col bg-bg-base text-ink">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <div className="font-display text-lg font-800 accent-text">GameTracker</div>
          <div className="text-[11px] text-ink-faint">{remoteBase().replace(/^https?:\/\//, "")}</div>
        </div>
        <button onClick={unpair} className="btn btn-ghost h-9" title="Disconnect">
          <LogOut className="h-4 w-4" /> Disconnect
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {tab === "stats" && <StatsScreen />}
        {tab === "music" && <MusicScreen />}
        {tab === "control" && <ControlScreen />}
      </main>

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
    </div>
  );
}
