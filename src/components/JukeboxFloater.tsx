import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ListMusic,
  Pause,
  Pin,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useJukebox } from "@/store/jukebox";
import { useApp } from "@/store/app";
import { assetUrl } from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { GameArt } from "./GameArt";
import { cn } from "@/lib/cn";

const TINY = 62;
const W = 348;
const EXPANDED_H_GUESS = 196;
const QUEUE_IDLE_MS = 1000;
const SPRING = { type: "spring" as const, stiffness: 380, damping: 42, mass: 0.88 };
const FADE = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };

function windowReady() {
  return window.innerWidth >= 200 && window.innerHeight >= 200;
}

function defaultFloaterPos(): { x: number; y: number } {
  const margin = 14;
  const nav = document.querySelector("aside nav");
  if (nav) {
    const rect = nav.getBoundingClientRect();
    return { x: margin, y: Math.round(rect.bottom + margin) };
  }
  return { x: margin, y: 36 + 72 + 9 * 44 + margin };
}

function clampPos(p: { x: number; y: number }, cardW: number) {
  if (!windowReady()) return p;
  return {
    x: Math.min(Math.max(8, p.x), window.innerWidth - cardW - 8),
    y: Math.min(Math.max(8, p.y), window.innerHeight - 80),
  };
}

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function MarqueeTitle({ text, className }: { text: string; className?: string }) {
  const long = text.length > 30;
  return (
    <div className={cn("overflow-hidden", className)}>
      <span className={cn("block truncate", long && "jukebox-marquee max-w-none whitespace-nowrap")}>{text}</span>
    </div>
  );
}

function Equalizer({ className, bars = 4 }: { className?: string; bars?: number }) {
  return (
    <span className={cn("flex h-3.5 items-end gap-[2px]", className)}>
      {Array.from({ length: bars }, (_, i) => (
        <motion.span
          key={i}
          className="w-[2px] rounded-full bg-gradient-to-t from-accent to-white"
          animate={{ height: ["22%", "100%", "35%", "90%", "22%"] }}
          transition={{ duration: 0.85, repeat: Infinity, ease: "easeInOut", delay: i * 0.14 }}
          style={{ height: "28%" }}
        />
      ))}
    </span>
  );
}

/**
 * Floating mini-player. Idle = cover disc with progress ring; hover / pin / queue
 * morphs into a glass control card. Position lives on a ref + DOM only (never
 * reset on minimize/restore). Width + height spring together for a smooth expand.
 */
export function JukeboxFloater() {
  const active = useJukebox((s) => s.active);
  const tracks = useJukebox((s) => s.tracks);
  const index = useJukebox((s) => s.index);
  const playing = useJukebox((s) => s.playing);
  const progress = useJukebox((s) => s.progress);
  const duration = useJukebox((s) => s.duration);
  const volume = useJukebox((s) => s.volume);
  const shuffle = useJukebox((s) => s.shuffle);
  const repeat = useJukebox((s) => s.repeat);
  const setFloaterPos = useJukebox((s) => s.setFloaterPos);
  const toggle = useJukebox((s) => s.toggle);
  const next = useJukebox((s) => s.next);
  const prev = useJukebox((s) => s.prev);
  const stop = useJukebox((s) => s.stop);
  const seekTo = useJukebox((s) => s.seekTo);
  const setVolume = useJukebox((s) => s.setVolume);
  const toggleShuffle = useJukebox((s) => s.toggleShuffle);
  const cycleRepeat = useJukebox((s) => s.cycleRepeat);
  const seek = useJukebox((s) => s.seek);
  const removeAt = useJukebox((s) => s.removeAt);
  const muted = useApp((s) => s.prefs.themeMuted);
  const setPref = useApp((s) => s.setPref);

  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<{ x: number; y: number } | null>(useJukebox.getState().floaterPos);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const sessionInitRef = useRef(false);
  const expandedRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [changed, setChanged] = useState(false);
  const [contentH, setContentH] = useState(EXPANDED_H_GUESS);

  const track = tracks[index];
  const audible = playing && !muted;
  const expanded = hovered || pinned || changed || showQueue;
  const pct = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;
  const cardH = expanded ? contentH : TINY;
  const coverUrl = assetUrl(track?.coverPath ?? track?.iconPath);

  expandedRef.current = expanded;

  const applyPosition = useCallback((p: { x: number; y: number }, persist = false) => {
    const cardW = expandedRef.current ? W : TINY;
    const clamped = clampPos(p, cardW);
    posRef.current = clamped;
    const el = hostRef.current;
    if (el) {
      el.style.left = `${clamped.x}px`;
      el.style.top = `${clamped.y}px`;
    }
    if (persist) setFloaterPos(clamped.x, clamped.y);
    return clamped;
  }, [setFloaterPos]);

  const scheduleReclamp = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!posRef.current || !windowReady()) return;
        applyPosition(posRef.current, false);
      });
    });
  }, [applyPosition]);

  // Initialise once per jukebox session.
  useEffect(() => {
    if (!active) {
      sessionInitRef.current = false;
      setReady(false);
      return;
    }
    if (sessionInitRef.current) return;
    sessionInitRef.current = true;
    const saved = useJukebox.getState().floaterPos;
    const initial = saved ?? posRef.current ?? defaultFloaterPos();
    applyPosition(initial, false);
    setReady(true);
  }, [active, applyPosition]);

  // When the card grows (hover / queue), keep it on-screen without jumping.
  useEffect(() => {
    if (!ready || !posRef.current) return;
    applyPosition(posRef.current, !!useJukebox.getState().floaterPos);
  }, [expanded, showQueue, ready, applyPosition]);

  // Fit shell height to real content (no dead padding at the bottom).
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!expanded || !el) return;
    const measure = () => setContentH(el.scrollHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, showQueue, tracks.length, index, track?.vid]);

  // Unpinned queue panel auto-closes after 1s without hover.
  useEffect(() => {
    if (!showQueue || pinned || hovered) return;
    const t = setTimeout(() => setShowQueue(false), QUEUE_IDLE_MS);
    return () => clearTimeout(t);
  }, [showQueue, pinned, hovered]);

  // Briefly pop open whenever the track changes.
  useEffect(() => {
    if (!active || !track) return;
    setChanged(true);
    const t = setTimeout(() => setChanged(false), 3200);
    return () => clearTimeout(t);
  }, [index, track?.vid, active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reclamp after real resize / restore — never while minimized (innerHeight ≈ 0 snaps to top).
  useEffect(() => {
    const onResize = () => scheduleReclamp();
    const onVisible = () => {
      if (document.visibilityState === "visible") scheduleReclamp();
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisible);

    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void getCurrentWindow()
        .onResized(() => scheduleReclamp())
        .then((fn) => {
          unlisten = fn;
        });
    }

    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisible);
      unlisten?.();
    };
  }, [scheduleReclamp]);

  // Window-level drag.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      e.preventDefault();
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 0) movedRef.current = true;
      applyPosition({
        x: e.clientX - dragOffsetRef.current.x,
        y: e.clientY - dragOffsetRef.current.y,
      });
    };
    const onUp = () => {
      if (!draggingRef.current || !posRef.current) return;
      draggingRef.current = false;
      applyPosition(posRef.current, true);
      if (!movedRef.current && !expandedRef.current) setPinned(true);
      movedRef.current = false;
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [applyPosition]);

  const onDragStart = (e: React.PointerEvent) => {
    if (!posRef.current) return;
    if ((e.target as HTMLElement).closest("button, input, [data-no-drag]")) return;
    draggingRef.current = true;
    movedRef.current = false;
    dragOffsetRef.current = { x: e.clientX - posRef.current.x, y: e.clientY - posRef.current.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onSeek = (e: React.MouseEvent) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    seekTo(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * duration);
  };

  if (!active || !track || !ready) return null;

  const VolIcon = muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  const ringR = 27;
  const ringC = 2 * Math.PI * ringR;

  return (
    <div
      ref={hostRef}
      className="jukebox-floater fixed z-[95] select-none"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {audible && (
        <motion.div
          className="pointer-events-none absolute -inset-4 -z-10 rounded-[32px]"
          style={{
            background: `radial-gradient(60% 60% at 50% 50%, color-mix(in srgb, ${track.accentColor ?? "var(--accent-1)"} 45%, transparent), transparent 72%)`,
          }}
          animate={{ opacity: [0.25, 0.7, 0.25], scale: [0.94, 1.06, 0.94] }}
          transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
        />
      )}

      <motion.div
        initial={false}
        animate={{ width: expanded ? W : TINY, height: cardH }}
        transition={SPRING}
        className="jukebox-floater-shell relative overflow-hidden rounded-[1.35rem] border border-white/[0.1] backdrop-blur-2xl"
        onPointerDown={onDragStart}
      >
        {coverUrl && (
          <div className="jukebox-floater-ambient pointer-events-none absolute inset-0 overflow-hidden opacity-50">
            <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute inset-0 bg-bg-900/55" />
          </div>
        )}

        {/* Tiny — crossfades out while the shell grows */}
        <motion.div
          className="absolute inset-0 z-20 cursor-grab touch-none active:cursor-grabbing"
          initial={false}
          animate={{ opacity: expanded ? 0 : 1, scale: expanded ? 0.9 : 1 }}
          transition={FADE}
          style={{ pointerEvents: expanded ? "none" : "auto" }}
          aria-hidden={expanded}
        >
          <div className="relative h-full w-full" style={{ width: TINY, height: TINY }} title={`${track.label} — ${track.gameName}`}>
            <GameArt
              id={track.gameId}
              name={track.gameName}
              cover={track.coverPath}
              icon={track.iconPath}
              accent={track.accentColor}
              className={cn("absolute inset-1 h-[calc(100%-8px)] w-[calc(100%-8px)] shadow-lg", audible && "animate-breathe")}
              rounded="rounded-[1.1rem]"
            />
            <div className="absolute inset-0 rounded-[1.35rem] bg-gradient-to-b from-white/[0.08] to-black/35" />
            <svg viewBox={`0 0 ${TINY} ${TINY}`} className="absolute inset-0 h-full w-full -rotate-90">
              <circle cx={TINY / 2} cy={TINY / 2} r={ringR} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="2.5" />
              <circle
                cx={TINY / 2}
                cy={TINY / 2}
                r={ringR}
                fill="none"
                stroke="url(#jukebox-ring)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={ringC}
                strokeDashoffset={ringC * (1 - pct / 100)}
              />
              <defs>
                <linearGradient id="jukebox-ring" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="var(--accent-1)" />
                  <stop offset="100%" stopColor="var(--accent-3)" />
                </linearGradient>
              </defs>
            </svg>
            <div className="absolute inset-0 grid place-items-center">
              {audible ? (
                <Equalizer bars={3} />
              ) : (
                <span className="grid h-8 w-8 place-items-center rounded-full bg-black/35 backdrop-blur-sm">
                  <Play className="h-3.5 w-3.5 text-white drop-shadow" />
                </span>
              )}
            </div>
          </div>
        </motion.div>

        {/* Expanded — height driven by content measurement */}
        <motion.div
          ref={contentRef}
          className="relative z-10"
          initial={false}
          animate={{ opacity: expanded ? 1 : 0 }}
          transition={{ ...FADE, delay: expanded ? 0.04 : 0 }}
          style={{ pointerEvents: expanded ? "auto" : "none" }}
          aria-hidden={!expanded}
        >
          {audible && (
            <motion.div
              className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px"
              style={{ background: "linear-gradient(90deg, transparent, var(--accent-1), var(--accent-3), transparent)" }}
              animate={{ opacity: [0.35, 1, 0.35] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
            />
          )}

          <div className="flex items-center gap-3 p-3.5 pb-2">
            <div className="relative shrink-0 cursor-grab touch-none active:cursor-grabbing">
              <div className={cn("rounded-xl p-0.5", audible && "bg-gradient-to-br from-accent/50 to-accent-3/30 shadow-glow")}>
                <GameArt
                  id={track.gameId}
                  name={track.gameName}
                  cover={track.coverPath}
                  icon={track.iconPath}
                  accent={track.accentColor}
                  className="h-[3.75rem] w-[2.85rem] shadow-lg"
                  rounded="rounded-[0.65rem]"
                />
              </div>
              {audible && <Equalizer className="absolute -bottom-1 left-1/2 -translate-x-1/2 drop-shadow-md" bars={3} />}
            </div>

            <div className="min-w-0 flex-1">
              <MarqueeTitle text={track.label} className="text-sm font-800 text-ink" />
              <MarqueeTitle text={track.gameName} className="mt-0.5 text-[11px] text-ink-soft" />
              <div className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-800 tabular-nums text-ink-faint">
                <span className="text-accent">{index + 1}</span>
                <span>/</span>
                <span>{tracks.length}</span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-0.5" data-no-drag>
              <button
                type="button"
                onClick={() => setShowQueue((q) => !q)}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-lg transition hover:bg-white/[0.08]",
                  showQueue ? "text-accent" : "text-ink-faint hover:text-ink"
                )}
                title={showQueue ? "Hide queue" : "Show queue"}
              >
                <ListMusic className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setPinned((p) => !p)}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-lg transition hover:bg-white/[0.08]",
                  pinned ? "text-accent" : "text-ink-faint hover:text-ink"
                )}
                title={pinned ? "Unpin" : "Keep open"}
              >
                <Pin className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={stop}
                className="grid h-7 w-7 place-items-center rounded-lg text-ink-faint transition hover:bg-white/[0.08] hover:text-ink"
                title="Stop jukebox"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="px-3.5" data-no-drag>
            <div className="group relative h-2 cursor-pointer rounded-full bg-white/10" onClick={onSeek}>
              <div
                className={cn("absolute inset-y-0 left-0 rounded-full", audible ? "jukebox-progress-live" : "bg-accent")}
                style={{ width: `${pct}%` }}
              />
              <div
                className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow-lg ring-2 ring-accent/40 transition-opacity group-hover:opacity-100"
                style={{ left: `${pct}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] tabular-nums text-ink-faint">
              <span>{fmt(progress)}</span>
              <span>{duration > 0 ? fmt(duration) : "--:--"}</span>
            </div>
          </div>

          <div className="flex items-center justify-between px-3 pb-1 pt-1.5" data-no-drag>
            <button
              type="button"
              onClick={toggleShuffle}
              className={cn("grid h-8 w-8 place-items-center rounded-xl transition hover:bg-white/[0.08]", shuffle ? "text-accent" : "text-ink-faint hover:text-ink")}
              title={shuffle ? "Shuffle on" : "Shuffle off"}
            >
              <Shuffle className="h-3.5 w-3.5" />
            </button>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={prev} className="btn btn-ghost h-9 w-9 rounded-xl p-0" title="Previous">
                <SkipBack className="h-4 w-4" />
              </button>
              <button type="button" onClick={toggle} className="btn btn-primary h-11 w-11 rounded-xl p-0 shadow-glow" title={playing ? "Pause" : "Play"}>
                {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
              <button type="button" onClick={next} className="btn btn-ghost h-9 w-9 rounded-xl p-0" title="Next">
                <SkipForward className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={cycleRepeat}
              className={cn("grid h-8 w-8 place-items-center rounded-xl transition hover:bg-white/[0.08]", repeat !== "off" ? "text-accent" : "text-ink-faint hover:text-ink")}
              title={`Repeat: ${repeat}`}
            >
              {repeat === "one" ? <Repeat1 className="h-3.5 w-3.5" /> : <Repeat className="h-3.5 w-3.5" />}
            </button>
          </div>

          <div className="flex items-center gap-2 px-3.5 pb-2 pt-0.5" data-no-drag>
            <button
              type="button"
              onClick={() => setPref("themeMuted", !muted)}
              className="grid h-7 w-7 place-items-center rounded-lg text-ink-soft transition hover:bg-white/[0.08] hover:text-ink"
              title={muted ? "Unmute" : "Mute"}
            >
              <VolIcon className="h-4 w-4" />
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (muted && v > 0) setPref("themeMuted", false);
                setVolume(v);
              }}
              className="jukebox-volume h-1.5 flex-1 cursor-pointer appearance-none rounded-full"
              style={{ background: `linear-gradient(to right, var(--accent-1) ${muted ? 0 : volume}%, rgba(255,255,255,0.1) ${muted ? 0 : volume}%)` }}
              title="Volume"
            />
            <span className="w-6 text-right text-[10px] tabular-nums text-ink-faint">{muted ? 0 : volume}</span>
          </div>

          {showQueue && tracks.length > 0 && (
            <div className="border-t border-white/[0.08]" data-no-drag>
              <div className="flex items-center gap-2 px-3.5 py-2 text-[10px] font-800 uppercase tracking-wider text-ink-dim">
                <ListMusic className="h-3.5 w-3.5 text-accent" />
                Queue · {tracks.length}
              </div>
              <ul className="max-h-[240px] space-y-0.5 overflow-y-auto px-2 pb-2.5 [scrollbar-width:thin]">
                {tracks.map((t, i) => {
                  const isCurrent = i === index;
                  return (
                    <li
                      key={`${t.gameId}-${t.vid}-${i}`}
                      className={cn(
                        "group flex items-center gap-2 rounded-xl px-1.5 py-1 transition",
                        isCurrent ? "bg-accent/12 ring-1 ring-accent/35" : "hover:bg-white/[0.05]"
                      )}
                    >
                      <button type="button" onClick={() => seek(i)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                        <span className="w-4 shrink-0 text-center text-[10px] font-800 tabular-nums text-ink-faint">
                          {isCurrent && audible ? "♪" : i + 1}
                        </span>
                        <GameArt
                          id={t.gameId}
                          name={t.gameName}
                          cover={t.coverPath}
                          icon={t.iconPath}
                          accent={t.accentColor}
                          className="h-7 w-5 shrink-0"
                          rounded="rounded-md"
                        />
                        <span className="min-w-0 flex-1">
                          <span className={cn("block truncate text-[11px] font-700", isCurrent ? "text-accent" : "text-ink-soft")}>
                            {t.label}
                          </span>
                          <span className="block truncate text-[9px] text-ink-faint">{t.gameName}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeAt(i)}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-faint opacity-0 transition hover:bg-white/[0.08] hover:text-ink group-hover:opacity-100"
                        title="Remove from queue"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </motion.div>
      </motion.div>
    </div>
  );
}
