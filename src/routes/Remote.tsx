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
  Activity,
  Gauge,
  Cpu,
  ArrowDownUp,
  Timer,
  Monitor,
  Type as TypeIcon,
  Clapperboard,
  Sparkles,
} from "lucide-react";
import { Eye, EyeOff, ExternalLink, DownloadCloud, Usb, Trash2, ShieldCheck as ShieldIcon, Clock, Loader2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Page } from "@/components/Page";
import { Panel } from "@/components/Panel";
import { SectionTitle, Toggle, Skeleton } from "@/components/ui";
import { api, RemoteStatus, RemoteGrants } from "@/lib/api";
import { DEFAULT_SIGNAL_URL, SIGNAL_PORT } from "@/lib/remoteConfig";
import { useApp } from "@/store/app";
import { useRemoteHost } from "@/store/remote";
import type { HostLiveStats } from "@/lib/rtcHost";

const RELEASES_URL = "https://github.com/AbishekJReuben/GameTracker/releases";

export default function RemotePage() {
  const pushToast = useApp((s) => s.pushToast);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [signalDraft, setSignalDraft] = useState(DEFAULT_SIGNAL_URL);
  // The WebRTC host now runs app-wide (see RemoteHostManager) so the phone can
  // connect no matter which page is open; we just read its live client count.
  const cloudClients = useRemoteHost((s) => s.cloudClients);
  const hostStats = useRemoteHost((s) => s.hostStats);
  const [showSecret, setShowSecret] = useState(false);
  const [grants, setGrants] = useState<RemoteGrants | null>(null);
  const [usbDevices, setUsbDevices] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
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
      // Grants (for the live countdown) + USB devices (for the install button).
      api.remoteListGrants().then(setGrants).catch(() => {});
      api.remoteAdbDevices().then(setUsbDevices).catch(() => setUsbDevices([]));
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

  const regenSecret = async () => {
    setBusy(true);
    try {
      setStatus(await api.remoteRegenSecret());
      pushToast({ kind: "success", title: "New permanent key generated" });
    } catch (e) {
      pushToast({ kind: "info", title: "Couldn't regenerate key", message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const revokeDevice = async (id: string) => {
    try {
      setGrants(await api.remoteRevoke(id));
      pushToast({ kind: "success", title: "Device revoked" });
    } catch (e) {
      pushToast({ kind: "info", title: "Couldn't revoke device", message: String(e) });
    }
  };

  const openReleases = () => {
    openUrl(RELEASES_URL).catch(() => {});
  };

  const installOnUsb = async () => {
    setInstalling(true);
    pushToast({ kind: "info", title: "Installing on phone…", message: "Downloading the latest APK" });
    try {
      const msg = await api.remoteAdbInstall();
      pushToast({ kind: "success", title: "Installed", message: msg });
    } catch (e) {
      pushToast({ kind: "info", title: "USB install failed", message: String(e) });
    } finally {
      setInstalling(false);
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
                    title="Connect from anywhere"
                    subtitle="Enter these on the phone — screen & control then flow peer-to-peer"
                    right={<Globe className="h-4 w-4" />}
                  />
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
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
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
                      Required to reach this PC. A device with only this code asks for your approval here.
                    </p>
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">
                      <ShieldIcon className="h-3.5 w-3.5" /> Permanent key
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="font-display text-3xl font-800 uppercase tracking-[0.3em] accent-text">
                        {showSecret ? status.secretCode || "—" : "••••••••"}
                      </div>
                      <button onClick={() => setShowSecret((v) => !v)} className="btn btn-ghost h-9 w-9 p-0" title={showSecret ? "Hide" : "Reveal"}>
                        {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                      <button onClick={regenSecret} disabled={busy} className="btn btn-ghost h-9" title="Generate a new key">
                        <RefreshCw className="h-4 w-4" /> New key
                      </button>
                    </div>
                    <p className="mt-1.5 text-xs text-ink-faint">
                      Optional. A phone that also enters this key is trusted <b>permanently</b> with no prompt.
                    </p>
                  </div>
                </div>

                <div className="mt-4 border-t border-line pt-4">
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
                    Pre-filled with the default. It only brokers the handshake — run it on this PC and expose
                    it with a Cloudflare Tunnel to <span className="font-mono">localhost:{SIGNAL_PORT}</span>.
                  </p>
                </div>
              </Panel>
            </motion.div>
          )}

          {on && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-5">
              <DevicesPanel grants={grants} onRevoke={revokeDevice} />
            </motion.div>
          )}

          {on && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-5">
              <Panel panelKey="remote.getapp" className="p-5">
                <SectionTitle title="Get the phone app" subtitle="Install the companion APK on your Android phone" right={<Download className="h-4 w-4" />} />
                <div className="mt-4 flex flex-wrap items-center gap-2.5">
                  <button onClick={openReleases} className="btn btn-subtle h-10 gap-2">
                    <ExternalLink className="h-4 w-4" /> Open releases page
                  </button>
                  <button onClick={installOnUsb} disabled={installing || usbDevices.length === 0} className="btn btn-primary h-10 gap-2">
                    {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
                    {installing ? "Installing…" : "Install on USB phone"}
                  </button>
                  <span className="flex items-center gap-1.5 text-xs text-ink-faint">
                    <Usb className="h-3.5 w-3.5" />
                    {usbDevices.length > 0
                      ? `${usbDevices.length} phone${usbDevices.length === 1 ? "" : "s"} connected via USB`
                      : "No USB phone (enable USB debugging)"}
                  </span>
                </div>
              </Panel>
            </motion.div>
          )}

          {on && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-5">
              <LiveSessionPanel stats={hostStats} connected={cloudClients > 0} />
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
                    Turn <b>Remote access</b> on above, then in the app enter the <b>connection code</b>
                    shown here (add the <b>permanent key</b> too to skip the approval prompt). Screen and
                    control run <b>directly peer-to-peer</b>.
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

const CONTENT_META = [
  { label: "Auto", icon: Sparkles, hint: "Balanced" },
  { label: "Text", icon: TypeIcon, hint: "Sharp · 4:4:4" },
  { label: "Video", icon: Clapperboard, hint: "Smooth · fast scale" },
] as const;

/** Live telemetry for the active peer-to-peer session, streamed from the host. */
function LiveSessionPanel({ stats, connected }: { stats: HostLiveStats | null; connected: boolean }) {
  const cap = stats?.capture ?? null;
  const cm = CONTENT_META[stats?.content ?? 0] ?? CONTENT_META[0];
  const kbps = stats?.sendKbps ?? 0;
  const bitrate = kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
  const frameKB = cap ? `${(cap.frameBytes / 1024).toFixed(0)} KB` : "—";
  const cpuMs = cap ? cap.captureMs + cap.scaleMs + cap.encodeMs : 0;

  // Plain-language read on where the pipeline is spending its time / where it's limited.
  const health = (() => {
    if (!connected || !stats) return { text: "Waiting for a phone to connect…", tone: "dim" as const };
    if (!cap || !cap.running) return { text: "Link up — starting capture…", tone: "dim" as const };
    if (cpuMs > 16 && stats.sendFps > 0 && stats.sendFps < cap.fps * 0.75) {
      const worst = cap.encodeMs >= cap.scaleMs && cap.encodeMs >= cap.captureMs ? "encode" : cap.scaleMs >= cap.captureMs ? "downscale" : "capture";
      return { text: `Host CPU-bound (${worst}). Lower resolution or sharpness on the phone.`, tone: "warn" as const };
    }
    if (stats.rttMs > 120) return { text: `High round-trip (${stats.rttMs} ms) — network latency dominates.`, tone: "warn" as const };
    return { text: "Pipeline healthy — streaming smoothly.", tone: "ok" as const };
  })();

  return (
    <Panel panelKey="remote.live" className="p-5">
      <SectionTitle
        title="Live session"
        subtitle={connected ? "Real-time capture & link telemetry" : "Shows here once a phone connects"}
        right={<Activity className="h-4 w-4" />}
      />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-700"
          style={{
            background: connected ? "color-mix(in srgb, #34d399 18%, transparent)" : "rgba(255,255,255,0.05)",
            color: connected ? "#34d399" : "var(--ink-dim)",
          }}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: connected ? "#34d399" : "#64748b", boxShadow: connected ? "0 0 8px #34d399" : undefined }} />
          {connected ? "Peer connected" : "Idle"}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/[0.03] px-2.5 py-1 text-xs font-700 text-ink-soft">
          <cm.icon className="h-3.5 w-3.5" /> {cm.label}
          <span className="text-ink-faint">· {cm.hint}</span>
        </span>
        {cap && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/[0.03] px-2.5 py-1 text-xs font-700 text-ink-soft">
            <Monitor className="h-3.5 w-3.5" /> {cap.nativeW}×{cap.nativeH} → {cap.outW}×{cap.outH}
          </span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        <Metric icon={<Gauge className="h-4 w-4" />} label="Encoder fps" value={stats ? `${stats.sendFps}` : "—"} sub={cap ? `target ${cap.fps}` : undefined} />
        <Metric
          icon={<ArrowDownUp className="h-4 w-4" />}
          label="Send bitrate"
          value={stats ? bitrate : "—"}
          sub={stats && stats.encoderMaxKbps > 0 ? `cap ${(stats.encoderMaxKbps / 1000).toFixed(1)} Mbps` : undefined}
        />
        <Metric icon={<Timer className="h-4 w-4" />} label="Round-trip" value={stats ? `${stats.rttMs} ms` : "—"} />
        <Metric icon={<Cpu className="h-4 w-4" />} label="Host CPU / frame" value={cap ? `${cpuMs.toFixed(1)} ms` : "—"} sub={cap ? `cap ${cap.captureMs.toFixed(0)} · scl ${cap.scaleMs.toFixed(0)} · enc ${cap.encodeMs.toFixed(0)}` : undefined} />
        <Metric icon={<Wifi className="h-4 w-4" />} label="Capture" value={cap ? `${cap.captureMs.toFixed(1)} ms` : "—"} />
        <Metric icon={<Sparkles className="h-4 w-4" />} label="Downscale" value={cap ? `${cap.scaleMs.toFixed(1)} ms` : "—"} />
        <Metric icon={<Activity className="h-4 w-4" />} label="Encode" value={cap ? `${cap.encodeMs.toFixed(1)} ms` : "—"} />
        <Metric icon={<Radio className="h-4 w-4" />} label="Frame size" value={frameKB} />
      </div>

      <div
        className="mt-4 rounded-xl px-3 py-2 text-xs font-600"
        style={{
          background:
            health.tone === "warn"
              ? "color-mix(in srgb, #f59e0b 12%, transparent)"
              : health.tone === "ok"
                ? "color-mix(in srgb, #34d399 10%, transparent)"
                : "rgba(255,255,255,0.03)",
          color: health.tone === "warn" ? "#f59e0b" : health.tone === "ok" ? "#34d399" : "var(--ink-dim)",
        }}
      >
        {health.text}
      </div>
    </Panel>
  );
}

function Metric({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-white/[0.02] p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-600 uppercase tracking-wide text-ink-dim">
        <span className="text-ink-soft">{icon}</span> {label}
      </div>
      <div className="mt-1 font-display text-xl font-800 tabular-nums text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-[10px] tabular-nums text-ink-faint">{sub}</div>}
    </div>
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

/** Human "time left" for a temporary grant (updated every ~2s by the page poll). */
function fmtRemaining(expiresUtc: string): string {
  const ms = new Date(expiresUtc).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m ${s % 60}s left`;
  return `${s % 60}s left`;
}

/** Trusted (permanent) + active temporary devices, each revocable. */
function DevicesPanel({ grants, onRevoke }: { grants: RemoteGrants | null; onRevoke: (id: string) => void }) {
  const trusted = grants?.trusted ?? [];
  const temporary = grants?.temporary ?? [];
  const empty = trusted.length === 0 && temporary.length === 0;
  return (
    <Panel panelKey="remote.devices" className="p-5">
      <SectionTitle title="Devices" subtitle="Who can connect to this PC" right={<ShieldIcon className="h-4 w-4" />} />
      {empty ? (
        <p className="mt-3 text-sm text-ink-faint">
          No devices yet. Approve a phone when it connects, or share the permanent key for automatic trust.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {trusted.map((d) => (
            <DeviceRow
              key={d.id}
              name={d.name}
              badge={
                <span className="pill flex items-center gap-1 text-green">
                  <ShieldIcon className="h-3 w-3" /> Permanent
                </span>
              }
              onRevoke={() => onRevoke(d.id)}
            />
          ))}
          {temporary.map((d) => (
            <DeviceRow
              key={d.id}
              name={d.name}
              badge={
                <span className="pill flex items-center gap-1 text-accent-3">
                  <Clock className="h-3 w-3" /> {fmtRemaining(d.expiresUtc)}
                </span>
              }
              onRevoke={() => onRevoke(d.id)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function DeviceRow({ name, badge, onRevoke }: { name: string; badge: React.ReactNode; onRevoke: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-white/[0.02] px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <Smartphone className="h-4 w-4 flex-none text-ink-dim" />
        <span className="truncate text-sm font-600 text-ink">{name}</span>
      </div>
      <div className="flex items-center gap-2">
        {badge}
        <button onClick={onRevoke} className="btn btn-ghost h-8 w-8 p-0 text-ink-dim hover:text-pink" title="Revoke access">
          <Trash2 className="h-4 w-4" />
        </button>
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
