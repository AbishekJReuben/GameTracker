import { useState } from "react";
import { Smartphone, ShieldCheck, Clock, X, ChevronLeft } from "lucide-react";
import { Modal } from "@/components/Modal";
import { useRemoteHost } from "@/store/remote";

/**
 * App-wide approval prompt for an untrusted phone trying to connect over the
 * remote link. Shown the moment a device without the secret key / prior trust
 * asks in — the host holds the stream until the user decides here. Three paths:
 *   - Temporary: pick a duration; grant expires when it elapses.
 *   - Permanent: confirm, then the device is remembered across restarts.
 *   - Cancel: deny the connection.
 */

const TEMP_PRESETS = [
  { label: "15 min", secs: 15 * 60 },
  { label: "1 hour", secs: 60 * 60 },
  { label: "4 hours", secs: 4 * 60 * 60 },
  { label: "8 hours", secs: 8 * 60 * 60 },
];

type Step = "choose" | "temporary" | "permanent";

export function RemoteApprovalModal() {
  const pending = useRemoteHost((s) => s.pendingApproval);
  const resolveApproval = useRemoteHost((s) => s.resolveApproval);
  const [step, setStep] = useState<Step>("choose");
  const [customMin, setCustomMin] = useState("");

  const open = !!pending;
  const name = pending?.request.name || "A phone";

  const close = () => {
    resolveApproval({ kind: "deny" });
    setStep("choose");
    setCustomMin("");
  };
  const grantTemporary = (secs: number) => {
    if (secs <= 0) return;
    resolveApproval({ kind: "temporary", durationSecs: secs });
    setStep("choose");
    setCustomMin("");
  };
  const grantPermanent = () => {
    resolveApproval({ kind: "permanent" });
    setStep("choose");
  };

  return (
    <Modal open={open} onClose={close} className="max-w-md">
      <div className="p-5">
        <div className="mb-4 flex items-center gap-3">
          <span className="grid h-11 w-11 flex-none place-items-center rounded-2xl bg-accent-sheen shadow-glow">
            <Smartphone className="h-5 w-5 text-white" />
          </span>
          <div className="min-w-0">
            <div className="font-display text-lg font-800">Allow remote access?</div>
            <div className="truncate text-sm text-ink-dim">
              <b className="text-ink">{name}</b> wants to view and control this PC.
            </div>
          </div>
        </div>

        {step === "choose" && (
          <div className="flex flex-col gap-2">
            <button onClick={() => setStep("temporary")} className="btn btn-subtle h-12 justify-start gap-3 px-4">
              <Clock className="h-5 w-5 text-accent-3" />
              <span className="flex flex-col items-start">
                <span className="text-sm font-700">Temporary access</span>
                <span className="text-[11px] text-ink-faint">Allow for a set time, then it expires</span>
              </span>
            </button>
            <button onClick={() => setStep("permanent")} className="btn btn-subtle h-12 justify-start gap-3 px-4">
              <ShieldCheck className="h-5 w-5 text-green" />
              <span className="flex flex-col items-start">
                <span className="text-sm font-700">Permanent access</span>
                <span className="text-[11px] text-ink-faint">Remember this device — no prompt next time</span>
              </span>
            </button>
            <button onClick={close} className="btn btn-ghost mt-1 h-11 gap-2 text-ink-dim">
              <X className="h-4 w-4" /> Cancel
            </button>
          </div>
        )}

        {step === "temporary" && (
          <div>
            <button onClick={() => setStep("choose")} className="mb-3 flex items-center gap-1 text-xs font-700 text-ink-dim hover:text-ink">
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </button>
            <div className="mb-2 text-[11px] font-700 uppercase tracking-wider text-ink-dim">Grant access for</div>
            <div className="grid grid-cols-2 gap-2">
              {TEMP_PRESETS.map((p) => (
                <button key={p.secs} onClick={() => grantTemporary(p.secs)} className="btn btn-subtle h-11 text-sm font-700">
                  {p.label}
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input
                type="number"
                min={1}
                inputMode="numeric"
                placeholder="Custom minutes"
                value={customMin}
                onChange={(e) => setCustomMin(e.target.value.replace(/[^0-9]/g, ""))}
                className="input flex-1"
              />
              <button
                onClick={() => grantTemporary(Math.max(0, parseInt(customMin || "0", 10)) * 60)}
                disabled={!customMin || parseInt(customMin, 10) <= 0}
                className="btn btn-primary h-10 px-4"
              >
                Grant
              </button>
            </div>
          </div>
        )}

        {step === "permanent" && (
          <div>
            <button onClick={() => setStep("choose")} className="mb-3 flex items-center gap-1 text-xs font-700 text-ink-dim hover:text-ink">
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </button>
            <div className="rounded-xl border border-amber/40 bg-amber/10 px-3 py-2.5 text-sm text-amber">
              <b>{name}</b> will be able to connect and control this PC <b>any time</b>, with no further
              prompts, until you revoke it on the Remote page.
            </div>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setStep("choose")} className="btn btn-ghost h-11 flex-1 text-ink-dim">
                Back
              </button>
              <button onClick={grantPermanent} className="btn btn-primary h-11 flex-1 gap-2">
                <ShieldCheck className="h-4 w-4" /> Allow permanently
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
