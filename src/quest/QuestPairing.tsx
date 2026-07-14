/**
 * DEPRECATED / UNUSED — live Quest pairing is CompanionApp → Pairing (shared with
 * APK/web). Kept on disk for reference only; do not import.
 *
 * Quest-styled first-run pairing. Same WebRTC handshake as the phone companion
 * (reuses CloudConn), but with large, laser-friendly targets and the headset's
 * model name in the PC approval prompt.
 */

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Headset, KeyRound, Loader2, ShieldCheck, Eye, EyeOff, Globe } from "lucide-react";
import { DEFAULT_SIGNAL_URL } from "@/lib/remoteConfig";
import { CloudConn, type ConnectSnapshot } from "@/companion/cloud";
import { ConnectionProgress } from "@/companion/ConnectionProgress";
import { deviceId, questDeviceName } from "./device";

export type QuestConnected = { conn: CloudConn; code: string; signalUrl: string; secret: string };

const LS_CODE = "gt.remote.code";
const LS_SIGNAL = "gt.remote.signal";
const LS_SECRET = "gt.remote.secret";

export function QuestPairing({ onConnected }: { onConnected: (c: QuestConnected) => void }) {
  const [signalUrl, setSignalUrl] = useState(localStorage.getItem(LS_SIGNAL) || DEFAULT_SIGNAL_URL);
  const [code, setCode] = useState(localStorage.getItem(LS_CODE) || "");
  const [secret, setSecret] = useState(localStorage.getItem(LS_SECRET) || "");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ConnectSnapshot | null>(null);
  const connRef = useRef<CloudConn | null>(null);
  const progressRef = useRef<ConnectSnapshot | null>(null);

  useEffect(() => {
    if (!busy || !connRef.current) return;
    return connRef.current.onProgress((snap) => {
      progressRef.current = snap;
      setProgress(snap);
      if (snap.phase === "pending_approval") setWaiting(true);
    });
  }, [busy]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setWaiting(false);
    setError(null);
    setProgress(null);
    progressRef.current = null;
    const url = signalUrl.trim();
    const c = code.trim().toUpperCase();
    const key = secret.trim().toUpperCase();
    localStorage.setItem(LS_SIGNAL, url);
    localStorage.setItem(LS_SECRET, key);
    const conn = new CloudConn(url, c, { deviceId: deviceId(), name: questDeviceName(), secret: key || undefined });
    connRef.current = conn;
    const timeout = window.setTimeout(() => {
      setError("Couldn't reach your PC. Make sure GameTracker is running with Remote enabled, and the code is correct.");
      setBusy(false);
      setProgress(null);
      connRef.current = null;
      conn.close();
    }, 15000);
    conn.onStatus((s) => {
      if (s === "connected") {
        window.clearTimeout(timeout);
        onConnected({ conn, code: c, signalUrl: url, secret: key });
      } else if (s === "pending") {
        window.clearTimeout(timeout);
        setWaiting(true);
      } else if (s === "denied") {
        window.clearTimeout(timeout);
        setError("Access was declined on the PC. Ask to be allowed, or enter the permanent key.");
        setBusy(false);
        setWaiting(false);
        setProgress(null);
        connRef.current = null;
        conn.close();
      } else if (s === "error") {
        window.clearTimeout(timeout);
        setError("That code was rejected. Check the code on your PC and try again.");
        setBusy(false);
        setProgress(null);
        connRef.current = null;
        conn.close();
      }
    });
    try {
      await conn.connect();
    } catch (err) {
      window.clearTimeout(timeout);
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      setProgress(null);
      connRef.current = null;
      conn.close();
    }
  };

  return (
    <div className="grid min-h-[100dvh] place-items-center bg-bg-base px-8 text-ink">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
        <div className="mb-7 flex flex-col items-center text-center">
          <span className="mb-4 grid h-20 w-20 place-items-center rounded-[1.75rem] bg-accent-sheen shadow-glow">
            <Headset className="h-10 w-10 text-white" />
          </span>
          <h1 className="font-display text-3xl font-800">Connect your PC</h1>
          <p className="mt-1.5 text-base text-ink-dim">Control your gaming PC from your headset — flat screen or immersive VR.</p>
        </div>

        <form onSubmit={submit}>
          <p className="mb-5 text-base text-ink-dim">
            On your PC open <b>Remote → From anywhere</b> and enter the <b>connection code</b> shown there.
          </p>
          <Label icon={<KeyRound className="h-4 w-4" />}>Connection code</Label>
          <input
            className="input mb-5 h-14 w-full text-center font-display text-3xl uppercase tracking-[0.3em]"
            placeholder="XXXXXXXX"
            maxLength={8}
            autoCapitalize="characters"
            autoCorrect="off"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())}
          />
          <Label icon={<ShieldCheck className="h-4 w-4" />}>Permanent key (optional)</Label>
          <div className="relative mb-2">
            <input
              className="input h-14 w-full pr-12 text-center font-display text-2xl uppercase tracking-[0.3em]"
              placeholder="skip for one-time"
              maxLength={8}
              type={showSecret ? "text" : "password"}
              autoCapitalize="characters"
              autoCorrect="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())}
            />
            <button
              type="button"
              onClick={() => setShowSecret((v) => !v)}
              className="absolute right-2.5 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-xl text-ink-dim active:bg-white/[0.08]"
            >
              {showSecret ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            </button>
          </div>
          <p className="mb-5 text-sm text-ink-faint">
            Enter the key from the PC to be trusted automatically. Leave blank to ask for approval instead.
          </p>

          {waiting && !progress && (
            <div className="mb-5 flex items-center gap-2 rounded-2xl border border-accent-3/40 bg-accent-3/10 px-4 py-3 text-base text-accent-3">
              <Loader2 className="h-5 w-5 animate-spin" /> Waiting for approval on your PC…
            </div>
          )}
          {busy && progress && (
            <div className="mb-5">
              <ConnectionProgress snapshot={progress} showSteps={!waiting} />
            </div>
          )}
          {error && <div className="mb-5 rounded-2xl border border-amber/40 bg-amber/10 px-4 py-3 text-base text-amber">{error}</div>}

          <button type="submit" disabled={busy || !signalUrl || code.length < 8} className="btn btn-primary h-14 w-full text-lg">
            {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : "Connect"}
          </button>
          <p className="mt-4 text-center text-sm text-ink-faint">Peer-to-peer and encrypted. Nothing to install.</p>

          <details className="mt-5">
            <summary className="cursor-pointer text-center text-sm text-ink-faint">Advanced: signaling server</summary>
            <div className="mt-3">
              <Label icon={<Globe className="h-4 w-4" />}>Signaling server</Label>
              <input
                className="input h-12 w-full"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                value={signalUrl}
                onChange={(e) => setSignalUrl(e.target.value)}
              />
            </div>
          </details>
        </form>
      </motion.div>
    </div>
  );
}

function Label({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="mb-2 flex items-center gap-1.5 text-xs font-700 uppercase tracking-wider text-ink-dim">
      {icon} {children}
    </label>
  );
}
