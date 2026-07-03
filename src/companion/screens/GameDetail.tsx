/**
 * Companion GameDetail — a full-screen mobile port of the desktop GameDetail route,
 * opened as an overlay from any screen via `openGame(id)` (see ../ui). Reuses the
 * remote link for data (`/api/games/:id`, `/api/sessions?gameId=`, screenshots,
 * Steam achievements) and posts status/launch back to the PC.
 *
 * Online-only panels (Steam/Metacritic reviews, trailer, soundtrack, Twitch) are
 * intentionally omitted — the desktop serves those via commands the thin companion
 * shell can't reach over the data channel.
 */

import { useEffect, useMemo, useState } from "react";
import {
  X,
  Play,
  Clock,
  Zap,
  Hash,
  CalendarClock,
  Star,
  Trophy,
  Timer,
  Loader2,
  Check,
  AppWindow,
  ExternalLink,
  Camera,
  Award,
  Globe,
} from "lucide-react";
import type { Game, GameStatus, Session, Screenshot, SteamAchievement } from "@/lib/api";
import { dur, relativeTime, timeLabel, dateLabel, partialDate, formatHltbMinutes } from "@/lib/format";
import { clipFocusSpans } from "@/lib/focusSpans";
import { apiGet, apiPost, loadMedia } from "../link";
import { useRemote } from "../useRemote";
import { Art, RemoteImg, STATUS_STYLE, STATUS_ORDER } from "../ui";
import { LiveStatsPanel, SteamReviewsPanel, MetacriticReviewsPanel, TrailerPanel, SoundtrackPanel, TwitchPanel } from "./OnlinePanels";
import { Sparkles } from "lucide-react";

function dayHeading(d: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const that = new Date(d);
  that.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

export function GameDetailScreen({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: game, loading, error } = useRemote<Game>(`/api/games/${id}`, 10000);
  const { data: sessions } = useRemote<Session[]>(`/api/sessions?gameId=${encodeURIComponent(id)}&limit=500`, 20000);
  const { data: shots } = useRemote<Screenshot[]>(`/api/games/${id}/screenshots`, 60000);

  if ((loading && !game) || (!game && !error)) {
    return (
      <Overlay onClose={onClose}>
        <div className="grid h-full place-items-center text-ink-dim"><Loader2 className="h-5 w-5 animate-spin" /></div>
      </Overlay>
    );
  }
  if (!game) {
    return (
      <Overlay onClose={onClose}>
        <div className="grid h-full place-items-center px-6 text-center text-sm text-ink-dim">This game couldn't be loaded.</div>
      </Overlay>
    );
  }
  return (
    <Overlay onClose={onClose}>
      <Detail game={game} sessions={sessions ?? []} shots={shots ?? []} onClose={onClose} />
    </Overlay>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-bg-base" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <button onClick={onClose} className="absolute right-3 z-20 grid h-9 w-9 place-items-center rounded-full bg-black/50 text-white backdrop-blur active:scale-95" style={{ top: "max(0.75rem, calc(env(safe-area-inset-top) + 0.25rem))" }}>
        <X className="h-5 w-5" />
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function Detail({ game, sessions, shots, onClose }: { game: Game; sessions: Session[]; shots: Screenshot[]; onClose: () => void }) {
  const [g, setG] = useState(game);
  useEffect(() => setG(game), [game]);
  const [busy, setBusy] = useState<string | null>(null);
  const isApp = g.kind === "app";
  const accent = g.accentColor || STATUS_STYLE[g.status].color;

  const setStatus = async (status: GameStatus) => {
    setBusy("status");
    try {
      await apiPost(`/api/games/${g.id}/status`, { status });
      setG({ ...g, status });
    } catch {
      /* ignore */
    } finally {
      setBusy(null);
    }
  };
  const launch = async () => {
    setBusy("launch");
    try {
      await apiPost(`/api/games/${g.id}/launch`);
    } catch {
      /* ignore */
    } finally {
      setBusy(null);
    }
  };
  // "Get data": kick off cover/info/HLTB (or Wikipedia for apps) on the PC. It runs
  // in the background there; the game's periodic poll fills in the new fields.
  const [enriching, setEnriching] = useState(false);
  const enrich = async () => {
    setEnriching(true);
    try {
      await apiPost(`/api/games/${g.id}/enrich`, { name: g.displayName, isApp });
    } catch {
      /* ignore */
    }
    window.setTimeout(() => setEnriching(false), 20000);
  };

  const hltbItems = [
    { label: "Main Story", minutes: g.hltbMainMinutes, color: "#34d399" },
    { label: "Main + Extra", minutes: g.hltbMainExtraMinutes, color: "#22d3ee" },
    { label: "100%", minutes: g.hltbCompletionistMinutes, color: "#7c5cff" },
  ].filter((x): x is { label: string; minutes: number; color: string } => x.minutes != null && x.minutes > 0);

  const lastPlayed = g.lastPlayedUtc
    ? relativeTime(g.lastPlayedUtc)
    : partialDate(g.completedYear, g.completedMonth, g.completedDay) !== "—"
      ? partialDate(g.completedYear, g.completedMonth, g.completedDay)
      : "Never";

  const dayGroups = useMemo(() => {
    const byDay = new Map<string, Session[]>();
    for (const s of sessions) {
      const d = new Date(s.startUtc);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(s);
    }
    return [...byDay.entries()]
      .map(([key, list]) => {
        const sorted = [...list].sort((a, b) => new Date(b.startUtc).getTime() - new Date(a.startUtc).getTime());
        return {
          key,
          label: dayHeading(new Date(sorted[0].startUtc)),
          sessions: sorted,
          active: list.reduce((a, s) => a + s.activeSeconds, 0),
          runtime: list.reduce((a, s) => a + s.runtimeSeconds, 0),
        };
      })
      .sort((a, b) => new Date(b.sessions[0].startUtc).getTime() - new Date(a.sessions[0].startUtc).getTime());
  }, [sessions]);
  const maxRuntime = useMemo(() => sessions.reduce((m, s) => Math.max(m, s.runtimeSeconds), 1), [sessions]);

  return (
    <div className="pb-10">
      {/* hero */}
      <div className="relative">
        <div className="absolute inset-0 overflow-hidden">
          <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} rounded="rounded-none" className="h-full w-full scale-110 blur-2xl opacity-50" />
          <div className="absolute inset-0 bg-bg-base/80" />
        </div>
        <div className="relative flex gap-4 p-4 pt-6">
          <Art id={g.id} name={g.displayName} cover={g.coverPath} icon={g.iconPath} accent={g.accentColor} rounded="rounded-2xl" className="h-44 w-32 shrink-0 shadow-float ring-1 ring-white/10" />
          <div className="min-w-0 flex-1 self-end">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
              {isApp ? (
                <span className="inline-flex items-center gap-1 rounded-lg bg-white/[0.06] px-2 py-1 font-700 text-ink-soft"><AppWindow className="h-3 w-3" /> App</span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-700" style={{ background: `color-mix(in srgb, ${STATUS_STYLE[g.status].color} 18%, transparent)`, color: STATUS_STYLE[g.status].color }}>{STATUS_STYLE[g.status].label}</span>
              )}
              {g.releaseYear && <span className="rounded-lg bg-white/[0.05] px-2 py-1 font-700 text-ink-dim">{g.releaseYear}</span>}
            </div>
            <h1 className="font-display text-2xl font-800 leading-tight">{g.displayName || "Untitled"}</h1>
            {g.developer && <div className="mt-0.5 truncate text-sm text-ink-dim">{g.developer}</div>}
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              {g.rating != null && <Score label="My score" value={g.rating} color="#fbbf24" icon={<Star className="h-3.5 w-3.5" />} />}
              {g.metacritic != null && <Score label="Metacritic" value={g.metacritic} color="#34d399" />}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4 px-4">
        <div className="flex gap-2">
          {g.exePaths.length > 0 && (
            <button onClick={launch} disabled={busy === "launch"} className="btn btn-primary h-11 flex-1">
              {busy === "launch" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Play className="h-5 w-5" />} Launch on PC
            </button>
          )}
          <button onClick={enrich} disabled={enriching} className="btn btn-subtle h-11 flex-1" title={isApp ? "Fetch details from Wikipedia" : "Fetch cover & info (Steam) + HowLongToBeat"}>
            {enriching ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />} {isApp ? "Get info" : "Get data"}
          </button>
        </div>

        {/* stats */}
        <div className="grid grid-cols-2 gap-2.5">
          <Stat icon={<Clock className="h-4 w-4" />} label={isApp ? "Total time" : "Total runtime"} value={dur(g.totalRuntimeSeconds)} color="#22d3ee" />
          <Stat icon={<Zap className="h-4 w-4" />} label={isApp ? "Focused" : "Active play"} value={dur(g.totalActiveSeconds)} color="#34d399" />
          <Stat icon={<Hash className="h-4 w-4" />} label="Sessions" value={String(g.sessionCount)} color="var(--accent-1)" />
          <Stat icon={<CalendarClock className="h-4 w-4" />} label={isApp ? "Last used" : "Last played"} value={lastPlayed} color="#f472b6" />
        </div>
        {!isApp && (g.trackedRuntimeSeconds > 0 || g.manualPlaytimeSeconds > 0) && (
          <p className="text-sm text-ink-dim">
            Tracked <span className="font-700 text-ink-soft">{dur(g.trackedActiveSeconds)}</span> active
            {g.manualPlaytimeSeconds > 0 && <> · Manual <span className="font-700 text-ink-soft">{dur(g.manualPlaytimeSeconds)}</span></>}
          </p>
        )}

        {/* status changer */}
        {!isApp && (
          <Card title="Status">
            <div className="flex flex-wrap gap-1.5">
              {STATUS_ORDER.map((st) => (
                <button key={st} onClick={() => setStatus(st)} disabled={busy === "status"} className={`inline-flex items-center gap-1 rounded-xl border px-2.5 py-1.5 text-xs font-700 transition ${g.status === st ? "border-accent-3 bg-accent-3/15 text-white" : "border-line bg-white/[0.03] text-ink-soft"}`}>
                  {g.status === st && <Check className="h-3 w-3" />} {STATUS_STYLE[st].label}
                </button>
              ))}
            </div>
          </Card>
        )}

        {/* HLTB */}
        {!isApp && hltbItems.length > 0 && (
          <Card title="How long to beat" icon={<Timer className="h-3.5 w-3.5" />}>
            <div className="grid grid-cols-3 gap-2">
              {hltbItems.map((it) => (
                <div key={it.label} className="rounded-xl border border-line bg-white/[0.02] p-2.5">
                  <div className="flex items-center gap-1 text-[10px] font-700 uppercase tracking-wide text-ink-dim">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: it.color }} /> {it.label}
                  </div>
                  <div className="mt-1 font-display text-base font-800 tabular-nums">{formatHltbMinutes(it.minutes)}</div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* achievements */}
        {!isApp && g.steamAppId != null && <Achievements gameId={g.id} accent={accent} />}

        {/* session history */}
        {sessions.length > 0 && (
          <Card title="Session history" subtitle={`${sessions.length} sessions · ${dayGroups.length} ${dayGroups.length === 1 ? "day" : "days"}`}>
            <div className="max-h-[420px] overflow-y-auto">
              {dayGroups.map((grp) => (
                <div key={grp.key}>
                  <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line/60 bg-bg-900/95 py-1.5 backdrop-blur-sm">
                    <span className="text-[11px] font-800 uppercase tracking-wider text-ink-soft">{grp.label}</span>
                    <span className="text-[10px] tabular-nums text-ink-faint">{grp.sessions.length} · {dur(isApp ? grp.runtime : grp.active)}</span>
                  </div>
                  <div className="divide-y divide-line/40">
                    {grp.sessions.map((s) => {
                      const startMs = new Date(s.startUtc).getTime();
                      const endMs = new Date(s.endUtc ?? s.lastSeenUtc).getTime();
                      const span = endMs - startMs || 1;
                      const segs = clipFocusSpans(s, startMs, endMs, Date.now());
                      return (
                        <div key={s.id} className="flex items-center gap-3 py-2">
                          <div className="w-14 shrink-0 text-xs tabular-nums text-ink-dim">{timeLabel(s.startUtc, false)}</div>
                          <div className="min-w-0 flex-1">
                            {/* Bar width = runtime vs the day's longest; bright = focused, dim = alt-tabbed. */}
                            <div className="relative h-2 overflow-hidden rounded-full bg-white/[0.05]" style={{ width: `${Math.max((s.runtimeSeconds / maxRuntime) * 100, 3)}%`, minWidth: 24 }}>
                              {segs.map((seg, si) => (
                                <span key={si} className="absolute inset-y-0 rounded-full" style={{ left: `${((seg.startMs - startMs) / span) * 100}%`, width: `${Math.max(((seg.endMs - seg.startMs) / span) * 100, 1)}%`, background: accent, opacity: seg.focused ? 1 : 0.35 }} />
                              ))}
                            </div>
                          </div>
                          <div className="w-20 shrink-0 text-right">
                            <div className="text-sm font-800 tabular-nums">{dur(isApp ? s.runtimeSeconds : s.activeSeconds)}</div>
                            {s.runtimeSeconds > s.activeSeconds + 30 && <div className="text-[10px] tabular-nums text-ink-faint">{dur(s.activeSeconds)} focused</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* window & browser activity log */}
        {sessions.some((s) => (s.activitySpans?.length ?? 0) > 0) && (
          <Card title="Window & browser activity" subtitle="What was on screen while you played">
            <ActivityLog sessions={sessions} />
          </Card>
        )}

        {/* store images */}
        {g.screenshots.length > 0 && (
          <Card title={isApp ? "Media" : "Store images"} subtitle={`${g.screenshots.length} ${isApp ? "images" : "screenshots"}`}>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {g.screenshots.map((url, i) => (
                <RemoteImg key={i} url={url} className="h-28 w-48 shrink-0 rounded-xl object-cover ring-1 ring-white/[0.06]" />
              ))}
            </div>
          </Card>
        )}

        {/* auto-captures */}
        {shots.length > 0 && (
          <Card title="Screenshots" subtitle={`${shots.length} captured while playing`} icon={<Camera className="h-3.5 w-3.5" />}>
            <div className="grid grid-cols-2 gap-2">
              {shots.map((s) => <Capture key={s.id} path={s.path} />)}
            </div>
          </Card>
        )}

        {/* details */}
        <Card title="Details">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <Row label={isApp ? "Publisher" : "Developer"} value={g.developer ?? "—"} />
            <Row label="Released" value={g.releaseYear?.toString() ?? "—"} />
            {!isApp && <Row label="Started" value={partialDate(g.startedYear, g.startedMonth, g.startedDay)} />}
            {!isApp && <Row label="Completed" value={partialDate(g.completedYear, g.completedMonth, g.completedDay)} />}
            <Row label="First tracked" value={dateLabel(g.firstPlayedUtc)} />
            <Row label="Tracked" value={g.isTracked ? "Yes" : "Catalog only"} />
          </dl>
          {g.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {g.tags.map((t) => <span key={t} className="rounded-full border border-line bg-white/[0.03] px-2.5 py-1 text-[11px] text-ink-dim">{t}</span>)}
            </div>
          )}
          {g.notes && <p className="mt-3 whitespace-pre-wrap rounded-xl border border-line bg-white/[0.02] p-3 text-sm leading-relaxed text-ink-soft">{g.notes}</p>}
          {g.website && (
            <a href={g.website} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-xs font-700 text-accent-3">
              <ExternalLink className="h-3.5 w-3.5" /> {isApp ? "Wikipedia" : "Website"}
            </a>
          )}
        </Card>

        {/* online panels — live stats, reviews, trailer, soundtrack, Twitch (games only) */}
        {isApp && g.notes && (
          <Card title="About" subtitle="From online sources"><p className="text-sm leading-relaxed text-ink-soft">{g.notes}</p></Card>
        )}
        {!isApp && (
          <>
            <LiveStatsPanel game={g} />
            {g.steamAppId != null && <SteamReviewsPanel appId={g.steamAppId} name={g.displayName} />}
            <MetacriticReviewsPanel gameId={g.id} slug={g.metacriticSlug} name={g.displayName} />
            {g.trailerUrl && <TrailerPanel game={g} />}
            <SoundtrackPanel game={g} />
            <TwitchPanel game={g} />
          </>
        )}

        {(g.completedYear || g.completedMonth || g.completedDay) && (
          <div className="flex items-center justify-center gap-1.5 text-sm text-ink-soft">
            <Trophy className="h-4 w-4 text-accent" /> Completed {partialDate(g.completedYear, g.completedMonth, g.completedDay)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Chronological browser/window activity from the sessions' `activitySpans`. */
function ActivityLog({ sessions }: { sessions: Session[] }) {
  const [showAll, setShowAll] = useState(false);
  const hostOf = (url?: string | null) => {
    if (!url) return null;
    try {
      return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };
  const rows = useMemo(() => {
    const now = Date.now();
    const out: { key: string; title: string | null; url: string | null; host: string | null; startMs: number; endMs: number; sec: number; live: boolean }[] = [];
    for (const s of sessions) {
      for (const a of s.activitySpans ?? []) {
        if (!a.title && !a.url) continue;
        const startMs = new Date(a.startUtc).getTime();
        const live = !a.endUtc;
        const endMs = a.endUtc ? new Date(a.endUtc).getTime() : now;
        out.push({ key: `${s.id}-${a.startUtc}-${a.url ?? a.title}`, title: a.title ?? null, url: a.url ?? null, host: hostOf(a.url), startMs, endMs, sec: Math.max(0, Math.round((endMs - startMs) / 1000)), live });
      }
    }
    return out.sort((a, b) => b.startMs - a.startMs);
  }, [sessions]);
  const shown = showAll ? rows : rows.slice(0, 40);
  return (
    <div>
      <div className="max-h-[420px] divide-y divide-line/40 overflow-y-auto">
        {shown.map((r) => {
          const fmt = (ms: number) => timeLabel(new Date(ms).toISOString(), false);
          return (
            <div key={r.key} className="flex items-start gap-2.5 py-2">
              <div className="w-20 shrink-0 text-[11px] text-ink-dim">
                {dateLabel(new Date(r.startMs).toISOString())}
                <div className="text-[10px] tabular-nums text-ink-faint">{fmt(r.startMs)} → {r.live ? "now" : fmt(r.endMs)}</div>
              </div>
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-line bg-white/[0.03] text-ink-dim">{r.host ? <Globe className="h-3 w-3" /> : <AppWindow className="h-3 w-3" />}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-700 text-ink-soft">{r.title ?? r.host}</div>
                {r.host && r.url && <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-[11px] text-ink-faint"><ExternalLink className="h-3 w-3 shrink-0" /><span className="truncate">{r.host}</span></a>}
              </div>
              <div className="shrink-0 text-right text-xs font-800 tabular-nums text-ink">{r.live ? <span className="text-accent-3">live</span> : dur(r.sec)}</div>
            </div>
          );
        })}
      </div>
      {rows.length > 40 && (
        <button onClick={() => setShowAll((v) => !v)} className="btn btn-ghost mt-2 h-8 w-full text-xs">{showAll ? "Show less" : `Show all ${rows.length} entries`}</button>
      )}
    </div>
  );
}

function Achievements({ gameId, accent }: { gameId: string; accent: string }) {
  const [list, setList] = useState<SteamAchievement[] | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<SteamAchievement[]>(`/api/games/${gameId}/achievements/steam`)
      .then((a) => alive && setList(a))
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [gameId]);
  if (!list || list.length === 0) return null;
  const unlocked = list.filter((a) => a.unlocked).length;
  const pct = Math.round((unlocked / list.length) * 100);
  const sorted = [...list].sort((a, b) => Number(b.unlocked) - Number(a.unlocked));
  return (
    <Card title="Achievements" subtitle={`${unlocked} / ${list.length} · ${pct}%`} icon={<Award className="h-3.5 w-3.5" />}>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: accent }} />
      </div>
      <div className="grid grid-cols-6 gap-1.5">
        {sorted.slice(0, 24).map((a) => (
          <img key={a.apiName} src={a.iconUrl} alt={a.displayName} title={`${a.displayName}${a.unlocked ? "" : " (locked)"}`} loading="lazy" className={`aspect-square w-full rounded-md object-cover ${a.unlocked ? "" : "opacity-30 grayscale"}`} />
        ))}
      </div>
    </Card>
  );
}

function Capture({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadMedia(path).then((u) => alive && setSrc(u));
    return () => {
      alive = false;
    };
  }, [path]);
  return (
    <div className="aspect-video overflow-hidden rounded-xl bg-bg-850 ring-1 ring-white/[0.06]">
      {src && <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />}
    </div>
  );
}

function Score({ label, value, color, icon }: { label: string; value: number; color: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="grid h-9 w-9 place-items-center rounded-xl text-sm font-800" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>{value}</div>
      <div className="flex items-center gap-1 text-[11px] font-700 text-ink-soft">{icon} {label}</div>
    </div>
  );
}

function Stat({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="rounded-2xl border border-line bg-bg-900/50 p-3">
      <div className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>{icon}</div>
      <div className="mt-2 font-display text-lg font-800 tabular-nums">{value}</div>
      <div className="text-[11px] text-ink-dim">{label}</div>
    </div>
  );
}

function Card({ title, subtitle, icon, children }: { title: string; subtitle?: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-bg-900/40 p-3.5">
      <div className="mb-3 flex items-center gap-2">
        {icon && <span className="text-ink-dim">{icon}</span>}
        <div>
          <div className="font-display text-sm font-800">{title}</div>
          {subtitle && <div className="text-[11px] text-ink-dim">{subtitle}</div>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/40 py-1">
      <dt className="shrink-0 text-xs text-ink-dim">{label}</dt>
      <dd className="text-right text-sm font-700 text-ink">{value}</dd>
    </div>
  );
}
