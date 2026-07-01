import { useState } from "react";
import { motion } from "motion/react";
import { Smartphone, Wifi, KeyRound, Loader2, Globe, Network } from "lucide-react";
import { pair } from "@/lib/remoteClient";
import { DEFAULT_SIGNAL_URL } from "@/lib/remoteConfig";
import { CloudConn } from "./cloud";

export type Connected = { mode: "lan" } | { mode: "cloud"; conn: CloudConn };

const LS_SIGNAL = "gt.remote.signal";

export function Pairing({ onConnected }: { onConnected: (c: Connected) => void }) {
  const [mode, setMode] = useState<"cloud" | "lan">("cloud");
  const [signalUrl, setSignalUrl] = useState(localStorage.getItem(LS_SIGNAL) || DEFAULT_SIGNAL_URL);
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitCloud = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    localStorage.setItem(LS_SIGNAL, signalUrl.trim());
    const conn = new CloudConn(signalUrl.trim(), code.trim().toUpperCase());
    const timeout = window.setTimeout(() => {
      setError("Couldn't reach your PC. Make sure the PC app is on with cloud mode enabled, and the code is right.");
      setBusy(false);
      conn.close();
    }, 15000);
    conn.onStatus((s) => {
      if (s === "connected") {
        window.clearTimeout(timeout);
        onConnected({ mode: "cloud", conn });
      } else if (s === "error" || s === "failed") {
        window.clearTimeout(timeout);
        setError("Connection failed. Check the code and try again.");
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

  const submitLan = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await pair(address, pin);
      onConnected({ mode: "lan" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
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
        </div>

        <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl border border-line bg-white/[0.03] p-1">
          <ModeTab active={mode === "cloud"} onClick={() => setMode("cloud")} icon={<Globe className="h-4 w-4" />} label="From anywhere" />
          <ModeTab active={mode === "lan"} onClick={() => setMode("lan")} icon={<Network className="h-4 w-4" />} label="Same network" />
        </div>

        {mode === "cloud" ? (
          <form onSubmit={submitCloud}>
            <p className="mb-4 text-sm text-ink-dim">
              On your PC: <b>Remote → From anywhere</b>. Just enter the <b>connection code</b> shown there.
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
        ) : (
          <form onSubmit={submitLan}>
            <p className="mb-4 text-sm text-ink-dim">
              On the same WiFi as your PC. Use the address + PIN from <b>Remote → Same network</b>.
            </p>
            <Label icon={<Wifi className="h-3.5 w-3.5" />}>Address</Label>
            <input
              className="input mb-4 w-full"
              placeholder="192.168.x.x:47800"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <Label icon={<KeyRound className="h-3.5 w-3.5" />}>Pairing PIN</Label>
            <input
              className="input mb-4 w-full text-center font-display text-2xl tracking-[0.4em] tabular-nums"
              placeholder="000000"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            />
            {error && <ErrorBox>{error}</ErrorBox>}
            <button type="submit" disabled={busy || !address || pin.length < 6} className="btn btn-primary h-12 w-full">
              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : "Pair"}
            </button>
          </form>
        )}
      </motion.div>
    </div>
  );
}

function ModeTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-700 transition ${
        active ? "bg-accent-sheen text-white" : "text-ink-dim"
      }`}
    >
      {icon} {label}
    </button>
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
