import { useId, useMemo } from "react";
import { motion } from "motion/react";
import { ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, CartesianGrid, Cell } from "recharts";
import { useMotionEnabled } from "@/store/app";
import { dur, hourLabel } from "@/lib/format";

/* ===================== Hour-of-day radial clock =====================
   24 spokes around a circle; spoke length ∝ active seconds in that hour. */
export function PolarHours({ values, use24 = false }: { values: number[]; use24?: boolean }) {
  const enabled = useMotionEnabled();
  const size = 240;
  const cx = size / 2;
  const cy = size / 2;
  const innerR = 40;
  const maxLen = 64;
  const max = Math.max(1, ...values);
  const peak = values.indexOf(Math.max(...values));
  const total = values.reduce((a, b) => a + b, 0);

  const spokes = values.map((v, i) => {
    const t = ((i + 0.5) / 24) * Math.PI * 2 - Math.PI / 2;
    const len = innerR + (v / max) * maxLen;
    const intensity = Math.round((v / max) * 100);
    return {
      i,
      x1: cx + innerR * Math.cos(t),
      y1: cy + innerR * Math.sin(t),
      x2: cx + len * Math.cos(t),
      y2: cy + len * Math.sin(t),
      color: `color-mix(in srgb, var(--accent-3) ${intensity}%, var(--accent-1))`,
    };
  });

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={innerR + maxLen} fill="none" stroke="rgba(255,255,255,0.05)" />
        <circle cx={cx} cy={cy} r={innerR} fill="none" stroke="rgba(255,255,255,0.06)" />
        {[0, 6, 12, 18].map((h) => {
          const t = (h / 24) * Math.PI * 2 - Math.PI / 2;
          const r = innerR + maxLen + 12;
          return (
            <text key={h} x={cx + r * Math.cos(t)} y={cy + r * Math.sin(t)} fill="var(--color-ink-dim)" fontSize="10" textAnchor="middle" dominantBaseline="middle">
              {hourLabel(h, use24)}
            </text>
          );
        })}
        {spokes.map((s) => (
          <motion.line
            key={s.i}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke={s.color}
            strokeWidth={6}
            strokeLinecap="round"
            initial={enabled ? { pathLength: 0 } : false}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.7, delay: Math.min(s.i * 0.015, 0.35), ease: [0.22, 1, 0.36, 1] }}
            style={{ filter: "drop-shadow(0 0 3px color-mix(in srgb, var(--accent-1) 50%, transparent))" }}
          />
        ))}
        <text x={cx} y={cy - 6} fill="var(--color-ink)" fontSize="15" fontWeight="800" textAnchor="middle" className="font-display">
          {total > 0 ? hourLabel(peak, use24) : "—"}
        </text>
        <text x={cx} y={cy + 11} fill="var(--color-ink-dim)" fontSize="9" textAnchor="middle">
          PEAK HOUR
        </text>
      </svg>
    </div>
  );
}

/* ===================== Radar / spider chart ===================== */
export function RadarChart({ items, max }: { items: { label: string; value: number }[]; max?: number }) {
  const id = useId().replace(/:/g, "");
  const enabled = useMotionEnabled();
  const n = items.length;
  const size = 240;
  const cx = size / 2;
  const cy = size / 2;
  const R = 82;
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  const rings = [0.33, 0.66, 1];

  const pt = (i: number, r: number) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  };
  const poly = items.map((it, i) => pt(i, (it.value / top) * R));
  const polyStr = poly.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");

  if (n < 3) return <div className="grid h-[200px] place-items-center text-sm text-ink-dim">Need at least 3 categories</div>;

  return (
    <div className="flex justify-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id={`rad-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent-1)" stopOpacity={0.55} />
            <stop offset="100%" stopColor="var(--accent-3)" stopOpacity={0.35} />
          </linearGradient>
        </defs>
        {rings.map((r, ri) => (
          <polygon
            key={ri}
            points={items.map((_, i) => pt(i, R * r).join(",")).join(" ")}
            fill="none"
            stroke="rgba(255,255,255,0.06)"
          />
        ))}
        {items.map((_, i) => {
          const [x, y] = pt(i, R);
          return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(255,255,255,0.06)" />;
        })}
        <motion.polygon
          points={polyStr}
          fill={`url(#rad-${id})`}
          stroke="var(--accent-1)"
          strokeWidth={2}
          initial={enabled ? { scale: 0, opacity: 0 } : false}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          style={{ transformOrigin: `${cx}px ${cy}px` }}
        />
        {poly.map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r={3} fill="var(--accent-3)" />
        ))}
        {items.map((it, i) => {
          const [x, y] = pt(i, R + 16);
          return (
            <text key={i} x={x} y={y} fill="var(--color-ink-soft)" fontSize="10" fontWeight="600" textAnchor="middle" dominantBaseline="middle">
              {it.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

/* ===================== Weekday bars ===================== */
export function WeekdayBars({ values, labels }: { values: number[]; labels: string[] }) {
  const enabled = useMotionEnabled();
  const max = Math.max(1, ...values);
  const peak = values.indexOf(Math.max(...values));
  return (
    <div className="flex h-[180px] items-end gap-2.5 px-1">
      {values.map((v, i) => (
        <div key={i} className="flex flex-1 flex-col items-center justify-end gap-2">
          <span className="text-[10px] font-700 tabular-nums text-ink-soft">{v > 0 ? dur(v) : ""}</span>
          <motion.div
            className="w-full rounded-t-lg"
            style={{
              background: i === peak ? "linear-gradient(180deg,var(--accent-3),var(--accent-1))" : "linear-gradient(180deg, color-mix(in srgb,var(--accent-1) 70%,#0b0d16), color-mix(in srgb,var(--accent-1) 35%,#0b0d16))",
              boxShadow: i === peak ? "0 0 18px -4px var(--accent-1)" : undefined,
            }}
            initial={enabled ? { height: 0 } : false}
            animate={{ height: `${(v / max) * 130 + 4}px` }}
            transition={{ delay: i * 0.05, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          />
          <span className={`text-[11px] ${i === peak ? "font-800 text-ink" : "text-ink-dim"}`}>{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}

/* ===================== Playtime vs score bubble field ===================== */
export function BubbleField({ data }: { data: { name: string; hours: number; score: number; sessions: number; color: string }[] }) {
  const points = useMemo(() => data.map((d) => ({ ...d, z: Math.max(1, d.sessions) })), [data]);
  if (points.length === 0) return <div className="grid h-[220px] place-items-center text-sm text-ink-dim">No tracked & scored games yet</div>;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ScatterChart margin={{ top: 10, right: 16, left: -16, bottom: 0 }}>
        <CartesianGrid stroke="rgba(255,255,255,0.04)" />
        <XAxis type="number" dataKey="hours" name="Hours" stroke="#454c66" fontSize={11} tickLine={false} axisLine={false} unit="h" />
        <YAxis type="number" dataKey="score" name="Score" domain={[40, 100]} stroke="#454c66" fontSize={11} tickLine={false} axisLine={false} />
        <ZAxis type="number" dataKey="z" range={[60, 480]} name="Sessions" />
        <Tooltip
          cursor={{ strokeDasharray: "3 3" }}
          content={({ active, payload }: any) =>
            active && payload?.length ? (
              <div className="rounded-xl border border-line bg-bg-800/95 px-3 py-2 text-xs shadow-float backdrop-blur">
                <div className="font-800">{payload[0].payload.name}</div>
                <div className="text-ink-soft">
                  {payload[0].payload.hours}h · score {payload[0].payload.score} · {payload[0].payload.sessions} sessions
                </div>
              </div>
            ) : null
          }
        />
        <Scatter data={points} fillOpacity={0.65}>
          {points.map((p, i) => (
            <Cell key={i} fill={p.color} />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}
