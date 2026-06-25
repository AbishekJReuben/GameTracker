import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Music2, Play, Pause, SkipBack, SkipForward, Shuffle, Volume2, VolumeX, ListMusic } from "lucide-react";
import type { Game } from "@/lib/api";
import { Panel } from "./Panel";
import { SectionTitle, EmptyState, Segmented } from "./ui";
import { GameArt } from "./GameArt";
import { useApp } from "@/store/app";
import { cn } from "@/lib/cn";

type Source = "all" | "top" | "completed";
type Content = "ost" | "themes" | "trailers";
type Order = "played" | "name" | "rating" | "random";

export interface JukeboxTrack {
  g: Game;
  vid: string;
  label: string;
}

function youtubeId(url?: string | null): string | null {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/);
  if (m) return m[1];
  return /^[\w-]{11}$/.test(url) ? url : null;
}

/** All playable YouTube ids for a game — OST mix uses every stored track, main theme first. */
export function gameYoutubeTracks(g: Game, ostMix: boolean): string[] {
  const fromDb = g.themeTrackIds?.filter((id) => /^[\w-]{11}$/.test(id)) ?? [];
  const main = g.themeYoutubeId && /^[\w-]{11}$/.test(g.themeYoutubeId) ? g.themeYoutubeId : null;

  if (ostMix) {
    const ids = [...fromDb];
    if (main) {
      const i = ids.indexOf(main);
      if (i > 0) {
        ids.splice(i, 1);
        ids.unshift(main);
      } else if (i < 0) {
        ids.unshift(main);
      }
    }
    if (ids.length > 0) return ids;
  }

  if (main) return [main];
  return fromDb;
}

function shuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed || 1;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const MAX = 50;

function buildTracks(games: Game[], source: Source, content: Content, order: Order, limit: number, seed: number): JukeboxTrack[] {
  let pool = games.filter((g) => g.kind === "game");
  if (source === "completed") pool = pool.filter((g) => g.status === "completed");
  if (source === "top") pool = pool.filter((g) => g.totalActiveSeconds > 0);

  const ostMix = content === "ost";
  let list: JukeboxTrack[] = [];
  for (const g of pool) {
    if (content === "trailers") {
      const vid = youtubeId(g.trailerUrl);
      if (vid) list.push({ g, vid, label: `${g.displayName} trailer` });
      continue;
    }
    const ids = gameYoutubeTracks(g, ostMix);
    ids.forEach((vid, ti) => {
      list.push({
        g,
        vid,
        label: ids.length > 1 ? `${g.displayName} · track ${ti + 1}` : g.displayName,
      });
    });
  }

  if (order === "name") list.sort((a, b) => a.g.displayName.localeCompare(b.g.displayName));
  else if (order === "rating") list.sort((a, b) => (b.g.rating ?? 0) - (a.g.rating ?? 0));
  else if (order === "random") list = shuffle(list, seed);
  else list.sort((a, b) => b.g.totalActiveSeconds - a.g.totalActiveSeconds);

  const seen = new Set<string>();
  const out: JukeboxTrack[] = [];
  for (const t of list) {
    const key = `${t.g.id}:${t.vid}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out.slice(0, Math.min(limit, MAX));
}

/** In-app YouTube jukebox — hidden iframe + IFrame API commands. */
function JukeboxPlayer({
  tracks,
  index,
  playing,
  onIndex,
  onPlaying,
}: {
  tracks: JukeboxTrack[];
  index: number;
  playing: boolean;
  onIndex: (i: number) => void;
  onPlaying: (p: boolean) => void;
}) {
  const muted = useApp((s) => s.prefs.themeMuted);
  const setPref = useApp((s) => s.setPref);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const didGesture = useRef(false);
  const track = tracks[index];

  const ytCommand = useCallback((func: string, args: unknown[] = []) => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*"
    );
  }, []);

  const applyMute = useCallback(() => {
    if (!track) return;
    if (muted) ytCommand("mute");
    else {
      ytCommand("unMute");
      ytCommand("setVolume", [60]);
    }
    if (playing) ytCommand("playVideo");
    else ytCommand("pauseVideo");
  }, [muted, playing, track, ytCommand]);

  const loadTrack = useCallback(
    (i: number, autoplay: boolean) => {
      const t = tracks[i];
      if (!t) return;
      const playlist = tracks.map((x) => x.vid).join(",");
      ytCommand("loadVideoById", [t.vid, 0, "default", playlist]);
      if (autoplay && !muted) {
        ytCommand("unMute");
        ytCommand("setVolume", [60]);
        ytCommand("playVideo");
      } else if (autoplay) {
        ytCommand("playVideo");
      }
    },
    [tracks, muted, ytCommand]
  );

  useEffect(() => {
    applyMute();
  }, [applyMute]);

  useEffect(() => {
    if (!track || !ready.current) return;
    loadTrack(index, playing);
  }, [index, track?.vid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      try {
        const d = JSON.parse(e.data) as { event?: string; info?: number };
        if (d.event === "onStateChange" && d.info === 0 && tracks.length > 1) {
          onIndex((index + 1) % tracks.length);
          onPlaying(true);
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [index, tracks.length, onIndex, onPlaying]);

  useEffect(() => {
    const onGesture = () => {
      if (didGesture.current) return;
      didGesture.current = true;
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      if (!muted) {
        ytCommand("unMute");
        ytCommand("setVolume", [60]);
        if (playing) ytCommand("playVideo");
      }
    };
    window.addEventListener("pointerdown", onGesture, true);
    window.addEventListener("keydown", onGesture, true);
    return () => {
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
    };
  }, [muted, playing, ytCommand]);

  if (!track) return null;

  const first = track.vid;
  const playlist = tracks.map((t) => t.vid).join(",");
  const ytSrc = `https://www.youtube-nocookie.com/embed/${first}?enablejsapi=1&autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0&iv_load_policy=3&playlist=${playlist}`;

  const prev = () => onIndex((index - 1 + tracks.length) % tracks.length);
  const next = () => onIndex((index + 1) % tracks.length);

  return (
    <>
      <iframe
        ref={iframeRef}
        src={ytSrc}
        title={`${track.label} — jukebox`}
        allow="autoplay; encrypted-media"
        tabIndex={-1}
        aria-hidden
        onLoad={() => {
          ready.current = true;
          iframeRef.current?.contentWindow?.postMessage(
            JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
            "*"
          );
          applyMute();
          if (playing) loadTrack(index, true);
        }}
        className="pointer-events-none fixed bottom-0 right-0 h-px w-px opacity-[0.001]"
      />

      <div className="mt-4 rounded-2xl border border-line bg-white/[0.03] p-3">
        <div className="flex flex-wrap items-center gap-3">
          <GameArt
            id={track.g.id}
            name={track.g.displayName}
            cover={track.g.coverPath}
            icon={track.g.iconPath}
            accent={track.g.accentColor}
            className="h-12 w-9 shrink-0"
            rounded="rounded-lg"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-800 text-ink">{track.label}</div>
            <div className="text-[11px] text-ink-faint">
              {index + 1} / {tracks.length}
              {playing && !muted && <span className="ml-2 text-accent"> · playing</span>}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={prev} className="btn btn-ghost h-9 w-9 p-0" title="Previous">
              <SkipBack className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                const nextPlaying = !playing;
                onPlaying(nextPlaying);
                if (nextPlaying) ytCommand("playVideo");
                else ytCommand("pauseVideo");
              }}
              className="btn btn-primary h-10 w-10 p-0"
              title={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
            <button type="button" onClick={next} className="btn btn-ghost h-9 w-9 p-0" title="Next">
              <SkipForward className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setPref("themeMuted", !muted)}
              className="btn btn-ghost h-9 w-9 p-0"
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Builds and plays a YouTube OST mix from your library — multiple top tracks per
 * game when available, streamed in-app via a hidden iframe.
 */
export function ThemePlaylist({ games }: { games: Game[] }) {
  const [source, setSource] = useState<Source>("top");
  const [content, setContent] = useState<Content>("ost");
  const [order, setOrder] = useState<Order>("played");
  const [limit, setLimit] = useState(25);
  const [seed, setSeed] = useState(7);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  const tracks = useMemo(
    () => buildTracks(games, source, content, order, limit, seed),
    [games, source, content, order, limit, seed]
  );

  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [tracks]);

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

  return (
    <Panel panelKey="sessions.themes" games={games}>
      <SectionTitle
        title="Theme jukebox"
        subtitle="OST mix from your library — plays right here in the app"
        right={<ListMusic className="h-4 w-4 text-ink-dim" />}
      />

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
              { value: "10", label: "10" },
              { value: "25", label: "25" },
              { value: "50", label: "50" },
            ]}
          />
        </Field>
      </div>

      {tracks.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={<Music2 className="h-6 w-6" />}
            title="No tracks yet"
            message={
              content === "trailers"
                ? "No game trailers found in your library for these filters."
                : "Fetch game info (Steam/RAWG) so OST tracks get linked — up to five per game."
            }
          />
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              onClick={() => {
                setPlaying(true);
                setIndex(0);
              }}
              className="btn btn-primary h-10"
            >
              <Play className="h-4 w-4" /> Play {tracks.length} tracks
            </button>
            {order === "random" && (
              <button onClick={() => setSeed((s) => s + 1)} className="btn btn-subtle h-10" title="Reshuffle">
                <Shuffle className="h-4 w-4" /> Reshuffle
              </button>
            )}
            <span className="ml-auto text-xs text-ink-faint">
              {content === "ost" ? "Multiple OST tracks per game when enriched" : "One pick per game"}
            </span>
          </div>

          {playing && (
            <JukeboxPlayer tracks={tracks} index={index} playing={playing} onIndex={setIndex} onPlaying={setPlaying} />
          )}

          <div className="-mx-1 mt-4 flex gap-3 overflow-x-auto px-1 pb-2 [scrollbar-width:thin]">
            {tracks.map((t, i) => (
              <button
                key={`${t.g.id}-${t.vid}-${i}`}
                type="button"
                onClick={() => {
                  setIndex(i);
                  setPlaying(true);
                }}
                className="group relative w-[104px] shrink-0 text-left"
              >
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.025, 0.4), duration: 0.35 }}
                  className={cn(
                    "relative aspect-[3/4] overflow-hidden rounded-xl border transition group-hover:-translate-y-1 group-hover:shadow-float",
                    playing && index === i ? "border-accent ring-1 ring-accent/40" : "border-line"
                  )}
                >
                  <GameArt
                    id={t.g.id}
                    name={t.g.displayName}
                    cover={t.g.coverPath}
                    icon={t.g.iconPath}
                    accent={t.g.accentColor}
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
            ))}
          </div>
        </>
      )}
    </Panel>
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
