import { useMemo, useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { motion, useScroll, useTransform } from "motion/react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Clock,
  Zap,
  Hash,
  CalendarClock,
  Star,
  Trophy,
  FolderOpen,
  Sparkles,
  Loader2,
  Timer,
  AppWindow,
  ExternalLink,
  Camera,
  Play,
} from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { Page } from "@/components/Page";
import { GameArt } from "@/components/GameArt";
import { Timeline, type TimelineRange } from "@/components/Timeline";
import { SectionTitle, StatusBadge, Badge, EmptyState, Skeleton, Segmented, statusColor, statusLabel } from "@/components/ui";
import { Panel } from "@/components/Panel";
import { useGame, useGames, useSessions, useScreenshots, useSetStatus, useRefreshAll, useSettings } from "@/lib/queries";
import { useApp, useMotionEnabled } from "@/store/app";
import { dur, dateLabel, relativeTime, timeLabel, partialDate, formatHltbMinutes } from "@/lib/format";
import { clipFocusSpans } from "@/lib/focusSpans";
import { api, assetUrl, GameStatus, Session } from "@/lib/api";
import { canLaunchGame } from "@/lib/launch";
import { isTauri } from "@/lib/tauri";
import { ScreenshotGallery } from "@/components/ScreenshotGallery";
import { ImageMarquee } from "@/components/ImageMarquee";
import { Captures } from "@/components/Captures";
import { SteamReviewsPanel } from "@/components/SteamReviewsPanel";
import { MetacriticReviewsPanel } from "@/components/MetacriticReviewsPanel";
import { TrailerPanel } from "@/components/TrailerPanel";
import { GameStatsPanel } from "@/components/GameStatsPanel";
import { ThemePlayer, ThemeToggleButton } from "@/components/ThemePlayer";
import { SoundtrackPanel } from "@/components/SoundtrackPanel";
import { TwitchPanel } from "@/components/TwitchPanel";
import { ActivityLog } from "@/components/ActivityLog";
import { EmbeddedPanel } from "@/components/EmbeddedPanel";
import { TIMELINE_RANGE_OPTIONS } from "@/lib/timelineZoom";
import { libraryNeighbors } from "@/lib/libraryNav";
import { SteamAchievementDetailPanel } from "@/components/SteamAchievements";
import { useLiveEntryStats, useLiveNowMs } from "@/lib/liveStats";
import { cn } from "@/lib/cn";

const STATUSES: GameStatus[] = ["playing", "backlog", "on_hold", "completed", "dropped", "watched"];
const RANGE_OPTS = TIMELINE_RANGE_OPTIONS;

// Remember which entries the user has already run "Get data" on, so the
// missing-info nudge appears only for games whose details were never fetched.
const ENRICH_ATTEMPT_KEY = "gt.enrichAttempted";
function readAttempted(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(ENRICH_ATTEMPT_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function hasEnrichAttempt(id: string): boolean {
  return readAttempted().has(id);
}
function markEnrichAttempt(id: string) {
  try {
    const set = readAttempted();
    set.add(id);
    localStorage.setItem(ENRICH_ATTEMPT_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

/** A friendly heading for a session's local day: Today / Yesterday / dated. */
function dayHeading(d: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const that = new Date(d);
  that.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

/** "cover art", "cover art & screenshots", "cover art, screenshots & 2 more". */
function listLabel(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} & ${items[1]}`;
  return `${items.slice(0, 2).join(", ")} & ${items.length - 2} more`;
}

function activityHost(url?: string | null): string | null {
  if (!url) return null;
  try {
    const u = url.includes("://") ? url : `https://${url}`;
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Recent distinct window titles / URLs recorded during a session. */
function sessionActivities(session: Session, limit = 3) {
  const spans = session.activitySpans ?? [];
  const seen = new Set<string>();
  const out: { title?: string | null; host: string | null }[] = [];
  for (let i = spans.length - 1; i >= 0 && out.length < limit; i--) {
    const a = spans[i];
    if (!a.title && !a.url) continue;
    const key = `${a.title ?? ""}|${a.url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: a.title, host: activityHost(a.url) });
  }
  return out;
}

export default function GameDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: game, isLoading, isError } = useGame(id);
  const { data: allGames } = useGames();
  const { data: sessions } = useSessions(id ? { gameId: id } : {});
  const { data: screenshots } = useScreenshots(id);
  const { data: settings } = useSettings();
  const themeMusicOn = settings ? settings.theme_music_enabled !== "false" : true;
  const openGameModal = useApp((s) => s.openGameModal);
  const pushToast = useApp((s) => s.pushToast);
  const use24 = useApp((s) => s.prefs.timeFormat === "24h");
  const setPref = useApp((s) => s.setPref);
  // The timeline range is a remembered toggle, shared with the Timeline page.
  const range = useApp((s) => s.prefs.timelineRange);
  const setRange = (v: TimelineRange) => setPref("timelineRange", v);
  const setStatus = useSetStatus();
  const refresh = useRefreshAll();
  const [coverBusy, setCoverBusy] = useState(false);
  const [infoBusy, setInfoBusy] = useState(false);
  const [hltbBusy, setHltbBusy] = useState(false);
  const [trailerPlaying, setTrailerPlaying] = useState(false);
  const [enrichAttempted, setEnrichAttempted] = useState(false);
  useEffect(() => {
    setEnrichAttempted(id ? hasEnrichAttempt(id) : false);
  }, [id]);
  const enabled = useMotionEnabled();
  const { scrollY } = useScroll();
  const heroY = useTransform(scrollY, [0, 280], [0, enabled ? 48 : 0]);
  const heroScale = useTransform(scrollY, [0, 280], [1, enabled ? 1.06 : 1]);

  const isApp = game?.kind === "app";
  const backTo = isApp ? "/apps" : "/library";
  const backLabel = isApp ? "Apps" : "Library";

  const themeYoutube = game?.themeYoutubeId ?? game?.themeTrackIds?.[0] ?? null;
  const hasThemeAudio = !!(
    themeYoutube ||
    game?.themeAudioUrl ||
    (game?.themeTrackIds?.length ?? 0) > 0
  );

  const neighbors = useMemo(() => {
    if (!id || !allGames || !game) return null;
    return libraryNeighbors(allGames, id, isApp ? "app" : "game");
  }, [allGames, game, id, isApp]);

  useEffect(() => {
    document.querySelector("[data-page-scroll]")?.scrollTo?.({ top: 0 });
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === "ArrowLeft" && neighbors?.prev) {
        e.preventDefault();
        navigate(`/game/${neighbors.prev.id}`);
      } else if (e.key === "ArrowRight" && neighbors?.next) {
        e.preventDefault();
        navigate(`/game/${neighbors.next.id}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, neighbors?.prev, neighbors?.next]);
  const accent = useMemo(() => (game ? game.accentColor || statusColor(game.status) : "var(--accent-1)"), [game]);
  const tags = game?.tags ?? [];
  const sessionList = sessions ?? [];
  const shots = screenshots ?? [];
  // Hoisted out of the session-history render loop (was an O(n²) Math.max per row).
  const maxSessionRuntime = useMemo(
    () => sessionList.reduce((m, s) => Math.max(m, s.runtimeSeconds), 1),
    [sessionList]
  );
  // Session history grouped into 24h day buckets (newest first), each with its
  // own per-day totals; sessions within a day are listed newest-first.
  const sessionDayGroups = useMemo(() => {
    const byDay = new Map<string, Session[]>();
    for (const s of sessionList) {
      const d = new Date(s.startUtc);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const arr = byDay.get(key);
      if (arr) arr.push(s);
      else byDay.set(key, [s]);
    }
    return [...byDay.entries()]
      .map(([key, list]) => {
        const sorted = [...list].sort((a, b) => new Date(b.startUtc).getTime() - new Date(a.startUtc).getTime());
        return {
          key,
          label: dayHeading(new Date(sorted[0].startUtc)),
          sessions: sorted,
          active: list.reduce((a, s) => a + s.activeSeconds, 0),
          runtime: list.reduce((a, s) => a + s.runtimeSeconds, 0),
        };
      })
      .sort((a, b) => new Date(b.sessions[0].startUtc).getTime() - new Date(a.sessions[0].startUtc).getTime());
  }, [sessionList]);
  const nowMs = useLiveNowMs();
  const liveStats = useLiveEntryStats(
    id,
    game?.kind === "app" ? "app" : "game",
    game
      ? {
          totalRuntimeSeconds: game.totalRuntimeSeconds,
          totalActiveSeconds: game.totalActiveSeconds,
          sessionCount: game.sessionCount,
        }
      : undefined,
    sessionList
  );
  const infoEntries = useMemo(() => {
    if (!game?.infoJson) return [] as [string, string][];
    try {
      const obj = JSON.parse(game.infoJson) as Record<string, string>;
      return Object.entries(obj);
    } catch {
      return [];
    }
  }, [game?.infoJson]);

  // Core enrichment fields this entry is still missing — drives the "Get data" nudge.
  const missingInfo = useMemo(() => {
    if (!game) return [] as string[];
    const m: string[] = [];
    if (isApp) {
      if (!game.coverPath && !game.iconPath) m.push("logo");
      if (!game.developer) m.push("publisher");
      if (!game.notes) m.push("description");
    } else {
      if (!game.coverPath) m.push("cover art");
      if (game.screenshots.length === 0) m.push("screenshots");
      if (!game.developer) m.push("developer");
      if (!game.releaseYear) m.push("release year");
      if (game.metacritic == null) m.push("Metacritic");
    }
    return m;
  }, [game, isApp]);

  const lastPlayedLabel = useMemo(() => {
    if (!game) return "—";
    if (game.lastPlayedUtc) return relativeTime(game.lastPlayedUtc);
    const completed = partialDate(game.completedYear, game.completedMonth, game.completedDay);
    if (completed !== "—") return completed;
    const started = partialDate(game.startedYear, game.startedMonth, game.startedDay);
    if (started !== "—") return started;
    return "Never";
  }, [game]);

  const launch = async () => {
    if (!game) return;
    try {
      await api.launchGame(game.id);
      pushToast({ kind: "success", title: "Launching", message: game.displayName });
    } catch (err) {
      pushToast({ kind: "info", title: "Launch failed", message: String(err) });
    }
  };

  // One "Get data" action: covers + Steam info + HowLongToBeat for games;
  // just the Wikipedia info pass for apps.
  const enrichAll = async () => {
    if (!game) return;
    // Mark up-front so the "missing info" nudge disappears immediately and never
    // nags again for this entry, even if some sources return nothing.
    markEnrichAttempt(game.id);
    setEnrichAttempted(true);
    if (isApp) {
      await fetchInfo();
      return;
    }
    await fetchCover();
    await fetchInfo();
    await fetchHltb();
  };

  const fetchCover = async () => {
    if (!game) return;
    setCoverBusy(true);
    try {
      const updated = await api.fetchCover(game.id, game.displayName || "Unknown");
      refresh();
      pushToast(updated ? { kind: "success", title: "Cover downloaded" } : { kind: "info", title: "No cover found online" });
    } catch (e) {
      pushToast({ kind: "info", title: "Cover fetch failed", message: String(e) });
    } finally {
      setCoverBusy(false);
    }
  };

  const fetchInfo = async () => {
    if (!game) return;
    setInfoBusy(true);
    try {
      const updated = isApp
        ? await api.fetchAppInfo(game.id, game.displayName || "Unknown", true)
        : await api.fetchGameInfo(game.id, game.displayName || "Unknown", false);
      refresh();
      pushToast(
        updated
          ? { kind: "success", title: isApp ? "App info updated" : "Game info updated", message: isApp ? "From Wikipedia" : "From Steam store data" }
          : { kind: "info", title: isApp ? "No info found online" : "No Steam match found" }
      );
    } catch (e) {
      pushToast({ kind: "info", title: "Info fetch failed", message: String(e) });
    } finally {
      setInfoBusy(false);
    }
  };

  const fetchHltb = async () => {
    if (!game) return;
    setHltbBusy(true);
    try {
      const updated = await api.fetchHltb(game.id, game.displayName || "Unknown", true);
      refresh();
      if (updated) {
        const extra = updated.hltbMainExtraMinutes;
        pushToast({
          kind: "success",
          title: "HLTB times applied",
          message: extra ? `Main+Extra: ${formatHltbMinutes(extra)} added to manual playtime` : "Estimates saved",
        });
      } else {
        pushToast({ kind: "info", title: "No HLTB match found" });
      }
    } catch (e) {
      pushToast({ kind: "info", title: "HLTB lookup failed", message: String(e) });
    } finally {
      setHltbBusy(false);
    }
  };

  if (isLoading) {
    return (
      <Page title="Game">
        <Skeleton className="h-56 w-full rounded-3xl" />
      </Page>
    );
  }

  if (!game || isError) {
    return (
      <Page title="Game not found">
        <EmptyState
          title="Game not found"
          message="This game may have been removed from your library."
          action={
            <Link to="/library" className="btn btn-primary">
              <ArrowLeft className="h-4 w-4" /> Back to library
            </Link>
          }
        />
      </Page>
    );
  }

  const hasSessions = sessionList.length > 0;
  const showEnrichNudge = !enrichAttempted && !infoBusy && !coverBusy && !hltbBusy && missingInfo.length > 0;

  // Every HowLongToBeat figure the game has, in increasing-effort order.
  const hltbItems = [
    { label: "Main Story", minutes: game.hltbMainMinutes, color: "#34d399" },
    { label: "Main + Extra", minutes: game.hltbMainExtraMinutes, color: "#22d3ee" },
    { label: "100% (Completionist)", minutes: game.hltbCompletionistMinutes, color: "#7c5cff" },
  ].filter((x): x is { label: string; minutes: number; color: string } => x.minutes != null && x.minutes > 0);

  const detailsCard = (
    <Panel panelKey="game-detail.details" game={game} games={allGames ?? []} className="h-full">
      <SectionTitle title="Details" />
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Row label={isApp ? "Publisher" : "Developer"} value={game.developer ?? "—"} />
        <Row label="Released" value={game.releaseYear?.toString() ?? "—"} />
        {!isApp && <Row label="Started" value={partialDate(game.startedYear, game.startedMonth, game.startedDay)} />}
        {!isApp && <Row label="Completed" value={partialDate(game.completedYear, game.completedMonth, game.completedDay)} />}
        {isApp && infoEntries.map(([k, v]) => (
          <Row key={k} label={k} value={k === "Website" ? <a href={v} target="_blank" rel="noreferrer" className="accent-text underline">{v}</a> : v} />
        ))}
        <Row label="First tracked" value={dateLabel(game.firstPlayedUtc)} />
        <Row label="Tracked" value={game.isTracked ? "Yes" : "Catalog only"} />
      </dl>
      {tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <Badge key={t} color="var(--accent-1)">
              {t}
            </Badge>
          ))}
        </div>
      )}
      {game.notes && (
        <div className="mt-4 rounded-xl border border-line bg-white/[0.02] p-3 text-sm leading-relaxed text-ink-soft">{game.notes}</div>
      )}
    </Panel>
  );

  const storeImagesCard = (cls: string) =>
    game.screenshots.length > 0 ? (
      <Panel panelKey="game-detail.screenshots" game={game} games={allGames ?? []} className={cls}>
        <SectionTitle
          title={isApp ? "Media" : "Store images"}
          subtitle={`${game.screenshots.length} ${isApp ? "images" : "screenshots"}${isApp ? " from Wikipedia" : " from Steam"}`}
          right={
            game.website ? (
              <a href={game.website} target="_blank" rel="noreferrer" className="btn btn-ghost h-9 text-xs">
                <ExternalLink className="h-3.5 w-3.5" /> {isApp ? "Wikipedia" : "Website"}
              </a>
            ) : undefined
          }
        />
        <div className="mt-4">
          <ScreenshotGallery urls={game.screenshots} name={game.displayName} />
        </div>
      </Panel>
    ) : null;

  const storeAndDetails = (cls: string) =>
    game.screenshots.length > 0 ? (
      <div className={`grid gap-6 lg:grid-cols-3 lg:items-start ${cls}`}>
        {storeImagesCard("lg:col-span-2")}
        {detailsCard}
      </div>
    ) : (
      <div className={cls}>{detailsCard}</div>
    );

  return (
    <Page
      title=""
      subtitle=""
      actions={
        <>
          <button
            onClick={enrichAll}
            disabled={coverBusy || infoBusy || hltbBusy}
            className="btn btn-ghost h-10"
            title={isApp ? "Fetch description & logo from Wikipedia" : "Fetch cover & info (Steam) and HowLongToBeat estimates"}
          >
            {coverBusy || infoBusy || hltbBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {isApp ? "Get info" : "Get data"}
          </button>
          <button onClick={() => openGameModal({ game })} className="btn btn-primary h-10">
            <Pencil className="h-4 w-4" /> Edit
          </button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link to={backTo} className="inline-flex items-center gap-1.5 text-sm font-700 text-ink-dim transition hover:text-ink">
          <ArrowLeft className="h-4 w-4" /> {backLabel}
        </Link>
        {neighbors && neighbors.total > 1 && neighbors.index >= 0 && (
          <div className="flex items-center gap-1">
            <NavArrow
              to={neighbors.prev ? `/game/${neighbors.prev.id}` : undefined}
              label={neighbors.prev ? `Previous: ${neighbors.prev.displayName}` : "No previous entry"}
              disabled={!neighbors.prev}
            >
              <ChevronLeft className="h-4 w-4" />
            </NavArrow>
            <span className="min-w-[4.5rem] px-2 text-center text-xs font-700 tabular-nums text-ink-dim">
              {neighbors.index + 1} / {neighbors.total}
            </span>
            <NavArrow
              to={neighbors.next ? `/game/${neighbors.next.id}` : undefined}
              label={neighbors.next ? `Next: ${neighbors.next.displayName}` : "No next entry"}
              disabled={!neighbors.next}
            >
              <ChevronRight className="h-4 w-4" />
            </NavArrow>
          </div>
        )}
      </div>

      {/* Hero */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="relative mb-6 overflow-hidden rounded-3xl border border-line">
        <motion.div className="absolute inset-0" style={{ y: heroY, scale: heroScale }}>
          {game.backgroundUrl ? (
            <img src={assetUrl(game.backgroundUrl) ?? undefined} alt="" className="h-full w-full scale-110 object-cover blur-xl" draggable={false} />
          ) : (
            <GameArt id={game.id} name={game.displayName} cover={game.coverPath} icon={game.iconPath} accent={game.accentColor} className="h-full w-full scale-110 blur-2xl" rounded="rounded-none" />
          )}
          <div className="absolute inset-0 bg-bg-base/82" />
        </motion.div>
        {/* Screenshot marquee drifts along the hero's right edge, behind the
            status/play controls. Masked into the backdrop for legibility. */}
        {game.screenshots.length > 0 && (
          <div className="pointer-events-none absolute inset-y-0 right-0 z-0 hidden w-[62%] overflow-hidden sm:block" aria-hidden>
            <ImageMarquee images={game.screenshots} fade={false} durationSec={46} className="h-full rounded-none border-0 bg-transparent" />
            <div className="absolute inset-0 bg-gradient-to-r from-bg-base via-bg-base/80 to-bg-base/40" />
            <div className="absolute inset-0 bg-bg-base/25" />
          </div>
        )}
        <div className="relative z-10 flex flex-col gap-5 p-6 sm:flex-row sm:items-end">
          <GameArt id={game.id} name={game.displayName} cover={game.coverPath} icon={game.iconPath} accent={game.accentColor} steamAppId={game.steamAppId} className="h-44 w-32 shrink-0 shadow-float" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {isApp ? (
                <span className="pill inline-flex items-center gap-1 border border-line bg-white/[0.06] text-ink-soft">
                  <AppWindow className="h-3 w-3" /> App
                </span>
              ) : (
                <StatusBadge status={game.status} />
              )}
              {game.developer && <Badge color="#94a3b8">{game.developer}</Badge>}
              {game.releaseYear && <Badge color="#94a3b8">{game.releaseYear}</Badge>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h1 className="font-display text-3xl font-800 tracking-tight text-balance">{game.displayName || "Untitled game"}</h1>
              {!isApp && themeMusicOn && hasThemeAudio && <ThemeToggleButton game={game} />}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-4">
              {game.rating != null && <Scorebox label="My score" value={game.rating} color="#fbbf24" icon={<Star className="h-3.5 w-3.5" />} />}
              {game.metacritic != null && <Scorebox label="Metacritic" value={game.metacritic} color="#34d399" />}
              {(game.completedYear || game.completedMonth || game.completedDay) && (
                <div className="flex items-center gap-1.5 text-sm text-ink-soft">
                  <Trophy className="h-4 w-4 text-accent" /> Completed {partialDate(game.completedYear, game.completedMonth, game.completedDay)}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {canLaunchGame(game) && (
              <button
                onClick={launch}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-emerald-500/90 px-4 text-sm font-800 text-white shadow-card transition hover:bg-emerald-500"
                title="Launch game"
              >
                <Play className="h-4 w-4 fill-current" /> Play
              </button>
            )}
            {!isApp && (
              <div className="inline-flex rounded-xl border border-line bg-bg-900/70 p-1">
                {STATUSES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatus.mutate({ id: game.id, status: s })}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-800 capitalize transition ${game.status === s ? "text-white" : "text-ink-dim hover:text-ink"}`}
                    style={game.status === s ? { background: `color-mix(in srgb, ${statusColor(s)} 32%, transparent)` } : {}}
                  >
                    {statusLabel(s)}
                  </button>
                ))}
              </div>
            )}
            {game.installFolder && isTauri() && (
              <button onClick={() => openPath(game.installFolder!).catch(() => {})} className="btn btn-subtle h-9 text-xs">
                <FolderOpen className="h-3.5 w-3.5" /> Open folder
              </button>
            )}
          </div>
        </div>
      </motion.div>

      {/* Missing-info nudge — only for entries whose details were never fetched. */}
      {showEnrichNudge && (
        <motion.button
          type="button"
          onClick={enrichAll}
          initial={enabled ? { opacity: 0, y: -8 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="mb-6 flex w-full items-center justify-between gap-4 rounded-2xl border border-accent-1/25 bg-accent-1/[0.06] px-4 py-3 text-left transition hover:bg-accent-1/[0.1]"
          title={`Missing: ${missingInfo.join(", ")}`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-sheen/20 text-accent-3">
              <Sparkles className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-700">Missing {listLabel(missingInfo)}</div>
              <div className="text-xs text-ink-dim">
                Tap to fetch {isApp ? "details from Wikipedia" : "the cover & details from Steam, plus HowLongToBeat"}.
              </div>
            </div>
          </div>
          <span className="shrink-0 text-xs font-700 text-accent-3">{isApp ? "Get info" : "Get data"} →</span>
        </motion.button>
      )}

      {/* Stats */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {isApp ? (
          <>
            <MiniStat panelKey="game-detail.stat.runtime" game={game} icon={<Clock className="h-4 w-4" />} label="Total time" value={dur(liveStats.totalRuntimeSeconds)} color="#22d3ee" delay={0} live={liveStats.isLive} />
            <MiniStat panelKey="game-detail.stat.active" game={game} icon={<Zap className="h-4 w-4" />} label="Focused time" value={dur(liveStats.totalActiveSeconds)} color="#34d399" delay={0.06} live={liveStats.isLive} />
            <MiniStat panelKey="game-detail.stat.sessions" game={game} icon={<Hash className="h-4 w-4" />} label="Sessions" value={String(liveStats.sessionCount)} color="var(--accent-1)" delay={0.12} />
            <MiniStat panelKey="game-detail.stat.last" game={game} icon={<CalendarClock className="h-4 w-4" />} label="Last used" value={lastPlayedLabel} color="#f472b6" delay={0.18} />
          </>
        ) : (
          <>
            <MiniStat panelKey="game-detail.stat.runtime" game={game} icon={<Clock className="h-4 w-4" />} label="Total runtime" value={dur(liveStats.totalRuntimeSeconds)} color="#22d3ee" delay={0} live={liveStats.isLive} />
            <MiniStat panelKey="game-detail.stat.active" game={game} icon={<Zap className="h-4 w-4" />} label="Active play" value={dur(liveStats.totalActiveSeconds)} color="#34d399" delay={0.06} live={liveStats.isLive} />
            <MiniStat panelKey="game-detail.stat.sessions" game={game} icon={<Hash className="h-4 w-4" />} label="Sessions" value={String(liveStats.sessionCount)} color="var(--accent-1)" delay={0.12} />
            <MiniStat panelKey="game-detail.stat.last" game={game} icon={<CalendarClock className="h-4 w-4" />} label="Last played" value={lastPlayedLabel} color="#f472b6" delay={0.18} />
          </>
        )}
      </div>
      {!isApp && (game.trackedRuntimeSeconds > 0 || game.manualPlaytimeSeconds > 0) && (
        <p className="mb-6 text-sm text-ink-dim">
          Tracked: <span className="font-700 text-ink-soft">{dur(game.trackedActiveSeconds)}</span> active
          {game.manualPlaytimeSeconds > 0 && (
            <>
              {" · "}Manual: <span className="font-700 text-ink-soft">{dur(game.manualPlaytimeSeconds)}</span>
            </>
          )}
        </p>
      )}

      {!isApp && hltbItems.length > 0 && (
        <Panel panelKey="game-detail.hltb" game={game} games={allGames ?? []} className="mb-6">
          <SectionTitle
            title="How long to beat"
            subtitle="Completion estimates from HowLongToBeat"
            right={<span className="pill inline-flex items-center gap-1 border border-line bg-white/[0.06] text-ink-soft"><Timer className="h-3 w-3" /> HLTB</span>}
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {hltbItems.map((it) => (
              <HltbStat key={it.label} label={it.label} minutes={it.minutes} color={it.color} />
            ))}
          </div>
        </Panel>
      )}

      {/* No play history yet — store images + details up top. */}
      {!hasSessions && storeAndDetails("mb-6")}

      {/* Per-game timeline (Gantt) — tracking data sits above any media. */}
      {game.isTracked && (
        <Panel panelKey="game-detail.timeline" game={game} games={allGames ?? []} sessions={sessionList} className="mb-6 overflow-visible">
          <SectionTitle title={isApp ? "Usage timeline" : "Play timeline"} subtitle={isApp ? "When you used this app" : "When you played this game"} right={<Segmented value={range} onChange={setRange} options={RANGE_OPTS} size="sm" />} />
          <Timeline sessions={sessionList} range={range} colorFor={() => accent} />
        </Panel>
      )}

      {hasSessions && (
        <Panel panelKey="game-detail.sessions" game={game} games={allGames ?? []} sessions={sessionList} className="mb-6 overflow-visible">
          <SectionTitle
            title="Session history"
            subtitle={`${sessionList.length} sessions · ${sessionDayGroups.length} ${sessionDayGroups.length === 1 ? "day" : "days"}`}
          />
          <div className="mt-1 max-h-[460px] overflow-y-auto">
            {sessionDayGroups.map((g) => (
              <div key={g.key}>
                {/* 24-hour bucket header: the day + its session count & total time. */}
                <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line/60 bg-bg-900/95 py-1.5 backdrop-blur-sm">
                  <span className="text-[11px] font-800 uppercase tracking-wider text-ink-soft">{g.label}</span>
                  <span className="text-[10px] tabular-nums text-ink-faint">
                    {g.sessions.length} {g.sessions.length === 1 ? "session" : "sessions"} · {dur(isApp ? g.runtime : g.active)}
                  </span>
                </div>
                <div className="divide-y divide-line/40">
                  {g.sessions.map((s, i) => {
                    const barW = (s.runtimeSeconds / maxSessionRuntime) * 100;
                    const startMs = new Date(s.startUtc).getTime();
                    const endMs = new Date(s.endUtc ?? s.lastSeenUtc).getTime();
                    const segments = clipFocusSpans(s, startMs, endMs, nowMs);
                    const span = endMs - startMs || 1;
                    const acts = sessionActivities(s);
                    return (
                      <motion.div
                        key={s.id}
                        className="flex items-center gap-3 py-2.5"
                        initial={enabled ? { opacity: 0, x: -16 } : false}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: Math.min(i * 0.03, 0.35), duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                      >
                        <div className="w-16 shrink-0 text-xs tabular-nums text-ink-dim">{timeLabel(s.startUtc, use24)}</div>
                        <div className="relative min-w-0 flex-1">
                          <div className="relative h-2 overflow-hidden rounded-full bg-white/[0.05]" style={{ width: `${barW}%`, minWidth: 24 }}>
                            {segments.map((seg, si) => {
                              const leftPct = ((seg.startMs - startMs) / span) * 100;
                              const widthPct = ((seg.endMs - seg.startMs) / span) * 100;
                              return (
                                <span
                                  key={si}
                                  className="absolute inset-y-0 rounded-full"
                                  style={{
                                    left: `${leftPct}%`,
                                    width: `${Math.max(widthPct, 1)}%`,
                                    background: accent,
                                    opacity: seg.focused ? 1 : 0.35,
                                    boxShadow: seg.focused ? `0 0 10px -2px ${accent}` : undefined,
                                  }}
                                />
                              );
                            })}
                          </div>
                          {acts.length > 0 && (
                            <div className="mt-1 space-y-0.5">
                              {acts.map((a, ai) => (
                                <div key={ai} className="truncate text-[10px] text-ink-faint">
                                  {a.title ?? a.host}
                                  {a.host && a.title && <span className="text-ink-faint/80"> · {a.host}</span>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="w-24 shrink-0 text-right">
                          <div className="text-sm font-800 tabular-nums">{dur(isApp ? s.runtimeSeconds : s.activeSeconds)}</div>
                          {s.runtimeSeconds > s.activeSeconds + 30 && (
                            <div className="text-[10px] tabular-nums text-ink-faint">{dur(s.activeSeconds)} focused</div>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {hasSessions && storeAndDetails("mb-6")}

      {/* Full soundtrack — browse & play this game's OST in one place. */}
      {!isApp && <SoundtrackPanel game={game} />}

      {/* Achievements sit below the store imagery / posters. */}
      {!isApp && <SteamAchievementDetailPanel game={game} />}

      {/* Browser & window activity — exact URL/title spans with start→end times. */}
      {sessionList.some((s) => (s.activitySpans?.length ?? 0) > 0) && (
        <Panel panelKey="game-detail.activity" game={game} games={allGames ?? []} sessions={sessionList} className="mt-6 overflow-visible">
          <SectionTitle
            title="Window & browser activity"
            subtitle={isApp ? "What was on screen while this app ran" : "What was on screen while you played — URLs with exact times"}
          />
          <div className="mt-4">
            <ActivityLog sessions={sessionList} />
          </div>
        </Panel>
      )}

      {/* Auto-captured in-game screenshots (taken every ~30 min while playing). */}
      {shots.length > 0 && (
        <Panel panelKey="game-detail.captures" game={game} games={allGames ?? []} className="mt-6">
          <SectionTitle
            title="Screenshots"
            subtitle={`${shots.length} captured automatically while playing`}
            right={<span className="pill inline-flex items-center gap-1 border border-line bg-white/[0.06] text-ink-soft"><Camera className="h-3 w-3" /> Auto</span>}
          />
          <div className="mt-4">
            <Captures shots={shots} gameId={game.id} name={game.displayName} />
          </div>
        </Panel>
      )}

      {game.screenshots.length === 0 && game.website && (
        <div className="mt-6">
          <a href={game.website} target="_blank" rel="noreferrer" className="btn btn-ghost h-9 text-xs">
            <ExternalLink className="h-3.5 w-3.5" /> {isApp ? "Wikipedia page" : "Official website"}
          </a>
        </div>
      )}

      {isApp && game.notes && (
        <Panel panelKey="game-detail.about" game={game} games={allGames ?? []} className="mt-6">
          <SectionTitle title="About" subtitle="From online sources" />
          <p className="mt-3 text-sm leading-relaxed text-ink-soft">{game.notes}</p>
        </Panel>
      )}

      {!isApp && (
        <div className="mt-6 space-y-4">
          <SectionTitle title="Stats, reviews & links" subtitle="Players, sales, Steam, Metacritic & official site" />
          <Panel panelKey="game-detail.reviews" game={game} games={allGames ?? []} className="space-y-6">
            <GameStatsPanel gameId={game.id} gameName={game.displayName} />
            <SteamReviewsPanel steamAppId={game.steamAppId} gameName={game.displayName} />
            <MetacriticReviewsPanel gameId={game.id} gameName={game.displayName} metacriticSlug={game.metacriticSlug} />
          </Panel>
          {/* Trailer sits at the bottom, right above the official website. */}
          {game.trailerUrl && (
            <TrailerPanel url={game.trailerUrl} poster={game.backgroundUrl ?? game.coverPath} name={game.displayName} onPlayingChange={setTrailerPlaying} />
          )}
          {/* Live streams (left) + official website (right) — a 16:9 row split in half. */}
          {(() => {
            const showWebsite = !!game.website && !game.website.includes("steampowered.com");
            return (
              <div className={cn("grid gap-4", showWebsite && "lg:grid-cols-2")}>
                <TwitchPanel game={game} />
                {showWebsite && <EmbeddedPanel title="Official website" url={game.website!} aspectClass="aspect-[8/9]" />}
              </div>
            );
          })()}
        </div>
      )}

      {/* Per-game theme: hidden audio player (toggle lives by the title). */}
      {!isApp && themeMusicOn && hasThemeAudio && (
        <ThemePlayer youtubeId={themeYoutube} audioUrl={game.themeAudioUrl} name={game.displayName} suppressed={trailerPlaying} />
      )}
    </Page>
  );
}

function Scorebox({ label, value, color, icon }: { label: string; value: number; color: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <div className="grid h-10 w-10 place-items-center rounded-xl text-sm font-800" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
        {value}
      </div>
      <div className="text-xs text-ink-dim">
        <div className="flex items-center gap-1 font-700 text-ink-soft">
          {icon} {label}
        </div>
        <div className="text-[11px]">out of 100</div>
      </div>
    </div>
  );
}

function HltbStat({ label, minutes, color }: { label: string; minutes: number; color: string }) {
  return (
    <div className="rounded-xl border border-line bg-white/[0.02] p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wide text-ink-dim">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
        {label}
      </div>
      <div className="mt-1 font-display text-lg font-800 tabular-nums text-ink">{formatHltbMinutes(minutes)}</div>
    </div>
  );
}

function MiniStat({
  panelKey,
  game,
  icon,
  label,
  value,
  color,
  delay = 0,
  live = false,
}: {
  panelKey: string;
  game: import("@/lib/api").Game;
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
  delay?: number;
  live?: boolean;
}) {
  const enabled = useMotionEnabled();
  return (
    <motion.div
      initial={enabled ? { opacity: 0, y: 14, scale: 0.96 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
    >
      <Panel panelKey={panelKey} game={game} shell="hud" className={cn("!p-4", live && "ring-1 ring-green/25")}>
      <div className="grid h-9 w-9 place-items-center rounded-xl" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
        {icon}
      </div>
      <div className="mt-3 font-display text-xl font-800 tabular-nums">{value}</div>
      <div className="text-xs text-ink-dim">{label}{live ? " · live" : ""}</div>
      </Panel>
    </motion.div>
  );
}

function NavArrow({
  to,
  label,
  disabled,
  children,
}: {
  to?: string;
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const className =
    "grid h-9 w-9 place-items-center rounded-xl border border-line bg-bg-900/60 text-ink-soft transition hover:bg-white/[0.06] hover:text-ink disabled:pointer-events-none disabled:opacity-30";
  if (disabled || !to) {
    return (
      <button type="button" className={className} disabled aria-label={label}>
        {children}
      </button>
    );
  }
  return (
    <Link to={to} className={className} title={label} aria-label={label}>
      {children}
    </Link>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/40 py-1.5 sm:flex-col sm:items-start sm:gap-0.5 sm:border-0 sm:py-0">
      <dt className="shrink-0 text-xs text-ink-dim">{label}</dt>
      <dd className="text-right text-sm font-700 text-ink sm:text-left">{value}</dd>
    </div>
  );
}
