/** Shared timeline zoom presets (finest = 5 minutes). */

export type TimelineRange = "5m" | "15m" | "30m" | "1h" | "6h" | "24h" | "1w" | "1m" | "1y";

export const TIMELINE_RANGE_OPTIONS: { value: TimelineRange; label: string }[] = [
  { value: "5m", label: "5 min" },
  { value: "15m", label: "15 min" },
  { value: "30m", label: "30 min" },
  { value: "1h", label: "1 hr" },
  { value: "6h", label: "6 hr" },
  { value: "24h", label: "24 hr" },
  { value: "1w", label: "1 week" },
  { value: "1m", label: "1 month" },
  { value: "1y", label: "1 year" },
];

export const SYSTEM_HISTORY_RANGES: { value: TimelineRange; label: string }[] = TIMELINE_RANGE_OPTIONS;

const DAY_MS = 86_400_000;

const MINUTE_MAP: Partial<Record<TimelineRange, number>> = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "6h": 360,
  "24h": 1440,
};

export function rangeToMinutes(range: TimelineRange): number | null {
  return MINUTE_MAP[range] ?? null;
}

/** How far back to load sessions / chart data for a zoom preset. */
export function rangeToLookbackMs(range: TimelineRange): number {
  const mins = rangeToMinutes(range);
  if (mins != null) return mins * 60_000;
  if (range === "1w") return 7 * DAY_MS;
  if (range === "1m") return 30 * DAY_MS;
  if (range === "1y") return 365 * DAY_MS;
  return 60 * 60_000;
}

/** Minutes passed to `system_history` (backend may clamp retention). */
export function rangeToHistoryMinutes(range: TimelineRange): number {
  const mins = rangeToMinutes(range);
  if (mins != null) return mins;
  if (range === "1w") return 7 * 1440;
  if (range === "1m") return 30 * 1440;
  if (range === "1y") return 365 * 1440;
  return 60;
}

export function normalizeTimelineRange(value: string | undefined): TimelineRange {
  if (value && TIMELINE_RANGE_OPTIONS.some((o) => o.value === value)) {
    return value as TimelineRange;
  }
  return "1h";
}
