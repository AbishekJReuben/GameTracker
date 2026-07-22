import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, useSpring, useTransform } from "motion/react";
import { Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, ArrowDownToLine, Gauge, Radio, Timer, Wifi } from "lucide-react";

export interface TransferTelemetry {
  state: string;
  route: string;
  sentBytes: number;
  receivedBytes: number;
  totalBytes: number;
  speedBps: number;
  rttMs: number | null;
  bufferedBytes: number;
  etaSeconds: number | null;
}

export interface TransferSample {
  at: number;
  speedBps: number;
  rttMs: number | null;
  bufferedBytes: number;
  progress: number;
}

export interface TransferEvent {
  at: number;
  title: string;
  detail: string;
  tone?: "blue" | "green" | "amber" | "pink";
}

export function formatBytes(value = 0): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const n = value / 1024 ** index;
  return `${n.toFixed(index ? (n >= 100 ? 0 : 1) : 0)} ${units[index]}`;
}

export function formatRate(value = 0): string {
  return value > 0 ? `${formatBytes(value)}/s` : "—";
}

export function formatEta(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "Calculating";
  if (value < 60) return `${Math.max(0, Math.round(value))} sec`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return `${minutes}m ${seconds}s`;
}

export function useTransferSeries(stats: TransferTelemetry, limit = 60) {
  const [samples, setSamples] = useState<TransferSample[]>([]);
  const [events, setEvents] = useState<TransferEvent[]>([]);
  const previous = useRef({ state: stats.state, route: stats.route });

  useEffect(() => {
    const now = Date.now();
    const moved = Math.max(stats.sentBytes, stats.receivedBytes);
    setSamples((current) => [...current, {
      at: now,
      speedBps: stats.speedBps,
      rttMs: stats.rttMs,
      bufferedBytes: stats.bufferedBytes,
      progress: stats.totalBytes ? moved / stats.totalBytes * 100 : 0,
    }].slice(-limit));

    const next: TransferEvent[] = [];
    if (previous.current.route !== stats.route && stats.route !== "connecting" && stats.route !== "unknown") {
      next.push({ at: now, title: stats.route === "direct" ? "Direct route established" : "Encrypted relay selected", detail: stats.route === "direct" ? "Traffic is flowing peer to peer." : "The network required a relay path.", tone: stats.route === "direct" ? "green" : "amber" });
    }
    if (previous.current.state !== stats.state) {
      if (stats.state === "transferring") next.push({ at: now, title: "Transfer started", detail: "Destination confirmed and byte stream opened.", tone: "blue" });
      if (stats.state === "complete") next.push({ at: now, title: "Download complete", detail: `${formatBytes(moved)} received successfully.`, tone: "green" });
      if (stats.state === "error") next.push({ at: now, title: "Transfer interrupted", detail: "See the diagnostic log for details.", tone: "pink" });
    }
    if (next.length) setEvents((current) => [...next, ...current].slice(0, 24));
    previous.current = { state: stats.state, route: stats.route };
  }, [limit, stats]);

  return { samples, events, setEvents };
}

export function TransferHero({ stats, direction, eyebrow, title, subtitle, actions }: {
  stats: TransferTelemetry;
  direction: "download" | "upload";
  eyebrow: string;
  title: string;
  subtitle: string;
  actions?: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const moved = direction === "download" ? stats.receivedBytes : stats.sentBytes;
  const progress = stats.totalBytes ? Math.min(100, moved / stats.totalBytes * 100) : 0;
  const spring = useSpring(0, { stiffness: 85, damping: 22, mass: 0.8 });
  const dash = useTransform(spring, (v) => 326.7 * (1 - v / 100));
  useEffect(() => { spring.set(progress); }, [progress, spring]);

  return <div className="relative overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#0a0c14]/90 p-5 shadow-[0_28px_90px_rgba(0,0,0,.38)] sm:p-7">
    <div className="pointer-events-none absolute inset-0 opacity-60" style={{ background: "radial-gradient(circle at 14% 15%, rgba(124,92,255,.22), transparent 31%), radial-gradient(circle at 87% 12%, rgba(34,211,238,.15), transparent 27%)" }} />
    <motion.div aria-hidden className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full border border-cyan/15" animate={reduceMotion ? undefined : { rotate: 360 }} transition={{ duration: 22, repeat: Infinity, ease: "linear" }}><span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rounded-full bg-cyan shadow-[0_0_18px_#22d3ee]" /></motion.div>
    <div className="relative grid items-center gap-7 lg:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-[10px] font-800 uppercase tracking-[.22em] text-ink-dim"><LiveDot active={stats.state === "transferring"} /> {eyebrow}<span className="text-ink-faint">/</span><span className={stats.route === "direct" ? "text-green" : stats.route === "relayed" ? "text-amber" : "text-ink-dim"}>{stats.route === "direct" ? "Direct P2P" : stats.route === "relayed" ? "Encrypted relay" : "Negotiating route"}</span></div>
        <h1 className="mt-3 max-w-2xl font-display text-2xl font-800 tracking-tight text-ink sm:text-3xl">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-dim">{subtitle}</p>
        <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-4">
          <div><div className="text-[10px] font-800 uppercase tracking-[.2em] text-ink-faint">{direction === "download" ? "Received" : "Sent"}</div><div className="mt-1 font-display text-xl font-800 text-ink">{formatBytes(moved)} <span className="text-sm font-600 text-ink-dim">/ {formatBytes(stats.totalBytes)}</span></div></div>
          <div><div className="text-[10px] font-800 uppercase tracking-[.2em] text-ink-faint">Live speed</div><div className="mt-1 font-display text-xl font-800 text-cyan">{formatRate(stats.speedBps)}</div></div>
          {actions && <div className="ml-auto flex flex-wrap gap-2">{actions}</div>}
        </div>
        <div className="mt-6 h-1.5 overflow-hidden rounded-full bg-white/[0.06]"><motion.div className="relative h-full rounded-full bg-accent-sheen" initial={{ width: 0 }} animate={{ width: `${progress}%` }} transition={{ type: "spring", stiffness: 75, damping: 21 }}><span className="absolute inset-y-0 right-0 w-16 bg-gradient-to-r from-transparent to-white/60 blur-[2px]" /></motion.div></div>
      </div>
      <div className="relative mx-auto h-36 w-36 shrink-0 sm:h-40 sm:w-40">
        <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120" role="img" aria-label={`${progress.toFixed(1)} percent complete`}>
          <defs><linearGradient id={`transfer-ring-${direction}`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#815cff" /><stop offset=".52" stopColor="#3b82f6" /><stop offset="1" stopColor="#22d3ee" /></linearGradient></defs>
          <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="7" />
          <motion.circle cx="60" cy="60" r="52" fill="none" stroke={`url(#transfer-ring-${direction})`} strokeWidth="7" strokeLinecap="round" strokeDasharray="326.7" style={{ strokeDashoffset: dash }} />
        </svg>
        <div className="absolute inset-0 grid place-items-center text-center"><div><div className="font-display text-2xl font-800 text-ink">{progress.toFixed(progress > 99 ? 0 : 1)}%</div><div className="mt-0.5 text-[9px] font-800 uppercase tracking-[.2em] text-ink-faint">{stats.state === "complete" ? "Complete" : "Progress"}</div></div></div>
      </div>
    </div>
  </div>;
}

export function MetricsGrid({ stats, direction }: { stats: TransferTelemetry; direction: "download" | "upload" }) {
  const metrics = [
    { label: direction === "download" ? "Download" : "Upload", value: formatRate(stats.speedBps), detail: "Current throughput", color: "#22d3ee", icon: <Gauge /> },
    { label: "Latency", value: stats.rttMs == null ? "—" : `${Math.round(stats.rttMs)} ms`, detail: "Round-trip time", color: "#a78bfa", icon: <Activity /> },
    { label: "Buffer", value: formatBytes(stats.bufferedBytes), detail: stats.bufferedBytes > 4 * 1024 * 1024 ? "Backpressure active" : "Healthy queue", color: stats.bufferedBytes > 4 * 1024 * 1024 ? "#fbbf24" : "#34d399", icon: <Wifi /> },
    { label: "Time left", value: stats.state === "complete" ? "Done" : formatEta(stats.etaSeconds), detail: "Live estimate", color: "#60a5fa", icon: <Timer /> },
  ];
  return <motion.div className="grid grid-cols-2 gap-3 xl:grid-cols-4" initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: .055 } } }}>{metrics.map((metric) => <motion.div key={metric.label} variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }} transition={{ type: "spring", stiffness: 250, damping: 24 }} className="group relative overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
    <div className="absolute -right-5 -top-5 h-20 w-20 rounded-full opacity-10 blur-2xl transition-opacity group-hover:opacity-25" style={{ background: metric.color }} />
    <div className="relative flex items-center gap-2 text-[10px] font-800 uppercase tracking-[.16em] text-ink-dim"><span className="[&>svg]:h-4 [&>svg]:w-4" style={{ color: metric.color }}>{metric.icon}</span>{metric.label}</div>
    <div className="relative mt-3 font-display text-lg font-800 text-ink sm:text-xl">{metric.value}</div><div className="relative mt-1 text-[10px] text-ink-faint">{metric.detail}</div>
  </motion.div>)}</motion.div>;
}

export function TransferChart({ samples, title = "Transfer pulse" }: { samples: TransferSample[]; title?: string }) {
  const data = useMemo(() => samples.map((sample, index) => ({
    ...sample,
    label: `${Math.max(0, samples.length - index - 1)}s`,
    speedMB: sample.speedBps / 1024 / 1024,
  })), [samples]);
  return <div className="relative overflow-hidden rounded-[24px] border border-white/[0.07] bg-white/[0.022] p-4 sm:p-5">
    <div className="mb-4 flex items-center justify-between gap-4"><div><div className="flex items-center gap-2 font-display text-sm font-800 text-ink"><Activity className="h-4 w-4 text-cyan" />{title}</div><div className="mt-1 text-[10px] uppercase tracking-[.16em] text-ink-faint">Throughput and latency · last {Math.max(1, data.length)} seconds</div></div><div className="flex gap-3 text-[10px] font-700"><span className="flex items-center gap-1.5 text-cyan"><i className="h-1.5 w-1.5 rounded-full bg-cyan" /> MB/s</span><span className="flex items-center gap-1.5 text-accent-3"><i className="h-1.5 w-1.5 rounded-full bg-accent-3" /> ms</span></div></div>
    <div className="h-48 sm:h-56"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data} margin={{ top: 8, right: 4, left: -28, bottom: 0 }}>
      <defs><linearGradient id="speedArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#22d3ee" stopOpacity={.34} /><stop offset="1" stopColor="#22d3ee" stopOpacity={0} /></linearGradient></defs>
      <CartesianGrid vertical={false} stroke="rgba(255,255,255,.055)" />
      <XAxis dataKey="label" tick={{ fill: "#596179", fontSize: 9 }} axisLine={false} tickLine={false} minTickGap={28} reversed />
      <YAxis yAxisId="speed" tick={{ fill: "#596179", fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}`} />
      <YAxis yAxisId="ping" orientation="right" hide domain={[0, "auto"]} />
      <Tooltip content={<ChartTooltip />} cursor={{ stroke: "rgba(255,255,255,.15)", strokeDasharray: "3 3" }} />
      <Area isAnimationActive={false} yAxisId="speed" type="monotone" dataKey="speedMB" stroke="#22d3ee" strokeWidth={2.25} fill="url(#speedArea)" />
      <Line isAnimationActive={false} yAxisId="ping" type="monotone" dataKey="rttMs" stroke="#a78bfa" strokeWidth={1.5} dot={false} connectNulls />
    </AreaChart></ResponsiveContainer></div>
  </div>;
}

function ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as TransferSample & { speedMB: number; label: string };
  return <div className="rounded-xl border border-white/10 bg-[#0b0d16]/95 px-3 py-2 shadow-2xl backdrop-blur-xl"><div className="text-[9px] uppercase tracking-wider text-ink-faint">{point.label} ago</div><div className="mt-1 text-xs font-800 text-cyan">{point.speedMB.toFixed(1)} MB/s</div><div className="mt-0.5 text-[10px] text-accent-3">{point.rttMs == null ? "No RTT sample" : `${Math.round(point.rttMs)} ms RTT`}</div></div>;
}

export function EventStream({ events, empty = "Events will appear as the transfer progresses." }: { events: TransferEvent[]; empty?: string }) {
  return <div className="rounded-[24px] border border-white/[0.07] bg-white/[0.022] p-4 sm:p-5"><div className="flex items-center gap-2 font-display text-sm font-800 text-ink"><Radio className="h-4 w-4 text-accent-3" />Session activity</div>
    <div className="mt-4 max-h-56 space-y-1 overflow-y-auto pr-1"><AnimatePresence initial={false}>{events.length ? events.map((event, index) => <motion.div key={`${event.at}-${event.title}`} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="relative flex gap-3 rounded-xl px-2 py-2.5 hover:bg-white/[0.025]"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${event.tone === "green" ? "bg-green shadow-[0_0_9px_#34d399]" : event.tone === "amber" ? "bg-amber" : event.tone === "pink" ? "bg-pink" : "bg-accent-3"}`} /><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-3"><span className="text-xs font-700 text-ink-soft">{event.title}</span><span className="shrink-0 text-[9px] text-ink-faint">{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></div><p className="mt-0.5 text-[10px] leading-4 text-ink-dim">{event.detail}</p></div>{index < events.length - 1 && <span className="absolute bottom-[-7px] left-[11px] top-7 w-px bg-white/[0.07]" />}</motion.div>) : <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid min-h-32 place-items-center text-center"><div><ArrowDownToLine className="mx-auto h-5 w-5 text-ink-faint" /><p className="mt-2 text-xs text-ink-faint">{empty}</p></div></motion.div>}</AnimatePresence></div>
  </div>;
}

export function LiveDot({ active }: { active?: boolean }) {
  return <span className="relative flex h-2.5 w-2.5"><span className={`absolute inline-flex h-full w-full rounded-full ${active ? "animate-ping bg-green opacity-60" : "bg-ink-faint opacity-30"}`} /><span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${active ? "bg-green" : "bg-ink-faint"}`} /></span>;
}
