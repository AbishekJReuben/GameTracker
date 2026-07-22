import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, motion } from "motion/react";
import { Check, CheckCircle2, Clipboard, Download, File, FolderDown, Link2Off, ListTree, LockKeyhole, Radio, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import "../index.css";
import { joinShare, type PublicManifest, type ShareStats } from "../lib/fileShare";
import { EventStream, formatBytes, MetricsGrid, TransferChart, TransferHero, useTransferSeries } from "../components/share/TransferVisuals";

const idle: ShareStats = { state: "connecting", route: "connecting", sentBytes: 0, receivedBytes: 0, totalBytes: 0, speedBps: 0, peakSpeedBps: 0, rttMs: null, bufferedBytes: 0, etaSeconds: null, peer: null };
type View = "overview" | "files" | "activity";

function App() {
  const room = location.hash.slice(1).trim();
  const receiver = useRef<Awaited<ReturnType<typeof joinShare>> | null>(null);
  const [manifest, setManifest] = useState<PublicManifest | null>(null);
  const [stats, setStats] = useState<ShareStats>(idle);
  const [error, setError] = useState<string | null>(room ? null : "This share link is missing its secret.");
  const [ready, setReady] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [copied, setCopied] = useState(false);
  const { samples, events } = useTransferSeries(stats);

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
  const copyLogs = async () => {
    const diagnostics = receiver.current?.logs() || ["GameTracker Share receiver diagnostics", `room=${room}`, `state=${JSON.stringify(stats)}`, `error=${error || "none"}`].join("\n");
    try { await navigator.clipboard.writeText(diagnostics); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { window.prompt("Copy diagnostics", diagnostics); }
  };

  const direct = stats.route === "direct";
  const complete = stats.state === "complete";
  const currentFile = useMemo(() => {
    if (!manifest?.items.length) return null;
    let remaining = stats.receivedBytes;
    for (const item of manifest.items) { if (remaining <= item.size) return { item, received: Math.max(0, remaining) }; remaining -= item.size; }
    return { item: manifest.items[manifest.items.length - 1], received: manifest.items[manifest.items.length - 1].size };
  }, [manifest, stats.receivedBytes]);

  return <main className="relative min-h-screen overflow-hidden bg-bg-base px-4 py-6 text-ink sm:px-8 sm:py-8">
    <AmbientBackground />
    <section className="relative mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3"><motion.div className="grid h-12 w-12 place-items-center rounded-2xl bg-accent-sheen shadow-glow" initial={{ rotate: -12, scale: .8 }} animate={{ rotate: 0, scale: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }}><FolderDown className="h-5 w-5 text-white" /></motion.div><div><div className="font-display text-lg font-800 accent-text sm:text-xl">GameTracker Share</div><div className="text-xs text-ink-dim">Direct from the sender's PC</div></div></div>
        <div className="flex items-center gap-2"><span className="pill"><ShieldCheck className="h-3.5 w-3.5 text-green" /> End-to-end encrypted</span><button onClick={copyLogs} className="btn-ghost flex items-center gap-2 text-xs"><Clipboard className="h-3.5 w-3.5" />{copied ? "Copied" : "Copy diagnostics"}</button></div>
      </header>

      {error ? <ErrorState error={error} copyLogs={copyLogs} copied={copied} /> : !manifest ? <Connecting /> : <>
        <TransferHero
          stats={stats}
          direction="download"
          eyebrow={complete ? "Delivered securely" : accepted ? "Live transfer" : "Share ready"}
          title={complete ? "Everything arrived safely" : accepted ? (currentFile?.item.path || "Receiving your files") : "Files are ready for you"}
          subtitle={complete ? `${manifest.items.length} ${manifest.items.length === 1 ? "file" : "files"} saved from the sender's computer.` : accepted ? `Streaming ${formatBytes(manifest.totalBytes)} without storing a copy on the coordination server.` : `${manifest.items.length} ${manifest.items.length === 1 ? "file" : "files"} · ${formatBytes(manifest.totalBytes)} · the sender remains in control.`}
          actions={!accepted ? <button onClick={download} disabled={!ready} className="btn-primary flex items-center gap-2"><Download className="h-4 w-4" />{ready ? "Choose save location" : "Preparing…"}</button> : complete ? <button className="btn-ghost flex items-center gap-2" onClick={() => location.reload()}><RefreshCw className="h-4 w-4" /> Download again</button> : undefined}
        />

        <div className="mt-4"><MetricsGrid stats={stats} direction="download" /></div>
        <nav className="mt-5 flex max-w-full gap-1 overflow-x-auto rounded-2xl border border-white/[0.07] bg-white/[0.025] p-1.5 sm:w-fit">{(["overview", "files", "activity"] as View[]).map((item) => <button key={item} onClick={() => setView(item)} className={`relative rounded-xl px-4 py-2 text-xs font-700 capitalize transition-colors ${view === item ? "text-white" : "text-ink-dim hover:text-ink"}`}>{view === item && <motion.span layoutId="share-view" className="absolute inset-0 rounded-xl bg-white/[0.08] shadow-inner" transition={{ type: "spring", stiffness: 300, damping: 28 }} />}<span className="relative">{item}</span></button>)}</nav>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={view} initial={{ opacity: 0, y: 9 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -7 }} transition={{ duration: .2 }} className="mt-4">
            {view === "overview" && <div className="grid gap-4 lg:grid-cols-[1.65fr_1fr]"><TransferChart samples={samples} /> <SessionSummary stats={stats} direct={direct} currentFile={currentFile} /></div>}
            {view === "files" && <FileList manifest={manifest} received={stats.receivedBytes} />}
            {view === "activity" && <EventStream events={events} />}
          </motion.div>
        </AnimatePresence>
        {complete && fallback && <p className="mt-4 rounded-2xl border border-amber/25 bg-amber/10 p-4 text-xs leading-5 text-amber">Your browser held the received data in memory before saving it. For very large downloads, use a current version of Chrome or Edge and choose a destination before transfer.</p>}
      </>}
      <footer className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[10px] uppercase tracking-[.14em] text-ink-faint"><span className="flex items-center gap-1.5"><LockKeyhole className="h-3 w-3 text-green" /> Encrypted in transit</span><span>No cloud file storage</span><span>Closing this page stops an active transfer</span></footer>
    </section>
  </main>;
}

function AmbientBackground() { return <div className="pointer-events-none fixed inset-0"><div className="absolute inset-0 opacity-[.12]" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.08) 1px,transparent 1px)", backgroundSize: "44px 44px", maskImage: "radial-gradient(circle at 50% 15%,black,transparent 72%)" }} /><motion.div className="absolute -left-40 -top-60 h-[38rem] w-[38rem] rounded-full bg-accent-1/15 blur-3xl" animate={{ x: [0, 60, 0], y: [0, 30, 0] }} transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }} /><motion.div className="absolute -bottom-56 -right-32 h-[36rem] w-[36rem] rounded-full bg-cyan/10 blur-3xl" animate={{ x: [0, -50, 0], y: [0, -25, 0] }} transition={{ duration: 17, repeat: Infinity, ease: "easeInOut" }} /></div>; }

function ErrorState({ error, copyLogs, copied }: { error: string; copyLogs: () => void; copied: boolean }) { return <motion.div initial={{ opacity: 0, scale: .98 }} animate={{ opacity: 1, scale: 1 }} className="rounded-[28px] border border-pink/25 bg-pink/[0.07] p-6 sm:p-8"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-pink/10 text-pink"><Link2Off className="h-5 w-5" /></div><h1 className="mt-5 font-display text-2xl font-800">Couldn't open this share</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-ink-soft">{error}</p><button onClick={copyLogs} className="btn-ghost mt-5 flex items-center gap-2"><Clipboard className="h-4 w-4" />{copied ? "Diagnostics copied" : "Copy diagnostics"}</button></motion.div>; }
function Connecting() { return <div className="grid min-h-[430px] place-items-center rounded-[28px] border border-white/[0.07] bg-white/[0.02] text-center"><div><div className="relative mx-auto grid h-20 w-20 place-items-center"><motion.span className="absolute inset-0 rounded-full border border-accent-3/40" animate={{ scale: [1, 1.65], opacity: [.8, 0] }} transition={{ repeat: Infinity, duration: 1.8 }} /><Radio className="h-8 w-8 text-accent-3" /></div><h1 className="mt-5 font-display text-2xl font-800">Connecting to sender</h1><p className="mt-2 text-sm text-ink-dim">Opening an encrypted peer-to-peer route…</p></div></div>; }

function SessionSummary({ stats, direct, currentFile }: { stats: ShareStats; direct: boolean; currentFile: { item: PublicManifest["items"][number]; received: number } | null }) { return <div className="rounded-[24px] border border-white/[0.07] bg-white/[0.022] p-5"><div className="flex items-center gap-2 font-display text-sm font-800"><Sparkles className="h-4 w-4 text-accent-3" />This session</div><div className="mt-5 space-y-4"><Detail label="Route" value={direct ? "Direct peer-to-peer" : stats.route === "relayed" ? "Encrypted relay" : "Negotiating"} tone={direct ? "green" : undefined} /><Detail label="Peak speed" value={stats.peakSpeedBps ? `${formatBytes(stats.peakSpeedBps)}/s` : "—"} /><Detail label="Current file" value={currentFile?.item.path || "Waiting to begin"} /><Detail label="File progress" value={currentFile ? `${formatBytes(currentFile.received)} / ${formatBytes(currentFile.item.size)}` : "—"} /></div></div>; }
function Detail({ label, value, tone }: { label: string; value: string; tone?: "green" }) { return <div className="flex items-start justify-between gap-5 border-b border-white/[0.055] pb-3 last:border-0 last:pb-0"><span className="text-[10px] font-700 uppercase tracking-[.14em] text-ink-faint">{label}</span><span className={`max-w-[65%] break-words text-right text-xs font-700 ${tone === "green" ? "text-green" : "text-ink-soft"}`}>{value}</span></div>; }

function FileList({ manifest, received }: { manifest: PublicManifest; received: number }) { let cursor = 0; return <div className="overflow-hidden rounded-[24px] border border-white/[0.07] bg-white/[0.022]"><div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4"><div className="flex items-center gap-2 font-display text-sm font-800"><ListTree className="h-4 w-4 text-cyan" />Shared contents</div><span className="text-xs text-ink-dim">{manifest.items.length} items · {formatBytes(manifest.totalBytes)}</span></div><div className="max-h-[420px] overflow-y-auto p-2">{manifest.items.map((item, index) => { const fileReceived = Math.max(0, Math.min(item.size, received - cursor)); cursor += item.size; const p = item.size ? fileReceived / item.size * 100 : 100; return <motion.div key={item.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index * .025, .25) }} className="group rounded-2xl px-3 py-3 hover:bg-white/[0.025]"><div className="flex items-center gap-3"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.05] text-ink-dim"><File className="h-4 w-4" /></div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-4"><span className="truncate text-xs font-700 text-ink-soft">{item.path}</span><span className="shrink-0 text-[10px] text-ink-faint">{formatBytes(item.size)}</span></div><div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.055]"><motion.div className="h-full rounded-full bg-accent-sheen" animate={{ width: `${p}%` }} /></div></div>{p >= 100 && <CheckCircle2 className="h-4 w-4 shrink-0 text-green" />}</div></motion.div>; })}</div></div>; }

createRoot(document.getElementById("root")!).render(<App />);
