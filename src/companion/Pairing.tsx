import { useState } from "react";
import { motion } from "motion/react";
import { Smartphone, Wifi, KeyRound, Loader2 } from "lucide-react";
import { pair } from "@/lib/remoteClient";

export function Pairing({ onPaired }: { onPaired: () => void }) {
  const [address, setAddress] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await pair(address, pin);
      onPaired();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-[100dvh] place-items-center bg-bg-base px-6 text-ink">
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm"
      >
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 grid h-16 w-16 place-items-center rounded-3xl bg-accent-sheen shadow-glow">
            <Smartphone className="h-8 w-8 text-white" />
          </span>
          <h1 className="font-display text-2xl font-800">Connect to your PC</h1>
          <p className="mt-1 text-sm text-ink-dim">
            Open GameTracker on your PC, go to <b>Remote</b>, and enter the address and PIN it shows.
          </p>
        </div>

        <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">
          <Wifi className="h-3.5 w-3.5" /> Address
        </label>
        <input
          className="input mb-4 w-full"
          placeholder="100.x.y.z:47800"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />

        <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">
          <KeyRound className="h-3.5 w-3.5" /> Pairing PIN
        </label>
        <input
          className="input mb-4 w-full text-center font-display text-2xl tracking-[0.4em] tabular-nums"
          placeholder="000000"
          inputMode="numeric"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        />

        {error && <div className="mb-4 rounded-xl border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber">{error}</div>}

        <button type="submit" disabled={busy || !address || pin.length < 6} className="btn btn-primary h-12 w-full">
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : "Pair"}
        </button>

        <p className="mt-4 text-center text-xs text-ink-faint">
          Tip: install Tailscale on both devices so this works from anywhere, securely.
        </p>
      </motion.form>
    </div>
  );
}
