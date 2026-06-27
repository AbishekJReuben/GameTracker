import { useEffect, useState } from "react";
import { ExternalLink, Loader2, MonitorPlay as TwitchIcon, Radio, RefreshCw } from "lucide-react";
import { api, type Game, type TwitchLive } from "@/lib/api";
import { openExternalUrl } from "@/lib/tauri";
import { twitchDirectoryUrl } from "@/lib/twitch";

/**
 * Live Twitch stream for a game. Resolves the top live channel (keyless backend
 * GQL) and embeds the real `player.twitch.tv` iframe (parent = the Tauri webview
 * origin). Falls back to a "browse the directory" link when nobody is live.
 */
export function TwitchPanel({ game }: { game: Game }) {
  const [data, setData] = useState<TwitchLive | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .fetchTwitchLive(game.displayName)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [game.displayName, game.id, nonce]);

  const dirUrl = data?.slug
    ? `https://www.twitch.tv/directory/category/${data.slug}`
    : twitchDirectoryUrl(game.displayName);
  const channel = data?.channel ?? null;
  // player.twitch.tv requires the embedding page's host as `parent`. The Tauri
  // webview is http://tauri.localhost on Windows; localhost covers Vite dev.
  const src = channel
    ? `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=tauri.localhost&parent=localhost&muted=true&autoplay=true`
    : null;

  return (
    <div className="card flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <span className="flex items-center gap-2 font-display text-sm font-800">
          <TwitchIcon className="h-4 w-4 text-[#9146FF]" />
          Live on Twitch
          {channel && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#9146FF]/15 px-2 py-0.5 text-[10px] font-800 uppercase tracking-wide text-[#bf94ff]">
              <Radio className="h-2.5 w-2.5" /> Live
            </span>
          )}
        </span>
        <span className="flex items-center gap-2 text-ink-dim">
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            className="btn btn-ghost h-8 px-2"
            title="Refresh"
            disabled={loading}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
          <button type="button" onClick={() => openExternalUrl(dirUrl)} className="btn btn-ghost h-8 px-2" title="Browse on Twitch">
            <ExternalLink className="h-3.5 w-3.5" /> Twitch
          </button>
        </span>
      </div>

      <div className="relative aspect-[8/9] bg-black">
        {loading ? (
          <div className="grid h-full place-items-center text-ink-dim">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : src ? (
          <>
            <iframe
              key={channel}
              src={src}
              title={`${game.displayName} live on Twitch`}
              allowFullScreen
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              className="absolute inset-0 h-full w-full border-0"
            />
            {data?.channelName && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent p-3">
                <span className="truncate text-xs font-700 text-white">{data.channelName}</span>
                {data.viewers > 0 && (
                  <span className="shrink-0 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-800 text-white backdrop-blur">
                    {data.viewers.toLocaleString()} watching
                  </span>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="grid h-full place-items-center p-6 text-center">
            <div>
              <TwitchIcon className="mx-auto mb-2 h-8 w-8 text-[#9146FF]" />
              <div className="text-sm font-700 text-ink-soft">
                {data ? `No one's live on ${data.game} right now` : "No live streams found"}
              </div>
              <button onClick={() => openExternalUrl(dirUrl)} className="btn btn-subtle mx-auto mt-3 h-9">
                <ExternalLink className="h-4 w-4" /> Browse on Twitch
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
