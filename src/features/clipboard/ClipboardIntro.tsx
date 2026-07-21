import { useState } from "react";
import { motion } from "motion/react";
import { Copy, ArrowLeftRight, ClipboardPaste, Lock, X, Sparkles, ClipboardList } from "lucide-react";
import { clip } from "@/lib/clip";
import { clipSync } from "@/lib/clipboardSync";
import { Toggle } from "@/components/ui";

/** Build a single diagnostics report (Rust runtime log + JS sync state). */
async function buildClipReport(): Promise<string> {
  const lines: string[] = [];
  lines.push("=== GameTracker shared-clipboard diagnostics ===");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`App: ${typeof window !== "undefined" ? window.location.href : "(no window)"}`);
  lines.push("");
  lines.push("--- Rust runtime log (watcher + overlay window + apply_settings) ---");
  try {
    const rust = await clip.diagnostics();
    if (rust.length === 0) lines.push("(empty — feature was never toggled on this session)");
    else lines.push(...rust);
  } catch (e) {
    lines.push(`(failed to read Rust log: ${e instanceof Error ? e.message : String(e)})`);
  }
  lines.push("");
  lines.push("--- Sync engine state (webview) ---");
  for (const [k, v] of Object.entries(clipSync.diagnostics())) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("");
  lines.push("--- Local settings ---");
  try {
    const s = await clip.list().catch(() => []);
    lines.push(`local items: ${Array.isArray(s) ? s.length : "?"}`);
  } catch {
    /* ignore */
  }
  return lines.join("\n");
}

/** First-enable explainer + options. Turning it on only happens after this. */
export function ClipboardIntro({ onClose, onEnabled }: { onClose: () => void; onEnabled: () => void }) {
  const [overlay, setOverlay] = useState(true);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      // Safety: clip.configure is async + deferred now (no more main-thread
      // deadlock), but a misconfigured window could still hang. Race against a
      // 6s deadline so the user sees a real error instead of an infinite spinner.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out — the overlay window didn't open in 6s.")), 6000),
      );
      await Promise.race([clip.configure(true, overlay, auto), timeout]);
      await clipSync.restart();
      onEnabled();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const copyLogs = async () => {
    const report = await buildClipReport();
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: open a small window with the text (webview clipboard can fail
      // without a user gesture — this is a deliberate click, but be safe).
      setError("Couldn't copy automatically — check console.");
      console.log(report);
    }
  };

  const steps = [
    { icon: <Copy className="h-4 w-4" />, label: "Copy anything", sub: "text or an image, on any device" },
    { icon: <ArrowLeftRight className="h-4 w-4" />, label: "It syncs", sub: "encrypted, in a few seconds" },
    { icon: <ClipboardPaste className="h-4 w-4" />, label: "Paste anywhere", sub: "on your PC or phone" },
  ];

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/50 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 340, damping: 28 }}
        className="glass w-full max-w-md overflow-hidden rounded-3xl border border-white/12 shadow-float"
      >
        <div className="flex items-center justify-between px-5 pt-5">
          <span className="flex items-center gap-2 text-base font-800 text-ink">
            <span
              className="grid h-8 w-8 place-items-center rounded-xl text-white"
              style={{ backgroundImage: "linear-gradient(135deg,var(--accent-1),var(--accent-3))" }}
            >
              <Sparkles className="h-4 w-4" />
            </span>
            Synced notes
          </span>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-ink-dim hover:bg-white/10 hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="px-5 pt-2 text-sm text-ink-dim">
          A notes + clipboard hub with a floating widget: editable notes, folders, and a permanent
          history that follow you across your PC and phone.
        </p>

        <div className="mt-4 grid grid-cols-3 gap-2 px-5">
          {steps.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 * i }}
              className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-3 text-center"
            >
              <div className="mx-auto grid h-9 w-9 place-items-center rounded-xl bg-white/[0.05] text-accent-3">{s.icon}</div>
              <div className="mt-2 text-xs font-700 text-ink">{s.label}</div>
              <div className="text-[10px] text-ink-faint">{s.sub}</div>
            </motion.div>
          ))}
        </div>

        <div className="mx-5 mt-4 flex items-start gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          <p className="text-[11px] leading-relaxed text-ink-dim">
            End-to-end encrypted with your device key — the sync server only ever stores unreadable ciphertext.
          </p>
        </div>

        <div className="mt-4 space-y-1 px-5">
          <label className="flex items-center justify-between rounded-xl px-1 py-2">
            <span className="text-sm text-ink-soft">
              Floating widget
              <span className="block text-[11px] text-ink-faint">A draggable bubble on top of everything.</span>
            </span>
            <Toggle checked={overlay} onChange={setOverlay} />
          </label>
          <label className="flex items-center justify-between rounded-xl px-1 py-2">
            <span className="text-sm text-ink-soft">
              Auto-capture copies
              <span className="block text-[11px] text-ink-faint">Save everything you copy on this PC automatically.</span>
            </span>
            <Toggle checked={auto} onChange={setAuto} />
          </label>
        </div>

        {error && (
          <div className="mx-5 mt-3 rounded-xl border border-rose-500/30 bg-rose-500/[0.08] px-3 py-2.5 text-[12px] leading-relaxed text-rose-200">
            <div className="mb-1 font-700">Couldn't turn on synced notes</div>
            <div className="break-words text-rose-300/90">{error}</div>
            <div className="mt-1 text-rose-300/70">
              Tap "Copy logs" and share the report — it captures the watcher, the overlay window, and the sync engine.
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 px-5 pb-5 pt-4">
          <button
            type="button"
            onClick={copyLogs}
            className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs font-600 text-ink-dim transition hover:bg-white/10 hover:text-ink"
            title="Copy a diagnostics report for debugging"
          >
            {copied ? (
              <>
                <ClipboardList className="h-3.5 w-3.5 text-emerald-400" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" /> Copy logs
              </>
            )}
          </button>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm">
              {error ? "Close" : "Not now"}
            </button>
            <motion.button whileTap={{ scale: 0.96 }} disabled={busy} onClick={enable} className="btn-primary px-5 py-2 text-sm disabled:opacity-50">
              {busy ? "Turning on…" : error ? "Try again" : "Turn on"}
            </motion.button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
