import { useCallback, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { Volume2, VolumeX, Music2 } from "lucide-react";
import { useApp } from "@/store/app";

type Props = {
  youtubeId?: string | null;
  audioUrl?: string | null;
  name: string;
  /** When true (e.g. trailer playing), theme audio is paused and restored after. */
  suppressed?: boolean;
};

/**
 * Plays a game's theme while its detail page is open. Prefers a full-length
 * YouTube track (hidden, audio-only) and falls back to a 30s iTunes preview.
 *
 * WebViews block *audible* autoplay until a user gesture, so the element starts
 * muted; the first click/keypress anywhere re-applies the user's saved choice
 * (audible if they've unmuted, silent if not). The mute setting is a single
 * global preference (off for all games or on for all games) that persists across
 * games and restarts. The player unmounts when you leave, so the theme stops.
 */
export function ThemePlayer({ youtubeId, audioUrl, name, suppressed = false }: Props) {
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
    applyMute();
  }, [applyMute]);

  // Duck theme while trailer (or other media) is playing on the same page.
  useEffect(() => {
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
  }, [suppressed, muted, youtubeId, ytCommand]);

  // The first interaction satisfies the browser's gesture requirement, so we
  // re-apply the user's saved mute choice audibly. We never flip the setting
  // here — a globally-muted theme stays muted, so the preference is respected.
  useEffect(() => {
    if (!youtubeId && !audioUrl) return;
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
  }, [youtubeId, audioUrl, applyMute]);

  if (!youtubeId && !audioUrl) return null;

  const ytSrc = youtubeId
    ? `https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&mute=1&controls=0&loop=1&playlist=${youtubeId}&modestbranding=1&playsinline=1&enablejsapi=1&disablekb=1&fs=0&rel=0&iv_load_policy=3`
    : undefined;

  return youtubeId ? (
    // Kept in the DOM at ~zero size (not display:none, which would pause it).
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

/** Compact mute/play toggle for the theme — placed next to the game title. */
export function ThemeToggleButton({ name, className }: { name: string; className?: string }) {
  const muted = useApp((s) => s.prefs.themeMuted);
  const setPref = useApp((s) => s.setPref);
  return (
    <motion.button
      type="button"
      onClick={() => setPref("themeMuted", !muted)}
      whileTap={{ scale: 0.96 }}
      title={muted ? `Play ${name} theme` : "Mute theme"}
      className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-white/[0.04] px-3 py-1.5 text-xs font-700 text-ink-soft transition hover:text-ink ${className ?? ""}`}
    >
      <span className="relative grid h-4 w-4 place-items-center">
        <Music2 className="h-3.5 w-3.5 text-accent" />
        {!muted && (
          <motion.span
            className="absolute inset-0 rounded-full"
            style={{ boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent-1) 50%, transparent)" }}
            animate={{ scale: [1, 1.6], opacity: [0.6, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
          />
        )}
      </span>
      {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
      <span>{muted ? "Theme" : "Playing"}</span>
    </motion.button>
  );
}
