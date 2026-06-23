import { useEffect, useRef, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { Gamepad2, Moon, Zap, Clock, Play } from "lucide-react";
import { useApp, useMotionEnabled } from "@/store/app";
import { api, type Session, TrackingState } from "@/lib/api";
import { useDashboard, useGames } from "@/lib/queries";
import { buildHeroSlides } from "@/lib/heroSlides";
import { GameArt } from "./GameArt";
import { ShaderSlideshow } from "./animations/ShaderSlideshow";
import { clockString, dur, relativeTime } from "@/lib/format";

export function NowPlaying() {
  const tracking = useApp((s) => s.tracking);
  const pushToast = useApp((s) => s.pushToast);
  const { data: dashboard } = useDashboard();
  const { data: games } = useGames();
  const enabled = useMotionEnabled();
  const playing = !!tracking?.isPlaying && !tracking?.paused;
  const idle = !!tracking?.isIdle;

  const lastGame = dashboard?.recentSessions.find((s) => s.kind !== "app") ?? null;
  const heroSlides = useMemo(() => buildHeroSlides(games ?? []), [games]);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(0);
  }, [tracking?.sessionActiveSeconds, tracking?.sessionRuntimeSeconds, tracking?.gameId]);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [playing]);

  const runtime = (tracking?.sessionRuntimeSeconds ?? 0) + (playing ? tick : 0);
  const active = (tracking?.sessionActiveSeconds ?? 0) + (playing && !idle ? tick : 0);

  const launchLast = async () => {
    if (!lastGame) return;
    try {
      await api.launchGame(lastGame.gameId);
    } catch (e) {
      pushToast({ kind: "info", title: "Could not launch game", message: String(e) });
    }
  };

  return (
    <motion.div
      layout
      initial={enabled ? { opacity: 0, y: 16, scale: 0.98 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className="relative overflow-hidden rounded-3xl border border-line bg-bg-850/70 p-6 shadow-card"
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: playing
            ? "radial-gradient(120% 120% at 0% 0%, color-mix(in srgb, #34d399 18%, transparent), transparent 55%)"
            : lastGame
              ? "radial-gradient(120% 120% at 0% 0%, color-mix(in srgb, var(--accent-2) 14%, transparent), transparent 55%)"
              : "radial-gradient(120% 120% at 0% 0%, color-mix(in srgb, var(--accent-1) 16%, transparent), transparent 55%)",
        }}
      />
      {playing && (
        <div className="pointer-events-none absolute inset-y-0 right-0 w-1/3 overflow-hidden">
          <div className="absolute inset-0 animate-scan bg-gradient-to-b from-transparent via-white/[0.04] to-transparent" />
        </div>
      )}

      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-6 sm:flex-row sm:items-center">
        <ArtBlock playing={playing} tracking={tracking} lastGame={lastGame} enabled={enabled} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-800 uppercase tracking-[0.24em] text-ink-dim glow-text">
              {playing ? "● Now Playing" : tracking?.paused ? "Paused" : lastGame ? "Last played" : "Ready Player One"}
            </span>
            {playing && enabled && <EqualizerBars />}
            {idle && playing && (
              <span className="pill bg-amber/15 text-amber">
                <Moon className="h-3 w-3" /> AFK
              </span>
            )}
          </div>
          <h2 className="mt-1 truncate font-display text-2xl font-800 tracking-tight">
            {playing ? tracking?.gameName : lastGame ? lastGame.gameName : "No active session"}
          </h2>

          {playing ? (
            <div className="mt-4 flex flex-wrap items-center gap-6">
              <Metric
                icon={<Zap className="h-4 w-4 text-green" />}
                label="Active session"
                value={clockString(active)}
                mono
                big
                tick={enabled}
              />
              <Metric
                icon={<Clock className="h-4 w-4 text-accent-3" />}
                label="Runtime"
                value={clockString(runtime)}
                mono
                tick={enabled}
              />
              <Metric label="Today" value={dur(tracking?.todayActiveSeconds ?? 0)} />
            </div>
          ) : lastGame ? (
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <p className="text-sm text-ink-dim">
                {relativeTime(lastGame.endUtc ?? lastGame.lastSeenUtc)}
                {" · "}
                <span className="font-700 text-ink-soft">{dur(lastGame.activeSeconds)}</span> active last session
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void launchLast()} className="btn btn-primary h-10">
                  <Play className="h-4 w-4" /> Continue game
                </button>
                <Link to={`/game/${lastGame.gameId}`} className="btn btn-ghost h-10 text-sm">
                  View details
                </Link>
              </div>
            </div>
          ) : (
            <p className="mt-2 max-w-md text-sm text-ink-dim">
              Launch any tracked game and it'll appear here live — active session timer, runtime, and today's
              total ticking up in real time.
            </p>
          )}
        </div>
        </div>

        <ShaderSlideshow
          slides={heroSlides}
          className="hidden h-auto min-h-[148px] lg:block lg:w-[min(40%,420px)] lg:shrink-0 lg:self-stretch"
          dimmed={playing}
        />
      </div>
    </motion.div>
  );
}

function ArtBlock({
  playing,
  tracking,
  lastGame,
  enabled,
}: {
  playing: boolean;
  tracking: TrackingState | null;
  lastGame: Session | null;
  enabled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotateX = useSpring(useTransform(my, [-0.5, 0.5], [6, -6]), { stiffness: 180, damping: 22 });
  const rotateY = useSpring(useTransform(mx, [-0.5, 0.5], [-6, 6]), { stiffness: 180, damping: 22 });

  const onMove = (e: React.MouseEvent) => {
    if (!enabled || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    mx.set((e.clientX - r.left) / r.width - 0.5);
    my.set((e.clientY - r.top) / r.height - 0.5);
  };
  const onLeave = () => {
    mx.set(0);
    my.set(0);
  };

  const idleArt = lastGame ? (
    <GameArt
      id={lastGame.gameId}
      name={lastGame.gameName}
      cover={lastGame.coverPath}
      icon={lastGame.iconPath}
      accent={lastGame.accentColor}
      className="relative h-[104px] w-[104px] shadow-[0_12px_40px_-12px_rgba(0,0,0,0.65)]"
      rounded="rounded-[22px]"
    />
  ) : (
    <div className="relative grid h-[104px] w-[104px] place-items-center rounded-[22px] bg-bg-800">
      <Gamepad2 className="h-9 w-9 text-ink-faint" />
    </div>
  );

  return (
    <div
      ref={ref}
      className="relative [perspective:800px]"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <motion.div
        className="absolute -inset-1.5 rounded-[26px] blur-md"
        animate={
          playing && enabled
            ? { opacity: [0.45, 0.95, 0.45], scale: [1, 1.04, 1] }
            : { opacity: 0.5, scale: 1 }
        }
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        style={{
          background: playing
            ? "linear-gradient(135deg,#34d399,#22d3ee)"
            : lastGame
              ? "linear-gradient(135deg,var(--accent-2),var(--accent-3))"
              : "linear-gradient(135deg,var(--accent-1),var(--accent-2))",
        }}
      />
      {playing && enabled && (
        <motion.div
          className="pointer-events-none absolute -inset-2 rounded-[28px] border border-green/40"
          animate={{ opacity: [0.2, 0.7, 0.2], scale: [1, 1.06, 1] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      <motion.div
        style={enabled ? { rotateX, rotateY, transformStyle: "preserve-3d" } : undefined}
        whileHover={enabled ? { scale: 1.04 } : undefined}
        transition={{ type: "spring", stiffness: 320, damping: 22 }}
        className="relative"
      >
        {playing && tracking?.gameId ? (
          <GameArt
            id={tracking.gameId}
            name={tracking.gameName ?? "Game"}
            cover={tracking.coverPath}
            icon={tracking.iconPath}
            accent={tracking.accentColor}
            className="relative h-[104px] w-[104px] shadow-[0_12px_40px_-12px_rgba(0,0,0,0.65)]"
            rounded="rounded-[22px]"
          />
        ) : (
          idleArt
        )}
      </motion.div>
      {playing && (
        <span className="absolute -right-1 -top-1 flex h-4 w-4">
          <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-green/70" />
          <motion.span
            className="relative inline-flex h-4 w-4 rounded-full border-2 border-bg-850 bg-green"
            animate={enabled ? { scale: [1, 1.15, 1] } : undefined}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          />
        </span>
      )}
    </div>
  );
}

function EqualizerBars() {
  const heights = [0.35, 0.65, 0.45, 0.85, 0.55];
  return (
    <div className="flex h-4 items-end gap-[2px]" aria-hidden>
      {heights.map((base, i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-full bg-green"
          animate={{
            height: [`${base * 16}px`, `${(1 - base) * 12 + 6}px`, `${base * 16}px`],
            opacity: [0.55, 1, 0.55],
          }}
          transition={{
            duration: 0.45 + i * 0.08,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.06,
          }}
        />
      ))}
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  mono,
  big,
  tick,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  big?: boolean;
  tick?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">
        {icon}
        {label}
      </div>
      <div
        className={`mt-0.5 overflow-hidden ${mono ? "font-mono" : "font-display"} ${big ? "text-3xl" : "text-xl"} font-700 tabular-nums text-ink`}
      >
        {tick ? (
          <motion.span
            key={value}
            initial={{ y: 10, opacity: 0, filter: "blur(4px)" }}
            animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="inline-block"
          >
            {value}
          </motion.span>
        ) : (
          value
        )}
      </div>
    </div>
  );
}
