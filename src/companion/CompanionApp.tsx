import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  BarChart3,
  Library,
  Headphones,
  MonitorSmartphone,
  LogOut,
  Globe,
  Loader2,
  Smartphone,
  KeyRound,
  Plug,
  Power,
} from "lucide-react";
import { DEFAULT_SIGNAL_URL } from "@/lib/remoteConfig";
import { Pairing, type Connected } from "./Pairing";
import { setCloudMode } from "./link";
import { makeRtcLink, type RemoteLink } from "./links";
import { CloudConn } from "./cloud";
import { StatsScreen } from "./screens/Stats";
import { LibraryScreen } from "./screens/Library";
import { MusicScreen } from "./screens/MusicView";
import { ControlScreen } from "./screens/Control";

type Tab = "stats" | "library" | "music" | "control";
type Phase = "boot" | "pairing" | "autoconnecting" | "connected" | "paused";

const LS_CODE = "gt.remote.code"; // remembered code → auto-connect on launch
const LS_SIGNAL = "gt.remote.signal";

const TABS: { id: Tab; label: string; icon: typeof BarChart3 }[] = [
  { id: "stats", label: "Stats", icon: BarChart3 },
  { id: "library", label: "Library", icon: Library },
  { id: "music", label: "Music", icon: Headphones },
  { id: "control", label: "Control", icon: MonitorSmartphone },
];

export function CompanionApp() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [conn, setConn] = useState<CloudConn | null>(null);
  const [tab, setTab] = useState<Tab>("control");
  const [activeCode, setActiveCode] = useState(() => localStorage.getItem(LS_CODE) || "");
  const autoConnRef = useRef<CloudConn | null>(null);

  const adopt = useCallback((c: CloudConn, code?: string, signalUrl?: string) => {
    autoConnRef.current = null; // hand ownership to app state; skip cleanup close
    if (code) {
      localStorage.setItem(LS_CODE, code);
      setActiveCode(code);
    }
    if (signalUrl) localStorage.setItem(LS_SIGNAL, signalUrl);
    setCloudMode(c);
    setConn(c);
    setPhase("connected");
    setTab("control");
  }, []);

  // Build a CloudConn from the remembered code and connect (it self-heals/retries).
  const beginAutoConnect = useCallback(() => {
    const code = localStorage.getItem(LS_CODE) || "";
    if (!code) {
      setPhase("pairing");
      return;
    }
    setActiveCode(code);
    const signalUrl = localStorage.getItem(LS_SIGNAL) || DEFAULT_SIGNAL_URL;
    const c = new CloudConn(signalUrl, code);
    autoConnRef.current = c;
    setPhase("autoconnecting");
    c.onStatus((s) => {
      if (s === "connected") adopt(c);
    });
    c.connect().catch(() => {
      /* CloudConn keeps retrying on its own */
    });
  }, [adopt]);

  // On launch, reconnect with the remembered code (if any).
  useEffect(() => {
    beginAutoConnect();
    return () => {
      if (autoConnRef.current) autoConnRef.current.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPaired = (c: Connected) => adopt(c.conn, c.code, c.signalUrl);

  const closeAll = () => {
    conn?.close();
    autoConnRef.current?.close();
    autoConnRef.current = null;
    setConn(null);
  };

  // Disconnect: end the live session but KEEP the remembered code — one tap
  // reconnects, no code needed. This is why "disconnect" never re-prompts.
  const disconnect = () => {
    closeAll();
    setPhase("paused");
  };

  // Forget: clear the remembered code and return to first-run pairing.
  const forget = () => {
    closeAll();
    localStorage.removeItem(LS_CODE);
    setActiveCode("");
    setPhase("pairing");
  };

  if (phase === "boot") return <FullscreenSpinner label="Starting…" />;
  if (phase === "autoconnecting") return <Connecting code={activeCode} onCancel={forget} />;
  if (phase === "paused") return <Paused onReconnect={beginAutoConnect} onForget={forget} />;
  if (phase === "pairing" || !conn) return <Pairing onConnected={onPaired} initialCode={activeCode} />;

  const isControlTab = tab === "control";

  return (
    <div className="flex h-[100dvh] flex-col bg-bg-base text-ink">
      {!isControlTab && (
        <header
          className="flex items-center justify-between border-b border-line px-4 py-3"
          style={{ paddingTop: "max(0.75rem, calc(env(safe-area-inset-top) + 0.5rem))" }}
        >
          <div>
            <div className="font-display text-lg font-800 accent-text">GameTracker</div>
            <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
              <Globe className="h-3 w-3" />
              Cloud · peer-to-peer
            </div>
          </div>
          <button onClick={disconnect} className="btn btn-ghost h-9" title="Disconnect (keeps this PC saved)">
            <LogOut className="h-4 w-4" /> Disconnect
          </button>
        </header>
      )}

      <main className={`min-h-0 flex-1 ${isControlTab || tab === "library" ? "" : "overflow-y-auto"}`}>
        {tab === "stats" && <StatsScreen />}
        {tab === "library" && <LibraryScreen />}
        {tab === "music" && <MusicScreen />}
        {tab === "control" && (
          <ControlTab conn={conn} onNavigate={(t) => setTab(t)} onDisconnect={disconnect} />
        )}
      </main>

      {!isControlTab && (
        <nav
          className="grid grid-cols-4 border-t border-line bg-bg-900/70 backdrop-blur"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
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
 * Builds the WebRTC screen/control transport for the Control tab and tears it down
 * when the tab is left (the underlying CloudConn stays alive and owned by the app).
 */
function ControlTab({
  conn,
  onNavigate,
  onDisconnect,
}: {
  conn: CloudConn;
  onNavigate: (t: Tab) => void;
  onDisconnect: () => void;
}) {
  const link: RemoteLink = useMemo(() => makeRtcLink(conn), [conn]);
  useEffect(() => () => link.close(), [link]);
  return <ControlScreen link={link} onNavigate={onNavigate} onDisconnect={onDisconnect} />;
}

function FullscreenSpinner({ label }: { label: string }) {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-bg-base text-ink-dim">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-accent-3" />
        <span className="text-sm">{label}</span>
      </div>
    </div>
  );
}

/** Persistent "reconnecting to your PC" screen shown while the saved code auto-connects. */
function Connecting({ code, onCancel }: { code: string; onCancel: () => void }) {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-bg-base px-6 text-ink">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm text-center">
        <span className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-3xl bg-accent-sheen shadow-glow">
          <Smartphone className="h-8 w-8 text-white" />
        </span>
        <h1 className="font-display text-xl font-800">Connecting to your PC</h1>
        <div className="mt-3 flex items-center justify-center gap-2 text-sm text-ink-dim">
          <Loader2 className="h-4 w-4 animate-spin" />
          Waiting for your PC to come online…
        </div>
        <div className="mt-4 inline-flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3 py-2 text-sm">
          <KeyRound className="h-3.5 w-3.5 text-ink-faint" />
          <span className="font-display tracking-[0.25em]">{code}</span>
        </div>
        <p className="mt-4 text-xs text-ink-faint">This connects automatically as soon as your PC is reachable.</p>
        <button onClick={onCancel} className="btn btn-ghost mt-5 h-10 w-full text-ink-dim">
          Use a different code
        </button>
      </motion.div>
    </div>
  );
}

/** Shown after an explicit Disconnect — the code is still saved, so one tap reconnects. */
function Paused({ onReconnect, onForget }: { onReconnect: () => void; onForget: () => void }) {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-bg-base px-6 text-ink">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm text-center">
        <span className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-3xl bg-white/[0.05]">
          <Power className="h-8 w-8 text-ink-dim" />
        </span>
        <h1 className="font-display text-xl font-800">Disconnected</h1>
        <p className="mt-1 text-sm text-ink-dim">Your PC is still saved — reconnect any time, no code needed.</p>
        <button onClick={onReconnect} className="btn btn-primary mt-6 h-12 w-full">
          <Plug className="h-5 w-5" /> Reconnect
        </button>
        <button onClick={onForget} className="btn btn-ghost mt-2 h-10 w-full text-ink-dim">
          Forget this PC
        </button>
      </motion.div>
    </div>
  );
}
