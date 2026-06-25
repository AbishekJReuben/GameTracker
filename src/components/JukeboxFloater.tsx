import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ChevronDown,
  ChevronUp,
  GripHorizontal,
  ListMusic,
  Music2,
  Pause,
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
import { GameArt } from "./GameArt";
import { cn } from "@/lib/cn";

const W = 248;
const FULL_H = 118;

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Tiny animated equalizer used to signal live playback. */
function Equalizer({ active }: { active: boolean }) {
  return (
    <span className="flex h-2.5 items-end gap-[2px]">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="w-[2px] rounded-full bg-accent"
          animate={active ? { height: ["25%", "100%", "40%", "80%", "25%"] } : { height: "30%" }}
          transition={active ? { duration: 0.9, repeat: Infinity, ease: "easeInOut", delay: i * 0.16 } : { duration: 0.2 }}
          style={{ height: "30%" }}
        />
      ))}
    </span>
  );
}

/** Draggable mini music player — visible on every page while the jukebox is active. */
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
  const collapsed = useJukebox((s) => s.collapsed);
  const floaterPos = useJukebox((s) => s.floaterPos);
  const setFloaterPos = useJukebox((s) => s.setFloaterPos);
  const toggle = useJukebox((s) => s.toggle);
  const next = useJukebox((s) => s.next);
  const prev = useJukebox((s) => s.prev);
  const stop = useJukebox((s) => s.stop);
  const seekTo = useJukebox((s) => s.seekTo);
  const setVolume = useJukebox((s) => s.setVolume);
  const toggleShuffle = useJukebox((s) => s.toggleShuffle);
  const cycleRepeat = useJukebox((s) => s.cycleRepeat);
  const setCollapsed = useJukebox((s) => s.setCollapsed);
  const muted = useApp((s) => s.prefs.themeMuted);
  const setPref = useApp((s) => s.setPref);

  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const [pos, setPos] = useState<{ x: number; y: number } | null>(floaterPos);

  const track = tracks[index];
  const upNext = tracks[(index + 1) % Math.max(1, tracks.length)];

  const defaultPos = useCallback(() => {
    const margin = 16;
    return {
      x: Math.max(margin, Math.round((window.innerWidth - W) / 2)),
      y: Math.max(margin, window.innerHeight - FULL_H - margin),
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    if (floaterPos) {
      setPos(floaterPos);
      return;
    }
    const p = defaultPos();
    setPos(p);
    setFloaterPos(p.x, p.y);
  }, [active, floaterPos, defaultPos, setFloaterPos]);

  useEffect(() => {
    const onResize = () => {
      setPos((cur) => {
        if (!cur) return cur;
        const clamped = {
          x: Math.min(Math.max(8, cur.x), window.innerWidth - W - 8),
          y: Math.min(Math.max(8, cur.y), window.innerHeight - 64),
        };
        setFloaterPos(clamped.x, clamped.y);
        return clamped;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setFloaterPos]);

  const onDragStart = (e: React.PointerEvent) => {
    if (!pos) return;
    dragging.current = true;
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const x = Math.min(Math.max(8, e.clientX - dragOffset.current.x), window.innerWidth - W - 8);
    const y = Math.min(Math.max(8, e.clientY - dragOffset.current.y), window.innerHeight - 64);
    setPos({ x, y });
  };
  const onDragEnd = (e: React.PointerEvent) => {
    if (!dragging.current || !pos) return;
    dragging.current = false;
    setFloaterPos(pos.x, pos.y);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onSeek = (e: React.MouseEvent) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    seekTo(frac * duration);
  };

  if (!active || !track || !pos) return null;

  const pct = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;
  const audible = playing && !muted;
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  const volPct = muted ? 0 : volume;

  return (
    <motion.div
      className="fixed z-[95] select-none"
      style={{ left: pos.x, top: pos.y, width: W }}
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
    >
      {audible && (
        <motion.div
          className="pointer-events-none absolute -inset-1.5 -z-10 rounded-2xl"
          style={{ background: "radial-gradient(60% 60% at 50% 50%, color-mix(in srgb, var(--accent-1) 30%, transparent), transparent 70%)" }}
          animate={{ opacity: [0.3, 0.6, 0.3], scale: [0.99, 1.01, 0.99] }}
          transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      <div className="relative overflow-hidden rounded-xl border border-line bg-bg-850/95 shadow-float backdrop-blur-xl">
        {audible && (
          <motion.div
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px"
            style={{ background: "linear-gradient(90deg, transparent, var(--accent-1), transparent)" }}
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
          />
        )}

        <div
          className="flex cursor-grab items-center gap-1 border-b border-line/80 bg-white/[0.03] px-2 py-1 active:cursor-grabbing"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <GripHorizontal className="h-3 w-3 text-ink-faint" />
          {audible ? <Equalizer active /> : <Music2 className="h-2.5 w-2.5 text-accent" />}
          <span className="flex-1 truncate text-[9px] font-800 uppercase tracking-wider text-ink-dim">Jukebox</span>
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="grid h-5 w-5 place-items-center rounded-md text-ink-faint transition hover:bg-white/[0.06] hover:text-ink"
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={stop}
            className="grid h-5 w-5 place-items-center rounded-md text-ink-faint transition hover:bg-white/[0.06] hover:text-ink"
            title="Stop jukebox"
          >
            <X className="h-3 w-3" />
          </button>
        </div>

        <div className="flex items-center gap-2 px-2 pt-1.5">
          <div className="relative shrink-0">
            <GameArt
              id={track.gameId}
              name={track.gameName}
              cover={track.coverPath}
              icon={track.iconPath}
              accent={track.accentColor}
              className={cn("h-9 w-7", audible && "ring-1 ring-accent/50")}
              rounded="rounded-md"
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-800 leading-tight text-ink">{track.label}</div>
            <div className="truncate text-[9px] text-ink-soft">
              {track.gameName} · {index + 1}/{tracks.length}
            </div>
          </div>
        </div>

        <div className="px-2 pt-1.5">
          <div className="group relative h-1 cursor-pointer rounded-full bg-white/10" onClick={onSeek}>
            <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-0.5 flex justify-between text-[9px] tabular-nums text-ink-faint">
            <span>{fmt(progress)}</span>
            <span>{duration > 0 ? fmt(duration) : "--:--"}</span>
          </div>
        </div>

        <div className="flex items-center justify-between px-1.5 pt-0.5">
          <button
            type="button"
            onClick={toggleShuffle}
            className={cn(
              "grid h-6 w-6 place-items-center rounded-md transition hover:bg-white/[0.06]",
              shuffle ? "text-accent" : "text-ink-faint hover:text-ink"
            )}
            title={shuffle ? "Shuffle on" : "Shuffle off"}
          >
            <Shuffle className="h-3 w-3" />
          </button>
          <div className="flex items-center gap-0.5">
            <button type="button" onClick={prev} className="btn btn-ghost h-7 w-7 p-0" title="Previous">
              <SkipBack className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={toggle} className="btn btn-primary h-8 w-8 p-0" title={playing ? "Pause" : "Play"}>
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
            <button type="button" onClick={next} className="btn btn-ghost h-7 w-7 p-0" title="Next">
              <SkipForward className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={cycleRepeat}
            className={cn(
              "grid h-6 w-6 place-items-center rounded-md transition hover:bg-white/[0.06]",
              repeat !== "off" ? "text-accent" : "text-ink-faint hover:text-ink"
            )}
            title={`Repeat: ${repeat}`}
          >
            {repeat === "one" ? <Repeat1 className="h-3 w-3" /> : <Repeat className="h-3 w-3" />}
          </button>
        </div>

        {/* Mute + horizontal volume slider — always visible, grouped together. */}
        <div className="flex items-center gap-1.5 border-t border-line/60 px-2 py-1" onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setPref("themeMuted", !muted)}
            className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-ink-soft transition hover:bg-white/[0.06] hover:text-ink"
            title={muted ? "Unmute" : "Mute"}
          >
            <VolIcon className="h-3 w-3" />
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={volPct}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (muted && v > 0) setPref("themeMuted", false);
              setVolume(v);
            }}
            className="jukebox-volume h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/10"
            style={{
              background: `linear-gradient(to right, var(--accent-1) ${volPct}%, rgba(255,255,255,0.1) ${volPct}%)`,
            }}
            title="Volume"
          />
        </div>

        <AnimatePresence initial={false}>
          {!collapsed && tracks.length > 1 && upNext && (
            <motion.button
              type="button"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              onClick={next}
              className="flex w-full items-center gap-1.5 overflow-hidden border-t border-line/70 px-2 py-1.5 text-left transition hover:bg-white/[0.04]"
              title="Skip to next"
            >
              <ListMusic className="h-3 w-3 shrink-0 text-ink-faint" />
              <span className="text-[9px] font-800 uppercase tracking-wider text-ink-dim">Next</span>
              <span className="min-w-0 flex-1 truncate text-[10px] font-600 text-ink-soft">{upNext.label}</span>
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
