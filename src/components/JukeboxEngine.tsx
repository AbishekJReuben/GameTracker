import { useCallback, useEffect, useRef } from "react";
import { assetUrl } from "@/lib/api";
import { useJukebox } from "@/store/jukebox";
import { useApp } from "@/store/app";

/** Hidden YouTube iframe + Media Session — mounted once at app root. */
export function JukeboxEngine() {
  const tracks = useJukebox((s) => s.tracks);
  const index = useJukebox((s) => s.index);
  const playing = useJukebox((s) => s.playing);
  const active = useJukebox((s) => s.active);
  const play = useJukebox((s) => s.play);
  const pause = useJukebox((s) => s.pause);
  const next = useJukebox((s) => s.next);
  const prev = useJukebox((s) => s.prev);
  const muted = useApp((s) => s.prefs.themeMuted);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const didGesture = useRef(false);
  const track = tracks[index];

  const ytCommand = useCallback((func: string, args: unknown[] = []) => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*"
    );
  }, []);

  const applyMute = useCallback(() => {
    if (!track) return;
    if (muted) ytCommand("mute");
    else {
      ytCommand("unMute");
      ytCommand("setVolume", [65]);
    }
    if (playing) ytCommand("playVideo");
    else ytCommand("pauseVideo");
  }, [muted, playing, track, ytCommand]);

  const loadTrack = useCallback(
    (i: number, autoplay: boolean) => {
      const t = tracks[i];
      if (!t) return;
      ytCommand("loadVideoById", [t.vid, 0, "default"]);
      if (autoplay) {
        ytCommand("playVideo");
        if (!muted) {
          ytCommand("unMute");
          ytCommand("setVolume", [65]);
        }
      }
    },
    [tracks, muted, ytCommand]
  );

  useEffect(() => {
    applyMute();
  }, [applyMute]);

  useEffect(() => {
    if (!track || !ready.current) return;
    loadTrack(index, playing);
  }, [index, track?.vid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      try {
        const d = JSON.parse(e.data) as { event?: string; info?: number };
        if (d.event === "onStateChange" && d.info === 0 && tracks.length > 1) {
          next();
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [tracks.length, next]);

  useEffect(() => {
    const onGesture = () => {
      if (didGesture.current) return;
      didGesture.current = true;
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      if (!muted && playing) {
        ytCommand("unMute");
        ytCommand("setVolume", [65]);
        ytCommand("playVideo");
      }
    };
    window.addEventListener("pointerdown", onGesture, true);
    window.addEventListener("keydown", onGesture, true);
    return () => {
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
    };
  }, [muted, playing, ytCommand]);

  // Windows / OS media overlay (play/pause/skip hardware keys).
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

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;

    const onPlay = () => play();
    const onPause = () => pause();
    const onNext = () => next();
    const onPrev = () => prev();

    ms.setActionHandler("play", onPlay);
    ms.setActionHandler("pause", onPause);
    ms.setActionHandler("nexttrack", onNext);
    ms.setActionHandler("previoustrack", onPrev);

    return () => {
      for (const action of ["play", "pause", "nexttrack", "previoustrack"] as const) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
    };
  }, [play, pause, next, prev]);

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
        applyMute();
        if (playing) loadTrack(index, true);
      }}
      className="pointer-events-none fixed bottom-0 left-0 h-px w-px opacity-[0.001]"
    />
  );
}
