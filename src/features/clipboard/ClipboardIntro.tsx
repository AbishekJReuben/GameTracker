import { useState } from "react";
import { motion } from "motion/react";
import { Copy, ArrowLeftRight, ClipboardPaste, Lock, X, Sparkles } from "lucide-react";
import { clip } from "@/lib/clip";
import { clipSync } from "@/lib/clipboardSync";
import { Toggle } from "@/components/ui";

/** First-enable explainer + options. Turning it on only happens after this. */
export function ClipboardIntro({ onClose, onEnabled }: { onClose: () => void; onEnabled: () => void }) {
  const [overlay, setOverlay] = useState(true);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    try {
      await clip.configure(true, overlay, auto);
      await clipSync.restart();
      onEnabled();
      onClose();
    } finally {
      setBusy(false);
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
            Shared clipboard
          </span>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-ink-dim hover:bg-white/10 hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="px-5 pt-2 text-sm text-ink-dim">
          A floating widget and a permanent history that follow you across your PC and phone.
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

        <div className="flex justify-end gap-2 px-5 pb-5 pt-4">
          <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm">
            Not now
          </button>
          <motion.button whileTap={{ scale: 0.96 }} disabled={busy} onClick={enable} className="btn-primary px-5 py-2 text-sm disabled:opacity-50">
            {busy ? "Turning on…" : "Turn on"}
          </motion.button>
        </div>
      </motion.div>
    </div>
  );
}
