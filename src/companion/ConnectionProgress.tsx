import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { ConnectPhase, ConnectSnapshot } from "./cloud";

const STEPS: { id: ConnectPhase; label: string }[] = [
  { id: "signaling", label: "Signaling server" },
  { id: "waiting_offer", label: "PC online" },
  { id: "negotiating", label: "Peer connection" },
  { id: "authenticating", label: "Device authorization" },
  { id: "connected", label: "Connected" },
];

const PHASE_ORDER: ConnectPhase[] = [
  "idle",
  "signaling",
  "waiting_offer",
  "negotiating",
  "authenticating",
  "pending_approval",
  "connected",
  "reconnecting",
  "denied",
];

function phaseIndex(phase: ConnectPhase): number {
  const i = PHASE_ORDER.indexOf(phase);
  return i < 0 ? 0 : i;
}

function stepState(
  step: (typeof STEPS)[number],
  snapshot: ConnectSnapshot,
): "done" | "active" | "pending" {
  const cur = snapshot.phase;
  if (cur === "connected") return "done";
  if (cur === "denied") return step.id === "authenticating" ? "active" : "pending";
  if (cur === "reconnecting") {
    if (step.id === "signaling" || step.id === "waiting_offer") return "active";
    return "pending";
  }
  const curIdx = phaseIndex(cur === "pending_approval" ? "authenticating" : cur);
  const stepIdx = phaseIndex(step.id);
  if (curIdx > stepIdx) return "done";
  if (curIdx === stepIdx || (cur === "pending_approval" && step.id === "authenticating")) return "active";
  return "pending";
}

export function statusLabel(snapshot: ConnectSnapshot): string {
  if (snapshot.phase === "connected") return "Live";
  if (snapshot.phase === "pending_approval") return "Awaiting approval";
  if (snapshot.phase === "reconnecting") return "Reconnecting";
  if (snapshot.phase === "negotiating") return "Negotiating";
  if (snapshot.phase === "authenticating") return "Authorizing";
  if (snapshot.phase === "waiting_offer") return "Waiting for PC";
  if (snapshot.phase === "signaling") return "Connecting";
  if (snapshot.phase === "denied") return "Denied";
  return "Connecting";
}

export function ConnectionProgress({
  snapshot,
  compact = false,
  showSteps = true,
}: {
  snapshot: ConnectSnapshot;
  compact?: boolean;
  showSteps?: boolean;
}) {
  const [countdown, setCountdown] = useState(snapshot.backoffMs);

  useEffect(() => {
    setCountdown(snapshot.backoffMs);
    if (snapshot.phase !== "reconnecting" || snapshot.backoffMs <= 0) return;
    const id = window.setInterval(() => {
      setCountdown((ms) => Math.max(0, ms - 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [snapshot.phase, snapshot.backoffMs, snapshot.attempt]);

  const showApproval = snapshot.phase === "pending_approval";

  if (compact) {
    return (
      <div className="flex max-w-[min(100%,20rem)] flex-col items-center gap-2 rounded-2xl bg-black/65 px-4 py-3 text-center text-white backdrop-blur">
        <div className="flex items-center gap-2 text-sm font-600">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          <span>{snapshot.job}</span>
        </div>
        {snapshot.phase === "reconnecting" && snapshot.attempt > 0 && (
          <div className="text-[11px] text-white/70">
            Attempt {snapshot.attempt}
            {countdown > 0 ? ` · retry in ${Math.ceil(countdown / 1000)}s` : ""}
          </div>
        )}
        {showSteps && (
          <div className="flex flex-wrap justify-center gap-1.5 pt-0.5">
            {STEPS.slice(0, -1).map((step) => {
              const st = stepState(step, snapshot);
              return (
                <span
                  key={step.id}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-700 ${
                    st === "done"
                      ? "bg-emerald-500/30 text-emerald-200"
                      : st === "active"
                        ? "bg-white/20 text-white"
                        : "bg-white/5 text-white/40"
                  }`}
                >
                  {step.label}
                </span>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full text-left">
      <div className="flex items-center gap-2 text-sm text-ink-dim">
        {snapshot.phase === "connected" ? (
          <Check className="h-4 w-4 text-emerald-400" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-accent-3" />
        )}
        <span className="font-600 text-ink-soft">{snapshot.job}</span>
      </div>

      {snapshot.phase === "reconnecting" && snapshot.attempt > 0 && (
        <p className="mt-1.5 text-xs text-ink-faint">
          Attempt {snapshot.attempt}
          {countdown > 0 ? ` · retrying in ${Math.ceil(countdown / 1000)}s` : " · retrying now…"}
        </p>
      )}

      {showApproval && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-accent-3/40 bg-accent-3/10 px-3 py-2.5 text-sm text-accent-3">
          <Loader2 className="h-4 w-4 animate-spin" /> Waiting for approval on your PC…
        </div>
      )}

      {showSteps && (
        <ol className="mt-4 space-y-2">
          {STEPS.map((step) => {
            const st = stepState(step, snapshot);
            return (
              <li key={step.id} className="flex items-center gap-2.5 text-sm">
                <span
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${
                    st === "done"
                      ? "bg-emerald-500/20 text-emerald-400"
                      : st === "active"
                        ? "bg-accent-3/20 text-accent-3"
                        : "bg-white/[0.04] text-ink-faint"
                  }`}
                >
                  {st === "done" ? (
                    <Check className="h-3 w-3" />
                  ) : st === "active" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />
                  )}
                </span>
                <span className={st === "pending" ? "text-ink-faint" : "text-ink-soft"}>{step.label}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
