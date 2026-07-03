/**
 * Companion System — a mobile port of the desktop System route (`routes/Systems.tsx`).
 * A live hardware monitor: PC specs, CPU/GPU/RAM/disk gauges, live + historical
 * usage/temperature charts, per-core load, component detail and a session-aligned
 * history. Data comes over the remote link from the host's `/api/system/*`
 * endpoints (`/api/system/live`, `/api/system/history?minutes=`), which proxy the
 * desktop's `system_live` / `system_history` commands — so the phone shows the very
 * same real sensor data (LibreHardwareMonitor sidecar) the desktop does.
 */

import { useMemo, useState } from "react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Gauge as GaugeIcon,
  Thermometer,
  Monitor,
  Server,
  Clock,
  Zap,
  Activity,
  Boxes,
  ShieldAlert,
  Loader2,
  Layers,
} from "lucide-react";
import type { SystemLive, SystemHistory, SystemSample, SystemSpecs, DiskSpec, Session, Game, AppUsageHistory, AppUsageMeta } from "@/lib/api";
import { RadialGauge, LevelBar } from "@/components/RadialGauge";
import { dur } from "@/lib/format";
import { useRemote } from "../useRemote";
import { Art, openGame } from "../ui";
import { MarqueePoolProvider, SectionBackdrop } from "../Marquee";

const C = {
  cpu: "#22d3ee",
  gpu: "#a78bfa",
  ram: "#34d399",
  disk: "#fbbf24",
  cpuTemp: "#f472b6",
  gpuTemp: "#fb923c",
  ramTemp: "#2dd4bf",
};

type Range = "1h" | "6h" | "24h" | "7d";
const RANGE_MIN: Record<Range, number> = { "1h": 60, "6h": 360, "24h": 1440, "7d": 10080 };
const RANGE_OPTS: { id: Range; label: string }[] = [
  { id: "1h", label: "1h" },
  { id: "6h", label: "6h" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
];

function tempColor(t: number | null | undefined) {
  if (t == null) return "#6b7280";
  if (t < 60) return "#34d399";
  if (t < 80) return "#fbbf24";
  return "#f87171";
}
function fmt(n: number | null | undefined, suffix = "", digits = 0) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(digits)}${suffix}`;
}
function fmtTB(gb: number) {
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(0)} GB`;
}
function timeTick(t: number) {
  return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function SystemScreen() {
  const { data: settings } = useRemote<Record<string, string>>("/api/settings", 60000);
  const monitorOn = settings ? settings.system_monitor_enabled !== "false" : true;
  const { data: live, loading, error } = useRemote<SystemLive>("/api/system/live", 2000);
  const { data: games } = useRemote<Game[]>("/api/games", 60000);

  const [range, setRange] = useState<Range>("1h");
  const [histMetric, setHistMetric] = useState<"usage" | "temp">("usage");
  const { data: history } = useRemote<SystemHistory>(`/api/system/history?minutes=${RANGE_MIN[range]}`, 15000);
  // Per-app history polls at ~2s so the stacked chart's tail advances live, matching
  // the host's per-app tick ring (same data the desktop System route shows).
  const { data: appHistory } = useRemote<AppUsageHistory>(`/api/system/app-history?minutes=${RANGE_MIN[range]}`, 2000);

  const specs = live?.specs;
  const samples = live?.samples ?? [];
  const latest: SystemSample | undefined = samples[samples.length - 1];

  if (!monitorOn) {
    return (
      <Wrap>
        <div className="mt-10 grid place-items-center px-6 text-center">
          <GaugeIcon className="mb-3 h-8 w-8 text-ink-dim" />
          <div className="font-display text-lg font-800">Performance tracking is off</div>
          <p className="mt-1 text-sm text-ink-dim">
            Turn on Performance tracking in Settings → Tracking on your PC to record and view live CPU, GPU, RAM and temperatures.
          </p>
        </div>
      </Wrap>
    );
  }

  if ((loading && !live) || !specs) {
    return (
      <Wrap>
        <div className="mt-16 grid place-items-center text-sm text-ink-dim">
          {error ? (
            <span className="mx-6 rounded-xl border border-amber/40 bg-amber/10 px-3 py-2 text-amber">{error}</span>
          ) : (
            <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Reading sensors…</span>
          )}
        </div>
      </Wrap>
    );
  }

  return (
    <MarqueePoolProvider games={games ?? []}>
      <div className="space-y-4 p-4">
        <SpecHero specs={specs} latest={latest} />

        {specs.sidecarPresent && !specs.hasCpuTemp && (
          <Notice tone="amber">
            <span className="font-700 text-ink">CPU temperature needs elevated access.</span>{" "}
            Run Tracker as administrator on the PC to read CPU package/core temperatures. GPU, memory and load all work without it.
          </Notice>
        )}
        {!specs.sidecarPresent && (
          <Notice tone="dim">
            Sensor bridge not found — temperatures and GPU details are unavailable. CPU, memory and disk usage still update live.
          </Notice>
        )}

        {/* Live gauges */}
        <div className="grid grid-cols-2 gap-3">
          <GaugeCard icon={<Cpu className="h-4 w-4" />} label="CPU" pct={latest?.cpu ?? 0} temp={latest?.cpuTemp} from={C.cpu} to="#0ea5e9" sub={fmt(latest?.cpuClockMhz != null ? latest.cpuClockMhz / 1000 : null, " GHz", 2)} />
          <GaugeCard icon={<Monitor className="h-4 w-4" />} label="GPU" pct={latest?.gpu ?? 0} temp={latest?.gpuTemp} from={C.gpu} to="#7c5cff" sub={specs.hasGpuSensors ? fmt(latest?.gpuPowerW, " W") : "no sensor"} />
          <GaugeCard icon={<MemoryStick className="h-4 w-4" />} label="RAM" pct={latest?.ram ?? 0} temp={latest?.ramTemp} from={C.ram} to="#22d3ee" sub={`${fmt(latest?.ramUsedGb, "", 1)} / ${fmt(latest?.ramTotalGb, " GB", 0)}`} />
          <GaugeCard icon={<HardDrive className="h-4 w-4" />} label="Disk" pct={latest?.diskUsage ?? 0} temp={latest?.diskTemp} from={C.disk} to="#fb923c" sub={latest?.disk != null ? `${Math.round(latest.disk)}% active` : "capacity used"} />
        </div>

        {/* Live load + temperatures */}
        <Section title="Live load" subtitle="CPU · GPU · RAM · disk" right={<LivePulse />}>
          <LiveChart samples={samples} kind="usage" />
        </Section>
        <Section title="Temperatures" subtitle="CPU & GPU thermals" right={<Thermometer className="h-4 w-4 text-ink-dim" />}>
          {specs.hasCpuTemp || specs.hasGpuSensors || latest?.ramTemp != null ? (
            <LiveChart samples={samples} kind="temp" />
          ) : (
            <Empty text="No temperature sensors — run as admin (CPU) or check the sensor bridge (GPU)." />
          )}
        </Section>

        {/* Per-core */}
        {latest && latest.perCore.length > 0 && (
          <Section title="Per-core utilization" subtitle={`${latest.perCore.length} logical processors`} right={<Boxes className="h-4 w-4 text-ink-dim" />}>
            <CoreGrid cores={latest.perCore} />
          </Section>
        )}

        {/* Component detail */}
        <GpuCard specs={specs} latest={latest} />
        <MemoryCard latest={latest} swapTotal={specs.swapTotalGb} />
        <StorageCard disks={specs.disks} activity={latest?.disk} />

        {/* History + sessions */}
        <Section
          title="History"
          subtitle="System usage aligned with your sessions"
          right={
            <div className="flex items-center gap-1.5">
              <Toggle value={histMetric} onChange={setHistMetric} opts={[{ id: "usage", label: "Usage" }, { id: "temp", label: "Temps" }]} />
            </div>
          }
        >
          <div className="mb-3 flex gap-1.5">
            {RANGE_OPTS.map((o) => (
              <button key={o.id} onClick={() => setRange(o.id)} className={`flex-1 rounded-lg py-1.5 text-xs font-700 transition ${range === o.id ? "bg-accent-3 text-white" : "bg-white/[0.04] text-ink-dim"}`}>{o.label}</button>
            ))}
          </div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-700 uppercase tracking-wider text-ink-dim">
            <Activity className="h-3 w-3" /> System usage
          </div>
          <HistoryChart history={history} metric={histMetric} minutes={RANGE_MIN[range]} />
          <div className="mt-4 border-t border-line pt-4">
            <AppHistoryChart data={appHistory} minutes={RANGE_MIN[range]} />
          </div>
          <SessionLegend sessions={history?.sessions ?? []} />
        </Section>
      </div>
    </MarqueePoolProvider>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="p-4">{children}</div>;
}

function Section({ title, subtitle, right, children }: { title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-line bg-bg-900/40 p-3.5">
      <SectionBackdrop prefix="systems" title={title} art="icon" />
      <div className="relative z-10">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="font-display text-base font-800">{title}</div>
            {subtitle && <div className="text-[11px] text-ink-dim">{subtitle}</div>}
          </div>
          {right}
        </div>
        {children}
      </div>
    </section>
  );
}

function Notice({ tone, children }: { tone: "amber" | "dim"; children: React.ReactNode }) {
  return (
    <div className={`flex items-start gap-3 rounded-2xl border px-3.5 py-3 text-sm ${tone === "amber" ? "border-amber/30 bg-amber/[0.07] text-ink-dim" : "border-line bg-white/[0.03] text-ink-dim"}`}>
      <ShieldAlert className={`h-5 w-5 shrink-0 ${tone === "amber" ? "text-amber" : "text-ink-dim"}`} />
      <div>{children}</div>
    </div>
  );
}

function SpecHero({ specs, latest }: { specs: SystemSpecs; latest?: SystemSample }) {
  const totalStorage = specs.disks.reduce((a, d) => a + d.totalGb, 0);
  return (
    <div className="relative overflow-hidden rounded-3xl border border-line bg-bg-900/70 p-5 shadow-card">
      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(120% 120% at 100% 0%, color-mix(in srgb, var(--accent-1) 16%, transparent), transparent 55%)" }} />
      <div className="relative">
        <div className="flex items-center gap-2 text-[11px] font-800 uppercase tracking-[0.22em] text-ink-dim">
          <Server className="h-3.5 w-3.5" /> {specs.osName || "Windows"}
        </div>
        <h2 className="mt-1 truncate font-display text-2xl font-800 tracking-tight">{specs.hostname || "This PC"}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-dim">
          <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> up {dur(specs.uptimeSecs)}</span>
          {specs.motherboard && <span className="truncate">· {specs.motherboard}</span>}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-sm">
          <Identity icon={<Cpu className="h-4 w-4 text-accent-3" />} label="Processor" value={specs.cpuName} sub={`${specs.cpuCores}C / ${specs.cpuThreads}T · ${specs.cpuGhz} GHz`} />
          <Identity icon={<Monitor className="h-4 w-4 text-accent-3" />} label="Graphics" value={specs.gpuNames[0] ?? "—"} sub={specs.gpuVramMb ? `${(specs.gpuVramMb / 1024).toFixed(0)} GB VRAM` : specs.gpuNames[1] ?? ""} />
          <Identity icon={<MemoryStick className="h-4 w-4 text-accent-3" />} label="Memory" value={`${specs.ramTotalGb} GB`} sub={latest ? fmt(latest.ramUsedGb, " GB used", 1) : `${specs.swapTotalGb} GB swap`} />
          <Identity icon={<HardDrive className="h-4 w-4 text-accent-3" />} label="Storage" value={fmtTB(totalStorage)} sub={`${specs.disks.length} ${specs.disks.length === 1 ? "drive" : "drives"}`} />
        </div>
      </div>
    </div>
  );
}

function Identity({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[10px] font-700 uppercase tracking-wider text-ink-dim">{icon}{label}</div>
      <div className="truncate font-700 text-ink">{value}</div>
      {sub && <div className="truncate text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}

function GaugeCard({ icon, label, pct, temp, from, to, sub }: { icon: React.ReactNode; label: string; pct: number; temp?: number | null; from: string; to: string; sub?: string }) {
  return (
    <div className="relative flex flex-col items-center gap-2 overflow-hidden rounded-2xl border border-line bg-bg-900/40 py-4">
      <SectionBackdrop prefix="systems" title={`gauge ${label}`} art="icon" />
      <div className="relative z-10 flex flex-col items-center gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">{icon}{label}</div>
        <RadialGauge value={pct} max={100} size={104} from={from} to={to}>
          <div className="text-center">
            <div className="font-display text-2xl font-800 tabular-nums leading-none">{Math.round(pct)}<span className="text-sm text-ink-dim">%</span></div>
            {temp != null && (
              <div className="mt-1 inline-flex items-center gap-1 text-[11px] font-700" style={{ color: tempColor(temp) }}>
                <Thermometer className="h-3 w-3" />{Math.round(temp)}°
              </div>
            )}
          </div>
        </RadialGauge>
        {sub && <div className="text-[11px] text-ink-faint">{sub}</div>}
      </div>
    </div>
  );
}

function LivePulse() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-700 text-green">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green/70" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-green" />
      </span>
      LIVE
    </span>
  );
}

function chartData(samples: SystemSample[]) {
  return samples.map((s) => ({
    t: new Date(s.ts).getTime(),
    cpu: s.cpu,
    gpu: s.gpu ?? null,
    ram: s.ram,
    disk: s.disk ?? s.diskUsage ?? null,
    cpuTemp: s.cpuTemp ?? null,
    gpuTemp: s.gpuTemp ?? null,
    ramTemp: s.ramTemp ?? null,
  }));
}

function LiveChart({ samples, kind }: { samples: SystemSample[]; kind: "usage" | "temp" }) {
  const data = useMemo(() => chartData(samples), [samples]);
  if (data.length < 2) return <div className="grid h-[180px] place-items-center text-sm text-ink-dim">Collecting samples…</div>;
  const isTemp = kind === "temp";
  const series = isTemp
    ? [
        { key: "cpuTemp", name: "CPU °C", color: C.cpuTemp },
        { key: "gpuTemp", name: "GPU °C", color: C.gpuTemp },
        { key: "ramTemp", name: "RAM °C", color: C.ramTemp },
      ]
    : [
        { key: "cpu", name: "CPU", color: C.cpu },
        { key: "gpu", name: "GPU", color: C.gpu },
        { key: "ram", name: "RAM", color: C.ram },
        { key: "disk", name: "Disk", color: C.disk },
      ];
  return (
    <ResponsiveContainer width="100%" height={190}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -26, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`lsg-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} scale="time" tickFormatter={timeTick} stroke="#454c66" fontSize={9} tickLine={false} axisLine={false} minTickGap={40} />
        <YAxis domain={isTemp ? [20, 100] : [0, 100]} stroke="#454c66" fontSize={9} tickLine={false} axisLine={false} width={40} unit={isTemp ? "°" : "%"} />
        <Tooltip content={<LiveTooltip isTemp={isTemp} />} />
        {series.map((s) => (
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} fill={`url(#lsg-${s.key})`} isAnimationActive={false} connectNulls dot={false} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function LiveTooltip({ active, payload, label, isTemp }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-line bg-bg-900/95 px-3 py-2 text-xs shadow-float backdrop-blur">
      <div className="mb-1 font-800 text-ink">{timeTick(label)}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-ink-soft">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          {p.name}: <span className="font-800 text-ink">{p.value == null ? "—" : `${Math.round(p.value)}${isTemp ? "°" : "%"}`}</span>
        </div>
      ))}
    </div>
  );
}

function CoreGrid({ cores }: { cores: number[] }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {cores.map((v, i) => (
        <div key={i} className="rounded-lg border border-line bg-white/[0.02] p-2">
          <div className="flex items-center justify-between text-[10px] text-ink-dim">
            <span>C{i}</span>
            <span className="font-700 tabular-nums text-ink-soft">{Math.round(v)}%</span>
          </div>
          <div className="mt-1.5">
            <LevelBar value={v} max={100} color={v > 85 ? "#f87171" : v > 55 ? "#fbbf24" : "#34d399"} delay={i * 0.01} />
          </div>
        </div>
      ))}
    </div>
  );
}

function StatRow({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="flex items-center gap-1.5 text-ink-dim">{icon}{label}</span>
      <span className="font-800 tabular-nums" style={color ? { color } : undefined}>{value}</span>
    </div>
  );
}

function GpuCard({ specs, latest }: { specs: SystemSpecs; latest?: SystemSample }) {
  const memPct = latest?.gpuMemUsedMb != null && latest?.gpuMemTotalMb ? (latest.gpuMemUsedMb / latest.gpuMemTotalMb) * 100 : 0;
  return (
    <Section title="Graphics" subtitle={specs.gpuNames[0] ?? "GPU"} right={<Monitor className="h-4 w-4 text-ink-dim" />}>
      {specs.hasGpuSensors ? (
        <div className="space-y-3">
          <StatRow icon={<Activity className="h-3.5 w-3.5" />} label="Load" value={fmt(latest?.gpu, "%")} />
          <StatRow icon={<Thermometer className="h-3.5 w-3.5" />} label="Temp" value={fmt(latest?.gpuTemp, "°C")} color={tempColor(latest?.gpuTemp)} />
          <StatRow icon={<GaugeIcon className="h-3.5 w-3.5" />} label="Clock" value={fmt(latest?.gpuClockMhz, " MHz")} />
          <StatRow icon={<Zap className="h-3.5 w-3.5" />} label="Power" value={fmt(latest?.gpuPowerW, " W")} />
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-ink-dim">
              <span>VRAM</span>
              <span className="font-700 text-ink-soft">{latest?.gpuMemUsedMb != null ? `${(latest.gpuMemUsedMb / 1024).toFixed(1)} / ${((latest.gpuMemTotalMb ?? 0) / 1024).toFixed(0)} GB` : "—"}</span>
            </div>
            <LevelBar value={memPct} max={100} color={C.gpu} />
          </div>
        </div>
      ) : (
        <Empty text="No GPU sensor data. The sensor bridge reports GPU temp, load and VRAM for NVIDIA, AMD and Intel GPUs." />
      )}
    </Section>
  );
}

function MemoryCard({ latest, swapTotal }: { latest?: SystemSample; swapTotal: number }) {
  return (
    <Section title="Memory" subtitle="RAM & swap" right={<MemoryStick className="h-4 w-4 text-ink-dim" />}>
      <div className="space-y-4">
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-ink-dim">
            <span>Physical memory</span>
            <span className="font-700 text-ink-soft">{latest ? `${fmt(latest.ramUsedGb, "", 1)} / ${fmt(latest.ramTotalGb, " GB", 0)}` : "—"}</span>
          </div>
          <LevelBar value={latest?.ram ?? 0} max={100} color={C.ram} />
          <div className="mt-1 flex items-center justify-between text-[11px] text-ink-faint">
            <span>{Math.round(latest?.ram ?? 0)}% in use</span>
            {latest?.ramTemp != null && (
              <span className="inline-flex items-center gap-1 font-700" style={{ color: tempColor(latest.ramTemp) }}>
                <Thermometer className="h-3 w-3" />{Math.round(latest.ramTemp)}°C
              </span>
            )}
          </div>
        </div>
        {swapTotal > 0 && (
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-ink-dim">
              <span>Swap / page file</span>
              <span className="font-700 text-ink-soft">{fmt(swapTotal, " GB", 0)}</span>
            </div>
            <LevelBar value={latest?.swap ?? 0} max={100} color="#60a5fa" />
          </div>
        )}
      </div>
    </Section>
  );
}

function StorageCard({ disks, activity }: { disks: DiskSpec[]; activity?: number | null }) {
  return (
    <Section title="Storage" subtitle={activity != null ? `${Math.round(activity)}% activity` : `${disks.length} drives`} right={<HardDrive className="h-4 w-4 text-ink-dim" />}>
      <div className="space-y-3">
        {disks.length === 0 && <Empty text="No drives detected" />}
        {disks.map((d) => {
          const pct = d.totalGb > 0 ? (d.usedGb / d.totalGb) * 100 : 0;
          const bar = pct > 90 ? "#f87171" : pct > 75 ? "#fbbf24" : C.disk;
          return (
            <div key={d.mount + d.name}>
              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="font-700 text-ink">{d.mount}</span>
                  <span className="rounded px-1.5 py-0.5 text-[9px] font-800" style={{ background: `color-mix(in srgb, ${d.kind === "SSD" ? "#34d399" : d.kind === "HDD" ? "#60a5fa" : "#94a3b8"} 20%, transparent)`, color: d.kind === "SSD" ? "#34d399" : d.kind === "HDD" ? "#60a5fa" : "#94a3b8" }}>{d.kind}</span>
                  <span className="truncate text-ink-faint">{d.name}</span>
                </span>
                <span className="shrink-0 font-700 text-ink-soft">{fmtTB(d.usedGb)} / {fmtTB(d.totalGb)}</span>
              </div>
              <LevelBar value={pct} max={100} color={bar} />
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function HistoryChart({ history, metric, minutes }: { history?: SystemHistory | null; metric: "usage" | "temp"; minutes: number }) {
  const data = useMemo(
    () =>
      (history?.points ?? []).map((p) => ({
        t: new Date(p.ts).getTime(),
        cpu: p.cpu,
        gpu: p.gpu ?? null,
        ram: p.ram,
        cpuTemp: p.cpuTemp ?? null,
        gpuTemp: p.gpuTemp ?? null,
        ramTemp: p.ramTemp ?? null,
      })),
    [history],
  );
  const now = Date.now();
  const from = now - minutes * 60_000;
  const longRange = minutes > 1440;
  const axisTick = (t: number) => (longRange ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : timeTick(t));
  const isTemp = metric === "temp";
  const series = isTemp
    ? [{ key: "cpuTemp", name: "CPU °C", color: C.cpuTemp }, { key: "gpuTemp", name: "GPU °C", color: C.gpuTemp }, { key: "ramTemp", name: "RAM °C", color: C.ramTemp }]
    : [{ key: "cpu", name: "CPU", color: C.cpu }, { key: "gpu", name: "GPU", color: C.gpu }, { key: "ram", name: "RAM", color: C.ram }];

  if (data.length < 2) {
    return <Empty text="Building history — keep Tracker running and it fills in over time." />;
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -26, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`hsg-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
        <XAxis dataKey="t" type="number" scale="time" domain={[from, now]} tickFormatter={axisTick} stroke="#454c66" fontSize={9} tickLine={false} axisLine={false} minTickGap={48} />
        <YAxis domain={isTemp ? [20, 100] : [0, 100]} stroke="#454c66" fontSize={9} tickLine={false} axisLine={false} width={40} unit={isTemp ? "°" : "%"} />
        <Tooltip content={<LiveTooltip isTemp={isTemp} />} />
        {series.map((s) => (
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} fill={`url(#hsg-${s.key})`} isAnimationActive={false} connectNulls dot={false} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

type AppMetric = "cpu" | "gpu" | "ram";
type AppSeries = { key: string; name: string; color: string; meta?: AppUsageMeta };
const APP_PALETTE = ["#22d3ee", "#a78bfa", "#34d399", "#fbbf24", "#f472b6", "#60a5fa", "#fb923c", "#2dd4bf"];
const MAX_APPS = 6;

function isHex(c?: string | null): c is string {
  return !!c && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c);
}

function buildAppSeries(data: AppUsageHistory | undefined | null, metric: AppMetric) {
  if (!data || data.points.length === 0) return { rows: [] as Record<string, number>[], apps: [] as AppSeries[] };
  const top = data.apps.slice(0, MAX_APPS);
  const topIds = new Set(top.map((a) => a.gameId));
  const apps: AppSeries[] = top.map((a, i) => ({
    key: a.gameId,
    name: a.name,
    color: isHex(a.accentColor) ? a.accentColor : APP_PALETTE[i % APP_PALETTE.length],
    meta: a,
  }));
  if (data.apps.length > MAX_APPS) apps.push({ key: "__other", name: "Other apps", color: "#64748b" });
  const keys = apps.map((a) => a.key);
  const byT = new Map<number, Record<string, number>>();
  for (const p of data.points) {
    const t = new Date(p.ts).getTime();
    let row = byT.get(t);
    if (!row) {
      row = { t };
      for (const k of keys) row[k] = 0;
      byT.set(t, row);
    }
    const v = metric === "cpu" ? p.cpu : metric === "gpu" ? p.gpu ?? 0 : p.ramMb / 1024;
    const key = topIds.has(p.gameId) ? p.gameId : "__other";
    row[key] = (row[key] ?? 0) + v;
  }
  const rows = [...byT.values()].sort((a, b) => a.t - b.t);
  return { rows, apps };
}

/**
 * Per-app stacked resource chart — the third graph in the History card. Uses the
 * same `[from, now]` domain and left margin / YAxis width as HistoryChart so its
 * x-axis lines up with the system-usage graph above it.
 */
function AppHistoryChart({ data, minutes }: { data?: AppUsageHistory | null; minutes: number }) {
  const [metric, setMetric] = useState<AppMetric>("cpu");
  const hasGpu = data?.hasGpu ?? false;
  const effMetric: AppMetric = metric === "gpu" && !hasGpu ? "cpu" : metric;
  const { rows, apps } = useMemo(() => buildAppSeries(data, effMetric), [data, effMetric]);
  const isRam = effMetric === "ram";
  const now = Date.now();
  const from = now - minutes * 60_000;
  const longRange = minutes > 1440;
  const axisTick = (t: number) => (longRange ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : timeTick(t));
  const fmtVal = (v: number) => (isRam ? `${v.toFixed(1)} GB` : `${Math.round(v)}%`);
  const opts: { id: AppMetric; label: string }[] = [
    { id: "cpu", label: "CPU" },
    ...(hasGpu ? [{ id: "gpu" as const, label: "GPU" }] : []),
    { id: "ram", label: "RAM" },
  ];

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] font-700 uppercase tracking-wider text-ink-dim">
          <Layers className="h-3 w-3" /> Per-app usage
        </div>
        <Toggle value={effMetric} onChange={setMetric} opts={opts} />
      </div>
      {apps.length === 0 || rows.length < 2 ? (
        <Empty text="Building per-app history — play a game or use a tracked app with Performance tracking on." />
      ) : (
        <>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={rows} margin={{ top: 8, right: 8, left: -26, bottom: 0 }}>
              <defs>
                {apps.map((a) => (
                  <linearGradient key={a.key} id={`asg-${a.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={a.color} stopOpacity={0.55} />
                    <stop offset="100%" stopColor={a.color} stopOpacity={0.12} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={[from, now]} tickFormatter={axisTick} stroke="#454c66" fontSize={9} tickLine={false} axisLine={false} minTickGap={48} />
              <YAxis stroke="#454c66" fontSize={9} tickLine={false} axisLine={false} width={40} unit={isRam ? "" : "%"} />
              <Tooltip content={<AppTooltip apps={apps} fmtVal={fmtVal} />} />
              {apps.map((a) => (
                <Area key={a.key} type="monotone" dataKey={a.key} name={a.name} stackId="apps" stroke={a.color} strokeWidth={1.25} fill={`url(#asg-${a.key})`} isAnimationActive={false} dot={false} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
          <div className="mt-3 flex flex-wrap gap-2">
            {apps.map((a) => (
              <span key={a.key} className="flex items-center gap-1.5 rounded-lg border border-line bg-white/[0.02] py-1 pl-1 pr-2.5 text-xs">
                {a.meta ? (
                  <Art id={a.meta.gameId} name={a.meta.name} cover={a.meta.coverPath} icon={a.meta.iconPath} accent={a.meta.accentColor} className="h-5 w-5" rounded="rounded" />
                ) : (
                  <span className="h-3 w-3 rounded-sm" style={{ background: a.color }} />
                )}
                <span className="max-w-[120px] truncate font-700 text-ink-soft">{a.name}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AppTooltip({ active, payload, label, apps, fmtVal }: any) {
  if (!active || !payload?.length) return null;
  const nameFor = (key: string) => apps.find((a: AppSeries) => a.key === key)?.name ?? key;
  const rows = (payload as any[]).filter((p) => (p.value ?? 0) > 0.05).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const total = (payload as any[]).reduce((a, p) => a + (p.value || 0), 0);
  if (rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-line bg-bg-900/95 px-3 py-2 text-xs shadow-float backdrop-blur">
      <div className="mb-1 flex items-center justify-between gap-4 font-800 text-ink">
        <span>{timeTick(label)}</span>
        <span className="text-ink-dim">Σ {fmtVal(total)}</span>
      </div>
      {rows.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-3 text-ink-soft">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: p.stroke }} />
            <span className="max-w-[140px] truncate">{nameFor(p.dataKey)}</span>
          </span>
          <span className="font-800 text-ink">{fmtVal(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function SessionLegend({ sessions }: { sessions: Session[] }) {
  const items = useMemo(() => [...sessions].sort((a, b) => new Date(b.startUtc).getTime() - new Date(a.startUtc).getTime()).slice(0, 12), [sessions]);
  if (items.length === 0) return null;
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-2 text-[11px] font-700 uppercase tracking-wider text-ink-dim">Running in this window</div>
      <div className="flex flex-wrap gap-2">
        {items.map((s) => (
          <button key={s.id} onClick={() => openGame(s.gameId)} className="flex items-center gap-2 rounded-xl border border-line bg-white/[0.02] py-1.5 pl-1.5 pr-3 active:bg-white/[0.05]">
            <Art id={s.gameId} name={s.gameName} cover={s.coverPath} icon={s.iconPath} accent={s.accentColor} className="h-6 w-6" rounded="rounded-md" />
            <div className="min-w-0">
              <div className="max-w-[130px] truncate text-xs font-700">{s.gameName}</div>
              <div className="text-[10px] font-700 text-green">{dur(s.activeSeconds)} active</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle<T extends string>({ value, onChange, opts }: { value: T; onChange: (v: T) => void; opts: { id: T; label: string }[] }) {
  return (
    <div className="flex rounded-lg bg-white/[0.05] p-0.5">
      {opts.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)} className={`rounded-md px-2 py-1 text-[11px] font-700 transition ${value === o.id ? "bg-accent-3 text-white" : "text-ink-dim"}`}>{o.label}</button>
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="grid place-items-center px-3 py-6 text-center text-sm text-ink-dim">{text}</div>;
}
