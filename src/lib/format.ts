/** Human duration: 1h 23m, 45m, 30s. */
export function dur(seconds: number, opts: { compact?: boolean } = {}): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return opts.compact ? `${h}h ${m}m` : `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

/** Split seconds into {h, m, s} for ticking timers. */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return {
    h: Math.floor(s / 3600),
    m: Math.floor((s % 3600) / 60),
    s: s % 60,
  };
}

export function clockString(seconds: number): string {
  const { h, m, s } = clock(seconds);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function hours(seconds: number, digits = 1): string {
  return (seconds / 3600).toFixed(digits);
}

/** HowLongToBeat estimates are stored as minutes — format like other durations. */
export function formatHltbMinutes(minutes: number): string {
  return dur(Math.max(0, Math.round(minutes)) * 60);
}

export function relativeTime(iso?: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Never";
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function dateLabel(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Time of day. Pass `use24` to force a 24-hour clock (Settings pref). */
export function timeLabel(iso?: string | null, use24 = false): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: use24 ? "2-digit" : "numeric",
    minute: "2-digit",
    hour12: !use24,
  });
}

/** Active ÷ runtime for session bars (0–1). */
export function sessionActiveRatio(runtimeSeconds: number, activeSeconds: number): number {
  if (runtimeSeconds > 0) return Math.min(1, activeSeconds / runtimeSeconds);
  if (activeSeconds > 0) return 1;
  return 0;
}

/** Bare hour label for timeline axes, e.g. "14:00" or "2 PM". */
export function hourLabel(hour: number, use24 = false): string {
  const h = ((hour % 24) + 24) % 24;
  if (use24) return `${String(h).padStart(2, "0")}:00`;
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/** Deterministic accent gradient from a string id (for placeholders). */
const ACCENTS: [string, string][] = [
  ["#7c5cff", "#3b82f6"],
  ["#22d3ee", "#3b82f6"],
  ["#34d399", "#22d3ee"],
  ["#f472b6", "#7c5cff"],
  ["#fbbf24", "#f472b6"],
  ["#60a5fa", "#34d399"],
  ["#a78bfa", "#22d3ee"],
  ["#fb923c", "#f472b6"],
];
export function accentFor(id: string): [string, string] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

export function initials(name: string): string {
  const words = name
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const a = words[0][0] ?? "?";
  const b = words[1][0] ?? "";
  return (a + b).toUpperCase();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Format optional year / month / day (any granularity). */
export function partialDate(
  year: number | null | undefined,
  month: number | null | undefined,
  day: number | null | undefined
): string {
  if (!year) return "—";
  if (month && day) return `${MONTHS[month - 1] ?? month} ${day}, ${year}`;
  if (month) return `${MONTHS[month - 1] ?? month} ${year}`;
  return String(year);
}
