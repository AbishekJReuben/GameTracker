import { useRef } from "react";
import { Link } from "react-router-dom";
import { motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { Pencil, Clock, Gamepad2, Play } from "lucide-react";
import { Game } from "@/lib/api";
import { api } from "@/lib/api";
import { canLaunchGame } from "@/lib/launch";
import { GameArt } from "./GameArt";
import { statusColor } from "./ui";
import { dur } from "@/lib/format";
import { useApp, useMotionEnabled } from "@/store/app";
import { GameScores, hasAnyScore } from "./GameScores";
import { pulseGlow, staggerTransition } from "@/lib/motion";

/** Neighbours in the grid arrive from alternating edges for a lively,
 *  "assembling" entrance (cycles up → left → right → down). */
function cardEntrance(i: number): { x?: number; y?: number } {
  switch (i % 4) {
    case 0:
      return { y: 24 };
    case 1:
      return { x: 30 };
    case 2:
      return { x: -30 };
    default:
      return { y: -24 };
  }
}

export function GameCard({ game, index = 0 }: { game: Game; index?: number }) {
  const openGameModal = useApp((s) => s.openGameModal);
  const pushToast = useApp((s) => s.pushToast);
  const liveGameId = useApp((s) => (s.tracking?.isPlaying ? s.tracking.gameId : null));
  const isLive = liveGameId === game.id;
  const launchable = canLaunchGame(game);
  const enabled = useMotionEnabled();
  const color = isLive ? "#34d399" : statusColor(game.status);
  const playtime = game.totalRuntimeSeconds;
  const cardRef = useRef<HTMLDivElement>(null);

  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotateX = useSpring(useTransform(my, [-0.5, 0.5], [6, -6]), { stiffness: 280, damping: 28 });
  const rotateY = useSpring(useTransform(mx, [-0.5, 0.5], [-6, 6]), { stiffness: 280, damping: 28 });

  const onMove = (e: React.MouseEvent) => {
    if (!enabled || !cardRef.current) return;
    const r = cardRef.current.getBoundingClientRect();
    mx.set((e.clientX - r.left) / r.width - 0.5);
    my.set((e.clientY - r.top) / r.height - 0.5);
  };
  const onLeave = () => {
    mx.set(0);
    my.set(0);
  };

  return (
    <motion.div
      ref={cardRef}
      layout
      initial={enabled ? { opacity: 0, ...cardEntrance(index) } : false}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={staggerTransition(index, 0.035, 0.35)}
      className="group relative [perspective:900px]"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={enabled ? { rotateX, rotateY, transformStyle: "preserve-3d" } : undefined}
    >
      <Link to={`/game/${game.id}`} className="block">
        <motion.div
          className="relative aspect-[3/4] overflow-hidden rounded-2xl border border-line shadow-card transition duration-300 group-hover:border-line-strong group-hover:shadow-float"
          whileHover={enabled ? "hover" : undefined}
          initial="rest"
        >
          <GameArt
            id={game.id}
            name={game.displayName}
            cover={game.coverPath}
            icon={game.iconPath}
            accent={game.accentColor}
            steamAppId={game.steamAppId}
            className="absolute inset-0 h-full w-full"
            rounded="rounded-2xl"
          />

          {/* Cover shine sweep */}
          {enabled && (
            <motion.div
              className="pointer-events-none absolute inset-0 z-10"
              variants={{
                rest: { x: "-120%", opacity: 0 },
                hover: { x: "120%", opacity: 1, transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] } },
              }}
              style={{
                background:
                  "linear-gradient(105deg, transparent 38%, rgba(255,255,255,0.18) 50%, transparent 62%)",
              }}
            />
          )}

          {/* Live "now playing" ring — this game is running right now. */}
          {isLive && (
            <motion.div
              className="pointer-events-none absolute inset-0 z-20 rounded-2xl"
              style={{ boxShadow: "inset 0 0 0 2px #34d399, 0 0 26px -2px #34d399" }}
              animate={enabled ? { opacity: [0.5, 1, 0.5] } : { opacity: 0.9 }}
              transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
            />
          )}

          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
          <div
            className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            style={{
              background: `radial-gradient(120% 80% at 50% 110%, color-mix(in srgb, ${color} 35%, transparent), transparent 60%)`,
            }}
          />

          <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
            <span
              className="pill backdrop-blur-md"
              style={{ background: `color-mix(in srgb, ${color} 30%, rgba(0,0,0,0.4))`, color: "#fff" }}
            >
              {enabled ? (
                <motion.span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: color }}
                  {...pulseGlow(color, (index % 12) * 0.2)}
                />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
              )}
              <span className="capitalize">{isLive ? "Playing now" : game.status}</span>
            </span>
          </div>

          <GameScores game={game} variant="badge" index={index} />

          <div className="absolute inset-x-0 bottom-0 p-3">
            <div className="truncate text-[13px] font-800 text-white">{game.displayName || "Untitled"}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-white/70">
              {game.totalRuntimeSeconds > 0 ? (
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" /> {dur(playtime)}
                </span>
              ) : game.isTracked ? (
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Not played
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Gamepad2 className="h-3 w-3" /> {game.developer ?? "Catalog"}
                </span>
              )}
              {game.completedYear && <span>· {game.completedYear}</span>}
            </div>
          </div>
        </motion.div>
      </Link>

      {launchable && (
        <button
          onClick={async (e) => {
            e.preventDefault();
            try {
              await api.launchGame(game.id);
              pushToast({ kind: "success", title: "Launching", message: game.displayName });
            } catch (err) {
              pushToast({ kind: "info", title: "Launch failed", message: String(err) });
            }
          }}
          className="absolute left-2.5 grid h-8 w-8 place-items-center rounded-lg bg-emerald-500/80 text-white opacity-0 backdrop-blur-md transition group-hover:opacity-100 hover:bg-emerald-500"
          style={{ top: hasAnyScore(game) ? 52 : 10 }}
          title="Launch game"
        >
          <Play className="h-3.5 w-3.5 fill-current" />
        </button>
      )}

      <button
        onClick={(e) => {
          e.preventDefault();
          openGameModal({ game });
        }}
        className="absolute right-2.5 grid h-8 w-8 place-items-center rounded-lg bg-black/55 text-white opacity-0 backdrop-blur-md transition group-hover:opacity-100 hover:bg-black/75"
        style={{ top: hasAnyScore(game) ? 52 : 10 }}
        title="Edit"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}
