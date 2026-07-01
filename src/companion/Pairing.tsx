import { useState } from "react";
import { motion } from "motion/react";
import { Smartphone, KeyRound, Loader2, Globe } from "lucide-react";
import { DEFAULT_SIGNAL_URL } from "@/lib/remoteConfig";
import { CloudConn } from "./cloud";

export type Connected = { conn: CloudConn; code: string; signalUrl: string };

const LS_SIGNAL = "gt.remote.signal";

/**
 * First-run pairing: the user enters the 8-char connection code shown on the PC.
 * The code is remembered afterwards (see CompanionApp), so this only appears once.
 */
export function Pairing({
  onConnected,
  initialCode = "",
}: {
  onConnected: (c: Connected) => void;
  initialCode?: string;
}) {
  const [signalUrl, setSignalUrl] = useState(localStorage.getItem(LS_SIGNAL) || DEFAULT_SIGNAL_URL);
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const url = signalUrl.trim();
    const c = code.trim().toUpperCase();
    localStorage.setItem(LS_SIGNAL, url);
    const conn = new CloudConn(url, c);
    const timeout = window.setTimeout(() => {
      setError("Couldn't reach your PC. Make sure the PC app is on with cloud mode enabled, and the code is right.");
      setBusy(false);
      conn.close();
    }, 15000);
    conn.onStatus((s) => {
      if (s === "connected") {
        window.clearTimeout(timeout);
        onConnected({ conn, code: c, signalUrl: url });
      } else if (s === "error") {
        window.clearTimeout(timeout);
        setError("That code was rejected. Check the code on your PC and try again.");
        setBusy(false);
        conn.close();
      }
    });
    try {
      await conn.connect();
    } catch (err) {
      window.clearTimeout(timeout);
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      conn.close();
    }
  };

  return (
    <div className="grid min-h-[100dvh] place-items-center bg-bg-base px-6 text-ink">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 grid h-16 w-16 place-items-center rounded-3xl bg-accent-sheen shadow-glow">
            <Smartphone className="h-8 w-8 text-white" />
          </span>
          <h1 className="font-display text-2xl font-800">Connect to your PC</h1>
          <p className="mt-1 text-sm text-ink-dim">One-time setup — we'll remember it after this.</p>
        </div>

        <form onSubmit={submit}>
          <p className="mb-4 text-sm text-ink-dim">
            On your PC open <b>Remote → From anywhere</b> and enter the <b>connection code</b> shown there.
          </p>
          <Label icon={<KeyRound className="h-3.5 w-3.5" />}>Connection code</Label>
          <input
            className="input mb-4 w-full text-center font-display text-2xl uppercase tracking-[0.3em]"
            placeholder="XXXXXXXX"
            maxLength={8}
            autoCapitalize="characters"
            autoCorrect="off"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())}
          />
          {error && <ErrorBox>{error}</ErrorBox>}
          <button type="submit" disabled={busy || !signalUrl || code.length < 8} className="btn btn-primary h-12 w-full">
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : "Connect"}
          </button>
          <p className="mt-4 text-center text-xs text-ink-faint">
            Connects directly to your PC (peer-to-peer, encrypted) from anywhere. Nothing to install.
          </p>

          <details className="mt-4">
            <summary className="cursor-pointer text-center text-xs text-ink-faint">Advanced: signaling server</summary>
            <div className="mt-3">
              <Label icon={<Globe className="h-3.5 w-3.5" />}>Signaling server</Label>
              <input
                className="input w-full"
                placeholder="wss://discovery.chilloutgamestudio.com"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                value={signalUrl}
                onChange={(e) => setSignalUrl(e.target.value)}
              />
              <p className="mt-1.5 text-xs text-ink-faint">
                Pre-filled with the default. Only change this if you host your own signaling server.
              </p>
            </div>
          </details>
        </form>
      </motion.div>
    </div>
  );
}

function Label({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">
      {icon} {children}
    </label>
  );
}
function ErrorBox({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 rounded-xl border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber">{children}</div>;
}
