/**
 * Companion Settings screen: app version + in-app updater controls, plus this
 * device's connection details and management.
 *
 * The updater is the primary reason this screen exists — Tauri's updater plugin
 * is desktop-only, so the phone self-updates through the custom flow in
 * `../update.ts` (+ `companion/src-tauri/src/update.rs`). The launch-time banner
 * is easy to miss and swallows every failure; here the user can trigger a check
 * on demand and actually see the result (up to date, a download with progress,
 * or a specific error).
 */

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Download,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  KeyRound,
  Smartphone,
  Plug,
  Trash2,
  Info,
} from "lucide-react";
import { checkForUpdateVerbose, installUpdate, type UpdateCheck } from "../update";
import { deviceName } from "../device";

interface SettingsProps {
  /** The saved connection code (code 1). */
  code: string;
  /** Save a permanent key for this PC and reconnect so the host auto-grants us. */
  onSaveKey: (secret: string) => void;
  /** End the session but keep this PC saved (one-tap reconnect later). */
  onDisconnect: () => void;
  /** Clear the saved PC and return to first-run pairing. */
  onForget: () => void;
}

export function SettingsScreen({ code, onSaveKey, onDisconnect, onForget }: SettingsProps) {
  return (
    <div className="mx-auto max-w-xl space-y-4 p-4">
      <UpdateSection />
      <ConnectionSection code={code} onSaveKey={onSaveKey} onDisconnect={onDisconnect} onForget={onForget} />
      <div className="pb-2 text-center text-[11px] text-ink-faint">GameTracker Remote · companion</div>
    </div>
  );
}

/** In-app updater: current version, manual check, and download+install. */
function UpdateSection() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  // Run a check automatically the first time the screen opens.
  useEffect(() => {
    void runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect native download/install progress while an install is running.
  useEffect(() => {
    if (!installing) return;
    const un = listen<{ phase: string; received: number; total: number }>("apk-update://progress", (e) => {
      const { phase, received, total } = e.payload;
      setPct(phase === "installing" ? 100 : total > 0 ? Math.round((received / total) * 100) : null);
    });
    return () => {
      un.then((f) => f());
    };
  }, [installing]);

  const runCheck = async () => {
    setChecking(true);
    setInstallError(null);
    try {
      setCheck(await checkForUpdateVerbose());
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    if (check?.status !== "update-available") return;
    setInstalling(true);
    setPct(null);
    setInstallError(null);
    try {
      await installUpdate(check.info.url);
    } catch (e) {
      setInstallError(e instanceof Error && e.message ? e.message : "Update failed. Please try again.");
      setInstalling(false);
    }
  };

  const current = check && "current" in check ? check.current : null;

  return (
    <section className="rounded-2xl border border-line bg-bg-900/60 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-sheen shadow-glow">
          <Download className="h-4 w-4 text-white" />
        </span>
        <div>
          <div className="font-display text-base font-800">App updates</div>
          <div className="text-[11px] text-ink-faint">
            Version {current ?? "…"}
          </div>
        </div>
      </div>

      {/* Status line */}
      <div className="mb-3 min-h-[2.75rem] rounded-xl border border-line bg-white/[0.02] px-3 py-2.5 text-sm">
        {checking ? (
          <span className="flex items-center gap-2 text-ink-dim">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking for updates…
          </span>
        ) : check?.status === "update-available" ? (
          <div>
            <span className="flex items-center gap-2 font-700 text-accent-3">
              <Info className="h-4 w-4" /> Update available · v{check.info.version}
            </span>
            {check.info.notes ? <p className="mt-1 whitespace-pre-wrap text-[12px] text-ink-dim">{check.info.notes}</p> : null}
          </div>
        ) : check?.status === "up-to-date" ? (
          <span className="flex items-center gap-2 text-green">
            <CheckCircle2 className="h-4 w-4" /> You're on the latest version.
          </span>
        ) : check?.status === "error" ? (
          <span className="flex items-center gap-2 text-amber">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {check.message}
          </span>
        ) : (
          <span className="text-ink-faint">Tap "Check for updates".</span>
        )}
      </div>

      {installError ? (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-red/30 bg-red/5 px-3 py-2 text-[12px] text-red">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {installError}
        </div>
      ) : null}

      {installing ? (
        <div className="rounded-xl border border-line bg-white/[0.02] px-3 py-2.5">
          <div className="mb-1.5 flex items-center justify-between text-[12px] font-700">
            <span className="flex items-center gap-2 text-accent-3">
              <Loader2 className="h-4 w-4 animate-spin" />
              {pct == null ? "Downloading…" : pct >= 100 ? "Opening installer…" : `Downloading… ${pct}%`}
            </span>
            {pct != null && pct < 100 ? <span className="tabular-nums text-ink-dim">{pct}%</span> : null}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-accent-sheen transition-[width]" style={{ width: `${pct ?? 8}%` }} />
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button onClick={runCheck} disabled={checking} className="btn btn-subtle h-11 flex-1 gap-2">
            <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} /> Check for updates
          </button>
          {check?.status === "update-available" ? (
            <button onClick={install} className="btn btn-primary h-11 flex-1 gap-2">
              <Download className="h-4 w-4" /> Update now
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** This device's connection: code, permanent key entry, and session controls. */
function ConnectionSection({ code, onSaveKey, onDisconnect, onForget }: SettingsProps) {
  const [key, setKey] = useState("");

  return (
    <section className="rounded-2xl border border-line bg-bg-900/60 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/[0.05]">
          <Smartphone className="h-4 w-4 text-ink-dim" />
        </span>
        <div>
          <div className="font-display text-base font-800">This connection</div>
          <div className="text-[11px] text-ink-faint">{deviceName()}</div>
        </div>
      </div>

      <div className="mb-3 flex items-center justify-between rounded-xl border border-line bg-white/[0.02] px-3 py-2.5">
        <span className="text-sm text-ink-dim">Connection code</span>
        <span className="inline-flex items-center gap-2 font-display tracking-[0.25em]">
          <KeyRound className="h-3.5 w-3.5 text-ink-faint" />
          {code || "—"}
        </span>
      </div>

      {/* Permanent key: enter it so the PC trusts this device with no prompt. */}
      <label className="mb-1.5 block text-[11px] font-700 uppercase tracking-wider text-ink-dim">
        Permanent key (optional)
      </label>
      <p className="mb-2 text-[12px] text-ink-faint">
        Enter the permanent key from the PC's Remote page to connect without waiting for approval.
      </p>
      <div className="mb-4 flex gap-2">
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Permanent key"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="input flex-1"
        />
        <button
          onClick={() => {
            const trimmed = key.trim();
            if (trimmed) onSaveKey(trimmed);
          }}
          disabled={!key.trim()}
          className="btn btn-primary h-10 px-4"
        >
          Save
        </button>
      </div>

      <div className="flex gap-2">
        <button onClick={onDisconnect} className="btn btn-subtle h-11 flex-1 gap-2">
          <Plug className="h-4 w-4" /> Disconnect
        </button>
        <button onClick={onForget} className="btn btn-ghost h-11 flex-1 gap-2 text-red">
          <Trash2 className="h-4 w-4" /> Forget this PC
        </button>
      </div>
    </section>
  );
}
