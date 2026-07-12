/**
 * Quest client shell: pair (or auto-reconnect with the remembered code), then
 * show the flat remote with an "Enter VR" hand-off to the immersive big screen.
 * Transport is the same P2P WebRTC CloudConn the phone companion uses.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Loader2, Gamepad2, MousePointer2 } from "lucide-react";
import { DEFAULT_SIGNAL_URL } from "@/lib/remoteConfig";
import { CloudConn } from "@/companion/cloud";
import { makeRtcLink, type RemoteLink } from "@/companion/links";
import { setCloudMode } from "@/companion/link";
import { deviceId, questDeviceName } from "./device";
import { QuestPairing, type QuestConnected } from "./QuestPairing";
import { FlatScreen } from "./FlatScreen";
import { ImmersiveScreen } from "./ImmersiveScreen";
import { ImmersiveSession } from "./xr/session";

type Phase = "boot" | "pairing" | "autoconnecting" | "connected";

const LS_CODE = "gt.remote.code";
const LS_SIGNAL = "gt.remote.signal";
const LS_SECRET = "gt.remote.secret";

export function QuestApp() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [link, setLink] = useState<RemoteLink | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [vrSupported, setVrSupported] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [mode, setMode] = useState<"pointer" | "gamepad">("pointer");
  const connRef = useRef<CloudConn | null>(null);

  useEffect(() => {
    ImmersiveSession.isSupported().then(setVrSupported);
  }, []);

  const adopt = useCallback((conn: CloudConn) => {
    connRef.current = conn;
    setCloudMode(conn);
    const l = makeRtcLink(conn);
    setLink(l);
    l.onStream((s) => setStream(s));
    conn.onDenied(() => {
      conn.close();
      connRef.current = null;
      setLink(null);
      setStream(null);
      setImmersive(false);
      setPhase("pairing");
    });
    setPhase("connected");
  }, []);

  // Auto-reconnect with the remembered code on launch.
  const beginAutoConnect = useCallback(() => {
    const code = localStorage.getItem(LS_CODE) || "";
    if (!code) {
      setPhase("pairing");
      return;
    }
    const signalUrl = localStorage.getItem(LS_SIGNAL) || DEFAULT_SIGNAL_URL;
    const secret = localStorage.getItem(LS_SECRET) || undefined;
    const conn = new CloudConn(signalUrl, code, { deviceId: deviceId(), name: questDeviceName(), secret });
    connRef.current = conn;
    setPhase("autoconnecting");
    conn.onStatus((s) => {
      if (s === "connected") adopt(conn);
      else if (s === "denied") {
        conn.close();
        connRef.current = null;
        setPhase("pairing");
      }
    });
    conn.connect().catch(() => {
      /* CloudConn keeps retrying */
    });
  }, [adopt]);

  useEffect(() => {
    beginAutoConnect();
    return () => connRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPaired = (c: QuestConnected) => {
    localStorage.setItem(LS_CODE, c.code);
    localStorage.setItem(LS_SIGNAL, c.signalUrl);
    localStorage.setItem(LS_SECRET, c.secret);
    adopt(c.conn);
  };

  const disconnect = () => {
    connRef.current?.close();
    connRef.current = null;
    localStorage.removeItem(LS_CODE);
    setLink(null);
    setStream(null);
    setImmersive(false);
    setPhase("pairing");
  };

  if (phase === "boot") {
    return <Splash label="Starting…" />;
  }
  if (phase === "autoconnecting") {
    return <Splash label="Reconnecting to your PC…" sub="Using your saved code" />;
  }
  if (phase === "pairing" || !link) {
    return <QuestPairing onConnected={onPaired} />;
  }

  return (
    <>
      <FlatScreen
        link={link}
        stream={stream}
        vrSupported={vrSupported}
        onEnterVr={() => setImmersive(true)}
        onDisconnect={disconnect}
      />
      {vrSupported && !immersive && (
        <div className="fixed bottom-16 left-1/2 z-10 -translate-x-1/2">
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
      )}
      {immersive && <ImmersiveScreen link={link} stream={stream} mode={mode} onExit={() => setImmersive(false)} />}
    </>
  );
}

function ModeToggle({ mode, onChange }: { mode: "pointer" | "gamepad"; onChange: (m: "pointer" | "gamepad") => void }) {
  return (
    <div className="flex overflow-hidden rounded-full border border-white/10 bg-bg-900/85 text-sm shadow-float backdrop-blur">
      <button
        onClick={() => onChange("pointer")}
        className={`flex items-center gap-1.5 px-4 py-2 font-600 ${mode === "pointer" ? "bg-accent-3/25 text-accent-3" : "text-ink-dim"}`}
      >
        <MousePointer2 className="h-4 w-4" /> Pointer
      </button>
      <button
        onClick={() => onChange("gamepad")}
        className={`flex items-center gap-1.5 px-4 py-2 font-600 ${mode === "gamepad" ? "bg-accent-3/25 text-accent-3" : "text-ink-dim"}`}
      >
        <Gamepad2 className="h-4 w-4" /> Gamepad
      </button>
    </div>
  );
}

function Splash({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-bg-base text-ink">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-accent-3" />
        <div className="font-display text-lg font-700">{label}</div>
        {sub && <div className="text-sm text-ink-dim">{sub}</div>}
      </motion.div>
    </div>
  );
}
