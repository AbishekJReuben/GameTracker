import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { Headphones, Music2, ChevronRight, Mic2 } from "lucide-react";
import { Panel } from "@/components/Panel";
import { SectionTitle } from "@/components/ui";
import { useMusicOverview, useMusicTop, useMusicInsights } from "@/lib/queries";
import { assetUrl } from "@/lib/api";
import { dur } from "@/lib/format";
import { useMotionEnabled } from "@/store/app";
import { useNowListening } from "@/store/media";

const TYPE_COLOR: Record<string, string> = {
  music: "#a78bfa",
  video: "#22d3ee",
  podcast: "#f472b6",
  other: "#94a3b8",
};

/** Compact "Listening today" card for the Dashboard. Hidden when there's no data. */
export function ListeningTodayCard() {
  const enabled = useMotionEnabled();
  const { data: overview } = useMusicOverview();
  const { data: top } = useMusicTop(1);
  const now = useNowListening();

  if (!overview || overview.playCount === 0) return null;
  const topArtist = top?.artists?.[0];
  const nowArt = now ? assetUrl(now.thumbPath) : null;

  return (
    <Panel panelKey="dashboard.listening" className="overflow-hidden">
      <SectionTitle
        title="Listening today"
        subtitle={`${overview.distinctArtists} artists · ${dur(overview.totalSeconds)} all-time`}
        right={
          <Link to="/music" className="flex items-center gap-1 text-xs font-700 text-ink-dim hover:text-ink">
            Music <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        }
      />
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-display text-3xl font-800 tabular-nums text-ink">{dur(overview.todaySeconds)}</span>
        <span className="text-xs text-ink-faint">today · {dur(overview.weekSeconds)} this week</span>
      </div>

      {now ? (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-line bg-white/[0.02] p-2.5">
          <span className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-bg-850">
            {nowArt ? (
              <img src={nowArt} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="grid h-full w-full place-items-center text-accent-1">
                <Music2 className="h-5 w-5" />
              </span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[10px] font-700 uppercase tracking-wider text-accent-1">
              {enabled && (
                <span className="flex h-1.5 w-1.5 rounded-full bg-accent-1">
                  <span className="h-1.5 w-1.5 animate-ping rounded-full bg-accent-1" />
                </span>
              )}
              Now · {now.app}
            </div>
            <div className="truncate text-sm font-700 text-ink-soft">{now.title}</div>
            <div className="truncate text-[11px] text-ink-faint">{now.artist}</div>
          </div>
        </div>
      ) : topArtist ? (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-line bg-white/[0.02] p-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent-1/15 text-accent-1">
            <Mic2 className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-700 uppercase tracking-wider text-ink-faint">Most played artist</div>
            <div className="truncate text-sm font-700 text-ink-soft">{topArtist.label}</div>
            <div className="truncate text-[11px] text-ink-faint">{dur(topArtist.seconds)} · {topArtist.count} plays</div>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

/** "Music & gaming" analytics panel for the Collection/Insights screen. */
export function MusicGamingPanel() {
  const enabled = useMotionEnabled();
  const { data: overview } = useMusicOverview();
  const { data: top } = useMusicTop(5);
  const { data: insights } = useMusicInsights();

  if (!overview || overview.playCount === 0) return null;
  const total = Math.max(1, overview.byType.reduce((a, t) => a + t.seconds, 0));
  const maxArtist = Math.max(1, ...(top?.artists ?? []).map((a) => a.seconds));

  return (
    <Panel panelKey="collection.music">
      <SectionTitle
        title="Music & gaming"
        subtitle="Your soundtrack to playing"
        right={
          <Link to="/music" className="flex items-center gap-1 text-xs font-700 text-ink-dim hover:text-ink">
            <Headphones className="h-3.5 w-3.5" /> Music
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Listened" value={dur(overview.totalSeconds)} />
        <Stat label="With games on" value={`${Math.round(insights?.gamingWithMusicPct ?? 0)}%`} />
        <Stat label="Artists" value={String(overview.distinctArtists)} />
        <Stat label="Tracks" value={String(overview.distinctTracks)} />
      </div>

      <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-white/[0.04]">
        {overview.byType.map((t) => (
          <div key={t.mediaType} style={{ width: `${(t.seconds / total) * 100}%`, background: TYPE_COLOR[t.mediaType] ?? TYPE_COLOR.other }} />
        ))}
      </div>

      {top?.artists && top.artists.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="text-[11px] font-700 uppercase tracking-wider text-ink-dim">Top artists</div>
          {top.artists.slice(0, 5).map((a, i) => (
            <motion.div
              key={a.key}
              className="flex items-center gap-2"
              initial={enabled ? { opacity: 0, x: -8 } : false}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }}
            >
              <span className="w-28 shrink-0 truncate text-sm font-700 text-ink-soft">{a.label}</span>
              <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                <div className="h-full rounded-full bg-accent-1" style={{ width: `${(a.seconds / maxArtist) * 100}%` }} />
              </div>
              <span className="w-14 shrink-0 text-right text-xs font-700 tabular-nums text-ink-dim">{dur(a.seconds)}</span>
            </motion.div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-white/[0.02] px-3 py-2.5">
      <div className="font-display text-lg font-800 tabular-nums text-ink">{value}</div>
      <div className="text-[11px] text-ink-dim">{label}</div>
    </div>
  );
}
