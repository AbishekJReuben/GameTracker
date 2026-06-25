import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { listen } from "@tauri-apps/api/event";
import { openExternalUrl, isTauri } from "@/lib/tauri";
import {
  Music2,
  Play,
  Pause,
  Shuffle,
  ListMusic,
  ListPlus,
  Search,
  Link2,
  ExternalLink,
  Library,
  Loader2,
  Plus,
  SkipBack,
  SkipForward,
  Repeat,
  Repeat1,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { api, type Game } from "@/lib/api";
import { Panel } from "./Panel";
import { SectionTitle, EmptyState, Segmented } from "./ui";
import { GameArt } from "./GameArt";
import { useJukebox } from "@/store/jukebox";
import { useApp } from "@/store/app";
import {
  buildJukeboxQueue,
  buildWatchVideosUrl,
  playlistUrl,
  JUKEBOX_MAX,
  WATCH_VIDEOS_MAX,
  type JukeboxContent,
  type JukeboxOrder,
  type JukeboxSource,
} from "@/lib/jukeboxTracks";
import { cn } from "@/lib/cn";

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * The central music hub: build an OST/theme queue from the whole library, hand it
 * to the global jukebox, export it as a YouTube playlist URL, and backfill full
 * soundtracks for every game.
 */
export function ThemePlaylist({ games }: { games: Game[] }) {
  const [source, setSource] = useState<JukeboxSource>("all");
  const [content, setContent] = useState<JukeboxContent>("ost");
  const [order, setOrder] = useState<JukeboxOrder>("played");
  const [limit, setLimit] = useState(100);
  const [seed, setSeed] = useState(7);
  const [query, setQuery] = useState("");

  const jukeboxActive = useJukebox((s) => s.active);
  const jukeboxIndex = useJukebox((s) => s.index);
  const start = useJukebox((s) => s.start);
  const seek = useJukebox((s) => s.seek);
  const enqueue = useJukebox((s) => s.enqueue);
  const pushToast = useApp((s) => s.pushToast);

  const [ostJob, setOstJob] = useState<{ done: number; total: number; name?: string } | null>(null);

  // Listen for the background backfill job's progress.
  useEffect(() => {
    if (!isTauri()) return;
    const unProgress = listen<{ done: number; total: number; name?: string }>(
      "ost://progress",
      (e) => setOstJob({ done: e.payload.done, total: e.payload.total, name: e.payload.name })
    );
    const unDone = listen("ost://done", () => {
      setOstJob(null);
      pushToast({ kind: "success", title: "Soundtrack library ready" });
    });
    return () => {
      unProgress.then((f) => f());
      unDone.then((f) => f());
    };
  }, [pushToast]);

  const allTracks = useMemo(
    () => buildJukeboxQueue(games, source, content, order, limit, seed),
    [games, source, content, order, limit, seed]
  );

  // Search filters the queue by game name (so you can play just one game's OST).
  const tracks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allTracks;
    return allTracks.filter((t) => t.gameName.toLowerCase().includes(q));
  }, [allTracks, query]);

  const hasMusic = useMemo(
    () =>
      games.some(
        (g) =>
          g.kind === "game" &&
          (g.themeTrackIds?.length > 0 || g.themeYoutubeId || g.trailerUrl)
      ),
    [games]
  );

  if (!hasMusic) return null;

  const queueUrl = (): string | null => {
    const gameIds = new Set(tracks.map((t) => t.gameId));
    if (gameIds.size === 1) {
      const g = games.find((g) => g.id === [...gameIds][0]);
      if (g?.themePlaylistId) return playlistUrl(g.themePlaylistId);
    }
    return buildWatchVideosUrl(tracks);
  };

  const copyUrl = async () => {
    const url = queueUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      pushToast({
        kind: "success",
        title: "Playlist URL copied",
        message:
          url.includes("watch_videos") && tracks.length > WATCH_VIDEOS_MAX
            ? `First ${WATCH_VIDEOS_MAX} of ${tracks.length} tracks (YouTube's limit)`
            : `${Math.min(tracks.length, WATCH_VIDEOS_MAX)} tracks`,
      });
    } catch {
      pushToast({ kind: "info", title: "Copy failed — opening instead", message: url });
      await openExternalUrl(url);
    }
  };

  const openInYouTube = async () => {
    const url = queueUrl();
    if (!url) {
      pushToast({ kind: "info", title: "No tracks to open", message: "Build a queue first." });
      return;
    }
    try {
      await openExternalUrl(url);
    } catch (e) {
      pushToast({ kind: "info", title: "Could not open YouTube", message: String(e) });
    }
  };

  const queueAll = () => {
    const n = enqueue(tracks);
    pushToast({ kind: n ? "success" : "info", title: n ? `Added ${n} to queue` : "Already in queue" });
  };

  const buildOstLibrary = async () => {
    try {
      const total = await api.buildOstLibrary();
      if (total === 0) {
        pushToast({ kind: "info", title: "Soundtrack library already complete" });
        return;
      }
      setOstJob({ done: 0, total });
      pushToast({
        kind: "info",
        title: "Building soundtrack library",
        message: `${total} games — runs in the background`,
      });
    } catch (e) {
      pushToast({ kind: "info", title: "Turn on Online metadata in Settings", message: String(e) });
    }
  };

  return (
    <Panel panelKey="sessions.themes" games={games} className="mb-5">
      <SectionTitle
        title="Theme jukebox"
        subtitle="Every game's soundtrack in one place — plays in the background with a floating player and Windows media keys"
        right={<ListMusic className="h-4 w-4 text-ink-dim" />}
      />

      {jukeboxActive && <NowPlayingBar />}

      <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Source">
          <Segmented
            value={source}
            onChange={setSource}
            size="sm"
            options={[
              { value: "top", label: "Most played" },
              { value: "completed", label: "Completed" },
              { value: "all", label: "All" },
            ]}
          />
        </Field>
        <Field label="Include">
          <Segmented
            value={content}
            onChange={setContent}
            size="sm"
            options={[
              { value: "ost", label: "OST mix" },
              { value: "themes", label: "Main themes" },
              { value: "trailers", label: "Trailers" },
            ]}
          />
        </Field>
        <Field label="Order">
          <Segmented
            value={order}
            onChange={setOrder}
            size="sm"
            options={[
              { value: "played", label: "Played" },
              { value: "rating", label: "Rated" },
              { value: "name", label: "A–Z" },
              { value: "random", label: "Shuffle" },
            ]}
          />
        </Field>
        <Field label="Length">
          <Segmented
            value={String(limit)}
            onChange={(v) => setLimit(parseInt(v, 10))}
            size="sm"
            options={[
              { value: "25", label: "25" },
              { value: "50", label: "50" },
              { value: "100", label: "100" },
              { value: "250", label: "250" },
              { value: "500", label: "500" },
              { value: "1000", label: "All" },
            ]}
          />
        </Field>
        <Field label="Find a game">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <input
              className="input h-9 w-48 pl-8"
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </Field>
      </div>

      {tracks.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={<Music2 className="h-6 w-6" />}
            title={query ? "No matches" : "No tracks yet"}
            message={
              query
                ? "No games match your search for these filters."
                : content === "trailers"
                  ? "No game trailers found in your library for these filters."
                  : "Build the soundtrack library below to scrape full OSTs from YouTube — no API key needed."
            }
          />
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button onClick={() => start(tracks, 0)} className="btn btn-primary h-10">
              <Play className="h-4 w-4" /> Play {Math.min(tracks.length, JUKEBOX_MAX)} tracks
            </button>
            <button onClick={queueAll} className="btn btn-subtle h-10" title="Add this mix to the queue">
              <ListPlus className="h-4 w-4" /> Queue all
            </button>
            {order === "random" && (
              <button onClick={() => setSeed((s) => s + 1)} className="btn btn-subtle h-10" title="Reshuffle">
                <Shuffle className="h-4 w-4" /> Reshuffle
              </button>
            )}
            <button onClick={copyUrl} className="btn btn-ghost h-10" title="Copy a YouTube playlist URL of this mix">
              <Link2 className="h-4 w-4" /> Copy playlist URL
            </button>
            <button onClick={openInYouTube} className="btn btn-ghost h-10" title="Open this mix in YouTube">
              <ExternalLink className="h-4 w-4" /> Open in YouTube
            </button>
            <button
              onClick={buildOstLibrary}
              disabled={!!ostJob}
              className="btn btn-ghost h-10 disabled:opacity-60"
              title="Scrape full soundtracks for every game in your library"
            >
              {ostJob ? <Loader2 className="h-4 w-4 animate-spin" /> : <Library className="h-4 w-4" />}
              {ostJob ? `Building ${ostJob.done}/${ostJob.total}` : "Build full OST library"}
            </button>
          </div>

          {ostJob && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
              <motion.div
                className="h-full rounded-full bg-accent"
                animate={{ width: `${(ostJob.done / Math.max(1, ostJob.total)) * 100}%` }}
                transition={{ duration: 0.4 }}
              />
            </div>
          )}
          {ostJob && (
            <div className="mt-1 text-xs text-ink-faint">
              {ostJob.name ? `Fetching ${ostJob.name}…` : "Scraping soundtracks…"} ({ostJob.done}/{ostJob.total})
            </div>
          )}

          <div className="-mx-1 mt-4 flex gap-3 overflow-x-auto px-1 pb-2 [scrollbar-width:thin]">
            {tracks.map((t, i) => (
              <div key={`${t.gameId}-${t.vid}-${i}`} className="group relative w-[104px] shrink-0">
                <button
                  type="button"
                  onClick={() => (jukeboxActive ? seek(i) : start(tracks, i))}
                  className="block w-full text-left"
                >
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.025, 0.4), duration: 0.35 }}
                    className={cn(
                      "relative aspect-[3/4] overflow-hidden rounded-xl border transition group-hover:-translate-y-1 group-hover:shadow-float",
                      jukeboxActive && jukeboxIndex === i ? "border-accent ring-1 ring-accent/40" : "border-line"
                    )}
                  >
                    <GameArt
                      id={t.gameId}
                      name={t.gameName}
                      cover={t.coverPath}
                      icon={t.iconPath}
                      accent={t.accentColor}
                      className="absolute inset-0 h-full w-full"
                      rounded="rounded-xl"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
                    <div className="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-black/55 text-[10px] font-900 text-white backdrop-blur">
                      {i + 1}
                    </div>
                    <div className="absolute inset-x-0 bottom-0 truncate p-1.5 text-[10px] font-700 text-white">{t.label}</div>
                  </motion.div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const n = enqueue([t]);
                    pushToast({ kind: n ? "success" : "info", title: n ? "Added to queue" : "Already in queue" });
                  }}
                  className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-white opacity-0 backdrop-blur transition hover:bg-accent group-hover:opacity-100"
                  title="Add to queue"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>

          {jukeboxActive && <QueueList />}
        </>
      )}
    </Panel>
  );
}

/** Big, seekable now-playing bar shown at the top of the hub while active. */
function NowPlayingBar() {
  const tracks = useJukebox((s) => s.tracks);
  const index = useJukebox((s) => s.index);
  const playing = useJukebox((s) => s.playing);
  const progress = useJukebox((s) => s.progress);
  const duration = useJukebox((s) => s.duration);
  const volume = useJukebox((s) => s.volume);
  const muted = useApp((s) => s.prefs.themeMuted);
  const setPref = useApp((s) => s.setPref);
  const shuffle = useJukebox((s) => s.shuffle);
  const repeat = useJukebox((s) => s.repeat);
  const toggle = useJukebox((s) => s.toggle);
  const next = useJukebox((s) => s.next);
  const prev = useJukebox((s) => s.prev);
  const seekTo = useJukebox((s) => s.seekTo);
  const setVolume = useJukebox((s) => s.setVolume);
  const toggleShuffle = useJukebox((s) => s.toggleShuffle);
  const cycleRepeat = useJukebox((s) => s.cycleRepeat);

  const track = tracks[index];
  if (!track) return null;

  const pct = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;

  const onSeek = (e: React.MouseEvent) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    seekTo(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * duration);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative mt-4 overflow-hidden rounded-2xl border border-accent/25 bg-gradient-to-r from-accent/[0.08] via-bg-850/60 to-bg-850/60 p-3"
    >
      <div className="pointer-events-none absolute inset-0 opacity-40 [background:radial-gradient(120%_120%_at_0%_0%,color-mix(in_srgb,var(--accent-1)_22%,transparent),transparent_60%)]" />
      <div className="relative flex items-center gap-3">
        <GameArt
          id={track.gameId}
          name={track.gameName}
          cover={track.coverPath}
          icon={track.iconPath}
          accent={track.accentColor}
          className={cn("h-14 w-11 shrink-0", playing && !muted && "ring-1 ring-accent/60")}
          rounded="rounded-lg"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-800 text-ink">{track.label}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
              {index + 1}/{tracks.length}
            </span>
          </div>
          <div className="truncate text-[11px] text-ink-soft">{track.gameName}</div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="w-9 text-right text-[10px] tabular-nums text-ink-faint">{fmt(progress)}</span>
            <div className="group relative h-1.5 flex-1 cursor-pointer rounded-full bg-white/10" onClick={onSeek}>
              <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
              <div
                className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow transition-opacity group-hover:opacity-100"
                style={{ left: `${pct}%` }}
              />
            </div>
            <span className="w-9 text-[10px] tabular-nums text-ink-faint">{duration > 0 ? fmt(duration) : "--:--"}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button onClick={toggleShuffle} className={cn("grid h-8 w-8 place-items-center rounded-lg transition hover:bg-white/[0.06]", shuffle ? "text-accent" : "text-ink-faint")} title="Shuffle">
            <Shuffle className="h-3.5 w-3.5" />
          </button>
          <button onClick={prev} className="btn btn-ghost h-9 w-9 p-0" title="Previous">
            <SkipBack className="h-4 w-4" />
          </button>
          <button onClick={toggle} className="btn btn-primary h-10 w-10 p-0" title={playing ? "Pause" : "Play"}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <button onClick={next} className="btn btn-ghost h-9 w-9 p-0" title="Next">
            <SkipForward className="h-4 w-4" />
          </button>
          <button onClick={cycleRepeat} className={cn("grid h-8 w-8 place-items-center rounded-lg transition hover:bg-white/[0.06]", repeat !== "off" ? "text-accent" : "text-ink-faint")} title={`Repeat: ${repeat}`}>
            {repeat === "one" ? <Repeat1 className="h-3.5 w-3.5" /> : <Repeat className="h-3.5 w-3.5" />}
          </button>
          <div className="ml-1 hidden items-center gap-1.5 sm:flex">
            <button onClick={() => setPref("themeMuted", !muted)} className="grid h-7 w-7 place-items-center rounded-lg text-ink-soft transition hover:bg-white/[0.06]" title={muted ? "Unmute" : "Mute"}>
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
              className="jukebox-volume h-1.5 w-20 cursor-pointer appearance-none rounded-full"
              style={{ background: `linear-gradient(to right, var(--accent-1) ${muted ? 0 : volume}%, rgba(255,255,255,0.1) ${muted ? 0 : volume}%)` }}
              title="Volume"
            />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/** The live play queue — jump to or remove any track. */
function QueueList() {
  const tracks = useJukebox((s) => s.tracks);
  const index = useJukebox((s) => s.index);
  const playing = useJukebox((s) => s.playing);
  const seek = useJukebox((s) => s.seek);
  const removeAt = useJukebox((s) => s.removeAt);
  const [open, setOpen] = useState(true);

  if (tracks.length === 0) return null;

  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mb-2 flex items-center gap-2 text-[11px] font-800 uppercase tracking-wider text-ink-dim transition hover:text-ink"
      >
        <ListMusic className="h-3.5 w-3.5" /> Queue · {tracks.length}
        <span className="text-ink-faint">{open ? "▾" : "▸"}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="max-h-[320px] space-y-0.5 overflow-y-auto pr-1 [scrollbar-width:thin]"
          >
            {tracks.map((t, i) => {
              const isCurrent = i === index;
              return (
                <li
                  key={`${t.gameId}-${t.vid}-${i}`}
                  className={cn(
                    "group flex items-center gap-3 rounded-xl px-2 py-1.5 transition",
                    isCurrent ? "bg-accent/10 ring-1 ring-accent/30" : "hover:bg-white/[0.04]"
                  )}
                >
                  <span className="w-5 shrink-0 text-center text-[11px] font-800 tabular-nums text-ink-faint">
                    {isCurrent && playing ? "♪" : i + 1}
                  </span>
                  <GameArt
                    id={t.gameId}
                    name={t.gameName}
                    cover={t.coverPath}
                    icon={t.iconPath}
                    accent={t.accentColor}
                    className="h-8 w-6 shrink-0"
                    rounded="rounded"
                  />
                  <button onClick={() => seek(i)} className="min-w-0 flex-1 text-left">
                    <div className={cn("truncate text-xs font-700", isCurrent ? "text-accent" : "text-ink-soft")}>{t.label}</div>
                    <div className="truncate text-[10px] text-ink-faint">{t.gameName}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-faint opacity-0 transition hover:bg-white/[0.08] hover:text-ink group-hover:opacity-100"
                    title="Remove from queue"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim">{label}</div>
      {children}
    </label>
  );
}
