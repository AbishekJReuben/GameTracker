import { useCallback, useEffect, useRef, useState } from "react";
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
  Globe,
} from "lucide-react";
import { Page } from "@/components/Page";
import { Panel } from "@/components/Panel";
import { SectionTitle, Toggle, Skeleton } from "@/components/ui";
import { api, RemoteStatus } from "@/lib/api";
import { DEFAULT_SIGNAL_URL, SIGNAL_PORT } from "@/lib/remoteConfig";
import { useApp } from "@/store/app";
import { useRemoteHost } from "@/store/remote";

export default function RemotePage() {
  const pushToast = useApp((s) => s.pushToast);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [signalDraft, setSignalDraft] = useState(DEFAULT_SIGNAL_URL);
  // The WebRTC host now runs app-wide (see RemoteHostManager) so the phone can
  // connect no matter which page is open; we just read its live client count.
  const cloudClients = useRemoteHost((s) => s.cloudClients);
  // Keep the latest signaling URL from the backend without clobbering the user's
  // in-progress edit (only seed the draft once, when it's still empty).
  const seededSignal = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api.remoteStatus();
      setStatus(s);
      if (!seededSignal.current && s.signalUrl) {
        setSignalDraft(s.signalUrl);
        seededSignal.current = true;
      }
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

  const cloudOn = status?.cloudEnabled ?? false;

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

  const setCloud = async (enabled: boolean) => {
    if (enabled && !signalDraft.trim()) {
      pushToast({ kind: "info", title: "Enter a signaling server first" });
      return;
    }
    setBusy(true);
    try {
      setStatus(await api.remoteSetCloud(enabled, signalDraft.trim()));
      pushToast({
        kind: "success",
        title: enabled ? "Cloud access on" : "Cloud access off",
      });
    } catch (e) {
      pushToast({ kind: "info", title: "Couldn't change cloud access", message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const saveSignal = async () => {
    setBusy(true);
    try {
      setStatus(await api.remoteSetCloud(status?.cloudEnabled ?? false, signalDraft.trim()));
      pushToast({ kind: "success", title: "Signaling server saved" });
    } catch (e) {
      pushToast({ kind: "info", title: "Couldn't save signaling server", message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const regenCode = async () => {
    setBusy(true);
    try {
      setStatus(await api.remoteRegenCode());
      pushToast({ kind: "success", title: "New connection code generated" });
    } catch (e) {
      pushToast({ kind: "info", title: "Couldn't regenerate code", message: String(e) });
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
              className="mb-5"
            >
              <Panel panelKey="remote.cloud" className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <SectionTitle
                    title="From anywhere (cloud)"
                    subtitle="Connect over the internet — no Tailscale needed"
                    right={<Globe className="h-4 w-4" />}
                  />
                  <div className="flex items-center gap-3">
                    {cloudOn && (
                      <span className="flex items-center gap-1.5 text-sm text-ink-dim">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{
                            background: cloudClients > 0 ? "#34d399" : "#64748b",
                            boxShadow: cloudClients > 0 ? "0 0 10px #34d399" : undefined,
                          }}
                        />
                        {cloudClients > 0 ? "Phone connected" : "Waiting for phone"}
                      </span>
                    )}
                    <Toggle
                      checked={cloudOn}
                      onChange={(v) => !busy && setCloud(v)}
                      label={cloudOn ? "On" : "Off"}
                    />
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">
                      <Globe className="h-3.5 w-3.5" /> Signaling server
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        className="flex-1 rounded-xl border border-line bg-white/[0.03] px-3 py-2.5 font-mono text-sm outline-none focus:border-accent-1/60"
                        placeholder="wss://discovery.chilloutgamestudio.com"
                        spellCheck={false}
                        autoCapitalize="none"
                        autoCorrect="off"
                        value={signalDraft}
                        onChange={(e) => setSignalDraft(e.target.value)}
                      />
                      <button
                        onClick={saveSignal}
                        disabled={busy || signalDraft.trim() === (status?.signalUrl ?? "")}
                        className="btn btn-ghost h-10"
                        title="Save signaling server"
                      >
                        <Check className="h-4 w-4" /> Save
                      </button>
                    </div>
                    <p className="mt-1.5 text-xs text-ink-faint">
                      Pre-filled with the default. It only brokers the handshake — screen and
                      control then flow directly peer-to-peer. Run it on this PC and expose it with a
                      Cloudflare Tunnel to <span className="font-mono">localhost:{SIGNAL_PORT}</span>.
                    </p>
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">
                      <KeyRound className="h-3.5 w-3.5" /> Connection code
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="font-display text-3xl font-800 uppercase tracking-[0.3em] accent-text">
                        {status.code || "—"}
                      </div>
                      <button onClick={regenCode} disabled={busy} className="btn btn-ghost h-9" title="Generate a new code">
                        <RefreshCw className="h-4 w-4" /> New code
                      </button>
                    </div>
                    <p className="mt-1.5 text-xs text-ink-faint">
                      Enter this in the companion app under “From anywhere.” A new code disconnects the
                      old session.
                    </p>
                  </div>
                </div>
              </Panel>
            </motion.div>
          )}

          {on && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <Panel panelKey="remote.setup" className="p-5">
                <SectionTitle title="How to connect" subtitle="One-time setup — the app remembers it afterwards" right={<ShieldCheck className="h-4 w-4" />} />
                <ol className="mt-4 space-y-3">
                  <Step n={1}>
                    Install the <b>GameTracker companion</b> app on your Android phone
                    <span className="ml-1 inline-flex items-center gap-1 text-ink-faint">
                      <Download className="h-3.5 w-3.5" /> (build the APK — see companion/README.md)
                    </span>
                    .
                  </Step>
                  <Step n={2}>
                    <b>One-time host setup:</b> run the signaling server on this PC and point a
                    <b> Cloudflare Tunnel</b> at <span className="font-mono">localhost:{SIGNAL_PORT}</span> for
                    <span className="font-mono"> {DEFAULT_SIGNAL_URL.replace(/^wss:\/\//, "")}</span>. See
                    signaling/README.md for the exact commands.
                  </Step>
                  <Step n={3}>
                    Turn on <b>cloud access</b> above, then in the app enter the <b>connection code</b>
                    shown here (the signaling address is already baked in). Screen and control run
                    <b> directly peer-to-peer</b>.
                  </Step>
                  <Step n={4}>
                    That's it — the app <b>remembers the code</b> and reconnects automatically every time,
                    even after a PC restart. You won't need to enter it again.
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
                your phone — and remotely control the PC's screen — on the same network, or from
                anywhere via an encrypted peer-to-peer link. Everything stays on your own devices;
                nothing is stored on a third-party server.
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
