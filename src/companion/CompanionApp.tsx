import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import {
  LayoutDashboard,
  Library,
  Clock,
  Trophy,
  Headphones,
  MonitorSmartphone,
  Cpu,
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
import { DEFAULT_SIGNAL_URL, auxMonitorRoom } from "@/lib/remoteConfig";
import { readRemoteOnly, tabAllowed } from "@/lib/setupMode";
import { Pairing, type Connected } from "./Pairing";
import { apiGet, setCloudMode } from "./link";
import { makeRtcLink, type RemoteLink } from "./links";
import { CloudConn, type ConnectSnapshot } from "./cloud";
import { deviceId, deviceName } from "./device";
import { getCompanionRuntime } from "./runtime";
import { ConnectionProgress } from "./ConnectionProgress";
import { DashboardScreen } from "./screens/Dashboard";
import { LibraryScreen } from "./screens/Library";
import { TimelineScreen } from "./screens/Timeline";
import { CollectionsScreen } from "./screens/Collections";
import { MusicScreen } from "./screens/MusicView";
import { ControlScreen } from "./screens/Control";
import { SystemScreen } from "./screens/System";
import { SettingsScreen } from "./screens/Settings";
import { GameDetailScreen } from "./screens/GameDetail";
import { useOpenGame, closeGame } from "./ui";
import { ScreenErrorBoundary } from "./ErrorBoundary";
import { PageTransitionFX } from "./PageTransitionFX";
import { checkForUpdate, type UpdateInfo } from "./update";
import { UpdatePanel } from "./UpdatePanel";

type Tab = "stats" | "library" | "timeline" | "collection" | "music" | "control" | "system" | "settings";
type Phase = "boot" | "pairing" | "autoconnecting" | "connected" | "paused";

const LS_CODE = "gt.remote.code"; // remembered code → auto-connect on launch
const LS_SIGNAL = "gt.remote.signal";
const LS_SECRET = "gt.remote.secret"; // remembered permanent key (optional)

/** Multi-monitor pop-out: `?popout=1&monitor=N` joins the sibling room for that display. */
function readPopoutMonitor(): number | null {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get("popout") !== "1") return null;
    const n = Number(q.get("monitor"));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

const POPOUT_MONITOR = readPopoutMonitor();

const TABS: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "stats", label: "Home", icon: LayoutDashboard },
  { id: "library", label: "Library", icon: Library },
  { id: "timeline", label: "Time", icon: Clock },
  { id: "collection", label: "Wins", icon: Trophy },
  { id: "music", label: "Music", icon: Headphones },
  { id: "control", label: "Remote", icon: MonitorSmartphone },
  { id: "system", label: "System", icon: Cpu },
  { id: "settings", label: "More", icon: SettingsIcon },
];

export function CompanionApp() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [conn, setConn] = useState<CloudConn | null>(null);
  const [tab, setTab] = useState<Tab>("control");
  // Android floating mini-window: while a session is live, tell the native shell
  // that leaving the app (Home/recents) should enter 16:9 picture-in-picture.
  // Best-effort — rejects harmlessly on the web/discovery build (no Tauri).
  useEffect(() => {
    invoke("set_pip_enabled", { enabled: phase === "connected" }).catch(() => {});
  }, [phase]);
  // "Remote only" setup mode belongs to the PC — the companion mirrors it so the
  // phone, browser and Quest show the same tabs, and can't change it. Polled
  // rather than pushed: it flips at most a handful of times in a session, and a
  // late pickup is only ever cosmetic (the data behind a hidden tab still exists).
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [activeCode, setActiveCode] = useState(() => localStorage.getItem(LS_CODE) || "");
  const [pendingConn, setPendingConn] = useState<CloudConn | null>(null);
  const autoConnRef = useRef<CloudConn | null>(null);
  // Full-screen game-detail overlay, opened from any screen via `openGame(id)`.
  const detailId = useOpenGame();
  const isPopout = POPOUT_MONITOR != null;

  const adopt = useCallback((c: CloudConn, code?: string, signalUrl?: string, secret?: string) => {
    autoConnRef.current = null;
    setPendingConn(null);
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
    const room = POPOUT_MONITOR != null ? auxMonitorRoom(code, POPOUT_MONITOR) : code;
    const c = new CloudConn(signalUrl, room, {
      deviceId: deviceId(),
      name: getCompanionRuntime().deviceName?.() ?? deviceName(),
      secret,
    });
    autoConnRef.current = c;
    setPendingConn(c);
    setPhase("autoconnecting");
    c.onStatus((s) => {
      if (s === "connected") adopt(c);
      else if (s === "denied") {
        c.close();
        autoConnRef.current = null;
        setPendingConn(null);
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

  useEffect(() => {
    if (phase !== "connected") return;
    let alive = true;
    const read = async () => {
      try {
        const s = await apiGet<Record<string, string>>("/api/settings");
        if (alive) setRemoteOnly(readRemoteOnly(s));
      } catch {
        // Transient link hiccup — keep showing the last known mode.
      }
    };
    void read();
    const timer = setInterval(read, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase]);

  // Follow the PC if it flips to remote-only while a hidden tab (or a game
  // detail opened from one) is on screen.
  useEffect(() => {
    if (!remoteOnly) return;
    if (!tabAllowed(tab, true)) setTab("control");
    if (detailId) closeGame();
  }, [remoteOnly, tab, detailId]);

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
    setPendingConn(null);
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
  else if (phase === "autoconnecting") body = <Connecting code={activeCode} conn={pendingConn} onCancel={forget} />;
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
  const tabs = TABS.filter((t) => tabAllowed(t.id, remoteOnly));

  return (
    <>
    {updateBanner}
    {/* Glitch "energy tear" sweep on every tab change — matches the desktop route
        transition. Keyed on the active tab so it fires exactly on a screen swap. */}
    <PageTransitionFX triggerKey={tab} />
    {detailId && (
      <ScreenErrorBoundary key={detailId} label="game-detail">
        <GameDetailScreen id={detailId} onClose={closeGame} />
      </ScreenErrorBoundary>
    )}
    <div
      className={`flex h-[100dvh] flex-col text-ink ${
        isControlTab ? "bg-transparent" : "bg-bg-base"
      }`}
    >
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

      <main className={`min-h-0 flex-1 ${isControlTab || tab === "library" || tab === "timeline" ? "" : "overflow-y-auto"}`}>
        {/* Keyed by tab so a crash in one screen is isolated and cleared when you
            switch tabs — a screen error shows a retry card instead of a blank app. */}
        <ScreenErrorBoundary key={tab} label={tab}>
          {tab === "stats" && <DashboardScreen />}
          {tab === "library" && <LibraryScreen />}
          {tab === "timeline" && <TimelineScreen />}
          {tab === "collection" && <CollectionsScreen />}
          {tab === "music" && <MusicScreen />}
          {tab === "system" && <SystemScreen />}
          {tab === "settings" && (
            <SettingsScreen code={activeCode} onSaveKey={applyKey} onDisconnect={disconnect} onForget={forget} />
          )}
          {tab === "control" && (
            <ControlTab
              conn={conn}
              onNavigate={isPopout ? undefined : (t) => setTab(t)}
              onDisconnect={disconnect}
              popoutMonitor={POPOUT_MONITOR}
              remoteOnly={remoteOnly}
            />
          )}
        </ScreenErrorBoundary>
      </main>

      {!isControlTab && (
        <nav
          className="grid border-t border-line bg-bg-900/70 backdrop-blur"
          style={{
            paddingBottom: "env(safe-area-inset-bottom)",
            // Same curved-edge floor as the Control dock — Android reports 0 for
            // side curves, so the max() floor is what keeps the end tabs clear.
            paddingLeft: "max(1.25rem, env(safe-area-inset-left))",
            paddingRight: "max(1.25rem, env(safe-area-inset-right))",
            gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`,
          }}
        >
          {tabs.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex flex-col items-center gap-0.5 py-2 text-[9px] font-700 transition ${
                  active ? "text-accent-3" : "text-ink-dim"
                }`}
              >
                <t.icon className="h-[18px] w-[18px]" />
                {t.label}
              </button>
            );
          })}
        </nav>
      )}
    </div>
    {getCompanionRuntime().renderOverlay?.()}
    </>
  );
}

/**
 * "Update available" banner — tapping it opens the update panel with install
 * fallbacks (system installer → Downloads → manual), instead of silently
 * failing after a successful download.
 */
function UpdateBanner({ info, onDismiss }: { info: UpdateInfo; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <motion.div
        initial={{ y: -60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="fixed inset-x-0 top-0 z-50 border-b border-line bg-bg-900/95 backdrop-blur"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <div className="flex w-full items-center gap-3 px-4 py-2.5">
          <button type="button" onClick={() => setOpen(true)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
            <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-accent-sheen shadow-glow">
              <Download className="h-4 w-4 text-white" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-700">Update available · v{info.version}</div>
              <div className="truncate text-[11px] text-ink-dim">Tap for install options &amp; workarounds</div>
            </div>
            <span className="btn btn-primary pointer-events-none h-8 px-3 text-xs">Update</span>
          </button>
          <button type="button" onClick={onDismiss} className="btn btn-ghost h-8 w-8 p-0 text-ink-dim" title="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      </motion.div>
      {open ? <UpdatePanel info={info} sheet onClose={() => setOpen(false)} /> : null}
    </>
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
  popoutMonitor,
  remoteOnly,
}: {
  conn: CloudConn;
  onNavigate?: (t: Tab) => void;
  onDisconnect: () => void;
  popoutMonitor?: number | null;
  remoteOnly?: boolean;
}) {
  const link: RemoteLink = useMemo(() => makeRtcLink(conn), [conn]);
  const rt = getCompanionRuntime();
  useEffect(() => {
    getCompanionRuntime().onControlReady?.(link);
    return () => {
      getCompanionRuntime().onControlReady?.(null);
      link.close();
    };
  }, [link]);
  return (
    <ControlScreen
      link={link}
      onNavigate={onNavigate}
      onDisconnect={onDisconnect}
      vrSupported={rt.vrSupported}
      onEnterVr={rt.onEnterVr}
      vrMode={rt.vrMode}
      onVrModeChange={rt.onVrModeChange}
      popoutMonitor={popoutMonitor}
      remoteOnly={remoteOnly}
    />
  );
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
function Connecting({
  code,
  conn,
  onCancel,
}: {
  code: string;
  conn: CloudConn | null;
  onCancel: () => void;
}) {
  const [snap, setSnap] = useState<ConnectSnapshot | null>(conn?.getSnapshot() ?? null);

  useEffect(() => {
    if (!conn) return;
    return conn.onProgress(setSnap);
  }, [conn]);

  return (
    <div className="grid min-h-[100dvh] place-items-center bg-bg-base px-6 text-ink">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm text-center">
        <span className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-3xl bg-accent-sheen shadow-glow">
          <Smartphone className="h-8 w-8 text-white" />
        </span>
        <h1 className="font-display text-xl font-800">Connecting to your PC</h1>
        <div className="mt-4 text-left">
          {snap ? (
            <ConnectionProgress
              snapshot={snap}
              onResetDefaults={() => conn?.resetAndRebuild()}
            />
          ) : (
            <div className="flex items-center justify-center gap-2 text-sm text-ink-dim">
              <Loader2 className="h-4 w-4 animate-spin" />
              Starting…
            </div>
          )}
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
