import { useCallback, useEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { Volume2, VolumeX, Music2 } from "lucide-react";
import type { Game } from "@/lib/api";
import { useApp } from "@/store/app";
import { useJukebox, useJukeboxOwnsPlayback } from "@/store/jukebox";
import { buildGameTrackList } from "@/lib/jukeboxTracks";
import { cn } from "@/lib/cn";

type Props = {
  youtubeId?: string | null;
  audioUrl?: string | null;
  name: string;
  /** When true (e.g. trailer playing), theme audio is paused and restored after. */
  suppressed?: boolean;
};

/**
 * Plays a game's theme while its detail page is open. Yields to the global
 * jukebox when it is active.
 */
export function ThemePlayer({ youtubeId, audioUrl, name, suppressed = false }: Props) {
  const jukeboxOwns = useJukeboxOwnsPlayback();
  const muted = useApp((s) => s.prefs.themeMuted);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const didAutoStart = useRef(false);
  const wasAudibleRef = useRef(false);

  const ytCommand = useCallback((func: string, args: unknown[] = []) => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*"
    );
  }, []);

  const applyMute = useCallback(() => {
    if (youtubeId) {
      if (muted) {
        ytCommand("mute");
      } else {
        ytCommand("unMute");
        ytCommand("setVolume", [55]);
        ytCommand("playVideo");
      }
    }
    const audio = audioRef.current;
    if (audio) {
      audio.muted = muted;
      if (!muted) audio.play().catch(() => {});
    }
  }, [muted, youtubeId, ytCommand]);

  useEffect(() => {
    if (jukeboxOwns) {
      if (youtubeId) ytCommand("pauseVideo");
      audioRef.current?.pause();
      return;
    }
    applyMute();
  }, [applyMute, jukeboxOwns, youtubeId, ytCommand]);

  useEffect(() => {
    if (jukeboxOwns) return;
    if (suppressed) {
      if (!muted) {
        wasAudibleRef.current = true;
        if (youtubeId) ytCommand("pauseVideo");
        audioRef.current?.pause();
      }
      return;
    }
    if (wasAudibleRef.current) {
      wasAudibleRef.current = false;
      if (!muted) {
        if (youtubeId) {
          ytCommand("playVideo");
          ytCommand("unMute");
          ytCommand("setVolume", [55]);
        }
        audioRef.current?.play().catch(() => {});
      }
    }
  }, [suppressed, muted, youtubeId, ytCommand, jukeboxOwns]);

  useEffect(() => {
    if (jukeboxOwns || (!youtubeId && !audioUrl)) return;
    const onGesture = () => {
      if (didAutoStart.current) return;
      didAutoStart.current = true;
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      applyMute();
    };
    window.addEventListener("pointerdown", onGesture, true);
    window.addEventListener("keydown", onGesture, true);
    return () => {
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
    };
  }, [youtubeId, audioUrl, applyMute, jukeboxOwns]);

  if (jukeboxOwns || (!youtubeId && !audioUrl)) return null;

  const ytSrc = youtubeId
    ? `https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&mute=1&controls=0&loop=1&playlist=${youtubeId}&modestbranding=1&playsinline=1&enablejsapi=1&disablekb=1&fs=0&rel=0&iv_load_policy=3`
    : undefined;

  return youtubeId ? (
    <iframe
      ref={iframeRef}
      src={ytSrc}
      title={`${name} theme`}
      allow="autoplay; encrypted-media"
      tabIndex={-1}
      aria-hidden
      onLoad={applyMute}
      className="pointer-events-none fixed bottom-0 right-0 h-px w-px opacity-[0.001]"
    />
  ) : (
    <audio ref={audioRef} src={audioUrl ?? undefined} autoPlay loop muted={muted} aria-hidden />
  );
}

/**
 * Compact header control for the ambient per-game theme. Toggles mute only — the
 * full soundtrack list lives in `SoundtrackPanel` (no clipped hover popover).
 */
export function ThemeToggleButton({ game, className }: { game: Game; className?: string }) {
  const muted = useApp((s) => s.prefs.themeMuted);
  const setPref = useApp((s) => s.setPref);
  const jukeboxOwns = useJukeboxOwnsPlayback();

  const trackCount = useMemo(() => buildGameTrackList(game).length, [game]);

  return (
    <motion.button
      type="button"
      onClick={() => setPref("themeMuted", !muted)}
      whileTap={{ scale: 0.96 }}
      title={
        jukeboxOwns
          ? "Jukebox is playing — per-game theme paused"
          : muted
            ? `Play ${game.displayName} theme`
            : "Mute theme"
      }
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-line bg-white/[0.04] px-3 py-1.5 text-xs font-700 text-ink-soft transition hover:text-ink",
        jukeboxOwns && "opacity-70",
        className
      )}
    >
      <span className="relative grid h-4 w-4 place-items-center">
        <Music2 className="h-3.5 w-3.5 text-accent" />
        {!muted && !jukeboxOwns && (
          <motion.span
            className="absolute inset-0 rounded-full"
            style={{ boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent-1) 50%, transparent)" }}
            animate={{ scale: [1, 1.6], opacity: [0.6, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
          />
        )}
      </span>
      {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
      <span>
        {jukeboxOwns ? "Jukebox" : muted ? "Theme" : "Playing"}
        {trackCount > 1 ? ` · ${trackCount}` : ""}
      </span>
    </motion.button>
  );
}
