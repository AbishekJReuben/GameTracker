import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { api, MediaState, TrackingState } from "./api";
import { isTauri } from "./tauri";
import { useApp } from "@/store/app";
import { useProgress } from "@/store/progress";
import { useMediaStore } from "@/store/media";

interface SessionEvent {
  kind: "start" | "end";
  gameName: string;
  iconPath: string | null;
}

interface TaskProgressEvent {
  jobId: string;
  done: number;
  total: number;
  detail?: string | null;
}

/** Wires Tauri backend events into the React app. Mount once at the root. */
export function useTauriBridge() {
  const setTracking = useApp((s) => s.setTracking);
  const pushToast = useApp((s) => s.pushToast);
  const qc = useQueryClient();
  const lastLiveRefresh = useRef(0);
  const lastMediaRefresh = useRef(0);
  const lastMediaKey = useRef("");

  useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;

    // Seed initial state.
    api.trackingState().then((t) => mounted && setTracking(t)).catch(() => {});

    const unlistenState = listen<TrackingState>("tracking://state", (e) => {
      const st = e.payload;
      setTracking(st);
      // While something is actively tracked, keep timelines/sessions live by
      // refreshing the in-progress session rows — throttled so we don't thrash.
      if (st.isPlaying || st.appIsActive) {
        const now = Date.now();
        if (now - lastLiveRefresh.current > 4000) {
          lastLiveRefresh.current = now;
          qc.invalidateQueries({ queryKey: ["sessions"] });
          qc.invalidateQueries({ queryKey: ["systemHistory"] });
        }
      }
    });

    // Live "now listening" (SMTC). Update the store every tick; refresh the
    // music analytics queries only when the track actually changes (throttled).
    const unlistenMedia = listen<MediaState>("media://state", (e) => {
      const st = e.payload;
      useMediaStore.getState().setMedia(st);
      const key = `${st.title ?? ""}|${st.artist ?? ""}|${st.playing}`;
      const now = Date.now();
      if (key !== lastMediaKey.current && now - lastMediaRefresh.current > 4000) {
        lastMediaKey.current = key;
        lastMediaRefresh.current = now;
        qc.invalidateQueries({ queryKey: ["music"] });
      }
    });

    const unlistenSession = listen<SessionEvent>("session://event", (e) => {
      const { kind, gameName, iconPath } = e.payload;
      pushToast({
        kind: kind === "start" ? "play" : "stop",
        title: kind === "start" ? "Now tracking" : "Session saved",
        message: gameName,
        icon: iconPath,
      });
      // A session boundary changes what's on the timeline — refresh either way.
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: ["systemHistory"] });
      if (kind === "end") {
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        qc.invalidateQueries({ queryKey: ["games"] });
        qc.invalidateQueries({ queryKey: ["heatmap"] });
      }
    });

    const unlistenShot = listen<{ gameId: string }>("screenshot://captured", (e) => {
      qc.invalidateQueries({ queryKey: ["screenshots", e.payload.gameId] });
    });

    // Auto-enrichment finished for a freshly added game — refresh so its cover,
    // tags, and metadata appear without the user reloading.
    const unlistenEnriched = listen<{ id: string }>("game://enriched", (e) => {
      qc.invalidateQueries({ queryKey: ["games"] });
      qc.invalidateQueries({ queryKey: ["game", e.payload.id] });
    });

    const unlistenBreak = listen<{ minutes: number }>("reminder://break", (e) => {
      pushToast({
        kind: "info",
        title: "Time for a break",
        message: `You've been playing for ${e.payload.minutes} min straight. Stretch, hydrate, rest your eyes.`,
      });
    });

    const unlistenTask = listen<TaskProgressEvent>("task://progress", (e) => {
      const { jobId, done, total, detail } = e.payload;
      const prog = useProgress.getState();
      const job = prog.jobs.find((j) => j.id === jobId);
      if (job) {
        prog.patchJob(jobId, {
          done,
          total: total > 0 ? total : job.total,
          detail: detail ?? job.detail,
        });
      }
    });

    return () => {
      mounted = false;
      unlistenState.then((f) => f());
      unlistenMedia.then((f) => f());
      unlistenSession.then((f) => f());
      unlistenShot.then((f) => f());
      unlistenEnriched.then((f) => f());
      unlistenBreak.then((f) => f());
      unlistenTask.then((f) => f());
    };
  }, [setTracking, pushToast, qc]);
}
