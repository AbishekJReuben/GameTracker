import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Play, Plus, Trash2, GripVertical, X, ListMusic, Pencil, Check, Shuffle } from "lucide-react";
import { Panel } from "@/components/Panel";
import { SectionTitle, EmptyState } from "@/components/ui";
import { assetUrl, Playlist, PlaylistTrack } from "@/lib/api";
import { usePlaylists, usePlaylist, usePlaylistMutations } from "@/lib/queries";
import { useJukebox } from "@/store/jukebox";
import { useApp, useMotionEnabled } from "@/store/app";
import type { JukeboxTrack } from "@/lib/jukeboxTracks";

function toJukebox(t: PlaylistTrack): JukeboxTrack {
  return {
    gameId: t.gameId ?? "",
    gameName: t.artist ?? "",
    coverPath: t.coverPath ?? null,
    iconPath: t.iconPath ?? null,
    accentColor: null,
    vid: t.vid,
    label: t.title ?? t.vid,
  };
}

export function Playlists() {
  const enabled = useMotionEnabled();
  const { data: playlists } = usePlaylists();
  const { create } = usePlaylistMutations();
  const pushToast = useApp((s) => s.pushToast);
  const [newName, setNewName] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const start = useJukebox((s) => s.start);

  const createPlaylist = async () => {
    const n = newName.trim();
    if (!n) return;
    const id = await create.mutateAsync(n);
    setNewName("");
    setOpenId(id);
  };

  const playAll = (pl: Playlist, shuffle = false) => {
    if (pl.tracks.length === 0) return;
    const tracks = pl.tracks.map(toJukebox);
    const startIndex = shuffle ? Math.floor(Math.random() * tracks.length) : 0;
    start(tracks, startIndex);
    if (shuffle && !useJukebox.getState().shuffle) useJukebox.getState().toggleShuffle();
    pushToast({ kind: "play", title: `Playing ${pl.name}`, message: `${tracks.length} tracks` });
  };

  return (
    <Panel panelKey="sessions.playlists" className="mb-5">
      <SectionTitle
        title="Playlists"
        subtitle="Your curated soundtracks"
        right={
          <div className="flex items-center gap-1.5">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createPlaylist()}
              placeholder="New playlist…"
              className="input h-8 w-40 text-sm"
            />
            <button
              onClick={createPlaylist}
              disabled={!newName.trim()}
              className="btn btn-primary h-8 px-2.5 text-sm disabled:opacity-40"
            >
              <Plus className="h-4 w-4" /> New
            </button>
          </div>
        }
      />

      {!playlists || playlists.length === 0 ? (
        <EmptyState
          title="No playlists yet"
          message="Create one above, then use the + button on any soundtrack track to add to it."
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {playlists.map((pl, i) => (
            <motion.button
              key={pl.id}
              onClick={() => setOpenId(pl.id)}
              className="group/pl relative overflow-hidden rounded-2xl border border-line bg-bg-900/50 p-2.5 text-left transition hover:border-accent-1/40"
              initial={enabled ? { opacity: 0, y: 10 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
            >
              <Collage covers={pl.covers} />
              <div className="mt-2 truncate text-sm font-700 text-ink">{pl.name}</div>
              <div className="text-[11px] text-ink-faint">{pl.trackCount} tracks</div>
              {pl.trackCount > 0 && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenId(pl.id);
                  }}
                  className="absolute right-3 top-3 grid h-9 w-9 translate-y-1 place-items-center rounded-full bg-accent-sheen text-white opacity-0 shadow-glow transition group-hover/pl:translate-y-0 group-hover/pl:opacity-100"
                >
                  <Play className="h-4 w-4" />
                </span>
              )}
            </motion.button>
          ))}
        </div>
      )}

      <AnimatePresence>
        {openId && (
          <PlaylistDetail
            id={openId}
            onClose={() => setOpenId(null)}
            onPlay={playAll}
          />
        )}
      </AnimatePresence>
    </Panel>
  );
}

function Collage({ covers }: { covers: string[] }) {
  const imgs = covers.map(assetUrl).filter(Boolean).slice(0, 4) as string[];
  if (imgs.length === 0) {
    return (
      <div className="grid aspect-square w-full place-items-center rounded-xl bg-gradient-to-br from-bg-800 to-bg-850 text-ink-faint">
        <ListMusic className="h-8 w-8" />
      </div>
    );
  }
  if (imgs.length < 4) {
    return <img src={imgs[0]} alt="" className="aspect-square w-full rounded-xl object-cover" />;
  }
  return (
    <div className="grid aspect-square w-full grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden rounded-xl">
      {imgs.map((s, i) => (
        <img key={i} src={s} alt="" className="h-full w-full object-cover" />
      ))}
    </div>
  );
}

function PlaylistDetail({
  id,
  onClose,
  onPlay,
}: {
  id: string;
  onClose: () => void;
  onPlay: (pl: Playlist, shuffle?: boolean) => void;
}) {
  const { data: pl } = usePlaylist(id);
  const { rename, remove, removeTrack, reorder } = usePlaylistMutations();
  const playFromList = useJukebox((s) => s.playFromList);
  const [order, setOrder] = useState<PlaylistTrack[]>([]);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  useEffect(() => {
    if (pl) {
      setOrder(pl.tracks);
      setName(pl.name);
    }
  }, [pl]);

  if (!pl) return null;

  const commitReorder = (next: PlaylistTrack[]) => {
    setOrder(next);
    reorder.mutate({ id, vids: next.map((t) => t.vid) });
  };

  const onDrop = (toIdx: number) => {
    if (dragIdx === null || dragIdx === toIdx) return;
    const next = [...order];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(toIdx, 0, moved);
    setDragIdx(null);
    commitReorder(next);
  };

  const saveName = () => {
    const n = name.trim();
    if (n && n !== pl.name) rename.mutate({ id, name: n });
    setEditing(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="mt-4 overflow-hidden"
    >
      <div className="rounded-2xl border border-line bg-bg-900/60 p-4">
        <div className="mb-3 flex items-center gap-2">
          {editing ? (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
              autoFocus
              className="input h-9 max-w-xs flex-1 text-base font-700"
            />
          ) : (
            <h3 className="font-display text-xl font-800 text-ink">{pl.name}</h3>
          )}
          <button
            onClick={() => (editing ? saveName() : setEditing(true))}
            className="grid h-8 w-8 place-items-center rounded-lg text-ink-dim hover:bg-white/[0.06] hover:text-ink"
            title={editing ? "Save" : "Rename"}
          >
            {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          </button>
          <span className="text-sm text-ink-faint">{order.length} tracks</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => onPlay(pl)} disabled={order.length === 0} className="btn btn-primary h-9 disabled:opacity-40">
              <Play className="h-4 w-4" /> Play
            </button>
            <button onClick={() => onPlay(pl, true)} disabled={order.length === 0} className="btn btn-ghost h-9 disabled:opacity-40" title="Shuffle">
              <Shuffle className="h-4 w-4" />
            </button>
            <button
              onClick={() => {
                if (confirm(`Delete playlist “${pl.name}”?`)) {
                  remove.mutate(id);
                  onClose();
                }
              }}
              className="grid h-9 w-9 place-items-center rounded-lg text-ink-dim hover:bg-pink/10 hover:text-pink"
              title="Delete playlist"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg text-ink-dim hover:bg-white/[0.06] hover:text-ink">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {order.length === 0 ? (
          <EmptyState title="Empty playlist" message="Add tracks with the + button on any soundtrack." />
        ) : (
          <div className="divide-y divide-line">
            {order.map((t, i) => {
              const art = assetUrl(t.coverPath || t.iconPath);
              return (
                <div
                  key={t.vid}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(i)}
                  className={`group/tr flex items-center gap-3 py-2 ${dragIdx === i ? "opacity-50" : ""}`}
                >
                  <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-ink-faint" />
                  <span className="w-5 shrink-0 text-right text-xs tabular-nums text-ink-faint">{i + 1}</span>
                  <button onClick={() => playFromList(order.map(toJukebox), i)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <span className="h-9 w-9 shrink-0 overflow-hidden rounded-md bg-bg-850">
                      {art ? <img src={art} alt="" className="h-full w-full object-cover" /> : <span className="grid h-full w-full place-items-center text-ink-faint"><ListMusic className="h-4 w-4" /></span>}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-700 text-ink-soft group-hover/tr:text-ink">{t.title ?? t.vid}</span>
                      {t.artist && <span className="block truncate text-[11px] text-ink-faint">{t.artist}</span>}
                    </span>
                  </button>
                  <button
                    onClick={() => removeTrack.mutate({ id, vid: t.vid })}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-faint opacity-0 transition hover:bg-pink/10 hover:text-pink group-hover/tr:opacity-100"
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </motion.div>
  );
}
