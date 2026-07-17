import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, Copy, Loader2, RotateCcw, Wrench } from "lucide-react";
import type { ConnectDetail, ConnectPhase, ConnectSnapshot } from "./cloud";
import { formatConnectDiag } from "./cloud";
import { resetStreamTune } from "./streamTune";

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

/** How long the current stage may run before the diagnostics auto-expand. */
const STALL_HINT_MS = 6000;

const AUTH_LABEL: Record<ConnectDetail["authState"], string> = {
  none: "not sent",
  sent: "sent, no reply",
  pending: "PC prompt open",
  ok: "authorized",
  denied: "denied",
};

function fmtAge(ms: number): string {
  if (ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function DiagRow({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-ink-faint">{k}</span>
      <span className={`truncate text-right font-600 tabular-nums ${warn ? "text-amber" : "text-ink-soft"}`}>{v}</span>
    </div>
  );
}

/**
 * Live low-level connection diagnostics — the REAL states behind "Peer
 * connection" / "Device authorization", so a stuck stage shows exactly which
 * layer is wedged (signaling socket vs ICE vs data channels vs auth handshake).
 * Collapsed by default; auto-expands once the current stage has stalled.
 */
function DiagPanel({
  snapshot,
  copied,
  onCopy,
}: {
  snapshot: ConnectSnapshot;
  copied: boolean;
  onCopy: () => void;
}) {
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const d = snapshot.detail;
  if (!d) return null;
  const stalled = snapshot.phase !== "connected" && snapshot.phase !== "pending_approval" && d.phaseMs > STALL_HINT_MS;
  const open = userToggle ?? stalled;
  return (
    <div className="mt-3">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setUserToggle(!open)}
          className="flex min-w-0 flex-1 items-center justify-between rounded-lg px-1 py-1 text-[11px] font-700 text-ink-faint"
        >
          <span className="flex items-center gap-1.5">
            <Wrench className="h-3 w-3" /> Diagnostics
            {stalled && !open && <span className="rounded bg-amber/20 px-1 py-0.5 text-[9px] text-amber">stalling</span>}
          </span>
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={onCopy}
          title="Copy connection log (phases, ICE, auth, history)"
          className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[9px] font-800 ${
            copied ? "bg-green/25 text-green" : "bg-white/[0.08] text-ink-dim"
          }`}
        >
          <Copy className="h-3 w-3" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {open && (
        <div className="mt-1 space-y-1 rounded-xl border border-line bg-white/[0.03] px-2.5 py-2 text-[10px] leading-snug">
          <DiagRow k="Stage" v={`${snapshot.phase} · ${fmtAge(d.phaseMs)}`} warn={stalled} />
          <DiagRow k="Signaling" v={d.sig} warn={d.sig !== "open"} />
          <DiagRow k="Peer / ICE" v={`${d.pc} · ${d.ice}`} warn={d.pc !== "connected" && d.phaseMs > STALL_HINT_MS} />
          <DiagRow k="SDP / gather" v={`${d.sdp} · ${d.gather}`} />
          <DiagRow
            k="Channels c·d·v"
            v={`${d.chCtl} · ${d.chData} · ${d.chVid}`}
            warn={d.pc === "connected" && d.chCtl !== "open"}
          />
          <DiagRow k="Offers / cand ↓" v={`${d.offers} / ${d.candIn}`} warn={d.offers === 0 && d.phaseMs > STALL_HINT_MS} />
          <DiagRow
            k="Auth"
            v={`${AUTH_LABEL[d.authState]}${d.authSent > 0 ? ` · ×${d.authSent} (${fmtAge(d.authAgeMs)} ago)` : ""}`}
            warn={d.authState === "sent" && d.authAgeMs > 5000}
          />
          <DiagRow k="Permanent key" v={d.hasSecret ? "saved" : "none"} />
          {d.sid && <DiagRow k="Session" v={d.sid} />}
          <DiagRow k="Last event" v={`${d.lastEvent} · ${fmtAge(d.lastEventAgoMs)} ago`} />
          {(snapshot.history?.length ?? 0) > 0 && (
            <DiagRow k="History" v={`${snapshot.history.length} steps (in Copy)`} />
          )}
        </div>
      )}
    </div>
  );
}

export function ConnectionProgress({
  snapshot,
  compact = false,
  showSteps = true,
  onResetDefaults,
}: {
  snapshot: ConnectSnapshot;
  compact?: boolean;
  showSteps?: boolean;
  /** Wipe experimental stream tune + optional reconnect (stuck connect recovery). */
  onResetDefaults?: () => void;
}) {
  const [countdown, setCountdown] = useState(snapshot.backoffMs);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCountdown(snapshot.backoffMs);
    if (snapshot.phase !== "reconnecting" || snapshot.backoffMs <= 0) return;
    const id = window.setInterval(() => {
      setCountdown((ms) => Math.max(0, ms - 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [snapshot.phase, snapshot.backoffMs, snapshot.attempt]);

  const showApproval = snapshot.phase === "pending_approval";
  const stalled =
    snapshot.phase !== "connected" &&
    snapshot.phase !== "pending_approval" &&
    (snapshot.detail?.phaseMs ?? 0) > STALL_HINT_MS;
  const handleReset = () => {
    resetStreamTune();
    onResetDefaults?.();
  };
  const handleCopy = () => {
    void copyText(formatConnectDiag(snapshot)).then((ok) => {
      setCopied(ok);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

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
        {/* One-line live diagnostics once the current stage is stalling. */}
        {snapshot.detail && snapshot.phase !== "connected" && snapshot.detail.phaseMs > STALL_HINT_MS && (
          <div className="pt-0.5 text-[9px] tabular-nums text-white/50">
            sig:{snapshot.detail.sig} · pc:{snapshot.detail.pc} · ice:{snapshot.detail.ice} · auth:
            {snapshot.detail.authState}
            {snapshot.detail.authSent > 1 ? `×${snapshot.detail.authSent}` : ""} · {fmtAge(snapshot.detail.phaseMs)}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={handleCopy}
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-700 ${
              copied ? "bg-emerald-500/30 text-emerald-100" : "bg-white/10 text-white/90"
            }`}
          >
            <Copy className="h-3 w-3" />
            {copied ? "Copied" : "Copy connect log"}
          </button>
          {stalled && (
            <button
              type="button"
              onClick={handleReset}
              className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-700 text-white/90"
            >
              <RotateCcw className="h-3 w-3" /> Reset stream defaults
            </button>
          )}
        </div>
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
        <span className="min-w-0 flex-1 font-600 text-ink-soft">{snapshot.job}</span>
        <button
          type="button"
          onClick={handleCopy}
          title="Copy connection log (phases, ICE, auth, history)"
          className={`flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] font-800 ${
            copied ? "bg-green/25 text-green" : "bg-white/[0.06] text-ink-dim"
          }`}
        >
          <Copy className="h-3 w-3" />
          {copied ? "Copied" : "Copy log"}
        </button>
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
            // Under the ACTIVE step, surface what that stage is really doing —
            // "Peer connection" shows pc/ICE, "Device authorization" the handshake.
            const d = snapshot.detail;
            let sub: string | null = null;
            if (st === "active" && d && snapshot.phase !== "connected") {
              if (step.id === "negotiating") sub = `pc ${d.pc} · ice ${d.ice} · ${d.candIn} cand · ${fmtAge(d.phaseMs)}`;
              else if (step.id === "authenticating")
                sub = `${AUTH_LABEL[d.authState]}${d.authSent > 0 ? ` · asked ×${d.authSent}` : ""} · ${fmtAge(d.phaseMs)}`;
              else if (step.id === "signaling") sub = `socket ${d.sig} · ${fmtAge(d.phaseMs)}`;
              else if (step.id === "waiting_offer") sub = `${d.offers} offers · socket ${d.sig} · ${fmtAge(d.phaseMs)}`;
            }
            return (
              <li key={step.id} className="flex items-start gap-2.5 text-sm">
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
                <span className="min-w-0">
                  <span className={st === "pending" ? "text-ink-faint" : "text-ink-soft"}>{step.label}</span>
                  {sub && <span className="block truncate text-[10px] tabular-nums text-ink-faint">{sub}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <DiagPanel snapshot={snapshot} copied={copied} onCopy={handleCopy} />

      {stalled && (
        <button
          type="button"
          onClick={handleReset}
          className="btn btn-subtle mt-3 flex h-10 w-full items-center justify-center gap-2 text-xs"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset stream defaults &amp; retry
        </button>
      )}
    </div>
  );
}
