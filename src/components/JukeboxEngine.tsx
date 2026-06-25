import { useCallback, useEffect, useRef } from "react";
import { assetUrl } from "@/lib/api";
import { useJukebox } from "@/store/jukebox";
import { useApp } from "@/store/app";

/**
 * Hidden YouTube iframe that is the actual audio engine, mounted once at app
 * root. Drives playback, reports progress to the store, auto-advances the queue,
 * and wires the OS Media Session (Windows media keys + on-screen scrubber).
 */
export function JukeboxEngine() {
  const tracks = useJukebox((s) => s.tracks);
  const index = useJukebox((s) => s.index);
  const playing = useJukebox((s) => s.playing);
  const active = useJukebox((s) => s.active);
  const volume = useJukebox((s) => s.volume);
  const progress = useJukebox((s) => s.progress);
  const duration = useJukebox((s) => s.duration);
  const seekNonce = useJukebox((s) => s.seekNonce);
  const play = useJukebox((s) => s.play);
  const pause = useJukebox((s) => s.pause);
  const next = useJukebox((s) => s.next);
  const prev = useJukebox((s) => s.prev);
  const ended = useJukebox((s) => s.ended);
  const setProgress = useJukebox((s) => s.setProgress);
  const seekTo = useJukebox((s) => s.seekTo);
  const muted = useApp((s) => s.prefs.themeMuted);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const didGesture = useRef(false);
  const lastEndedAt = useRef(0);
  const track = tracks[index];

  const ytCommand = useCallback((func: string, args: unknown[] = []) => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*"
    );
  }, []);

  const applyVolume = useCallback(() => {
    if (!track) return;
    if (muted) {
      ytCommand("mute");
    } else {
      ytCommand("unMute");
      ytCommand("setVolume", [volume]);
    }
    if (playing) ytCommand("playVideo");
    else ytCommand("pauseVideo");
  }, [muted, volume, playing, track, ytCommand]);

  const loadTrack = useCallback(
    (i: number, autoplay: boolean) => {
      const t = tracks[i];
      if (!t) return;
      ytCommand("loadVideoById", [t.vid, 0, "default"]);
      if (autoplay) {
        ytCommand("playVideo");
        if (!muted) {
          ytCommand("unMute");
          ytCommand("setVolume", [volume]);
        }
      }
    },
    [tracks, muted, volume, ytCommand]
  );

  // Re-apply mute/volume/play-state whenever they change.
  useEffect(() => {
    applyVolume();
  }, [applyVolume]);

  // Load a new track when the current index/vid changes.
  useEffect(() => {
    if (!track || !ready.current) return;
    loadTrack(index, playing);
    ytCommand("getVideoData");
  }, [index, track?.vid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Honor explicit seek requests from the store (seek bar, repeat-one, prev-restart).
  useEffect(() => {
    if (!seekNonce) return;
    const { seekSeconds } = useJukebox.getState();
    ytCommand("seekTo", [seekSeconds, true]);
    ytCommand("playVideo");
    ytCommand("getVideoData");
  }, [seekNonce, ytCommand]);

  // YouTube only pushes infoDelivery on demand — poll while playing so the seek bar moves.
  useEffect(() => {
    if (!active || !playing || !ready.current) return;
    ytCommand("getVideoData");
    const id = window.setInterval(() => ytCommand("getVideoData"), 400);
    return () => clearInterval(id);
  }, [active, playing, track?.vid, ytCommand]);

  // Progress + auto-advance from the player's postMessages.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      let d: { event?: string; info?: unknown };
      try {
        d = JSON.parse(e.data);
      } catch {
        return;
      }
      const fireEnded = () => {
        // De-dupe the burst of end events YouTube can emit around a track switch.
        const now = Date.now();
        if (now - lastEndedAt.current < 1500) return;
        lastEndedAt.current = now;
        ended();
      };
      if (d.event === "infoDelivery" && d.info && typeof d.info === "object") {
        const info = d.info as { currentTime?: number; duration?: number; playerState?: number };
        if (typeof info.currentTime === "number" && typeof info.duration === "number" && info.duration > 0) {
          setProgress(info.currentTime, info.duration);
        }
        if (info.playerState === 0) fireEnded();
      } else if (d.event === "onStateChange" && d.info === 0) {
        fireEnded();
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [ended, setProgress]);

  // First user gesture unlocks audible autoplay (browsers block it otherwise).
  useEffect(() => {
    const onGesture = () => {
      if (didGesture.current) return;
      didGesture.current = true;
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      if (!muted && playing) {
        ytCommand("unMute");
        ytCommand("setVolume", [volume]);
        ytCommand("playVideo");
      }
    };
    window.addEventListener("pointerdown", onGesture, true);
    window.addEventListener("keydown", onGesture, true);
    return () => {
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
    };
  }, [muted, playing, volume, ytCommand]);

  // ---- OS Media Session: metadata + play state + scrubber ----
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;

    if (!active || !track) {
      ms.playbackState = "none";
      ms.metadata = null;
      return;
    }

    const art = assetUrl(track.coverPath || track.iconPath);
    ms.metadata = new MediaMetadata({
      title: track.label,
      artist: track.gameName,
      album: "GameTracker Jukebox",
      artwork: art
        ? [
            { src: art, sizes: "96x96", type: "image/png" },
            { src: art, sizes: "256x256", type: "image/png" },
            { src: art, sizes: "512x512", type: "image/png" },
          ]
        : [],
    });
    ms.playbackState = playing ? "playing" : "paused";
  }, [active, track, playing]);

  // Keep the OS scrubber in sync with playback position.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!active || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(progress, duration),
        playbackRate: 1,
      });
    } catch {
      /* some platforms throw on bad ranges */
    }
  }, [active, progress, duration]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;

    const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ["play", () => play()],
      ["pause", () => pause()],
      ["nexttrack", () => next()],
      ["previoustrack", () => prev()],
      ["stop", () => pause()],
      [
        "seekto",
        (d) => {
          if (typeof d.seekTime === "number") seekTo(d.seekTime);
        },
      ],
      [
        "seekforward",
        (d) => seekTo(useJukebox.getState().progress + (d.seekOffset || 10)),
      ],
      [
        "seekbackward",
        (d) => seekTo(Math.max(0, useJukebox.getState().progress - (d.seekOffset || 10))),
      ],
    ];

    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* unsupported action on this platform */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
    };
  }, [play, pause, next, prev, seekTo]);

  if (!active || !track) return null;

  const ytSrc = `https://www.youtube-nocookie.com/embed/${track.vid}?enablejsapi=1&autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0&iv_load_policy=3`;

  return (
    <iframe
      ref={iframeRef}
      key="jukebox-engine"
      src={ytSrc}
      title={`${track.label} — jukebox`}
      allow="autoplay; encrypted-media"
      tabIndex={-1}
      aria-hidden
      onLoad={() => {
        ready.current = true;
        iframeRef.current?.contentWindow?.postMessage(
          JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
          "*"
        );
        applyVolume();
        if (playing) loadTrack(index, true);
        ytCommand("getVideoData");
      }}
      className="pointer-events-none fixed bottom-0 left-0 h-px w-px opacity-[0.001]"
    />
  );
}
