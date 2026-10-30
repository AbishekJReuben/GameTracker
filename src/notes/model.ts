// What the panel derives from the store: the flat row list the virtual list draws,
// and the words for the sync pill.

import type { ClipItem } from "@/lib/clip";
import { classifyClip, type ClipContent } from "@/lib/clipContent";

export type Row = { kind: "label"; key: string; text: string } | { kind: "note"; key: string; item: ClipItem };

/** Classifying is cheap per note and not per thousand. Rows are replaced when they
 *  change, so the object itself is the cache key. */
const classified = new WeakMap<ClipItem, ClipContent>();

export function contentOf(item: ClipItem): ClipContent {
  let found = classified.get(item);
  if (!found) {
    found = classifyClip(item.text);
    classified.set(item, found);
  }
  return found;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function dayLabel(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "Earlier";
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = then.getFullYear() === now.getFullYear();
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" });
}

export function buildRows(pinned: ClipItem[], rest: ClipItem[], now = new Date()): Row[] {
  const rows: Row[] = [];
  if (pinned.length > 0) {
    rows.push({ kind: "label", key: "label:pinned", text: "Pinned" });
    for (const item of pinned) rows.push({ kind: "note", key: item.id, item });
  }
  let last = "";
  for (const item of rest) {
    const day = dayLabel(item.createdUtc, now);
    if (day !== last) {
      rows.push({ kind: "label", key: `label:${day}`, text: day });
      last = day;
    }
    rows.push({ kind: "note", key: item.id, item });
  }
  return rows;
}

export type Tone = "ok" | "wait" | "warn" | "off";

const STALE_MS = 20_000;

/** The header pill. Sync runs in the main app, so a report that's stopped arriving
 *  means sync has paused, whatever the last report said. */
export function statusOf(report: Record<string, unknown> | null, now = Date.now()): { text: string; tone: Tone } {
  if (!report || report.started !== "true") return { text: "Sync off", tone: "off" };
  const at = Number(report.updatedMs ?? 0);
  if (now - at > STALE_MS) return { text: "Sync paused", tone: "warn" };
  if (report.wsState === "open") {
    const count = Number(report.deviceCount ?? 0);
    return { text: count > 1 ? `Synced · ${count} devices` : "Synced", tone: "ok" };
  }
  if (report.lastError && report.lastError !== "(none)") return { text: "Reconnecting…", tone: "warn" };
  return { text: "Connecting…", tone: "wait" };
}

/** The next note after `from`, skipping day labels. */
export function stepSelection(rows: Row[], from: string | null, by: 1 | -1): string | null {
  const notes = rows.filter((r): r is Extract<Row, { kind: "note" }> => r.kind === "note");
  if (notes.length === 0) return null;
  const at = notes.findIndex((r) => r.key === from);
  if (at < 0) return notes[by > 0 ? 0 : notes.length - 1].key;
  return notes[Math.max(0, Math.min(notes.length - 1, at + by))].key;
}
