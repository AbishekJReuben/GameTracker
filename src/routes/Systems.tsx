import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
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
  Gamepad2,
  AppWindow,
} from "lucide-react";
import { Page } from "@/components/Page";
import { SectionTitle, EmptyState, Skeleton, Segmented, Badge } from "@/components/ui";
import { Panel } from "@/components/Panel";
import { SYSTEM_HISTORY_RANGES, rangeToHistoryMinutes, rangeToLookbackMs, type TimelineRange } from "@/lib/timelineZoom";
import { RadialGauge, LevelBar } from "@/components/RadialGauge";
import { GameArt } from "@/components/GameArt";
import { useSystemLive, useSystemHistory, useSessions, useSettings, useGames } from "@/lib/queries";
import { Timeline } from "@/components/Timeline";
import { useApp, useMotionEnabled } from "@/store/app";
import { dur } from "@/lib/format";
import { SystemSample, type Game } from "@/lib/api";

const C = {
  cpu: "#22d3ee",
  gpu: "#a78bfa",
  ram: "#34d399",
  disk: "#fbbf24",
  cpuTemp: "#f472b6",
  gpuTemp: "#fb923c",
  ramTemp: "#2dd4bf",
};

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

export default function SystemsPage() {
  const { data: settings } = useSettings();
  const monitorOn = settings ? settings.system_monitor_enabled !== "false" : true;
  const { data: live, isLoading } = useSystemLive(monitorOn);
  const defaultRange = useApp((s) => s.prefs.timelineRange);
  const [range, setRange] = useState<TimelineRange>(defaultRange);
  const historyMinutes = rangeToHistoryMinutes(range);
  const { data: history } = useSystemHistory(historyMinutes, monitorOn);
  const [histMetric, setHistMetric] = useState<"usage" | "temp">("usage");
  const lookbackMs = rangeToLookbackMs(range);
  const fromUtc = useMemo(() => new Date(Date.now() - lookbackMs).toISOString(), [lookbackMs]);
  const { data: sessions } = useSessions({ fromUtc });
  const { data: games } = useGames();

  const specs = live?.specs;
  const samples = live?.samples ?? [];
  const latest: SystemSample | undefined = samples[samples.length - 1];

  if (!monitorOn) {
    return (
      <Page title="System" subtitle="Hardware monitor">
        <EmptyState
          icon={<GaugeIcon className="h-6 w-6" />}
          title="Performance tracking is off"
          message="Turn on Performance tracking in Settings → Tracking to record and view live CPU, GPU, RAM and temperatures."
          action={
            <Link to="/settings" className="btn btn-primary">
              Open Settings
            </Link>
          }
        />
      </Page>
    );
  }

  if (isLoading || !specs) {
    return (
      <Page title="System" subtitle="Live hardware monitor">
        <div className="space-y-6">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </Page>
    );
  }

  return (
    <Page title="System" subtitle={`${specs.hostname || "This PC"} · live hardware monitor`}>
      <div className="space-y-6">
        <SpecHero specs={specs} latest={latest} />

        {specs.sidecarPresent && !specs.hasCpuTemp && (
          <div className="card flex items-center gap-3 border border-amber/30 bg-amber/[0.07] px-4 py-3">
            <ShieldAlert className="h-5 w-5 shrink-0 text-amber" />
            <div className="text-sm">
              <span className="font-700 text-ink">CPU temperature needs elevated access.</span>{" "}
              <span className="text-ink-dim">
                Run Tracker as administrator to read CPU package/core temperatures (the sensor driver requires it). GPU,
                memory and load all work without it.
              </span>
            </div>
          </div>
        )}
        {!specs.sidecarPresent && (
          <div className="card flex items-center gap-3 border border-line bg-white/[0.03] px-4 py-3">
            <ShieldAlert className="h-5 w-5 shrink-0 text-ink-dim" />
            <div className="text-sm text-ink-dim">
              Sensor bridge not found — temperatures and GPU details are unavailable. CPU, memory and disk usage still
              update live.
            </div>
          </div>
        )}

        {/* Live gauges */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <GaugeCard panelKey="systems.gauge.cpu" games={games ?? []} icon={<Cpu className="h-4 w-4" />} label="CPU" pct={latest?.cpu ?? 0} temp={latest?.cpuTemp} from={C.cpu} to="#0ea5e9" sub={`${fmt(latest?.cpuClockMhz != null ? latest.cpuClockMhz / 1000 : null, " GHz", 2)}`} />
          <GaugeCard panelKey="systems.gauge.gpu" games={games ?? []} icon={<Monitor className="h-4 w-4" />} label="GPU" pct={latest?.gpu ?? 0} temp={latest?.gpuTemp} from={C.gpu} to="#7c5cff" sub={specs.hasGpuSensors ? `${fmt(latest?.gpuPowerW, " W")}` : "no sensor"} />
          <GaugeCard panelKey="systems.gauge.ram" games={games ?? []} icon={<MemoryStick className="h-4 w-4" />} label="RAM" pct={latest?.ram ?? 0} temp={latest?.ramTemp} from={C.ram} to="#22d3ee" sub={`${fmt(latest?.ramUsedGb, "", 1)} / ${fmt(latest?.ramTotalGb, " GB", 0)}`} />
          <GaugeCard panelKey="systems.gauge.disk" games={games ?? []} icon={<HardDrive className="h-4 w-4" />} label="Disk" pct={latest?.diskUsage ?? 0} temp={latest?.diskTemp} from={C.disk} to="#fb923c" sub={latest?.disk != null ? `${Math.round(latest.disk)}% active` : "capacity used"} />
        </div>

        {/* Live charts */}
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel panelKey="systems.live-load" games={games ?? []} art="icon">
            <SectionTitle sheen title="Live load" subtitle="CPU · GPU · RAM · disk — last 10 minutes" right={<LivePulse />} />
            <LiveChart samples={samples} kind="usage" />
          </Panel>
          <Panel panelKey="systems.temperatures" games={games ?? []} art="icon">
            <SectionTitle sheen title="Temperatures" subtitle="CPU & GPU thermals" right={<Thermometer className="h-4 w-4 text-ink-dim" />} />
            {specs.hasCpuTemp || specs.hasGpuSensors || latest?.ramTemp != null ? (
              <LiveChart samples={samples} kind="temp" />
            ) : (
              <EmptyState title="No temperature sensors" message="Run as administrator (CPU) or check that the sensor bridge is present (GPU)." />
            )}
          </Panel>
        </div>

        {/* Per-core */}
        {latest && latest.perCore.length > 0 && (
          <Panel panelKey="systems.cores" games={games ?? []} art="icon">
            <SectionTitle sheen title="Per-core utilization" subtitle={`${latest.perCore.length} logical processors`} right={<Boxes className="h-4 w-4 text-ink-dim" />} />
            <CoreGrid cores={latest.perCore} />
          </Panel>
        )}

        {/* Component detail */}
        <div className="grid gap-6 lg:grid-cols-3">
          <GpuCard games={games ?? []} specs={specs} latest={latest} />
          <MemoryCard games={games ?? []} latest={latest} swapTotal={specs.swapTotalGb} />
          <StorageCard games={games ?? []} disks={specs.disks} activity={latest?.disk} />
        </div>

        {/* History + combined session timeline */}
        <Panel panelKey="systems.history" games={games ?? []} sessions={sessions} art="icon">
          <SectionTitle
            sheen
            title="History"
            subtitle="Games & apps timeline with system usage aligned below"
            right={
              <div className="flex items-center gap-2">
                <Segmented value={histMetric} onChange={setHistMetric} size="sm" options={[{ value: "usage" as const, label: "Usage" }, { value: "temp" as const, label: "Temps" }]} />
                <Segmented value={range} onChange={setRange} size="sm" options={SYSTEM_HISTORY_RANGES} />
              </div>
            }
          />
          <Timeline
            sessions={sessions ?? []}
            range={range}
            compact
            hideStepper
            groupByKind
            showActiveApp
            emptyLabel="No games or apps in this window — start tracking to see them here."
            footer={<HistoryUsageChart history={history} metric={histMetric} lookbackMs={lookbackMs} />}
          />
          <SessionLegend sessions={sessions ?? []} />
        </Panel>
      </div>
    </Page>
  );
}

function SpecHero({ specs, latest }: { specs: import("@/lib/api").SystemSpecs; latest?: SystemSample }) {
  const enabled = useMotionEnabled();
  return (
    <motion.div
      initial={enabled ? { opacity: 0, y: 14 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="relative overflow-hidden rounded-3xl border border-line bg-bg-850/70 p-6 shadow-card"
    >
      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(120% 120% at 100% 0%, color-mix(in srgb, var(--accent-1) 16%, transparent), transparent 55%)" }} />
      <div className="relative flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-800 uppercase tracking-[0.22em] text-ink-dim">
            <Server className="h-3.5 w-3.5" /> {specs.osName || "Windows"}
          </div>
          <h2 className="mt-1 truncate font-display text-3xl font-800 tracking-tight">{specs.hostname || "This PC"}</h2>
          <div className="mt-1 flex items-center gap-3 text-xs text-ink-dim">
            <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> up {dur(specs.uptimeSecs)}</span>
            {specs.motherboard && <span className="truncate">· {specs.motherboard}</span>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Identity icon={<Cpu className="h-4 w-4 text-accent-3" />} label="Processor" value={specs.cpuName} sub={`${specs.cpuCores}C / ${specs.cpuThreads}T · ${specs.cpuGhz} GHz`} />
          <Identity icon={<Monitor className="h-4 w-4 text-accent-3" />} label="Graphics" value={specs.gpuNames[0] ?? "—"} sub={specs.gpuVramMb ? `${(specs.gpuVramMb / 1024).toFixed(0)} GB VRAM` : (specs.gpuNames[1] ?? "")} />
          <Identity icon={<MemoryStick className="h-4 w-4 text-accent-3" />} label="Memory" value={`${specs.ramTotalGb} GB`} sub={latest ? `${fmt(latest.ramUsedGb, " GB used", 1)}` : `${specs.swapTotalGb} GB swap`} />
          <Identity icon={<HardDrive className="h-4 w-4 text-accent-3" />} label="Storage" value={`${specs.disks.reduce((a, d) => a + d.totalGb, 0) >= 1024 ? (specs.disks.reduce((a, d) => a + d.totalGb, 0) / 1024).toFixed(1) + " TB" : specs.disks.reduce((a, d) => a + d.totalGb, 0).toFixed(0) + " GB"}`} sub={`${specs.disks.length} ${specs.disks.length === 1 ? "drive" : "drives"}`} />
        </div>
      </div>
    </motion.div>
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

function GaugeCard({ panelKey, games, icon, label, pct, temp, from, to, sub }: { panelKey: string; games: Game[]; icon: React.ReactNode; label: string; pct: number; temp?: number | null; from: string; to: string; sub?: string }) {
  return (
    <Panel panelKey={panelKey} games={games} art="icon" className="flex flex-col items-center gap-2 py-5">
      <div className="flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">{icon}{label}</div>
      <RadialGauge value={pct} max={100} size={132} from={from} to={to}>
        <div className="text-center">
          <div className="font-display text-3xl font-800 tabular-nums leading-none">{Math.round(pct)}<span className="text-base text-ink-dim">%</span></div>
          {temp != null && (
            <div className="mt-1 inline-flex items-center gap-1 text-xs font-700" style={{ color: tempColor(temp) }}>
              <Thermometer className="h-3 w-3" />{Math.round(temp)}°
            </div>
          )}
        </div>
      </RadialGauge>
      {sub && <div className="text-[11px] text-ink-faint">{sub}</div>}
    </Panel>
  );
}

function LivePulse() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-700 text-green">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-green/70" />
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

function timeTick(t: number) {
  return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function LiveChart({ samples, kind }: { samples: SystemSample[]; kind: "usage" | "temp" }) {
  const data = useMemo(() => chartData(samples), [samples]);
  if (data.length < 2) return <Skeleton className="h-[200px] w-full" />;
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
    <ResponsiveContainer width="100%" height={210}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`sg-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} scale="time" tickFormatter={timeTick} stroke="#454c66" fontSize={10} tickLine={false} axisLine={false} minTickGap={48} />
        <YAxis domain={isTemp ? [20, 100] : [0, 100]} stroke="#454c66" fontSize={10} tickLine={false} axisLine={false} width={42} unit={isTemp ? "°" : "%"} />
        <Tooltip content={<LiveTooltip isTemp={isTemp} />} />
        {series.map((s) => (
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} fill={`url(#sg-${s.key})`} isAnimationActive={false} connectNulls dot={false} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function LiveTooltip({ active, payload, label, isTemp }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-line bg-bg-800/95 px-3 py-2 text-xs shadow-float backdrop-blur">
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
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-8 xl:grid-cols-8">
      {cores.map((v, i) => (
        <div key={i} className="rounded-lg border border-line bg-white/[0.02] p-2">
          <div className="flex items-center justify-between text-[10px] text-ink-dim">
            <span>C{i}</span>
            <span className="tabular-nums font-700 text-ink-soft">{Math.round(v)}%</span>
          </div>
          <div className="mt-1.5">
            <LevelBar value={v} max={100} color={v > 85 ? "#f87171" : v > 55 ? "#fbbf24" : "#34d399"} delay={i * 0.01} />
          </div>
        </div>
      ))}
    </div>
  );
}

function GpuCard({ games, specs, latest }: { games: Game[]; specs: import("@/lib/api").SystemSpecs; latest?: SystemSample }) {
  const memPct = latest?.gpuMemUsedMb != null && latest?.gpuMemTotalMb ? (latest.gpuMemUsedMb / latest.gpuMemTotalMb) * 100 : 0;
  return (
    <Panel panelKey="systems.gpu" games={games} art="icon">
      <SectionTitle title="Graphics" subtitle={specs.gpuNames[0] ?? "GPU"} right={<Monitor className="h-4 w-4 text-ink-dim" />} />
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
        <EmptyState title="No GPU sensor data" message="The sensor bridge reports GPU temperature, load and VRAM for NVIDIA, AMD and Intel GPUs." />
      )}
    </Panel>
  );
}

function MemoryCard({ games, latest, swapTotal }: { games: Game[]; latest?: SystemSample; swapTotal: number }) {
  return (
    <Panel panelKey="systems.memory" games={games} art="icon">
      <SectionTitle title="Memory" subtitle="RAM & swap" right={<MemoryStick className="h-4 w-4 text-ink-dim" />} />
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
    </Panel>
  );
}

function StorageCard({ games, disks, activity }: { games: Game[]; disks: import("@/lib/api").DiskSpec[]; activity?: number | null }) {
  return (
    <Panel panelKey="systems.storage" games={games} art="icon">
      <SectionTitle title="Storage" subtitle={activity != null ? `${Math.round(activity)}% activity` : `${disks.length} drives`} right={<HardDrive className="h-4 w-4 text-ink-dim" />} />
      <div className="space-y-3">
        {disks.length === 0 && <EmptyState title="No drives detected" />}
        {disks.map((d) => {
          const pct = d.totalGb > 0 ? (d.usedGb / d.totalGb) * 100 : 0;
          const free = pct > 90 ? "#f87171" : pct > 75 ? "#fbbf24" : C.disk;
          return (
            <div key={d.mount + d.name}>
              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="font-700 text-ink">{d.mount}</span>
                  <Badge color={d.kind === "SSD" ? "#34d399" : d.kind === "HDD" ? "#60a5fa" : "#94a3b8"}>{d.kind}</Badge>
                  <span className="truncate text-ink-faint">{d.name}</span>
                </span>
                <span className="shrink-0 font-700 text-ink-soft">{fmtTB(d.usedGb)} / {fmtTB(d.totalGb)}</span>
              </div>
              <LevelBar value={pct} max={100} color={free} />
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function fmtTB(gb: number) {
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(0)} GB`;
}

function StatRow({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="flex items-center gap-1.5 text-ink-dim">{icon}{label}</span>
      <span className="font-800 tabular-nums" style={color ? { color } : undefined}>{value}</span>
    </div>
  );
}

function sessionLikelyOpen(s: import("@/lib/api").Session, now: number): boolean {
  return now - new Date(s.lastSeenUtc).getTime() < 8_000;
}

function HistoryUsageChart({
  history,
  metric,
  lookbackMs,
}: {
  history?: import("@/lib/api").SystemHistory;
  metric: "usage" | "temp";
  lookbackMs: number;
}) {
  const longRange = lookbackMs > 86_400_000;
  const axisTick = (t: number) =>
    longRange
      ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : timeTick(t);
  const tracking = useApp((s) => s.tracking);
  const data = useMemo(
    () =>
      (history?.points ?? []).map((p) => ({
        t: new Date(p.ts).getTime(),
        cpu: p.cpu,
        gpu: p.gpu ?? null,
        ram: p.ram,
        disk: p.disk ?? null,
        cpuTemp: p.cpuTemp ?? null,
        gpuTemp: p.gpuTemp ?? null,
        ramTemp: p.ramTemp ?? null,
      })),
    [history]
  );
  const now = useMemo(
    () => Date.now(),
    [
      tracking?.sessionActiveSeconds,
      tracking?.sessionRuntimeSeconds,
      tracking?.appSessionActiveSeconds,
      tracking?.isPlaying,
      tracking?.appIsActive,
      history?.sessions,
    ]
  );
  const from = now - lookbackMs;
  const isTemp = metric === "temp";
  const series = isTemp
    ? [{ key: "cpuTemp", name: "CPU °C", color: C.cpuTemp }, { key: "gpuTemp", name: "GPU °C", color: C.gpuTemp }, { key: "ramTemp", name: "RAM °C", color: C.ramTemp }]
    : [{ key: "cpu", name: "CPU", color: C.cpu }, { key: "gpu", name: "GPU", color: C.gpu }, { key: "ram", name: "RAM", color: C.ram }];

  if (data.length < 2) {
    return <EmptyState icon={<Activity className="h-6 w-6" />} title="Building history" message="Keep Tracker running — system history fills in over time and lines up with your sessions." />;
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`hg-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
        <XAxis dataKey="t" type="number" scale="time" domain={[from, now]} tickFormatter={axisTick} stroke="#454c66" fontSize={10} tickLine={false} axisLine={false} minTickGap={56} />
        <YAxis domain={isTemp ? [20, 100] : [0, 100]} stroke="#454c66" fontSize={10} tickLine={false} axisLine={false} width={42} unit={isTemp ? "°" : "%"} />
        <Tooltip content={<LiveTooltip isTemp={isTemp} />} />
        {series.map((s) => (
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} fill={`url(#hg-${s.key})`} isAnimationActive={false} connectNulls dot={false} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function SessionLegend({ sessions }: { sessions: import("@/lib/api").Session[] }) {
  const tracking = useApp((s) => s.tracking);
  const now = useMemo(
    () => Date.now(),
    [
      tracking?.sessionActiveSeconds,
      tracking?.appSessionActiveSeconds,
      tracking?.isPlaying,
      tracking?.appIsActive,
      sessions,
    ]
  );
  const items = useMemo(() => [...sessions].sort((a, b) => new Date(b.startUtc).getTime() - new Date(a.startUtc).getTime()).slice(0, 12), [sessions]);
  if (items.length === 0) return null;
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-700 uppercase tracking-wider text-ink-dim">
        Running in this window
        {items.some((s) => sessionLikelyOpen(s, now)) && <LivePulse />}
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((s) => {
          const live = sessionLikelyOpen(s, now);
          const liveActive =
            live && tracking?.gameId === s.gameId && tracking.isPlaying
              ? tracking.sessionActiveSeconds
              : live && tracking?.appId === s.gameId && tracking.appIsActive
                ? tracking.appSessionActiveSeconds
                : s.activeSeconds;
          return (
          <Link
            key={s.id}
            to={`/game/${s.gameId}`}
            className={`flex items-center gap-2 rounded-xl border py-1.5 pl-1.5 pr-3 transition hover:bg-white/[0.05] ${
              live ? "border-green/35 bg-green/[0.06]" : "border-line bg-white/[0.02]"
            }`}
          >
            <GameArt id={s.gameId} name={s.gameName} cover={s.coverPath} icon={s.iconPath} accent={s.accentColor} className="h-6 w-6" rounded="rounded-md" />
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-xs font-700">
                {s.kind === "app" ? <AppWindow className="h-3 w-3 text-ink-dim" /> : <Gamepad2 className="h-3 w-3 text-ink-dim" />}
                <span className="truncate max-w-[140px]">{s.gameName}</span>
                {live && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green shadow-[0_0_6px_var(--green)]" />}
              </div>
              <div className="text-[10px] font-700 text-green">{dur(liveActive)} active</div>
            </div>
          </Link>
        );})}
      </div>
    </div>
  );
}
