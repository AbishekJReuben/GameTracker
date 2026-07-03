/**
 * Companion Music — a mobile port of the desktop Music route: full listening
 * analytics (now-listening, overview, timeline by media type, heatmap, hour-of-day,
 * type split, top artists/tracks/albums/apps, insights, recently played) plus
 * playlists (view / create / rename / delete / play). Data over the remote link
 * (`/api/music/*`, `/api/playlists*`); thumbnails via `loadMedia`.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Music2,
  Mic2,
  Disc3,
  Headphones,
  Clock,
  Flame,
  Sparkles,
  Radio,
  Film,
  Repeat,
  Moon,
  Gamepad2,
  ListMusic,
  Plus,
  Trash2,
  Play,
  X,
  Pencil,
  Loader2,
} from "lucide-react";
import type { MediaPlay, MusicOverview, MusicTop, MusicInsights, MusicEntry, DayValue, Playlist } from "@/lib/api";
import { dur, hourLabel, relativeTime } from "@/lib/format";
import { Heatmap } from "@/components/Heatmap";
import { useRemote } from "../useRemote";
import { apiGet, apiPost } from "../link";
import { LoadedImg } from "../ui";

const TYPE_META: Record<string, { label: string; icon: typeof Music2; color: string }> = {
  music: { label: "Music", icon: Music2, color: "#a78bfa" },
  video: { label: "Video", icon: Film, color: "#22d3ee" },
  podcast: { label: "Podcast", icon: Mic2, color: "#f472b6" },
  other: { label: "Other", icon: Radio, color: "#94a3b8" },
};
const typeMeta = (t: string) => TYPE_META[t] ?? TYPE_META.other;

const TL_RANGES = [
  { min: 1440, label: "24h" },
  { min: 360, label: "6h" },
  { min: 60, label: "1h" },
  { min: 10080, label: "7d" },
];

export function MusicScreen() {
  const { data: overview, loading, error } = useRemote<MusicOverview>("/api/music/overview", 10000);
  const { data: top } = useRemote<MusicTop>("/api/music/top?limit=10", 20000);
  const { data: insights } = useRemote<MusicInsights>("/api/music/insights", 30000);
  const { data: heat } = useRemote<DayValue[]>("/api/music/heatmap?days=140", 60000);
  const { data: hours } = useRemote<number[]>("/api/music/hourofday", 60000);
  const { data: recent } = useRemote<MediaPlay[]>("/api/music/recent?limit=16", 8000);

  if (loading && !overview) return <Center>Loading…</Center>;
  if (error && !overview) return <div className="m-4 rounded-xl border border-amber/40 bg-amber/10 p-3 text-sm text-amber">{error}</div>;
  if (!overview) return null;

  const nowPlaying = recent?.find((p) => !p.endUtc) ?? null;
  const empty = overview.playCount === 0;

  return (
    <div className="space-y-4 p-4">
      {nowPlaying && <NowHero play={nowPlaying} />}

      {empty ? (
        <div className="grid h-40 place-items-center p-6 text-center text-sm text-ink-dim">
          No listening recorded yet. Play music on your PC — it's tracked automatically.
        </div>
      ) : (
        <>
          {/* overview stats */}
          <div className="grid grid-cols-2 gap-2.5">
            <Stat icon={<Headphones className="h-4 w-4" />} label="Total" value={dur(overview.totalSeconds)} sub={`${overview.playCount} plays`} color="#a78bfa" />
            <Stat icon={<Clock className="h-4 w-4" />} label="Today" value={dur(overview.todaySeconds)} sub={`${dur(overview.weekSeconds)} week`} color="#22d3ee" />
            <Stat icon={<Mic2 className="h-4 w-4" />} label="Artists" value={String(overview.distinctArtists)} sub={`${overview.distinctAlbums} albums`} color="#f472b6" />
            <Stat icon={<Music2 className="h-4 w-4" />} label="Tracks" value={String(overview.distinctTracks)} sub={`${overview.distinctApps} sources`} color="#34d399" />
            <Stat icon={<Flame className="h-4 w-4" />} label="Streak" value={`${overview.currentStreak}d`} sub={`best ${overview.longestStreak}d`} color="#fb923c" />
            <Stat icon={<Sparkles className="h-4 w-4" />} label="Avg / day" value={dur(overview.avgPerActiveDay)} sub={`${overview.activeDays} active days`} color="#facc15" />
          </div>

          <Playlists />
          <TimelineSection />

          <Section title="Listening heatmap" subtitle="Every day you pressed play">
            {heat ? <Heatmap data={heat} maxStep={16} /> : <Center>Loading…</Center>}
          </Section>

          <HourOfDay hours={hours} />

          {overview.byType.length > 0 && <TypeSplit overview={overview} />}

          {top && (
            <>
              <TopList title="Top artists" icon={<Mic2 className="h-4 w-4" />} entries={top.artists} />
              <TopList title="Most played tracks" icon={<Music2 className="h-4 w-4" />} entries={top.tracks} />
              <TopList title="Top albums" icon={<Disc3 className="h-4 w-4" />} entries={top.albums} />
              <TopList title="Where it's playing" icon={<Headphones className="h-4 w-4" />} entries={top.apps} />
            </>
          )}

          {insights && <InsightsGrid insights={insights} />}

          {recent && recent.length > 0 && (
            <Section title="Recently played" subtitle="Your latest tracks across every app">
              <div className="divide-y divide-line">
                {recent.map((p) => {
                  const meta = typeMeta(p.mediaType);
                  return (
                    <div key={p.id} className="flex items-center gap-3 py-2">
                      <LoadedImg path={p.thumbPath} className="h-9 w-9 shrink-0 rounded-md object-cover" fallback={<span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-bg-850" style={{ color: meta.color }}><meta.icon className="h-4 w-4" /></span>} />
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
            </Section>
          )}

          <p className="pb-2 text-center text-[11px] text-ink-faint">Captured locally on your PC via Windows media + the jukebox.</p>
        </>
      )}
    </div>
  );
}

function NowHero({ play }: { play: MediaPlay }) {
  const meta = typeMeta(play.mediaType);
  return (
    <div className="flex items-center gap-3 overflow-hidden rounded-2xl border border-line bg-bg-900/60 p-3" style={{ boxShadow: `inset 0 0 60px -30px ${meta.color}` }}>
      <LoadedImg path={play.thumbPath} className="h-14 w-14 shrink-0 rounded-xl object-cover" fallback={<span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl" style={{ background: `color-mix(in srgb, ${meta.color} 25%, transparent)`, color: meta.color }}><meta.icon className="h-6 w-6" /></span>} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider" style={{ color: meta.color }}>
          <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: meta.color }} /><span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: meta.color }} /></span>
          Now playing · {play.appName ?? ""}
        </div>
        <div className="truncate font-display text-lg font-800 text-ink">{play.title ?? "Unknown"}</div>
        <div className="truncate text-sm text-ink-dim">{play.artist ?? ""}</div>
      </div>
    </div>
  );
}

function TimelineSection() {
  const [minutes, setMinutes] = useState(1440);
  const now = Date.now();
  const start = now - minutes * 60_000;
  const span = now - start;
  const fromISO = new Date(start).toISOString();
  const toISO = new Date(now).toISOString();
  const { data: plays } = useRemote<MediaPlay[]>(`/api/music/timeline?fromUtc=${encodeURIComponent(fromISO)}&toUtc=${encodeURIComponent(toISO)}`, 15000);

  const rows = useMemo(() => {
    const order = ["music", "video", "podcast", "other"];
    const byType = new Map<string, { p: MediaPlay; left: number; width: number }[]>();
    for (const p of plays ?? []) {
      const s = new Date(p.startUtc).getTime();
      const e = p.endUtc ? new Date(p.endUtc).getTime() : now;
      if (e <= start || s >= now) continue;
      const cs = Math.max(s, start);
      const ce = Math.min(e, now);
      const key = TYPE_META[p.mediaType] ? p.mediaType : "other";
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key)!.push({ p, left: ((cs - start) / span) * 100, width: Math.max(0.4, ((ce - cs) / span) * 100) });
    }
    return order.filter((t) => byType.has(t)).map((t) => ({ type: t, items: byType.get(t)! }));
  }, [plays, start, now, span]);

  return (
    <Section
      title="Listening timeline"
      subtitle={`Last ${TL_RANGES.find((r) => r.min === minutes)?.label}`}
      right={
        <div className="flex gap-1">
          {TL_RANGES.map((r) => (
            <button key={r.min} onClick={() => setMinutes(r.min)} className={`rounded-md px-2 py-1 text-[10px] font-700 ${minutes === r.min ? "bg-accent-3 text-white" : "bg-white/[0.05] text-ink-dim"}`}>{r.label}</button>
          ))}
        </div>
      }
    >
      {rows.length === 0 ? (
        <div className="grid h-16 place-items-center text-xs text-ink-faint">No listening in this window</div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const meta = typeMeta(row.type);
            return (
              <div key={row.type} className="flex items-center gap-2">
                <span className="flex w-14 shrink-0 items-center gap-1 text-[10px] font-700 uppercase" style={{ color: meta.color }}><meta.icon className="h-3 w-3" /> {meta.label}</span>
                <div className="relative h-6 flex-1 overflow-hidden rounded-lg border border-line bg-bg-900/40">
                  {row.items.map(({ p, left, width }, i) => (
                    <div key={i} className="absolute inset-y-[3px] rounded" style={{ left: `${left}%`, width: `${width}%`, background: meta.color }} title={`${p.title ?? "Unknown"} · ${dur(p.playedSeconds)}`} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function HourOfDay({ hours }: { hours?: number[] | null }) {
  const max = Math.max(1, ...(hours ?? [1]));
  const peak = (hours ?? []).reduce((b, v, i) => (v > (hours ?? [])[b] ? i : b), 0);
  return (
    <Section title="When you listen" subtitle={hours ? `Peak around ${hourLabel(peak, false)}` : "By hour of day"}>
      <div className="flex h-24 items-end gap-[3px]">
        {(hours ?? new Array(24).fill(0)).map((v, h) => (
          <div key={h} className="flex-1 rounded-t" style={{ height: `${Math.max(2, (v / max) * 100)}%`, background: h === peak ? "var(--accent-1)" : "rgba(255,255,255,0.12)" }} title={`${hourLabel(h, false)} · ${dur(v)}`} />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-ink-faint"><span>{hourLabel(0, false)}</span><span>{hourLabel(12, false)}</span><span>{hourLabel(23, false)}</span></div>
    </Section>
  );
}

function TypeSplit({ overview }: { overview: MusicOverview }) {
  const total = Math.max(1, overview.byType.reduce((a, t) => a + t.seconds, 0));
  return (
    <Section title="What you listen to" subtitle="Split by media type">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-white/[0.04]">
        {overview.byType.map((t) => <div key={t.mediaType} style={{ width: `${(t.seconds / total) * 100}%`, background: typeMeta(t.mediaType).color }} />)}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-3">
        {overview.byType.map((t) => {
          const meta = typeMeta(t.mediaType);
          return <div key={t.mediaType} className="flex items-center gap-1.5 text-xs"><span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} /><span className="font-700 text-ink-soft">{meta.label}</span><span className="tabular-nums text-ink-dim">{dur(t.seconds)}</span><span className="text-ink-faint">· {Math.round((t.seconds / total) * 100)}%</span></div>;
        })}
      </div>
    </Section>
  );
}

function TopList({ title, icon, entries }: { title: string; icon: React.ReactNode; entries?: MusicEntry[] }) {
  if (!entries || entries.length === 0) return null;
  const max = Math.max(1, ...entries.map((e) => e.seconds));
  return (
    <Section title={title} icon={icon}>
      <div className="space-y-2">
        {entries.map((e, i) => (
          <div key={e.key} className="flex items-center gap-3">
            <span className="w-4 shrink-0 text-right text-xs font-700 tabular-nums text-ink-faint">{i + 1}</span>
            <LoadedImg path={e.art} className="h-8 w-8 shrink-0 rounded-md object-cover" fallback={<span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-white/[0.06] text-[10px] font-800 text-ink-dim">{e.label.slice(0, 1).toUpperCase()}</span>} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-700 text-ink-soft">{e.label}</div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]"><div className="h-full rounded-full bg-accent-sheen" style={{ width: `${(e.seconds / max) * 100}%` }} /></div>
              {e.secondary && <div className="mt-0.5 truncate text-[11px] text-ink-faint">{e.secondary}</div>}
            </div>
            <div className="shrink-0 text-right">
              <div className="text-sm font-800 tabular-nums text-ink">{dur(e.seconds)}</div>
              <div className="text-[10px] text-ink-faint">{e.count} plays</div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function InsightsGrid({ insights }: { insights: MusicInsights }) {
  const cards: { icon: React.ReactNode; title: string; value: string; sub?: string; color: string }[] = [];
  if (insights.mostRepeated) cards.push({ icon: <Repeat className="h-4 w-4" />, title: "On repeat", value: insights.mostRepeated.label, sub: `${insights.mostRepeated.count} plays`, color: "#a78bfa" });
  cards.push({ icon: <Moon className="h-4 w-4" />, title: "Night-owl", value: dur(insights.nightOwlSeconds), sub: "midnight–5am", color: "#818cf8" });
  cards.push({ icon: <Gamepad2 className="h-4 w-4" />, title: "Gaming w/ music", value: `${Math.round(insights.gamingWithMusicPct)}%`, sub: "of game time", color: "#34d399" });
  if (insights.busiestDay) cards.push({ icon: <Flame className="h-4 w-4" />, title: "Biggest day", value: dur(insights.busiestDay.seconds), sub: new Date(insights.busiestDay.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }), color: "#fb923c" });
  cards.push({ icon: <Sparkles className="h-4 w-4" />, title: "New artists", value: String(insights.newArtistsThisMonth), sub: "this month", color: "#f472b6" });
  if (insights.longestPlayLabel) cards.push({ icon: <Clock className="h-4 w-4" />, title: "Longest play", value: dur(insights.longestPlaySeconds), sub: insights.longestPlayLabel, color: "#22d3ee" });
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-ink-dim"><Sparkles className="h-3.5 w-3.5" /> Things about your listening</h3>
      <div className="grid grid-cols-2 gap-2.5">
        {cards.map((c, i) => <Stat key={i} icon={c.icon} label={c.title} value={c.value} sub={c.sub} color={c.color} />)}
      </div>
    </div>
  );
}

// ---- playlists ----

function Playlists() {
  const [lists, setLists] = useState<Playlist[] | null>(null);
  const [open, setOpen] = useState<Playlist | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const reload = async () => {
    try {
      setLists(await apiGet<Playlist[]>("/api/playlists"));
    } catch {
      setLists([]);
    }
  };
  useEffect(() => {
    reload();
  }, []);

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      await apiPost("/api/playlists/create", { name: n });
    } catch {
      /* ignore */
    }
    setName("");
    setCreating(false);
    reload();
  };
  const remove = async (id: string) => {
    try {
      await apiPost(`/api/playlists/${id}/delete`);
    } catch {
      /* ignore */
    }
    reload();
  };

  if (!lists) return null;

  return (
    <Section
      title="Playlists"
      subtitle={`${lists.length} playlist${lists.length === 1 ? "" : "s"}`}
      icon={<ListMusic className="h-3.5 w-3.5" />}
      right={<button onClick={() => setCreating((v) => !v)} className="btn btn-ghost h-8 px-2 text-xs"><Plus className="h-3.5 w-3.5" /> New</button>}
    >
      {creating && (
        <div className="mb-3 flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Playlist name" autoFocus className="input flex-1" />
          <button onClick={create} disabled={!name.trim()} className="btn btn-primary h-10 px-3">Create</button>
        </div>
      )}
      {lists.length === 0 ? (
        <p className="text-sm text-ink-dim">No playlists yet. Tap New to make one.</p>
      ) : (
        <div className="space-y-2">
          {lists.map((pl) => (
            <div key={pl.id} className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.02] p-2">
              <button onClick={() => setOpen(pl)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <div className="grid h-11 w-11 shrink-0 grid-cols-2 overflow-hidden rounded-lg bg-bg-850">
                  {pl.covers.slice(0, 4).map((c, i) => <LoadedImg key={i} path={c} className="h-full w-full object-cover" fallback={<span className="bg-white/[0.04]" />} />)}
                  {pl.covers.length === 0 && <span className="col-span-2 grid place-items-center"><ListMusic className="h-4 w-4 text-ink-faint" /></span>}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-700">{pl.name}</div>
                  <div className="text-[11px] text-ink-faint">{pl.trackCount} tracks</div>
                </div>
              </button>
              <button onClick={() => remove(pl.id)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-dim active:bg-white/[0.08]"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      )}
      {open && <PlaylistSheet playlist={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </Section>
  );
}

function PlaylistSheet({ playlist, onClose, onChanged }: { playlist: Playlist; onClose: () => void; onChanged: () => void }) {
  const [pl, setPl] = useState<Playlist>(playlist);
  const [active, setActive] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(playlist.name);

  const reload = async () => {
    try {
      const fresh = await apiGet<Playlist>(`/api/playlists/${playlist.id}`);
      setPl(fresh);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist.id]);

  const rename = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      await apiPost(`/api/playlists/${pl.id}/rename`, { name: n });
    } catch {
      /* ignore */
    }
    setRenaming(false);
    reload();
    onChanged();
  };
  const removeTrack = async (vid: string) => {
    try {
      await apiPost(`/api/playlists/${pl.id}/remove_track`, { vid });
    } catch {
      /* ignore */
    }
    if (active === vid) setActive(null);
    reload();
    onChanged();
  };

  return (
    <div className="fixed inset-0 z-[70] flex flex-col justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="max-h-[88%] overflow-y-auto rounded-t-3xl border-t border-line bg-bg-base p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/15" />
        <div className="mb-3 flex items-center gap-2">
          {renaming ? (
            <>
              <input value={name} onChange={(e) => setName(e.target.value)} className="input flex-1" autoFocus />
              <button onClick={rename} className="btn btn-primary h-10 px-3">Save</button>
            </>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <div className="font-display text-lg font-800">{pl.name}</div>
                <div className="text-[11px] text-ink-faint">{pl.trackCount} tracks</div>
              </div>
              <button onClick={() => setRenaming(true)} className="grid h-9 w-9 place-items-center rounded-lg text-ink-dim active:bg-white/[0.08]"><Pencil className="h-4 w-4" /></button>
              <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg text-ink-dim active:bg-white/[0.08]"><X className="h-5 w-5" /></button>
            </>
          )}
        </div>

        {active && (
          <div className="mb-3 overflow-hidden rounded-xl border border-line bg-black">
            <iframe key={active} src={`https://www.youtube.com/embed/${active}?autoplay=1`} title="Track" allow="autoplay; encrypted-media; fullscreen" allowFullScreen className="aspect-video w-full border-0" />
          </div>
        )}

        <div className="space-y-0.5">
          {pl.tracks.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-dim">This playlist is empty.</p>
          ) : (
            pl.tracks.map((t, i) => (
              <div key={t.vid} className={`flex items-center gap-2.5 rounded-lg px-2 py-2 ${active === t.vid ? "bg-accent-3/15" : ""}`}>
                <button onClick={() => setActive(t.vid)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-white/[0.06]">{active === t.vid ? <Radio className="h-3 w-3 text-accent-3" /> : <Play className="h-3 w-3" />}</span>
                  <span className="w-5 shrink-0 text-center text-[10px] text-ink-faint">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-700">{t.title ?? "Untitled"}</span>
                    {t.artist && <span className="block truncate text-[11px] text-ink-faint">{t.artist}</span>}
                  </span>
                </button>
                <button onClick={() => removeTrack(t.vid)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-dim active:bg-white/[0.08]"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, subtitle, icon, right, children }: { title: string; subtitle?: string; icon?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-bg-900/40 p-3.5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {icon && <span className="text-ink-dim">{icon}</span>}
          <div>
            <div className="font-display text-sm font-800">{title}</div>
            {subtitle && <div className="text-[11px] text-ink-dim">{subtitle}</div>}
          </div>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Stat({ icon, label, value, sub, color }: { icon: React.ReactNode; label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white/[0.02] p-3">
      <div className="mb-1.5 flex items-center gap-2 text-ink-dim">
        <span className="grid h-6 w-6 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>{icon}</span>
        <span className="text-[10px] font-700 uppercase tracking-wider">{label}</span>
      </div>
      <div className="font-display text-lg font-800 tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center p-8 text-sm text-ink-dim">{children}</div>;
}
