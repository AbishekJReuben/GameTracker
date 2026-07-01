import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  Smartphone,
  Wifi,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Radio,
  Copy,
  Check,
  Download,
} from "lucide-react";
import { Page } from "@/components/Page";
import { Panel } from "@/components/Panel";
import { SectionTitle, Toggle, Skeleton } from "@/components/ui";
import { api, RemoteStatus } from "@/lib/api";
import { useApp } from "@/store/app";

export default function RemotePage() {
  const pushToast = useApp((s) => s.pushToast);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.remoteStatus());
    } catch {
      /* ignore transient poll errors */
    }
  }, []);

  useEffect(() => {
    refresh();
    // Poll while the page is open so the connected-device count stays live.
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      setStatus(await api.remoteSetEnabled(enabled));
      pushToast({
        kind: "success",
        title: enabled ? "Remote access on" : "Remote access off",
      });
    } catch (e) {
      pushToast({ kind: "info", title: "Couldn't change remote access", message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const regen = async () => {
    setBusy(true);
    try {
      setStatus(await api.remoteRegenPin());
      pushToast({ kind: "success", title: "New pairing PIN generated" });
    } catch (e) {
      pushToast({ kind: "info", title: "Couldn't regenerate PIN", message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const on = status?.enabled ?? false;
  const address = status?.host ? `${status.host}:${status.port}` : null;

  return (
    <Page
      title="Remote"
      subtitle="Control this PC and see your stats from the companion phone app"
    >
      {!status ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <Panel panelKey="remote.toggle" className="mb-5 p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <span
                  className="grid h-12 w-12 place-items-center rounded-2xl"
                  style={{
                    background: on
                      ? "color-mix(in srgb, var(--accent-1) 22%, transparent)"
                      : "rgba(255,255,255,0.05)",
                    color: on ? "var(--accent-1)" : "var(--ink-dim)",
                  }}
                >
                  <Smartphone className="h-6 w-6" />
                </span>
                <div>
                  <div className="font-display text-lg font-800">Remote access</div>
                  <div className="flex items-center gap-2 text-sm text-ink-dim">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{
                        background: status.running ? "#34d399" : "#64748b",
                        boxShadow: status.running ? "0 0 10px #34d399" : undefined,
                      }}
                    />
                    {status.running ? "Server running" : on ? "Starting…" : "Off"}
                    {status.running && (
                      <>
                        {" · "}
                        <Radio className="h-3.5 w-3.5" /> {status.clients} device
                        {status.clients === 1 ? "" : "s"} connected
                      </>
                    )}
                  </div>
                </div>
              </div>
              <Toggle checked={on} onChange={(v) => !busy && toggle(v)} label={on ? "On" : "Off"} />
            </div>
          </Panel>

          {on && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="grid grid-cols-1 gap-5 lg:grid-cols-2"
            >
              <Panel panelKey="remote.connect" className="p-5">
                <SectionTitle title="Connect your phone" subtitle="Enter these in the companion app" right={<Wifi className="h-4 w-4" />} />
                <div className="mt-4 space-y-4">
                  <Field
                    label="Address"
                    icon={<Wifi className="h-4 w-4" />}
                    value={address ?? "No network address found"}
                    canCopy={!!address}
                    mono
                  />
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">
                      <KeyRound className="h-3.5 w-3.5" /> Pairing PIN
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="font-display text-4xl font-800 tabular-nums tracking-[0.3em] accent-text">
                        {status.pin}
                      </div>
                      <button onClick={regen} disabled={busy} className="btn btn-ghost h-9" title="Generate a new PIN">
                        <RefreshCw className="h-4 w-4" /> New PIN
                      </button>
                    </div>
                    <p className="mt-1.5 text-xs text-ink-faint">
                      Generating a new PIN disconnects devices paired with the old one.
                    </p>
                  </div>
                </div>
              </Panel>

              <Panel panelKey="remote.setup" className="p-5">
                <SectionTitle title="How to connect" subtitle="One-time setup" right={<ShieldCheck className="h-4 w-4" />} />
                <ol className="mt-4 space-y-3">
                  <Step n={1}>
                    Install <b>Tailscale</b> on this PC and your phone, sign into both with the same
                    account. This creates a private, encrypted link so you can connect from anywhere —
                    no ports to open.
                  </Step>
                  <Step n={2}>
                    Install the <b>GameTracker companion</b> app on your Android phone
                    <span className="ml-1 inline-flex items-center gap-1 text-ink-faint">
                      <Download className="h-3.5 w-3.5" /> (APK — coming with this feature)
                    </span>
                    .
                  </Step>
                  <Step n={3}>
                    Open the companion app, enter the <b>address</b> and <b>PIN</b> shown here, and pair.
                  </Step>
                  <Step n={4}>
                    You'll see all your stats live, and can control this PC's screen once that phase
                    ships.
                  </Step>
                </ol>
              </Panel>
            </motion.div>
          )}

          {!on && (
            <Panel panelKey="remote.info" className="p-5">
              <SectionTitle title="What is this?" subtitle="Your PC, on your phone" />
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
                Turn this on to run a small, secure server on this PC that the GameTracker phone app
                connects to. You'll be able to browse all your play stats, music, and timeline from
                your phone — and remotely control the PC's screen — from home or anywhere, over an
                encrypted Tailscale link. Everything stays on your own devices; nothing is sent to a
                third-party server.
              </p>
            </Panel>
          )}
        </>
      )}
    </Page>
  );
}

function Field({
  label,
  icon,
  value,
  canCopy,
  mono,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  canCopy?: boolean;
  mono?: boolean;
}) {
  const pushToast = useApp((s) => s.pushToast);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      pushToast({ kind: "success", title: "Copied" });
    } catch {
      /* clipboard may be unavailable */
    }
  };
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">
        {icon} {label}
      </div>
      <div className="flex items-center gap-2">
        <div
          className={`flex-1 rounded-xl border border-line bg-white/[0.03] px-3 py-2.5 text-sm ${mono ? "font-mono tabular-nums" : ""}`}
        >
          {value}
        </div>
        {canCopy && (
          <button onClick={copy} className="btn btn-ghost h-10" title="Copy">
            {copied ? <Check className="h-4 w-4 text-green" /> : <Copy className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-sheen text-xs font-800 text-white">
        {n}
      </span>
      <span className="text-sm leading-relaxed text-ink-soft">{children}</span>
    </li>
  );
}
