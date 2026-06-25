import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { Music2, Play, Shuffle, ListMusic } from "lucide-react";
import type { Game } from "@/lib/api";
import { Panel } from "./Panel";
import { SectionTitle, EmptyState, Segmented } from "./ui";
import { GameArt } from "./GameArt";
import { useJukebox } from "@/store/jukebox";
import {
  buildJukeboxQueue,
  JUKEBOX_MAX,
  type JukeboxContent,
  type JukeboxOrder,
  type JukeboxSource,
} from "@/lib/jukeboxTracks";
import { cn } from "@/lib/cn";

/**
 * Builds a jukebox queue from the library and hands off to the global player.
 */
export function ThemePlaylist({ games }: { games: Game[] }) {
  const [source, setSource] = useState<JukeboxSource>("top");
  const [content, setContent] = useState<JukeboxContent>("ost");
  const [order, setOrder] = useState<JukeboxOrder>("played");
  const [limit, setLimit] = useState(25);
  const [seed, setSeed] = useState(7);

  const jukeboxActive = useJukebox((s) => s.active);
  const jukeboxIndex = useJukebox((s) => s.index);
  const start = useJukebox((s) => s.start);
  const seek = useJukebox((s) => s.seek);

  const tracks = useMemo(
    () => buildJukeboxQueue(games, source, content, order, limit, seed),
    [games, source, content, order, limit, seed]
  );

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
        subtitle="OST mix — keeps playing in the background with a floating mini player"
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
              { value: "25", label: "25" },
              { value: "50", label: "50" },
              { value: "100", label: "100" },
              { value: "250", label: "250" },
              { value: "500", label: "500" },
              { value: "1000", label: "1000" },
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
            <button onClick={() => start(tracks, 0)} className="btn btn-primary h-10">
              <Play className="h-4 w-4" /> Play {Math.min(tracks.length, JUKEBOX_MAX)} tracks
            </button>
            {order === "random" && (
              <button onClick={() => setSeed((s) => s + 1)} className="btn btn-subtle h-10" title="Reshuffle">
                <Shuffle className="h-4 w-4" /> Reshuffle
              </button>
            )}
            <span className="ml-auto text-xs text-ink-faint">
              {jukeboxActive ? "Playing in background — drag the mini player anywhere" : "Uses Windows media keys when available"}
            </span>
          </div>

          <div className="-mx-1 mt-4 flex gap-3 overflow-x-auto px-1 pb-2 [scrollbar-width:thin]">
            {tracks.map((t, i) => (
              <button
                key={`${t.gameId}-${t.vid}-${i}`}
                type="button"
                onClick={() => (jukeboxActive ? seek(i) : start(tracks, i))}
                className="group relative w-[104px] shrink-0 text-left"
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
