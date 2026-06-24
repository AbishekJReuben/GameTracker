import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { DayValue } from "@/lib/api";
import { dur } from "@/lib/format";
import { useMotionEnabled } from "@/store/app";

const LEVEL_COLORS = [
  "rgba(255,255,255,0.05)",
  "color-mix(in srgb, var(--accent-1) 35%, transparent)",
  "color-mix(in srgb, var(--accent-1) 60%, transparent)",
  "color-mix(in srgb, var(--accent-3) 78%, transparent)",
  "color-mix(in srgb, var(--accent-3) 100%, transparent)",
];

const GLOW_COLORS = [
  "transparent",
  "color-mix(in srgb, var(--accent-1) 45%, transparent)",
  "color-mix(in srgb, var(--accent-1) 65%, transparent)",
  "color-mix(in srgb, var(--accent-3) 80%, transparent)",
  "color-mix(in srgb, var(--accent-3) 100%, transparent)",
];

function parseLocal(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
}

type Cell = {
  date: string;
  seconds: number;
  dt: Date;
  dow: number;
  level: number;
};

/** Measure the rendered width of an element so the grid can fill its container. */
function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function Heatmap({ data, maxStep = 22 }: { data: DayValue[]; maxStep?: number }) {
  const enabled = useMotionEnabled();
  const containerRef = useRef<HTMLDivElement>(null);
  const { ref: measureRef, width } = useMeasuredWidth();
  const [hovered, setHovered] = useState<{ cell: Cell; x: number; y: number } | null>(null);

  const { weeks, months, max, cellCount } = useMemo(() => {
    const max = Math.max(1, ...data.map((d) => d.seconds));
    const cells = data.map((d) => {
      const dt = parseLocal(d.date);
      const level = d.seconds <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((d.seconds / max) * 4)));
      return { ...d, dt, dow: dt.getDay(), level };
    });
    const pad = cells.length ? cells[0].dow : 0;
    const padded: (Cell | null)[] = [...Array(pad).fill(null), ...cells];
    const weeks: (Cell | null)[][] = [];
    for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));

    const months: { label: string; index: number }[] = [];
    let lastMonth = -1;
    weeks.forEach((w, i) => {
      const first = w.find((c) => c);
      if (first && first.dt.getMonth() !== lastMonth) {
        lastMonth = first.dt.getMonth();
        months.push({ label: first.dt.toLocaleString(undefined, { month: "short" }), index: i });
      }
    });
    return { weeks, months, max, cellCount: cells.length };
  }, [data]);

  // Size the cells so the whole grid fills the available width. The gap scales
  // with the cell so the look stays consistent from compact to ultra-wide windows.
  const { cell, gap, step } = useMemo(() => {
    const cols = Math.max(weeks.length, 1);
    if (width <= 0) return { cell: 12, gap: 3, step: 15 };
    const step = Math.min(maxStep, Math.max(10, width / cols));
    const gap = Math.max(2, Math.round(step * 0.2));
    const cell = Math.max(6, Math.floor(step - gap));
    return { cell, gap, step: cell + gap };
  }, [width, weeks.length, maxStep]);

  let cellIndex = 0;

  return (
    <div ref={containerRef} className="relative">
      <AnimatePresence>
        {hovered && (
          <motion.div
            key="heatmap-tip"
            initial={{ opacity: 0, y: 4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 2, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-none absolute z-20 -translate-x-1/2 rounded-lg border border-line bg-bg-900/95 px-2.5 py-1.5 text-[11px] font-600 text-ink shadow-float backdrop-blur-sm"
            style={{ left: hovered.x, top: hovered.y - 36 }}
          >
            <div className="text-ink-soft">
              {hovered.cell.dt.toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </div>
            <div className="text-ink-dim">{hovered.cell.seconds ? dur(hovered.cell.seconds) : "no play"}</div>
          </motion.div>
        )}
      </AnimatePresence>

      <div ref={measureRef} className="flex w-full flex-col gap-1.5">
        <div className="relative h-4">
          {months.map((m, mi) => (
            <motion.span
              key={`${m.label}-${m.index}`}
              initial={enabled ? { opacity: 0, y: -4 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: mi * 0.04, duration: 0.35 }}
              className="absolute text-[10px] font-600 text-ink-dim"
              style={{ left: m.index * step }}
            >
              {m.label}
            </motion.span>
          ))}
        </div>
        <div className="flex" style={{ gap }}>
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col" style={{ gap }}>
              {Array.from({ length: 7 }).map((_, di) => {
                const c = week[di];
                if (!c)
                  return (
                    <div
                      key={di}
                      className="rounded-[3px] bg-transparent"
                      style={{ width: cell, height: cell }}
                    />
                  );
                const idx = cellIndex++;
                const stagger = enabled ? (idx / cellCount) * 0.35 : 0;
                return (
                  <motion.div
                    key={di}
                    initial={enabled ? { opacity: 0, scale: 0.4 } : false}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: stagger, duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                    whileHover={
                      enabled
                        ? {
                            scale: 1.45,
                            zIndex: 10,
                            boxShadow: `0 0 10px ${GLOW_COLORS[c.level]}`,
                          }
                        : undefined
                    }
                    onMouseEnter={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      const parent = containerRef.current?.getBoundingClientRect();
                      if (!parent) return;
                      setHovered({
                        cell: c,
                        x: r.left - parent.left + r.width / 2,
                        y: r.top - parent.top,
                      });
                    }}
                    onMouseLeave={() => setHovered(null)}
                    className="cursor-default rounded-[3px] ring-1 ring-inset ring-white/[0.03]"
                    style={{ width: cell, height: cell, background: LEVEL_COLORS[c.level] }}
                  />
                );
              })}
            </div>
          ))}
        </div>
        <motion.div
          initial={enabled ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.4 }}
          className="mt-1 flex items-center gap-1.5 self-end text-[10px] text-ink-dim"
        >
          <span>Less</span>
          {LEVEL_COLORS.map((c, i) => (
            <span key={i} className="h-3 w-3 rounded-[3px]" style={{ background: c }} />
          ))}
          <span>More</span>
          <span className="ml-2 text-ink-faint">peak {dur(max)}</span>
        </motion.div>
      </div>
    </div>
  );
}
