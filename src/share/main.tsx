import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, CheckCircle2, Download, FolderDown, Gauge, Link2Off, Radio, ShieldCheck, Timer, Wifi } from "lucide-react";
import "../index.css";
import { joinShare, type PublicManifest, type ShareStats } from "../lib/fileShare";

function bytes(value = 0): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const n = value / 1024 ** index;
  return `${n.toFixed(index ? (n >= 100 ? 0 : 1) : 0)} ${units[index]}`;
}
const rate = (value = 0) => value ? `${bytes(value)}/s` : "â€”";
const idle: ShareStats = { state: "connecting", route: "connecting", sentBytes: 0, receivedBytes: 0, totalBytes: 0, speedBps: 0, rttMs: null, bufferedBytes: 0, etaSeconds: null, peer: null };

function App() {
  const room = location.hash.slice(1).trim();
  const receiver = useRef<Awaited<ReturnType<typeof joinShare>> | null>(null);
  const [manifest, setManifest] = useState<PublicManifest | null>(null);
  const [stats, setStats] = useState<ShareStats>(idle);
  const [error, setError] = useState<string | null>(room ? null : "This share link is missing its secret.");
  const [ready, setReady] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (!room) return;
    let live = true;
    joinShare(room, {
      onStats: (next) => live && setStats(next),
      onManifest: (next) => live && setManifest(next),
      onReady: () => live && setReady(true),
      onDone: (memoryFallback) => { if (live) { setFallback(memoryFallback); setAccepted(true); } },
      onError: (message) => live && setError(message),
    }).then((next) => { if (live) receiver.current = next; else next.close(); }).catch((e) => live && setError(String(e)));
    return () => { live = false; receiver.current?.close(); };
  }, [room]);

  const download = async () => {
    try {
      await receiver.current?.accept("Browser receiver");
      setAccepted(true);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const progress = stats.totalBytes ? Math.min(100, stats.receivedBytes / stats.totalBytes * 100) : 0;
  const direct = stats.route === "direct";
  const complete = stats.state === "complete";

  return <main className="min-h-screen bg-bg-base px-4 py-7 text-ink sm:px-8">
    <div className="pointer-events-none fixed inset-0 overflow-hidden"><div className="absolute -left-24 -top-36 h-[34rem] w-[34rem] rounded-full bg-accent-1/15 blur-3xl" /><div className="absolute -bottom-44 -right-24 h-[32rem] w-[32rem] rounded-full bg-cyan/10 blur-3xl" /></div>
    <section className="relative mx-auto max-w-3xl">
      <header className="mb-7 flex items-center justify-between gap-4"><div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-accent-sheen shadow-glow"><FolderDown className="h-5 w-5 text-white" /></div><div><div className="font-display text-lg font-800 accent-text">GameTracker Share</div><div className="text-xs text-ink-dim">Direct download from sender’s PC</div></div></div><span className="pill"><ShieldCheck className="h-3.5 w-3.5 text-green" /> Encrypted</span></header>
      <div className="card relative overflow-hidden p-5 sm:p-7">
        {error ? <div className="rounded-2xl border border-pink/30 bg-pink/10 p-4 text-sm text-pink"><div className="flex items-center gap-2 font-800"><Link2Off className="h-4 w-4" /> Couldn’t open this share</div><div className="mt-1 text-ink-soft">{error}</div></div> : !manifest ? <div className="py-12 text-center"><Radio className="mx-auto h-8 w-8 animate-pulse text-accent-3" /><h1 className="mt-4 font-display text-xl font-800">Connecting to sender</h1><p className="mt-2 text-sm text-ink-dim">Waiting for the sender’s PC to confirm this link…</p></div> : <>
          <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><span className="pill" style={{ color: direct ? "#34d399" : "#fbbf24" }}><span className="h-1.5 w-1.5 rounded-full" style={{ background: direct ? "#34d399" : "#fbbf24" }} />{direct ? "Direct P2P" : stats.route === "relayed" ? "Encrypted relay" : "Finding fastest route"}</span><span className="text-xs text-ink-dim">{manifest.items.length} {manifest.items.length === 1 ? "file" : "files"}</span></div><h1 className="mt-3 font-display text-2xl font-800 tracking-tight">Files shared with you</h1><p className="mt-1 text-sm text-ink-dim">{bytes(manifest.totalBytes)} total · sender stays in control</p></div>{complete && <span className="flex items-center gap-2 text-sm font-800 text-green"><CheckCircle2 className="h-5 w-5" /> Complete</span>}</div>
          <div className="mt-6 max-h-48 overflow-y-auto rounded-xl border border-line bg-bg-900/50">{manifest.items.map((item) => <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5 text-sm last:border-0" key={item.id}><span className="min-w-0 truncate text-ink-soft">{item.path}</span><span className="shrink-0 text-xs text-ink-dim">{bytes(item.size)}</span></div>)}</div>
          {!accepted && <div className="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="max-w-md text-xs leading-5 text-ink-dim">Choose where to save. On Chrome and Edge, folders save directly to a selected folder; other browsers download individual files when complete.</p><button onClick={download} disabled={!ready} className="btn-primary flex shrink-0 items-center gap-2"><Download className="h-4 w-4" /> {ready ? "Choose save location" : "Preparing…"}</button></div>}
          {accepted && <><div className="mt-6 h-2 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-accent-sheen transition-[width] duration-500" style={{ width: `${progress}%` }} /></div><div className="mt-2 flex justify-between text-xs text-ink-dim"><span>{bytes(stats.receivedBytes)} of {bytes(stats.totalBytes)}</span><span>{progress.toFixed(1)}%</span></div></>}
          {complete && fallback && <p className="mt-4 rounded-xl border border-amber/30 bg-amber/10 p-3 text-xs leading-5 text-amber">Your browser saved the received data after completion. For large or resumable downloads, open the link in current Chrome or Edge and choose a save location.</p>}
        </>}
      </div>
      {manifest && <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat icon={<Gauge />} label="Download" value={rate(stats.speedBps)} /><Stat icon={<Activity />} label="Ping" value={stats.rttMs == null ? "â€”" : `${Math.round(stats.rttMs)} ms`} /><Stat icon={<Wifi />} label="Buffer" value={bytes(stats.bufferedBytes)} /><Stat icon={<Timer />} label="Route" value={direct ? "Direct" : stats.route === "relayed" ? "Relayed" : "Connecting"} /></div>}
      <p className="mt-7 text-center text-xs text-ink-faint">The coordination service does not store these files. Closing this page stops the transfer.</p>
    </section>
  </main>;
}

function Stat({ icon, label, value }: { icon: React.ReactElement; label: string; value: string }) { return <div className="hud-panel p-3"><div className="flex items-center gap-1.5 text-[10px] font-800 uppercase tracking-wider text-ink-dim"><span className="text-accent-3">{icon}</span>{label}</div><div className="mt-2 text-sm font-800 text-ink">{value}</div></div>; }

createRoot(document.getElementById("root")!).render(<App />);
