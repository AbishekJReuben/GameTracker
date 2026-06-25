import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { GripHorizontal, Music2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX, X } from "lucide-react";
import { useJukebox } from "@/store/jukebox";
import { useApp } from "@/store/app";
import { GameArt } from "./GameArt";
import { cn } from "@/lib/cn";

const W = 300;
const H = 88;

/** Draggable mini player — visible on every page while the jukebox session is active. */
export function JukeboxFloater() {
  const active = useJukebox((s) => s.active);
  const tracks = useJukebox((s) => s.tracks);
  const index = useJukebox((s) => s.index);
  const playing = useJukebox((s) => s.playing);
  const floaterPos = useJukebox((s) => s.floaterPos);
  const setFloaterPos = useJukebox((s) => s.setFloaterPos);
  const toggle = useJukebox((s) => s.toggle);
  const next = useJukebox((s) => s.next);
  const prev = useJukebox((s) => s.prev);
  const stop = useJukebox((s) => s.stop);
  const muted = useApp((s) => s.prefs.themeMuted);
  const setPref = useApp((s) => s.setPref);

  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const [pos, setPos] = useState<{ x: number; y: number } | null>(floaterPos);

  const track = tracks[index];

  const defaultPos = useCallback(() => {
    const margin = 16;
    return {
      x: Math.max(margin, window.innerWidth - W - margin - 240),
      y: Math.max(margin, window.innerHeight - H - margin - 72),
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
          y: Math.min(Math.max(8, cur.y), window.innerHeight - H - 8),
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
    const y = Math.min(Math.max(8, e.clientY - dragOffset.current.y), window.innerHeight - H - 8);
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

  if (!active || !track || !pos) return null;

  return (
    <motion.div
      className="fixed z-[95] select-none"
      style={{ left: pos.x, top: pos.y, width: W }}
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 380, damping: 28 }}
    >
      <div className="overflow-hidden rounded-2xl border border-line bg-bg-850/95 shadow-float backdrop-blur-xl">
        <div
          className="flex cursor-grab items-center gap-1.5 border-b border-line bg-white/[0.03] px-2 py-1 active:cursor-grabbing"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <GripHorizontal className="h-3.5 w-3.5 text-ink-faint" />
          <Music2 className="h-3 w-3 text-accent" />
          <span className="flex-1 truncate text-[10px] font-800 uppercase tracking-wider text-ink-dim">Jukebox</span>
          <button
            type="button"
            onClick={stop}
            className="grid h-6 w-6 place-items-center rounded-lg text-ink-faint transition hover:bg-white/[0.06] hover:text-ink"
            title="Stop jukebox"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-2.5 p-2.5">
          <GameArt
            id={track.gameId}
            name={track.gameName}
            cover={track.coverPath}
            icon={track.iconPath}
            accent={track.accentColor}
            className={cn("h-11 w-8 shrink-0", playing && !muted && "ring-1 ring-accent/50")}
            rounded="rounded-md"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-800 text-ink">{track.label}</div>
            <div className="text-[10px] text-ink-faint">
              {index + 1} / {tracks.length}
              {playing && !muted && <span className="text-accent"> · playing</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button type="button" onClick={prev} className="btn btn-ghost h-8 w-8 p-0" title="Previous">
              <SkipBack className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={toggle} className="btn btn-primary h-8 w-8 p-0" title={playing ? "Pause" : "Play"}>
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
            <button type="button" onClick={next} className="btn btn-ghost h-8 w-8 p-0" title="Next">
              <SkipForward className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setPref("themeMuted", !muted)}
              className="btn btn-ghost h-8 w-8 p-0"
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
