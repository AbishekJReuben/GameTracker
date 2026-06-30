import { useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  ListPlus,
  ListMusic,
  Play,
  Plus,
  Shuffle,
  ExternalLink,
  DownloadCloud,
  Loader2,
  Music2,
} from "lucide-react";
import { api, type Game } from "@/lib/api";
import { Panel } from "./Panel";
import { SectionTitle, EmptyState } from "./ui";
import { AddToPlaylist } from "./AddToPlaylist";
import { useJukebox } from "@/store/jukebox";
import { useApp } from "@/store/app";
import { buildGameTrackList, buildWatchVideosUrl, playlistUrl } from "@/lib/jukeboxTracks";
import { cn } from "@/lib/cn";
import { openExternalUrl } from "@/lib/tauri";

/** Animated equalizer shown on the currently-playing row. */
function Equalizer() {
  return (
    <span className="flex h-3.5 items-end gap-[2px]">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-full bg-accent"
          animate={{ height: ["30%", "100%", "45%", "85%", "30%"] }}
          transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut", delay: i * 0.18 }}
          style={{ height: "30%" }}
        />
      ))}
    </span>
  );
}

/** A game's full soundtrack — the proper, in-page place to browse & play its OST. */
export function SoundtrackPanel({ game }: { game: Game }) {
  const tracks = useMemo(() => buildGameTrackList(game), [game]);
  const start = useJukebox((s) => s.start);
  const playFromList = useJukebox((s) => s.playFromList);
  const enqueue = useJukebox((s) => s.enqueue);
  const playNext = useJukebox((s) => s.playNext);
  const toggleShuffle = useJukebox((s) => s.toggleShuffle);
  const shuffle = useJukebox((s) => s.shuffle);
  const active = useJukebox((s) => s.active);
  const current = useJukebox((s) => s.tracks[s.index]);
  const playing = useJukebox((s) => s.playing);
  const pushToast = useApp((s) => s.pushToast);
  const setPref = useApp((s) => s.setPref);

  const [fetching, setFetching] = useState(false);
  const sparse = !game.themePlaylistId && tracks.length < 6;

  const playAll = () => {
    setPref("themeMuted", false);
    start(tracks, 0);
  };
  const shufflePlay = () => {
    setPref("themeMuted", false);
    if (!shuffle) toggleShuffle();
    start(tracks, Math.floor(Math.random() * tracks.length));
  };
  const addAll = () => {
    const n = enqueue(tracks);
    pushToast({ kind: "success", title: n ? `Added ${n} to queue` : "Already in queue" });
  };
  const playTrack = (i: number) => {
    setPref("themeMuted", false);
    playFromList(tracks, i);
  };
  const queueTrack = (i: number) => {
    const n = enqueue([tracks[i]]);
    pushToast({ kind: n ? "success" : "info", title: n ? "Added to queue" : "Already in queue" });
  };
  const playTrackNext = (i: number) => {
    const n = playNext([tracks[i]]);
    if (n) pushToast({ kind: "success", title: "Playing next" });
  };
  const getFullOst = async () => {
    setFetching(true);
    try {
      await api.fetchFullOst(game.id);
      pushToast({ kind: "info", title: "Fetching full soundtrack", message: "Updates here when ready" });
    } catch (e) {
      pushToast({ kind: "info", title: "Turn on Online metadata in Settings", message: String(e) });
    } finally {
      setTimeout(() => setFetching(false), 1500);
    }
  };
  const openYouTube = async () => {
    const url = game.themePlaylistId ? playlistUrl(game.themePlaylistId) : buildWatchVideosUrl(tracks);
    if (!url) {
      pushToast({ kind: "info", title: "No YouTube link", message: "Fetch the full OST first." });
      return;
    }
    try {
      await openExternalUrl(url);
    } catch (e) {
      pushToast({ kind: "info", title: "Could not open YouTube", message: String(e) });
    }
  };

  const isCurrent = (vid: string) => active && current?.gameId === game.id && current?.vid === vid;

  return (
    <Panel panelKey="game.soundtrack" games={[game]} className="mb-6">
      <SectionTitle
        title="Soundtrack"
        subtitle={
          tracks.length
            ? `${tracks.length} track${tracks.length > 1 ? "s" : ""}${game.themePlaylistId ? " · full OST" : ""}`
            : "Find this game's OST on YouTube"
        }
        right={<ListMusic className="h-4 w-4 text-ink-dim" />}
      />

      {tracks.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={<Music2 className="h-6 w-6" />}
            title="No soundtrack yet"
            message="Fetch this game's full OST from YouTube — no API key needed."
          />
          <button onClick={getFullOst} disabled={fetching} className="btn btn-primary mx-auto mt-4 h-10 disabled:opacity-60">
            {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
            Get full OST
          </button>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={playAll} className="btn btn-primary h-9">
              <Play className="h-4 w-4" /> Play all
            </button>
            <button onClick={shufflePlay} className="btn btn-subtle h-9" title="Shuffle play">
              <Shuffle className="h-4 w-4" /> Shuffle
            </button>
            <button onClick={addAll} className="btn btn-ghost h-9" title="Add all to queue">
              <ListPlus className="h-4 w-4" /> Queue all
            </button>
            <button onClick={openYouTube} className="btn btn-ghost h-9" title="Open on YouTube">
              <ExternalLink className="h-4 w-4" /> YouTube
            </button>
            {sparse && (
              <button onClick={getFullOst} disabled={fetching} className="btn btn-ghost h-9 disabled:opacity-60" title="Scrape the full OST playlist">
                {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
                Get full OST
              </button>
            )}
          </div>

          <ul className="mt-3 max-h-[360px] space-y-0.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
            {tracks.map((t, i) => {
              const playingThis = isCurrent(t.vid);
              return (
                <motion.li
                  key={`${t.vid}-${i}`}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(i * 0.015, 0.3), duration: 0.3 }}
                  className={cn(
                    "group flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 transition",
                    playingThis ? "bg-accent/10 ring-1 ring-accent/30" : "hover:bg-white/[0.04]"
                  )}
                  onClick={() => playTrack(i)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      playTrack(i);
                    }
                  }}
                >
                  <span
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/[0.06] text-[11px] font-800 tabular-nums text-ink-dim transition group-hover:bg-accent/20 group-hover:text-accent"
                  >
                    {playingThis && playing ? <Equalizer /> : <span className="group-hover:hidden">{i + 1}</span>}
                    {!(playingThis && playing) && <Play className="hidden h-3.5 w-3.5 group-hover:block" />}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-sm font-600",
                      playingThis ? "text-accent" : "text-ink-soft"
                    )}
                  >
                    {t.label}
                  </span>
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
                    <AddToPlaylist
                      tracks={[{ vid: t.vid, gameId: t.gameId, title: t.label, artist: t.gameName, coverPath: t.coverPath, iconPath: t.iconPath }]}
                    />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        playTrackNext(i);
                      }}
                      className="grid h-7 w-7 place-items-center rounded-lg text-ink-faint transition hover:bg-white/[0.08] hover:text-ink"
                      title="Play next"
                    >
                      <ListMusic className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        queueTrack(i);
                      }}
                      className="grid h-7 w-7 place-items-center rounded-lg text-ink-faint transition hover:bg-white/[0.08] hover:text-ink"
                      title="Add to queue"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </motion.li>
              );
            })}
          </ul>
        </>
      )}
    </Panel>
  );
}
