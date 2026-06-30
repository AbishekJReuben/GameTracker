import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import {
  Music2,
  Disc3,
  Mic2,
  Radio,
  Clock,
  Flame,
  Headphones,
  Sparkles,
  Repeat,
  Moon,
  Gamepad2,
  AppWindow,
  Film,
  ListMusic,
} from "lucide-react";
import { Page } from "@/components/Page";
import { Panel } from "@/components/Panel";
import { SectionTitle, Segmented, EmptyState, Skeleton } from "@/components/ui";
import { Heatmap } from "@/components/Heatmap";
import { buildFixedWindow } from "@/components/Timeline";
import {
  useMusicOverview,
  useMusicTop,
  useMusicInsights,
  useMusicHeatmap,
  useMusicHourOfDay,
  useMediaTimeline,
  useMediaRecent,
} from "@/lib/queries";
import { assetUrl, MediaPlay, MusicEntry } from "@/lib/api";
import { dur, hourLabel, relativeTime } from "@/lib/format";
import { accentFor } from "@/lib/format";
import { useApp, useMotionEnabled } from "@/store/app";
import { useNowListening } from "@/store/media";
import { useJukebox } from "@/store/jukebox";

const DAY = 86_400_000;

const TYPE_META: Record<string, { label: string; icon: typeof Music2; color: string }> = {
  music: { label: "Music", icon: Music2, color: "#a78bfa" },
  video: { label: "Video", icon: Film, color: "#22d3ee" },
  podcast: { label: "Podcast", icon: Mic2, color: "#f472b6" },
  other: { label: "Other", icon: Radio, color: "#94a3b8" },
};

function typeMeta(t: string) {
  return TYPE_META[t] ?? TYPE_META.other;
}

export default function MusicPage() {
  const enabled = useMotionEnabled();
  const { data: overview, isLoading } = useMusicOverview();
  const { data: top } = useMusicTop(12);
  const { data: insights } = useMusicInsights();
  const { data: heat } = useMusicHeatmap(140);

  const empty = !isLoading && overview && overview.playCount === 0;

  return (
    <Page
      title="Music"
      subtitle={
        overview
          ? `${dur(overview.totalSeconds)} listened · ${overview.distinctTracks} tracks · ${overview.distinctArtists} artists`
          : "Your listening, tracked to the minute"
      }
    >
      <NowListeningHero />

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : empty ? (
        <EmptyState
          title="No listening recorded yet"
          message="Play music in Spotify, a browser, or the in-app jukebox — GameTracker records it automatically through Windows. Stats appear here within a minute."
        />
      ) : (
        overview && (
          <>
            <OverviewStats overview={overview} />
            <MediaTimelineSection />
            <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
              <Panel panelKey="music.heatmap" className="xl:col-span-2">
                <SectionTitle title="Listening heatmap" subtitle="Every day you pressed play" />
                <div className="mt-3">{heat ? <Heatmap data={heat} maxStep={20} /> : <Skeleton className="h-40 w-full" />}</div>
              </Panel>
              <HourOfDayPanel />
            </div>

            <TypeSplit overview={overview} />

            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <TopList title="Top artists" icon={<Mic2 className="h-4 w-4" />} entries={top?.artists} kind="artist" />
              <TopList title="Most played tracks" icon={<Music2 className="h-4 w-4" />} entries={top?.tracks} kind="track" />
              <TopList title="Top albums" icon={<Disc3 className="h-4 w-4" />} entries={top?.albums} kind="album" />
              <TopList title="Where it's playing" icon={<Headphones className="h-4 w-4" />} entries={top?.apps} kind="app" />
            </div>

            {insights && <InsightsGrid insights={insights} />}
            <RecentPlays />
          </>
        )
      )}

      {!isLoading && !empty && (
        <p className="mt-6 text-center text-[11px] text-ink-faint">
          Captured locally via Windows media + the in-app jukebox. Nothing leaves your PC.
        </p>
      )}
    </Page>
  );
}

function NowListeningHero() {
  const smtc = useNowListening();
  const jukeActive = useJukebox((s) => s.active && s.tracks.length > 0);
  const jukeTrack = useJukebox((s) => s.tracks[s.index]);
  const jukePlaying = useJukebox((s) => s.playing);
  const enabled = useMotionEnabled();

  const now = smtc
    ? {
        title: smtc.title ?? "Unknown",
        artist: smtc.artist ?? smtc.app ?? "",
        art: assetUrl(smtc.thumbPath),
        app: smtc.app ?? "",
        type: smtc.mediaType ?? "music",
      }
    : jukeActive && jukeTrack && jukePlaying
      ? {
          title: jukeTrack.label,
          artist: jukeTrack.gameName,
          art: assetUrl(jukeTrack.coverPath || jukeTrack.iconPath),
          app: "GameTracker Jukebox",
          type: "music",
        }
      : null;

  if (!now) return null;
  const meta = typeMeta(now.type);

  return (
    <motion.div
      initial={enabled ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      className="mb-5 flex items-center gap-4 overflow-hidden rounded-2xl border border-line bg-bg-900/60 p-4"
      style={{ boxShadow: `inset 0 0 60px -30px ${meta.color}` }}
    >
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-bg-850">
        {now.art ? (
          <img src={now.art} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full w-full place-items-center" style={{ background: `color-mix(in srgb, ${meta.color} 25%, transparent)` }}>
            <meta.icon className="h-6 w-6" style={{ color: meta.color }} />
          </div>
        )}
        {enabled && (
          <span className="absolute bottom-1 right-1 flex items-end gap-[2px]">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="w-[3px] rounded-full"
                style={{ background: meta.color }}
                animate={{ height: [4, 12, 4] }}
                transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.15 }}
              />
            ))}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px] font-700 uppercase tracking-wider" style={{ color: meta.color }}>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: meta.color }} />
            <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: meta.color }} />
          </span>
          Now {meta.label.toLowerCase() === "music" ? "listening" : "playing"} · {now.app}
        </div>
        <div className="truncate font-display text-lg font-800 text-ink">{now.title}</div>
        <div className="truncate text-sm text-ink-dim">{now.artist}</div>
      </div>
    </motion.div>
  );
}

function StatCard({ label, value, sub, icon, color, delay = 0 }: { label: string; value: string; sub?: string; icon: React.ReactNode; color?: string; delay?: number }) {
  const enabled = useMotionEnabled();
  return (
    <motion.div
      className="rounded-2xl border border-line bg-white/[0.02] p-4"
      initial={enabled ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4 }}
    >
      <div className="mb-2 flex items-center gap-2 text-ink-dim">
        <span className="grid h-7 w-7 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${color ?? "var(--accent-1)"} 18%, transparent)`, color: color ?? "var(--accent-1)" }}>
          {icon}
        </span>
        <span className="text-[11px] font-700 uppercase tracking-wider">{label}</span>
      </div>
      <div className="font-display text-2xl font-800 tabular-nums text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-faint">{sub}</div>}
    </motion.div>
  );
}

function OverviewStats({ overview }: { overview: NonNullable<ReturnType<typeof useMusicOverview>["data"]> }) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
      <StatCard label="Total" value={dur(overview.totalSeconds)} sub={`${overview.playCount} plays`} icon={<Headphones className="h-4 w-4" />} color="#a78bfa" delay={0} />
      <StatCard label="Today" value={dur(overview.todaySeconds)} sub={`${dur(overview.weekSeconds)} this week`} icon={<Clock className="h-4 w-4" />} color="#22d3ee" delay={0.04} />
      <StatCard label="Artists" value={String(overview.distinctArtists)} sub={`${overview.distinctAlbums} albums`} icon={<Mic2 className="h-4 w-4" />} color="#f472b6" delay={0.08} />
      <StatCard label="Tracks" value={String(overview.distinctTracks)} sub={`${overview.distinctApps} sources`} icon={<Music2 className="h-4 w-4" />} color="#34d399" delay={0.12} />
      <StatCard label="Streak" value={`${overview.currentStreak}d`} sub={`best ${overview.longestStreak}d`} icon={<Flame className="h-4 w-4" />} color="#fb923c" delay={0.16} />
      <StatCard label="Avg / day" value={dur(overview.avgPerActiveDay)} sub={`${overview.activeDays} active days`} icon={<Sparkles className="h-4 w-4" />} color="#facc15" delay={0.2} />
    </div>
  );
}

function TypeSplit({ overview }: { overview: NonNullable<ReturnType<typeof useMusicOverview>["data"]> }) {
  const total = Math.max(1, overview.byType.reduce((a, t) => a + t.seconds, 0));
  if (overview.byType.length === 0) return null;
  return (
    <Panel panelKey="music.types" className="mt-6">
      <SectionTitle title="What you listen to" subtitle="Split by media type" />
      <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-white/[0.04]">
        {overview.byType.map((t) => {
          const meta = typeMeta(t.mediaType);
          return <div key={t.mediaType} style={{ width: `${(t.seconds / total) * 100}%`, background: meta.color }} title={`${meta.label} · ${dur(t.seconds)}`} />;
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-4">
        {overview.byType.map((t) => {
          const meta = typeMeta(t.mediaType);
          return (
            <div key={t.mediaType} className="flex items-center gap-2 text-sm">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
              <span className="font-700 text-ink-soft">{meta.label}</span>
              <span className="tabular-nums text-ink-dim">{dur(t.seconds)}</span>
              <span className="text-ink-faint">· {Math.round((t.seconds / total) * 100)}%</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function HourOfDayPanel() {
  const use24 = useApp((s) => s.prefs.timeFormat === "24h");
  const { data: hours } = useMusicHourOfDay();
  const enabled = useMotionEnabled();
  const max = Math.max(1, ...(hours ?? []));
  const peak = (hours ?? []).reduce((b, v, i) => (v > (hours ?? [])[b] ? i : b), 0);
  return (
    <Panel panelKey="music.hours">
      <SectionTitle title="When you listen" subtitle={hours ? `Peak around ${hourLabel(peak, use24)}` : "By hour of day"} />
      <div className="mt-4 flex h-28 items-end gap-[3px]">
        {(hours ?? new Array(24).fill(0)).map((v, h) => (
          <motion.div
            key={h}
            className="flex-1 rounded-t"
            style={{ background: h === peak ? "var(--accent-1)" : "rgba(255,255,255,0.12)" }}
            initial={enabled ? { height: 0 } : false}
            animate={{ height: `${Math.max(2, (v / max) * 100)}%` }}
            transition={{ delay: h * 0.012, duration: 0.5 }}
            title={`${hourLabel(h, use24)} · ${dur(v)}`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-ink-faint">
        <span>{hourLabel(0, use24)}</span>
        <span>{hourLabel(12, use24)}</span>
        <span>{hourLabel(23, use24)}</span>
      </div>
    </Panel>
  );
}

function TopList({ title, icon, entries, kind }: { title: string; icon: React.ReactNode; entries?: MusicEntry[]; kind: string }) {
  const enabled = useMotionEnabled();
  if (!entries) return <Skeleton className="h-64 w-full" />;
  if (entries.length === 0) return null;
  const max = Math.max(1, ...entries.map((e) => e.seconds));
  return (
    <Panel panelKey={`music.top.${kind}`}>
      <SectionTitle title={title} subtitle="By listening time" right={icon} />
      <div className="mt-3 space-y-2">
        {entries.map((e, i) => {
          const color = accentFor(e.key)[0];
          const art = assetUrl(e.art);
          return (
            <motion.div
              key={e.key}
              className="flex items-center gap-3"
              initial={enabled ? { opacity: 0, x: -10 } : false}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.03 }}
            >
              <span className="w-4 shrink-0 text-right text-xs font-700 tabular-nums text-ink-faint">{i + 1}</span>
              <span className="h-8 w-8 shrink-0 overflow-hidden rounded-md bg-bg-850">
                {art ? <img src={art} alt="" className="h-full w-full object-cover" /> : <span className="grid h-full w-full place-items-center text-[10px] font-800" style={{ background: `color-mix(in srgb, ${color} 22%, transparent)`, color }}>{e.label.slice(0, 1).toUpperCase()}</span>}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-700 text-ink-soft">{e.label}</div>
                <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
                  <motion.div className="h-full rounded-full" style={{ background: color }} initial={{ width: 0 }} animate={{ width: `${(e.seconds / max) * 100}%` }} transition={{ duration: 0.6, delay: i * 0.03 }} />
                </div>
                {e.secondary && <div className="mt-0.5 truncate text-[11px] text-ink-faint">{e.secondary}</div>}
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm font-800 tabular-nums text-ink">{dur(e.seconds)}</div>
                <div className="text-[10px] text-ink-faint">{e.count} plays</div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </Panel>
  );
}

function InsightsGrid({ insights }: { insights: NonNullable<ReturnType<typeof useMusicInsights>["data"]> }) {
  const cards: { icon: React.ReactNode; title: string; value: string; sub?: string; color: string }[] = [];
  if (insights.mostRepeated) {
    cards.push({
      icon: <Repeat className="h-4 w-4" />,
      title: "On repeat",
      value: insights.mostRepeated.label,
      sub: `${insights.mostRepeated.count} plays${insights.mostRepeated.secondary ? ` · ${insights.mostRepeated.secondary}` : ""}`,
      color: "#a78bfa",
    });
  }
  cards.push({
    icon: <Moon className="h-4 w-4" />,
    title: "Night-owl listening",
    value: dur(insights.nightOwlSeconds),
    sub: "between midnight and 5am",
    color: "#818cf8",
  });
  cards.push({
    icon: <Gamepad2 className="h-4 w-4" />,
    title: "Gaming with music",
    value: `${Math.round(insights.gamingWithMusicPct)}%`,
    sub: "of your game time had music on",
    color: "#34d399",
  });
  if (insights.busiestDay) {
    cards.push({
      icon: <Flame className="h-4 w-4" />,
      title: "Biggest listening day",
      value: dur(insights.busiestDay.seconds),
      sub: new Date(insights.busiestDay.date).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }),
      color: "#fb923c",
    });
  }
  cards.push({
    icon: <Sparkles className="h-4 w-4" />,
    title: "New artists this month",
    value: String(insights.newArtistsThisMonth),
    sub: "first-time discoveries",
    color: "#f472b6",
  });
  if (insights.longestPlayLabel) {
    cards.push({
      icon: <Clock className="h-4 w-4" />,
      title: "Longest single play",
      value: dur(insights.longestPlaySeconds),
      sub: insights.longestPlayLabel,
      color: "#22d3ee",
    });
  }

  return (
    <div className="mt-6">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-700 uppercase tracking-wider text-ink-dim">
        <Sparkles className="h-4 w-4" /> Things you might not know about yourself
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c, i) => (
          <StatCard key={i} label={c.title} value={c.value} sub={c.sub} icon={c.icon} color={c.color} delay={i * 0.04} />
        ))}
      </div>
    </div>
  );
}

function RecentPlays() {
  const { data: recent } = useMediaRecent(16);
  if (!recent || recent.length === 0) return null;
  return (
    <Panel panelKey="music.recent" className="mt-6">
      <SectionTitle title="Recently played" subtitle="Your latest tracks across every app" />
      <div className="mt-3 divide-y divide-line">
        {recent.map((p) => {
          const meta = typeMeta(p.mediaType);
          const art = assetUrl(p.thumbPath);
          return (
            <div key={p.id} className="flex items-center gap-3 py-2">
              <span className="h-9 w-9 shrink-0 overflow-hidden rounded-md bg-bg-850">
                {art ? <img src={art} alt="" className="h-full w-full object-cover" /> : <span className="grid h-full w-full place-items-center" style={{ color: meta.color }}><meta.icon className="h-4 w-4" /></span>}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-700 text-ink-soft">{p.title ?? "Unknown"}</div>
                <div className="truncate text-[11px] text-ink-faint">
                  {[p.artist, p.appName].filter(Boolean).join(" · ")}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-xs font-700 tabular-nums text-ink-dim">{dur(p.playedSeconds)}</div>
                <div className="text-[10px] text-ink-faint">{relativeTime(p.lastSeenUtc)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ---- Media listening timeline (rows by media type) ----

const TL_RANGES = [
  { value: 1440, label: "24h" },
  { value: 360, label: "6h" },
  { value: 60, label: "1h" },
  { value: 10_080, label: "7d" },
] as const;

function MediaTimelineSection() {
  const use24 = useApp((s) => s.prefs.timeFormat === "24h");
  const [minutes, setMinutes] = useState<number>(1440);
  const win = useMemo(() => buildFixedWindow(minutes, Date.now(), 0, use24), [minutes, use24]);
  const fromISO = useMemo(() => new Date(win.start).toISOString(), [win.start]);
  const toISO = useMemo(() => new Date(win.end).toISOString(), [win.end]);
  const { data: plays } = useMediaTimeline(fromISO, toISO);

  const rows = useMemo(() => {
    const order = ["music", "video", "podcast", "other"];
    const span = win.end - win.start || 1;
    const byType = new Map<string, { p: MediaPlay; left: number; width: number }[]>();
    for (const p of plays ?? []) {
      const s = new Date(p.startUtc).getTime();
      const e = p.endUtc ? new Date(p.endUtc).getTime() : Date.now();
      if (e <= win.start || s >= win.end) continue;
      const cs = Math.max(s, win.start);
      const ce = Math.min(e, win.end);
      const left = ((cs - win.start) / span) * 100;
      const width = Math.max(0.4, ((ce - cs) / span) * 100);
      const key = TYPE_META[p.mediaType] ? p.mediaType : "other";
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key)!.push({ p, left, width });
    }
    return order.filter((t) => byType.has(t)).map((t) => ({ type: t, items: byType.get(t)! }));
  }, [plays, win]);

  return (
    <Panel panelKey="music.timeline" className="mb-6 overflow-visible">
      <SectionTitle
        title="Listening timeline"
        subtitle={win.title}
        right={<Segmented value={minutes} onChange={(v) => setMinutes(v as number)} options={TL_RANGES.map((r) => ({ value: r.value, label: r.label }))} size="sm" />}
      />
      <div className="relative mt-3 h-4">
        {win.ticks.map((t, i) => (
          <span key={i} className="absolute -translate-x-1/2 text-[10px] tabular-nums text-ink-faint" style={{ left: `${t.pos}%` }}>
            {t.label}
          </span>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="grid h-24 place-items-center text-xs text-ink-faint">No listening in this window</div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const meta = typeMeta(row.type);
            return (
              <div key={row.type} className="flex items-center gap-2">
                <span className="flex w-16 shrink-0 items-center gap-1 text-[10px] font-700 uppercase tracking-wide" style={{ color: meta.color }}>
                  <meta.icon className="h-3 w-3" /> {meta.label}
                </span>
                <div className="relative h-7 flex-1 overflow-hidden rounded-lg border border-line bg-bg-900/40">
                  {row.items.map(({ p, left, width }, i) => {
                    const color = accentFor(p.artist || p.appName || p.mediaType)[0];
                    return (
                      <div
                        key={`${p.id}-${i}`}
                        className="absolute inset-y-[3px] rounded"
                        style={{ left: `${left}%`, width: `${width}%`, background: `linear-gradient(180deg, color-mix(in srgb, ${color} 70%, #07080f), color-mix(in srgb, ${color} 45%, #07080f))` }}
                        title={`${p.title ?? "Unknown"}${p.artist ? ` — ${p.artist}` : ""} · ${dur(p.playedSeconds)} · ${p.appName ?? ""}`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
