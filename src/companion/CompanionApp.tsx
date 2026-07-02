import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { listen } from "@tauri-apps/api/event";
import {
  LayoutDashboard,
  Library,
  Headphones,
  MonitorSmartphone,
  Settings as SettingsIcon,
  LogOut,
  Globe,
  Loader2,
  Smartphone,
  KeyRound,
  Plug,
  Power,
  Download,
  X,
} from "lucide-react";
import { DEFAULT_SIGNAL_URL } from "@/lib/remoteConfig";
import { Pairing, type Connected } from "./Pairing";
import { setCloudMode } from "./link";
import { makeRtcLink, type RemoteLink } from "./links";
import { CloudConn } from "./cloud";
import { deviceId, deviceName } from "./device";
import { DashboardScreen } from "./screens/Dashboard";
import { LibraryScreen } from "./screens/Library";
import { MusicScreen } from "./screens/MusicView";
import { ControlScreen } from "./screens/Control";
import { SettingsScreen } from "./screens/Settings";
import { GameDetailScreen } from "./screens/GameDetail";
import { useOpenGame, closeGame } from "./ui";
import { checkForUpdate, installUpdate, type UpdateInfo } from "./update";

type Tab = "stats" | "library" | "music" | "control" | "settings";
type Phase = "boot" | "pairing" | "autoconnecting" | "connected" | "paused";

const LS_CODE = "gt.remote.code"; // remembered code → auto-connect on launch
const LS_SIGNAL = "gt.remote.signal";
const LS_SECRET = "gt.remote.secret"; // remembered permanent key (optional)

const TABS: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "stats", label: "Home", icon: LayoutDashboard },
  { id: "library", label: "Library", icon: Library },
  { id: "music", label: "Music", icon: Headphones },
  { id: "control", label: "Control", icon: MonitorSmartphone },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

export function CompanionApp() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [conn, setConn] = useState<CloudConn | null>(null);
  const [tab, setTab] = useState<Tab>("control");
  const [activeCode, setActiveCode] = useState(() => localStorage.getItem(LS_CODE) || "");
  const autoConnRef = useRef<CloudConn | null>(null);
  // Full-screen game-detail overlay, opened from any screen via `openGame(id)`.
  const detailId = useOpenGame();

  const adopt = useCallback((c: CloudConn, code?: string, signalUrl?: string, secret?: string) => {
    autoConnRef.current = null; // hand ownership to app state; skip cleanup close
    if (code) {
      localStorage.setItem(LS_CODE, code);
      setActiveCode(code);
    }
    if (signalUrl) localStorage.setItem(LS_SIGNAL, signalUrl);
    if (secret !== undefined) localStorage.setItem(LS_SECRET, secret);
    // Terminal denial can arrive at any time (e.g. the PC revokes this device, or
    // the user declines a fresh prompt) — including while the Control screen owns
    // the status subscription. Own this callback at the shell so we always fall
    // back to pairing instead of sitting on "Reconnecting…" forever. The saved
    // code is kept so the user can re-request access or enter the permanent key.
    c.onDenied(() => {
      c.close();
      autoConnRef.current = null;
      setConn(null);
      setPhase("pairing");
    });
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
    const secret = localStorage.getItem(LS_SECRET) || undefined;
    const c = new CloudConn(signalUrl, code, { deviceId: deviceId(), name: deviceName(), secret });
    autoConnRef.current = c;
    setPhase("autoconnecting");
    c.onStatus((s) => {
      if (s === "connected") adopt(c);
      // Approval declined on the PC — drop back to pairing so the user can enter
      // the permanent key or ask to be allowed again.
      else if (s === "denied") {
        c.close();
        autoConnRef.current = null;
        setPhase("pairing");
      }
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

  // In-app updater: check GitHub for a newer APK on launch (Tauri's updater
  // plugin doesn't support Android, so this is a small custom flow).
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  useEffect(() => {
    checkForUpdate().then((u) => {
      if (u) setUpdate(u);
    });
  }, []);

  const onPaired = (c: Connected) => adopt(c.conn, c.code, c.signalUrl, c.secret);

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
    localStorage.removeItem(LS_SECRET);
    setActiveCode("");
    setPhase("pairing");
  };

  // Save a permanent key for the saved PC and reconnect so the host re-runs auth
  // with the key (a correct key auto-grants → no approval prompt next time).
  const applyKey = (secret: string) => {
    localStorage.setItem(LS_SECRET, secret);
    closeAll();
    beginAutoConnect();
  };

  const updateBanner =
    update && !updateDismissed ? (
      <UpdateBanner info={update} onDismiss={() => setUpdateDismissed(true)} />
    ) : null;

  let body: React.ReactNode;
  if (phase === "boot") body = <FullscreenSpinner label="Starting…" />;
  else if (phase === "autoconnecting") body = <Connecting code={activeCode} onCancel={forget} />;
  else if (phase === "paused") body = <Paused onReconnect={beginAutoConnect} onForget={forget} />;
  else if (phase === "pairing" || !conn)
    body = <Pairing onConnected={onPaired} initialCode={activeCode} />;
  else body = null;

  if (body !== null) {
    return (
      <>
        {updateBanner}
        {body}
      </>
    );
  }

  if (!conn) return updateBanner; // unreachable (body handles !conn), narrows for TS

  const isControlTab = tab === "control";

  return (
    <>
    {updateBanner}
    {detailId && <GameDetailScreen id={detailId} onClose={closeGame} />}
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
        {tab === "stats" && <DashboardScreen />}
        {tab === "library" && <LibraryScreen />}
        {tab === "music" && <MusicScreen />}
        {tab === "settings" && (
          <SettingsScreen code={activeCode} onSaveKey={applyKey} onDisconnect={disconnect} onForget={forget} />
        )}
        {tab === "control" && (
          <ControlTab conn={conn} onNavigate={(t) => setTab(t)} onDisconnect={disconnect} />
        )}
      </main>

      {!isControlTab && (
        <nav
          className="grid grid-cols-5 border-t border-line bg-bg-900/70 backdrop-blur"
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
    </>
  );
}

/**
 * "Update available" banner shown at the top of the app when a newer companion
 * APK is published. Tapping Update downloads it and hands it to the Android
 * package installer; a small progress line reflects the download.
 */
function UpdateBanner({ info, onDismiss }: { info: UpdateInfo; onDismiss: () => void }) {
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [pct, setPct] = useState<number | null>(null);

  useEffect(() => {
    if (state !== "working") return;
    const un = listen<{ phase: string; received: number; total: number }>(
      "apk-update://progress",
      (e) => {
        const { phase, received, total } = e.payload;
        setPct(phase === "installing" ? 100 : total > 0 ? Math.round((received / total) * 100) : null);
      },
    );
    return () => {
      un.then((f) => f());
    };
  }, [state]);

  const start = async () => {
    setState("working");
    setPct(null);
    try {
      await installUpdate(info.url);
    } catch {
      setState("error");
    }
  };

  return (
    <motion.div
      initial={{ y: -60, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="fixed inset-x-0 top-0 z-50 border-b border-line bg-bg-900/95 backdrop-blur"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      <div className="flex items-center gap-3 px-4 py-2.5">
        <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-accent-sheen shadow-glow">
          <Download className="h-4 w-4 text-white" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-700">Update available · v{info.version}</div>
          <div className="truncate text-[11px] text-ink-dim">
            {state === "working"
              ? pct == null
                ? "Downloading…"
                : pct >= 100
                  ? "Opening installer…"
                  : `Downloading… ${pct}%`
              : state === "error"
                ? "Update failed — tap to retry"
                : "A newer version of the companion is ready."}
          </div>
        </div>
        {state === "working" && pct != null && pct < 100 ? (
          <span className="text-xs font-700 tabular-nums text-accent-3">{pct}%</span>
        ) : state === "working" ? (
          <Loader2 className="h-4 w-4 animate-spin text-accent-3" />
        ) : (
          <button onClick={start} className="btn btn-primary h-8 px-3 text-xs">
            {state === "error" ? "Retry" : "Update"}
          </button>
        )}
        {state !== "working" && (
          <button onClick={onDismiss} className="btn btn-ghost h-8 w-8 p-0 text-ink-dim" title="Dismiss">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </motion.div>
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
