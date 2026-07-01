import { Music2, Mic2, Disc3, Headphones, Clock } from "lucide-react";
import { MediaPlay, MusicOverview, MusicTop } from "@/lib/api";
import { dur, relativeTime } from "@/lib/format";
import { mediaUrl as remoteMediaUrl } from "../link";
import { useRemote } from "../useRemote";

export function MusicScreen() {
  const { data: overview, loading, error } = useRemote<MusicOverview>("/api/music/overview", 10000);
  const { data: top } = useRemote<MusicTop>("/api/music/top?limit=8", 15000);
  const { data: recent } = useRemote<MediaPlay[]>("/api/music/recent?limit=16", 8000);

  if (loading && !overview) return <div className="grid h-full place-items-center p-8 text-sm text-ink-dim">Loading…</div>;
  if (error && !overview) return <div className="m-4 rounded-xl border border-amber/40 bg-amber/10 p-3 text-sm text-amber">{error}</div>;
  if (!overview) return null;

  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-3">
        <Stat icon={<Headphones className="h-4 w-4" />} label="Total" value={dur(overview.totalSeconds)} sub={`${overview.playCount} plays`} color="#a78bfa" />
        <Stat icon={<Clock className="h-4 w-4" />} label="Today" value={dur(overview.todaySeconds)} sub={`${dur(overview.weekSeconds)} week`} color="#22d3ee" />
        <Stat icon={<Mic2 className="h-4 w-4" />} label="Artists" value={String(overview.distinctArtists)} color="#f472b6" />
        <Stat icon={<Music2 className="h-4 w-4" />} label="Tracks" value={String(overview.distinctTracks)} color="#34d399" />
      </div>

      {top && (
        <>
          <TopList title="Top artists" icon={<Mic2 className="h-4 w-4" />} entries={top.artists} />
          <TopList title="Most played" icon={<Music2 className="h-4 w-4" />} entries={top.tracks} />
          <TopList title="Top albums" icon={<Disc3 className="h-4 w-4" />} entries={top.albums} />
        </>
      )}

      {recent && recent.length > 0 && (
        <div className="rounded-2xl border border-line bg-white/[0.02] p-3">
          <h2 className="mb-2 text-[11px] font-800 uppercase tracking-wider text-ink-dim">Recently played</h2>
          <div className="divide-y divide-line">
            {recent.map((p) => {
              const art = remoteMediaUrl(p.thumbPath);
              return (
                <div key={p.id} className="flex items-center gap-3 py-2">
                  <div className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md bg-bg-850">
                    {art ? <img src={art} alt="" className="h-full w-full object-cover" /> : <Music2 className="h-4 w-4 text-ink-faint" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-700">{p.title ?? "Unknown"}</div>
                    <div className="truncate text-[11px] text-ink-faint">{[p.artist, p.appName].filter(Boolean).join(" · ")}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-xs font-700 tabular-nums text-ink-dim">{dur(p.playedSeconds)}</div>
                    <div className="text-[10px] text-ink-faint">{relativeTime(p.lastSeenUtc)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ icon, label, value, sub, color }: { icon: React.ReactNode; label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white/[0.02] p-3">
      <div className="mb-1.5 flex items-center gap-2 text-ink-dim">
        <span className="grid h-6 w-6 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
          {icon}
        </span>
        <span className="text-[10px] font-700 uppercase tracking-wider">{label}</span>
      </div>
      <div className="font-display text-xl font-800 tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}

function TopList({ title, icon, entries }: { title: string; icon: React.ReactNode; entries: MusicTop["artists"] }) {
  if (!entries || entries.length === 0) return null;
  const max = Math.max(1, ...entries.map((e) => e.seconds));
  return (
    <div className="rounded-2xl border border-line bg-white/[0.02] p-3">
      <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-800 uppercase tracking-wider text-ink-dim">
        {icon} {title}
      </h2>
      <div className="space-y-2">
        {entries.slice(0, 6).map((e, i) => (
          <div key={e.key} className="flex items-center gap-3">
            <span className="w-4 text-right text-xs font-700 tabular-nums text-ink-faint">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-700">{e.label}</div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
                <div className="h-full rounded-full bg-accent-sheen" style={{ width: `${(e.seconds / max) * 100}%` }} />
              </div>
            </div>
            <span className="shrink-0 text-sm font-800 tabular-nums">{dur(e.seconds)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
