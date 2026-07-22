import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Activity, Check, Copy, Files, FolderOpen, Gauge, Link2, Radio, ShieldCheck, Timer, Wifi, X, Zap } from "lucide-react";
import { Page } from "@/components/Page";
import { Panel } from "@/components/Panel";
import { Badge, SectionTitle } from "@/components/ui";
import { useApp } from "@/store/app";
import { useSettings } from "@/lib/queries";
import { DEFAULT_SIGNAL_URL } from "@/lib/remoteConfig";
import { hostShare, type ShareHost, type ShareStats } from "@/lib/fileShare";
import type { ShareManifest } from "@/lib/api";
import { dur } from "@/lib/format";

function bytes(value = 0): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? (value / 1024 ** index >= 100 ? 0 : 1) : 0)} ${units[index]}`;
}

function rate(value = 0) { return value > 0 ? `${bytes(value)}/s` : "â€”"; }
function eta(value: number | null) { return value == null || !Number.isFinite(value) ? "Calculating" : dur(value, { compact: true }); }

const IDLE: ShareStats = {
  state: "waiting", route: "connecting", sentBytes: 0, receivedBytes: 0, totalBytes: 0,
  speedBps: 0, rttMs: null, bufferedBytes: 0, etaSeconds: null, peer: null,
};

export default function SharePage() {
  const { data: settings } = useSettings();
  const toast = useApp((s) => s.pushToast);
  const [host, setHost] = useState<ShareHost | null>(null);
  const [manifest, setManifest] = useState<ShareManifest | null>(null);
  const [stats, setStats] = useState<ShareStats>(IDLE);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const signalUrl = settings?.remote_signal_url || DEFAULT_SIGNAL_URL;

  useEffect(() => () => host?.stop(), [host]);

  const start = useCallback(async (paths: string[]) => {
    if (!paths.length || busy) return;
    setBusy(true);
    setStats(IDLE);
    host?.stop();
    try {
      const next = await hostShare(paths, {
        signalUrl,
        onStats: setStats,
        onManifest: setManifest,
      });
      setHost(next);
      toast({ kind: "success", title: "Share link ready", message: "Keep GameTracker open while a receiver downloads." });
    } catch (error) {
      toast({ kind: "info", title: "Couldn't create share", message: String(error) });
    } finally {
      setBusy(false);
    }
  }, [busy, host, signalUrl, toast]);

  const pickFiles = async () => {
    const picked = await open({ multiple: true, directory: false, title: "Choose files to share" });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    await start(paths as string[]);
  };
  const pickFolder = async () => {
    const picked = await open({ multiple: false, directory: true, title: "Choose a folder to share" });
    if (picked) await start([picked as string]);
  };
  const copyLink = async () => {
    if (!host) return;
    try {
      await navigator.clipboard.writeText(host.link);
      setCopied(true); window.setTimeout(() => setCopied(false), 1600);
      toast({ kind: "success", title: "Link copied" });
    } catch { toast({ kind: "info", title: "Copy unavailable", message: host.link }); }
  };
  const stop = () => { host?.stop(); setHost(null); setStats(IDLE); toast({ kind: "info", title: "Share revoked" }); };
  const progress = stats.totalBytes ? Math.min(100, (stats.sentBytes / stats.totalBytes) * 100) : 0;
  const routeColor = stats.route === "direct" ? "#34d399" : stats.route === "relayed" ? "#fbbf24" : "#94a3b8";
  const itemsLabel = useMemo(() => manifest ? `${manifest.items.length} ${manifest.items.length === 1 ? "file" : "files"}` : "No selection", [manifest]);

  return (
    <Page title="Share" subtitle="Send any file or folder straight from this PC with a browser link">
      {!host ? (
        <Panel panelKey="share.create" className="relative overflow-hidden p-7">
          <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-accent-1/15 blur-3xl" />
          <div className="relative mx-auto flex max-w-2xl flex-col items-center py-7 text-center">
            <span className="grid h-16 w-16 place-items-center rounded-3xl bg-accent-sheen shadow-glow"><Link2 className="h-8 w-8 text-white" /></span>
            <h2 className="mt-5 font-display text-2xl font-800 tracking-tight text-ink">Create a direct share link</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-ink-dim">Files stream from your PC to the recipient’s browser. GameTracker uses a direct encrypted route when possible and only relays encrypted traffic when the network requires it.</p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <button className="btn-primary flex items-center gap-2" disabled={busy} onClick={pickFiles}><Files className="h-4 w-4" /> {busy ? "Preparing…" : "Add files"}</button>
              <button className="btn-ghost flex items-center gap-2" disabled={busy} onClick={pickFolder}><FolderOpen className="h-4 w-4" /> Add folder</button>
            </div>
            <div className="mt-8 grid w-full grid-cols-1 gap-3 text-left sm:grid-cols-3">
              <Info icon={<ShieldCheck className="h-4 w-4" />} title="Encrypted" text="WebRTC encryption end to end" />
              <Info icon={<Zap className="h-4 w-4" />} title="Direct first" text="Best speed on LAN and the internet" />
              <Info icon={<Radio className="h-4 w-4" />} title="Live telemetry" text="Speed, ping, route, and progress" />
            </div>
          </div>
        </Panel>
      ) : (
        <>
          <Panel panelKey="share.live" className="mb-5 overflow-hidden p-0">
            <div className="relative p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><Badge color={routeColor}><span className="h-1.5 w-1.5 rounded-full" style={{ background: routeColor, boxShadow: `0 0 8px ${routeColor}` }} /> {stats.route === "relayed" ? "Relayed" : stats.route === "direct" ? "Direct" : "Waiting for route"}</Badge><Badge color="#60a5fa">{itemsLabel}</Badge></div>
                  <h2 className="mt-3 font-display text-xl font-800 text-ink">{stats.state === "waiting" ? "Waiting for someone to open the link" : stats.state === "complete" ? "Transfer complete" : stats.state === "transferring" ? "Sending securely" : "Connecting receiver"}</h2>
                  <p className="mt-1 text-sm text-ink-dim">{stats.detail || (stats.peer ? `Connected to ${stats.peer}` : "The link works while this share stays open.")}</p>
                </div>
                <div className="flex gap-2"><button className="btn-ghost flex items-center gap-2" onClick={copyLink}>{copied ? <Check className="h-4 w-4 text-green" /> : <Copy className="h-4 w-4" />}{copied ? "Copied" : "Copy link"}</button><button className="btn-subtle flex items-center gap-2 text-pink" onClick={stop}><X className="h-4 w-4" /> Revoke</button></div>
              </div>
              <div className="mt-5 rounded-2xl border border-line bg-bg-900/70 p-3 font-mono text-xs text-ink-soft break-all select-all">{host.link}</div>
              <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-accent-sheen transition-[width] duration-500" style={{ width: `${progress}%` }} /></div>
              <div className="mt-2 flex justify-between text-xs text-ink-dim"><span>{bytes(stats.sentBytes)} of {bytes(stats.totalBytes)}</span><span>{progress.toFixed(1)}%</span></div>
            </div>
          </Panel>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={<Gauge />} label="Upload speed" value={rate(stats.speedBps)} detail="Live one-second window" color="#22d3ee" />
            <Metric icon={<Activity />} label="Ping / RTT" value={stats.rttMs == null ? "â€”" : `${Math.round(stats.rttMs)} ms`} detail={stats.route === "relayed" ? "Via TURN relay" : "Current WebRTC path"} color="#a78bfa" />
            <Metric icon={<Wifi />} label="Send buffer" value={bytes(stats.bufferedBytes)} detail="Queued without blocking the UI" color="#fbbf24" />
            <Metric icon={<Timer />} label="ETA" value={eta(stats.etaSeconds)} detail={stats.state === "complete" ? "Verified delivery finished" : "At current transfer speed"} color="#34d399" />
          </div>

          <Panel panelKey="share.contents" className="mt-5 p-5">
            <SectionTitle title="Share contents" subtitle={`${bytes(manifest?.totalBytes)} total · ${itemsLabel}`} right={<Badge color="#60a5fa">Sender only</Badge>} />
            <div className="max-h-64 overflow-y-auto rounded-xl border border-line bg-bg-900/45">
              {manifest?.items.map((item) => <div key={item.id} className="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5 last:border-0"><span className="min-w-0 truncate text-sm text-ink-soft">{item.path}</span><span className="shrink-0 text-xs text-ink-dim">{bytes(item.size)}</span></div>)}
            </div>
            {!!manifest?.skipped.length && <p className="mt-3 text-xs text-amber">{manifest.skipped.length} unreadable or linked entries were skipped for safety.</p>}
          </Panel>
        </>
      )}
    </Page>
  );
}

function Info({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="rounded-2xl border border-line bg-bg-900/55 p-3"><span className="text-accent-3">{icon}</span><div className="mt-2 text-xs font-800 text-ink">{title}</div><div className="mt-0.5 text-[11px] text-ink-dim">{text}</div></div>;
}
function Metric({ icon, label, value, detail, color }: { icon: React.ReactElement; label: string; value: string; detail: string; color: string }) {
  return <Panel panelKey={`share.metric.${label}`} className="p-4"><div className="flex items-center gap-2 text-xs font-800 uppercase tracking-wider text-ink-dim">{<span style={{ color }}>{icon}</span>}{label}</div><div className="mt-3 font-display text-xl font-800 text-ink">{value}</div><div className="mt-1 text-[11px] text-ink-dim">{detail}</div></Panel>;
}
