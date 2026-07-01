import { Gamepad2, Clock, Flame, Trophy, Zap, Radio } from "lucide-react";
import { Dashboard, TrackingState } from "@/lib/api";
import { dur, relativeTime } from "@/lib/format";
import { remoteMediaUrl } from "@/lib/remoteClient";
import { useRemote } from "../useRemote";

export function StatsScreen() {
  const { data: dash, loading, error } = useRemote<Dashboard>("/api/dashboard", 8000);
  const { data: now } = useRemote<TrackingState>("/api/tracking", 2000);

  if (loading && !dash) return <Loading />;
  if (error && !dash) return <ErrorNote message={error} />;
  if (!dash) return null;

  const playing = now && (now.isPlaying || now.appIsActive) && !now.paused;
  const nowName = now?.isPlaying ? now.gameName : now?.appName;
  const nowArt = remoteMediaUrl(now?.coverPath ?? now?.iconPath ?? now?.appCoverPath ?? now?.appIconPath);

  return (
    <div className="space-y-4 p-4">
      {playing && (
        <div className="flex items-center gap-3 overflow-hidden rounded-2xl border border-line bg-bg-900/60 p-3">
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-bg-850">
            {nowArt ? <img src={nowArt} alt="" className="h-full w-full object-cover" /> : null}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[11px] font-700 uppercase tracking-wider text-green">
              <Radio className="h-3.5 w-3.5" /> Now playing
            </div>
            <div className="truncate font-700">{nowName ?? "—"}</div>
          </div>
          <div className="shrink-0 text-right text-sm font-800 tabular-nums text-green">
            {dur(now?.isPlaying ? now.todayActiveSeconds : now?.appTodayActiveSeconds ?? 0)}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Stat icon={<Zap className="h-4 w-4" />} label="Today" value={dur(dash.todayActive)} color="#34d399" />
        <Stat icon={<Clock className="h-4 w-4" />} label="This week" value={dur(dash.weekActive)} color="#22d3ee" />
        <Stat icon={<Flame className="h-4 w-4" />} label="Streak" value={`${dash.currentStreak}d`} sub={`best ${dash.longestStreak}d`} color="#fb923c" />
        <Stat icon={<Trophy className="h-4 w-4" />} label="Completed" value={String(dash.gamesCompleted)} sub={`${dash.gamesTracked} tracked`} color="#a78bfa" />
      </div>

      <Section title="Top games">
        {dash.topGames.slice(0, 6).map((g) => {
          const art = remoteMediaUrl(g.coverPath ?? g.iconPath);
          return (
            <Row key={g.id} art={art} name={g.name} right={dur(g.activeSeconds)} sub={`${g.sessionCount} sessions`} />
          );
        })}
      </Section>

      <Section title="Recent sessions">
        {dash.recentSessions.slice(0, 12).map((s) => {
          const art = remoteMediaUrl(s.coverPath ?? s.iconPath);
          return (
            <Row key={s.id} art={art} name={s.gameName} right={dur(s.activeSeconds)} sub={relativeTime(s.startUtc)} />
          );
        })}
      </Section>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-white/[0.02] p-3">
      <h2 className="mb-2 text-[11px] font-800 uppercase tracking-wider text-ink-dim">{title}</h2>
      <div className="divide-y divide-line">{children}</div>
    </div>
  );
}

function Row({ art, name, right, sub }: { art: string | null; name: string; right: string; sub: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-bg-850">
        {art ? <img src={art} alt="" className="h-full w-full object-cover" /> : <Gamepad2 className="h-4 w-4 text-ink-faint" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-700">{name}</div>
        <div className="text-[11px] text-ink-faint">{sub}</div>
      </div>
      <div className="shrink-0 text-sm font-800 tabular-nums">{right}</div>
    </div>
  );
}

function Loading() {
  return <div className="grid h-full place-items-center p-8 text-sm text-ink-dim">Loading…</div>;
}
function ErrorNote({ message }: { message: string }) {
  return <div className="m-4 rounded-xl border border-amber/40 bg-amber/10 p-3 text-sm text-amber">{message}</div>;
}
