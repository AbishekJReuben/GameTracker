import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { Clock, ChevronRight, ArrowRight, Zap, Play } from "lucide-react";
import { Game, GameStatus } from "@/lib/api";
import { api } from "@/lib/api";
import { canLaunchGame } from "@/lib/launch";
import { useApp } from "@/store/app";
import { GameArt } from "./GameArt";
import { statusColor } from "./ui";
import { dur } from "@/lib/format";
import { useMotionEnabled } from "@/store/app";
import { GameScores } from "./GameScores";
import { fadeSlide, scaleIn, makeStaggerContainer, staggerTransition, springSoft } from "@/lib/motion";

/* ============================ LIST VIEW ============================ */

export function GameList({ games }: { games: Game[] }) {
  const enabled = useMotionEnabled();
  const pushToast = useApp((s) => s.pushToast);
  return (
    <motion.div
      className="card overflow-hidden p-0"
      variants={enabled ? makeStaggerContainer(0.02) : undefined}
      initial={enabled ? "hidden" : false}
      animate="show"
    >
      <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-4 border-b border-line px-4 py-3 text-[11px] font-800 uppercase tracking-wider text-ink-dim">
        <span className="w-10" />
        <span>Game</span>
        <span className="w-24 text-right">Status</span>
        <span className="w-24 text-right">Playtime</span>
        <span className="w-16 text-right">Scores</span>
        <span className="w-8" />
      </div>
      <div className="divide-y divide-line">
        {games.map((g, i) => {
          const color = statusColor(g.status);
          return (
            <motion.div
              key={g.id}
              custom={i}
              variants={enabled ? fadeSlide : undefined}
              initial={enabled ? "hidden" : false}
              animate="show"
              transition={staggerTransition(i, 0.015, 0.25)}
              whileHover={enabled ? { backgroundColor: "rgba(255,255,255,0.03)" } : undefined}
              className="group"
            >
              <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-4 px-4 py-2.5">
                <Link to={`/game/${g.id}`} className="contents">
                  <GameArt id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="h-12 w-10" rounded="rounded-md" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-700">{g.displayName || "Untitled"}</div>
                    <div className="flex items-center gap-2 truncate text-[11px] text-ink-dim">
                      {g.developer ?? (g.isTracked ? "Tracked" : "Catalog")}
                      {g.releaseYear && <span>· {g.releaseYear}</span>}
                      {g.tags.slice(0, 2).map((t) => (
                        <span key={t} className="rounded bg-white/[0.05] px-1.5 py-px text-[10px] text-ink-soft">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="pill w-24 justify-center capitalize" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                    {g.status}
                  </span>
                  <span className="w-24 text-right text-sm font-700 tabular-nums text-ink-soft">
                    {g.totalRuntimeSeconds > 0 ? dur(g.totalRuntimeSeconds) : "—"}
                  </span>
                  <GameScores game={g} variant="list" className="w-16" />
                </Link>
                <div className="flex w-8 justify-end">
                  {canLaunchGame(g) && (
                    <button
                      type="button"
                      title="Launch game"
                      className="grid h-8 w-8 place-items-center rounded-lg border border-line text-emerald-400 opacity-0 transition hover:bg-white/[0.05] group-hover:opacity-100"
                      onClick={async (e) => {
                        e.preventDefault();
                        try {
                          await api.launchGame(g.id);
                          pushToast({ kind: "success", title: "Launching", message: g.displayName });
                        } catch (err) {
                          pushToast({ kind: "info", title: "Launch failed", message: String(err) });
                        }
                      }}
                    >
                      <Play className="h-3.5 w-3.5 fill-current" />
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
}

/* ============================ COMPACT VIEW ============================ */

export function GameCompact({ games }: { games: Game[] }) {
  const enabled = useMotionEnabled();
  return (
    <motion.div
      className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-9"
      variants={enabled ? makeStaggerContainer(0.012) : undefined}
      initial={enabled ? "hidden" : false}
      animate="show"
    >
      {games.map((g, i) => {
        const color = statusColor(g.status);
        return (
          <motion.div
            key={g.id}
            variants={enabled ? scaleIn : undefined}
            initial={enabled ? "hidden" : false}
            animate="show"
            transition={staggerTransition(i, 0.01, 0.25)}
            whileHover={enabled ? { y: -4, scale: 1.02 } : undefined}
          >
            <Link to={`/game/${g.id}`} className="group block">
              <div className="relative aspect-[3/4] overflow-hidden rounded-lg border border-line transition group-hover:border-line-strong group-hover:shadow-float">
                <GameArt id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="absolute inset-0 h-full w-full transition group-hover:scale-105" rounded="rounded-lg" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/85 to-transparent" />
                <motion.span
                  className="absolute left-1.5 top-1.5 h-2 w-2 rounded-full"
                  style={{ background: color }}
                  animate={enabled ? { boxShadow: [`0 0 4px ${color}`, `0 0 10px ${color}`, `0 0 4px ${color}`] } : undefined}
                  transition={{ duration: 2, repeat: Infinity }}
                />
                <GameScores game={g} variant="micro" />
                <div className="absolute inset-x-0 bottom-0 truncate p-1.5 text-[10px] font-700 text-white">{g.displayName || "Untitled"}</div>
              </div>
            </Link>
          </motion.div>
        );
      })}
    </motion.div>
  );
}

/* ============================ ALBUM VIEW (cover shelves by status) ============================ */

const SHELF_ORDER: GameStatus[] = ["playing", "backlog", "completed", "dropped"];
const SHELF_LABEL: Record<GameStatus, string> = { playing: "Now Playing", backlog: "Up Next", completed: "Completed", dropped: "Set Aside" };

export function GameAlbum({ games }: { games: Game[] }) {
  const enabled = useMotionEnabled();
  const shelves = useMemo(() => {
    return SHELF_ORDER.map((status) => ({ status, list: games.filter((g) => g.status === status) })).filter((s) => s.list.length > 0);
  }, [games]);

  if (shelves.length === 0) return null;

  return (
    <motion.div
      className="space-y-7"
      variants={enabled ? makeStaggerContainer(0.1) : undefined}
      initial={enabled ? "hidden" : false}
      animate="show"
    >
      {shelves.map(({ status, list }, si) => {
        const color = statusColor(status);
        return (
          <motion.section
            key={status}
            variants={enabled ? { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0 } } : undefined}
            transition={{ delay: si * 0.08 }}
          >
            <div className="mb-3 flex items-center gap-2">
              <motion.span
                className="h-4 w-1 rounded-full"
                style={{ background: color }}
                animate={enabled ? { boxShadow: [`0 0 6px ${color}`, `0 0 14px ${color}`, `0 0 6px ${color}`] } : undefined}
                transition={{ duration: 2.2, repeat: Infinity }}
              />
              <h3 className="font-display text-base font-800">{SHELF_LABEL[status]}</h3>
              <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-700 text-ink-dim">{list.length}</span>
            </div>
            <div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-3">
              {list.map((g, i) => (
                <motion.div
                  key={g.id}
                  initial={enabled ? { opacity: 0, x: 20 } : false}
                  animate={{ opacity: 1, x: 0 }}
                  transition={staggerTransition(i, 0.04, 0.35)}
                  whileHover={enabled ? { y: -6, scale: 1.02 } : undefined}
                  className="group relative w-[150px] shrink-0"
                >
                  <Link to={`/game/${g.id}`} className="block">
                    <div
                      className="relative aspect-[3/4] overflow-hidden rounded-xl border border-line shadow-card transition duration-300 group-hover:shadow-float"
                      style={{ boxShadow: `0 18px 40px -24px ${color}` }}
                    >
                      <GameArt id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="absolute inset-0 h-full w-full transition duration-500 group-hover:scale-[1.07]" rounded="rounded-xl" />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent opacity-0 transition group-hover:opacity-100" />
                      <div className="absolute inset-x-0 bottom-0 translate-y-2 p-2.5 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100">
                        <div className="truncate text-xs font-800 text-white">{g.displayName}</div>
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-white/70">
                          <GameScores game={g} variant="inline" className="text-[10px]" />
                          {g.totalRuntimeSeconds > 0 && <span>{dur(g.totalRuntimeSeconds)}</span>}
                        </div>
                      </div>
                    </div>
                  </Link>
                </motion.div>
              ))}
            </div>
          </motion.section>
        );
      })}
    </motion.div>
  );
}

/* ============================ THEATRE VIEW (cinematic) ============================ */

export function GameTheatre({ games }: { games: Game[] }) {
  const enabled = useMotionEnabled();
  const [featuredId, setFeaturedId] = useState<string | null>(games[0]?.id ?? null);
  useEffect(() => {
    if (!featuredId || !games.some((g) => g.id === featuredId)) setFeaturedId(games[0]?.id ?? null);
  }, [games, featuredId]);

  const featured = games.find((g) => g.id === featuredId) ?? games[0];
  if (!featured) return null;
  const color = statusColor(featured.status);

  return (
    <div className="space-y-4">
      <AnimatePresence mode="wait">
        <motion.div
          key={featured.id}
          initial={enabled ? { opacity: 0, scale: 0.98 } : false}
          animate={{ opacity: 1, scale: 1 }}
          exit={enabled ? { opacity: 0, scale: 0.99 } : undefined}
          transition={springSoft}
          className="relative h-[360px] overflow-hidden rounded-3xl border border-line"
        >
          <div className="absolute inset-0 overflow-hidden">
            <GameArt
              id={featured.id}
              name={featured.displayName}
              cover={featured.coverPath}
              icon={featured.iconPath}
              accent={featured.accentColor}
              className="h-full w-full blur-2xl"
              rounded="rounded-none"
              kenBurns={enabled}
            />
            <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, var(--color-bg-base) 8%, color-mix(in srgb, var(--color-bg-base) 75%, transparent) 45%, transparent 100%)" }} />
            <div className="absolute inset-0 bg-gradient-to-t from-bg-base via-transparent to-transparent" />
          </div>
          <div className="relative flex h-full items-end gap-6 p-7">
            <motion.div
              initial={enabled ? { opacity: 0, x: -16 } : false}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1, ...springSoft }}
              className="hidden sm:block"
            >
              <GameArt id={featured.id} name={featured.displayName} cover={featured.coverPath} icon={featured.iconPath} accent={featured.accentColor} className="h-56 w-40 shrink-0 shadow-float" />
            </motion.div>
            <motion.div
              className="min-w-0 flex-1"
              initial={enabled ? { opacity: 0, y: 12 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, ...springSoft }}
            >
              <span className="pill capitalize" style={{ background: `color-mix(in srgb, ${color} 22%, rgba(0,0,0,0.4))`, color: "#fff" }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                {featured.status}
              </span>
              <h2 className="mt-2 font-display text-4xl font-900 tracking-tight text-balance glow-text">{featured.displayName || "Untitled"}</h2>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-soft">
                {featured.developer && <span>{featured.developer}</span>}
                {featured.releaseYear && <span>· {featured.releaseYear}</span>}
                <GameScores game={featured} variant="inline" />
                {featured.totalRuntimeSeconds > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> {dur(featured.totalRuntimeSeconds)}
                  </span>
                )}
                {featured.sessionCount > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Zap className="h-3.5 w-3.5 text-green" /> {featured.sessionCount} sessions
                  </span>
                )}
              </div>
              {featured.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {featured.tags.slice(0, 5).map((t) => (
                    <span key={t} className="rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] font-600 text-ink-soft">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <Link to={`/game/${featured.id}`} className="btn btn-primary mt-5 h-10 w-fit">
                View details <ArrowRight className="h-4 w-4" />
              </Link>
            </motion.div>
          </div>
        </motion.div>
      </AnimatePresence>

      {/* Filmstrip */}
      <div className="flex items-center gap-2 text-xs font-700 uppercase tracking-wider text-ink-dim">
        <span>Browse</span>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-ink-soft">{games.length} games</span>
      </div>
      <motion.div
        className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-3"
        variants={enabled ? makeStaggerContainer(0.03) : undefined}
        initial={enabled ? "hidden" : false}
        animate="show"
      >
        {games.map((g, i) => {
          const active = g.id === featured.id;
          return (
            <motion.button
              key={g.id}
              custom={i}
              variants={enabled ? scaleIn : undefined}
              initial={enabled ? "hidden" : false}
              animate="show"
              transition={staggerTransition(i, 0.025, 0.4)}
              onMouseEnter={() => setFeaturedId(g.id)}
              onClick={() => setFeaturedId(g.id)}
              whileHover={enabled ? { scale: 1.05, y: -3 } : undefined}
              whileTap={enabled ? { scale: 0.97 } : undefined}
              className={`relative w-[104px] shrink-0 overflow-hidden rounded-xl border transition ${active ? "border-transparent ring-2 ring-accent" : "border-line opacity-70 hover:opacity-100"}`}
            >
              <div className="relative aspect-[3/4]">
                <GameArt id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} className="absolute inset-0 h-full w-full" rounded="rounded-xl" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 truncate p-1.5 text-left text-[10px] font-700 text-white">{g.displayName}</div>
              </div>
              {active && enabled && (
                <motion.div
                  layoutId="theatre-active"
                  className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-accent"
                  transition={springSoft}
                />
              )}
            </motion.button>
          );
        })}
      </motion.div>
    </div>
  );
}
