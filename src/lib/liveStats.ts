import { useEffect, useMemo, useState } from "react";
import type { EntryKind, Session } from "@/lib/api";
import { useApp } from "@/store/app";

export interface EntryTotals {
  totalRuntimeSeconds: number;
  totalActiveSeconds: number;
  sessionCount: number;
}

function isLiveEntry(
  entryId: string,
  kind: EntryKind,
  tracking: ReturnType<typeof useApp.getState>["tracking"]
): boolean {
  if (!tracking || tracking.paused) return false;
  if (kind === "app") return tracking.appIsActive && tracking.appId === entryId;
  return tracking.isPlaying && tracking.gameId === entryId;
}

function liveSessionSeconds(
  kind: EntryKind,
  tracking: NonNullable<ReturnType<typeof useApp.getState>["tracking"]>
) {
  if (kind === "app") {
    return {
      runtime: tracking.appSessionRuntimeSeconds ?? tracking.appSessionActiveSeconds ?? 0,
      active: tracking.appSessionActiveSeconds ?? 0,
    };
  }
  return {
    runtime: tracking.sessionRuntimeSeconds ?? 0,
    active: tracking.sessionActiveSeconds ?? 0,
  };
}

/** Tick every second while an entry is actively tracked; mirrors NowPlaying. */
export function useLiveEntryStats(
  entryId: string | undefined,
  kind: EntryKind,
  totals: EntryTotals | undefined,
  sessions?: Session[]
) {
  const tracking = useApp((s) => s.tracking);
  const live = !!entryId && !!totals && isLiveEntry(entryId, kind, tracking);
  const idle = !!tracking?.isIdle;

  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(0);
  }, [
    tracking?.sessionActiveSeconds,
    tracking?.sessionRuntimeSeconds,
    tracking?.appSessionActiveSeconds,
    tracking?.appSessionRuntimeSeconds,
    tracking?.gameId,
    tracking?.appId,
    entryId,
  ]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [live]);

  return useMemo(() => {
    if (!totals) {
      return { totalRuntimeSeconds: 0, totalActiveSeconds: 0, sessionCount: 0, isLive: false };
    }
    if (!live || !tracking || !entryId) {
      return { ...totals, isLive: false };
    }

    const sess = liveSessionSeconds(kind, tracking);
    const hasOpenRow = (sessions ?? []).some((s) => !s.endUtc);
    const sessionBonus = hasOpenRow ? 0 : 1;

    return {
      totalRuntimeSeconds: totals.totalRuntimeSeconds + sess.runtime + tick,
      totalActiveSeconds: totals.totalActiveSeconds + sess.active + (idle ? 0 : tick),
      sessionCount: totals.sessionCount + sessionBonus,
      isLive: true,
    };
  }, [totals, live, tracking, entryId, kind, tick, idle, sessions]);
}

/** Reactive clock for live session bars — same deps as Timeline. */
export function useLiveNowMs() {
  const tracking = useApp((s) => s.tracking);
  return useMemo(
    () => Date.now(),
    [
      tracking?.sessionActiveSeconds,
      tracking?.sessionRuntimeSeconds,
      tracking?.appSessionActiveSeconds,
      tracking?.appSessionRuntimeSeconds,
      tracking?.isPlaying,
      tracking?.appIsActive,
      tracking?.isIdle,
    ]
  );
}

/** Extra active seconds for open sessions in a filtered list (timeline insights). */
export function useLiveSessionBonus(
  sessions: Session[],
  kind: EntryKind
): number {
  const tracking = useApp((s) => s.tracking);
  const [tick, setTick] = useState(0);

  const hasLiveOpen = useMemo(() => {
    if (!tracking || tracking.paused) return false;
    return sessions.some((s) => {
      if (s.endUtc) return false;
      if (kind === "app") return tracking.appIsActive && tracking.appId === s.gameId;
      return tracking.isPlaying && tracking.gameId === s.gameId;
    });
  }, [sessions, tracking, kind]);

  useEffect(() => {
    setTick(0);
  }, [
    tracking?.sessionActiveSeconds,
    tracking?.sessionRuntimeSeconds,
    tracking?.appSessionActiveSeconds,
    tracking?.appSessionRuntimeSeconds,
  ]);

  useEffect(() => {
    if (!hasLiveOpen) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasLiveOpen]);

  if (!hasLiveOpen || !tracking) return 0;
  const idle = tracking.isIdle;
  return idle ? 0 : tick;
}
