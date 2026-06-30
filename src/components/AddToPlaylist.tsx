import { useEffect, useRef, useState } from "react";
import { ListPlus, Plus, Check, ListMusic } from "lucide-react";
import { cn } from "@/lib/cn";
import { PlaylistTrack } from "@/lib/api";
import { usePlaylists, usePlaylistMutations } from "@/lib/queries";
import { useApp } from "@/store/app";

/**
 * A "+" control that adds one or more tracks to an existing playlist or a new
 * one. Reused from OST lists, the jukebox floater, game detail, and Music rows.
 */
export function AddToPlaylist({
  tracks,
  className,
  size = "sm",
  align = "right",
}: {
  tracks: PlaylistTrack[];
  className?: string;
  size?: "sm" | "md";
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const { data: playlists } = usePlaylists();
  const { create, addTracks } = usePlaylistMutations();
  const pushToast = useApp((s) => s.pushToast);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (tracks.length === 0) return null;
  const valid = tracks.filter((t) => t.vid);

  const summary = valid.length > 1 ? `${valid.length} tracks` : valid[0]?.title ?? "track";

  const addTo = async (id: string, plName: string) => {
    try {
      await addTracks.mutateAsync({ id, tracks: valid });
      pushToast({ kind: "success", title: `Added to ${plName}`, message: summary });
    } catch (e) {
      pushToast({ kind: "info", title: "Couldn't add", message: String(e) });
    }
    setOpen(false);
  };

  const createAndAdd = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      const id = await create.mutateAsync(n);
      await addTracks.mutateAsync({ id, tracks: valid });
      pushToast({ kind: "success", title: `Created “${n}”`, message: summary });
    } catch (e) {
      pushToast({ kind: "info", title: "Couldn't create playlist", message: String(e) });
    }
    setName("");
    setOpen(false);
  };

  const btnSize = size === "md" ? "h-9 w-9" : "h-7 w-7";
  const iconSize = size === "md" ? "h-4 w-4" : "h-3.5 w-3.5";

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((o) => !o);
        }}
        className={cn(
          "grid place-items-center rounded-lg border border-line bg-white/[0.03] text-ink-dim transition hover:bg-white/[0.07] hover:text-ink",
          btnSize
        )}
        title="Add to playlist"
      >
        <ListPlus className={iconSize} />
      </button>
      {open && (
        <div
          className={cn(
            "absolute z-[300] mt-1 w-60 overflow-hidden rounded-xl border border-line bg-bg-850 p-1.5 shadow-float",
            align === "right" ? "right-0" : "left-0"
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-2 py-1 text-[10px] font-700 uppercase tracking-wider text-ink-faint">
            Add to playlist
          </div>
          <div className="max-h-52 overflow-y-auto">
            {playlists && playlists.length > 0 ? (
              playlists.map((pl) => (
                <button
                  key={pl.id}
                  onClick={() => addTo(pl.id, pl.name)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-ink-soft transition hover:bg-white/[0.06]"
                >
                  <ListMusic className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate font-600">{pl.name}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">{pl.trackCount}</span>
                </button>
              ))
            ) : (
              <div className="px-2 py-1.5 text-xs text-ink-faint">No playlists yet</div>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5 border-t border-line pt-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createAndAdd();
              }}
              placeholder="New playlist…"
              className="input h-8 flex-1 text-sm"
            />
            <button
              onClick={createAndAdd}
              disabled={!name.trim()}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-sheen text-white disabled:opacity-40"
              title="Create & add"
            >
              {create.isPending ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
