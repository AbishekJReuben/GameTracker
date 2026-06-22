import { useId, useMemo } from "react";
import { motion } from "motion/react";
import { useMotionEnabled } from "@/store/app";

export function Sparkline({
  values,
  width = 240,
  height = 56,
  stroke = "var(--accent-3)",
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
}) {
  const rawId = useId();
  const id = rawId.replace(/:/g, "");
  const enabled = useMotionEnabled();
  const { line, area, lastPt } = useMemo(() => {
    const max = Math.max(1, ...values);
    const n = values.length;
    const stepX = n > 1 ? width / (n - 1) : width;
    const pts = values.map((v, i) => {
      const x = i * stepX;
      const y = height - 6 - (v / max) * (height - 12);
      return [x, y] as const;
    });
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const area = `${line} L${width},${height} L0,${height} Z`;
    const lastPt = pts.length > 0 ? pts[pts.length - 1] : ([0, height / 2] as const);
    return { line, area, lastPt };
  }, [values, width, height]);

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.4" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path
        d={area}
        fill={`url(#spark-${id})`}
        initial={enabled ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.2 }}
      />
      <motion.path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        initial={enabled ? { pathLength: 0, opacity: 0.6 } : false}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        style={{ filter: `drop-shadow(0 0 4px color-mix(in srgb, ${stroke} 60%, transparent))` }}
      />
      {values.length > 0 && (
        <>
          <motion.circle
            cx={lastPt[0]}
            cy={lastPt[1]}
            fill={stroke}
            initial={enabled ? { r: 0, opacity: 0 } : false}
            animate={enabled ? { r: [4, 7, 4], opacity: [0.12, 0.28, 0.12] } : { r: 4, opacity: 0.15 }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut", delay: 0.9 }}
          />
          <motion.circle
            cx={lastPt[0]}
            cy={lastPt[1]}
            r={3}
            fill={stroke}
            initial={enabled ? { scale: 0 } : false}
            animate={{ scale: 1 }}
            transition={{ delay: 0.85, type: "spring", stiffness: 400, damping: 18 }}
            style={{ filter: `drop-shadow(0 0 6px ${stroke})` }}
          />
        </>
      )}
    </svg>
  );
}
