import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { AppWindow, Gamepad2, Download, FileJson, Moon, Zap, Clock } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { Page } from "@/components/Page";
import { GameArt } from "@/components/GameArt";
import { Timeline, type TimelineRange } from "@/components/Timeline";
import { TIMELINE_RANGE_OPTIONS } from "@/lib/timelineZoom";
import { SectionTitle, Segmented, EmptyState, Skeleton, Toggle } from "@/components/ui";
import { Panel } from "@/components/Panel";
import { useLiveSessionBonus } from "@/lib/liveStats";
import { useSessions, useGames } from "@/lib/queries";
import { useApp, useMotionEnabled } from "@/store/app";
import { accentFor, dur, hourLabel, partialDate, dateLabel, timeLabel } from "@/lib/format";
import { api, EntryKind, Game, Session, SessionFilter } from "@/lib/api";
import { GameScores, scoreTooltip } from "@/components/GameScores";

type Mode = "sessions" | "completions";

const RANGE_OPTS = TIMELINE_RANGE_OPTIONS;

export default function TimelinePage() {
  const setPref = useApp((s) => s.setPref);
  // Range is a remembered toggle, shared with per-game timelines.
  const range = useApp((s) => s.prefs.timelineRange);
  const setRange = (v: TimelineRange) => setPref("timelineRange", v);
  const enabled = useMotionEnabled();
  const [mode, setMode] = useState<Mode>("sessions");
  const [hiddenGames, setHiddenGames] = useState<Set<string>>(new Set());
  const [hiddenApps, setHiddenApps] = useState<Set<string>>(new Set());

  // Fetch a broad window so the timeline's period-stepper can page back through history.
  const fromUtc = useMemo(() => new Date(Date.now() - 800 * 86_400_000).toISOString(), []);
  const { data: sessions, isLoading } = useSessions({ fromUtc });
  const { data: games } = useGames();

  const gameSessions = useMemo(
    () => (sessions ?? []).filter((s) => (s.kind ?? "game") === "game" && !hiddenGames.has(s.gameId)),
    [sessions, hiddenGames]
  );
  const appSessions = useMemo(
    () => (sessions ?? []).filter((s) => s.kind === "app" && !hiddenApps.has(s.gameId)),
    [sessions, hiddenApps]
  );
  const legendGames = useMemo(
    () => (games ?? []).filter((g) => g.kind === "game" && sessions?.some((s) => s.gameId === g.id)),
    [games, sessions]
  );
  const legendApps = useMemo(
    () => (games ?? []).filter((g) => g.kind === "app" && sessions?.some((s) => s.gameId === g.id)),
    [games, sessions]
  );

  const colorFor = (gameId: string, accent?: string | null) => accent || accentFor(gameId)[0];

  return (
    <Page
      title="Timeline"
      subtitle="Your play history, laid out left to right"
      actions={
        <motion.div layout={enabled} transition={{ type: "spring", stiffness: 400, damping: 30 }}>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "sessions", label: "Sessions" },
              { value: "completions", label: "Completions" },
            ]}
          />
        </motion.div>
      }
    >
      <AnimatePresence mode="wait">
        {mode === "sessions" ? (
          <motion.div
            key="sessions"
            initial={enabled ? { opacity: 0, x: -16 } : false}
            animate={{ opacity: 1, x: 0 }}
            exit={enabled ? { opacity: 0, x: 16 } : undefined}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <Segmented value={range} onChange={setRange} options={RANGE_OPTS} />
            <span className="text-sm text-ink-dim">{gameSessions.length + appSessions.length} sessions in view</span>
          </div>

          <TimelineSection
            title="Games"
            icon={<Gamepad2 className="h-4 w-4" />}
            sessions={gameSessions}
            range={range}
            isLoading={isLoading}
            legend={legendGames}
            hidden={hiddenGames}
            setHidden={setHiddenGames}
            colorFor={colorFor}
            emptyMessage="Play a tracked game to fill in your games timeline."
            barClassName=""
          />
          <TimelineInsights sessions={gameSessions} games={legendGames} colorFor={colorFor} kind="game" title="Games insights" />

          <TimelineSection
            title="Apps"
            icon={<AppWindow className="h-4 w-4" />}
            sessions={appSessions}
            range={range}
            isLoading={isLoading}
            legend={legendApps}
            hidden={hiddenApps}
            setHidden={setHiddenApps}
            colorFor={colorFor}
            emptyMessage="Use a tracked app to fill in your apps timeline."
            barClassName="opacity-90 [background-image:linear-gradient(90deg,transparent,rgba(255,255,255,0.04))]"
          />
          <TimelineInsights sessions={appSessions} games={legendApps} colorFor={colorFor} kind="app" title="Apps insights" />

          <SessionLogSection />
          </motion.div>
        ) : (
          <motion.div
            key="completions"
            initial={enabled ? { opacity: 0, x: 16 } : false}
            animate={{ opacity: 1, x: 0 }}
            exit={enabled ? { opacity: 0, x: -16 } : undefined}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            <Panel
              panelKey="timeline.completions"
              games={(games ?? []).filter((g) => g.kind === "game" && g.status === "completed")}
              className="p-5"
            >
              {games ? <CompletionTimeline games={games.filter((g) => g.kind === "game" && g.status === "completed")} colorFor={colorFor} /> : <Skeleton className="h-64 w-full" />}
            </Panel>
          </motion.div>
        )}
      </AnimatePresence>
    </Page>
  );
}

function SessionLogSection() {
  const { data: games } = useGames();
  const pushToast = useApp((s) => s.pushToast);
  const use24 = useApp((s) => s.prefs.timeFormat === "24h");
  const setPref = useApp((s) => s.setPref);
  const enabled = useMotionEnabled();
  const [gameId, setGameId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // kind / min-minutes / hide-AFK are remembered; the specific game & dates stay transient.
  const sf = useApp((s) => s.prefs.sessionFilters);
  const kind = sf.kind;
  const minMinutes = sf.minMinutes;
  const excludeIdle = sf.excludeIdle;
  const patchSf = (p: Partial<typeof sf>) =>
    setPref("sessionFilters", { ...useApp.getState().prefs.sessionFilters, ...p });
  const setMinMinutes = (v: string) => patchSf({ minMinutes: v });
  const setExcludeIdle = (v: boolean) => patchSf({ excludeIdle: v });
  const setKind = (v: EntryKind) => patchSf({ kind: v });

  const filteredGames = useMemo(() => (games ?? []).filter((g) => g.kind === kind), [games, kind]);

  const filter: SessionFilter = useMemo(
    () => ({
      kind,
      gameId: gameId || null,
      fromUtc: from ? new Date(from).toISOString() : null,
      toUtc: to ? new Date(to + "T23:59:59").toISOString() : null,
      minSeconds: minMinutes ? parseInt(minMinutes, 10) * 60 : null,
      excludeIdleEnded: excludeIdle,
    }),
    [kind, gameId, from, to, minMinutes, excludeIdle]
  );

  const { data: sessions, isLoading } = useSessions(filter);

  const totals = useMemo(() => {
    const runtime = sessions?.reduce((a, s) => a + s.runtimeSeconds, 0) ?? 0;
    const active = sessions?.reduce((a, s) => a + s.activeSeconds, 0) ?? 0;
    return { runtime, active };
  }, [sessions]);

  const exportCsv = async () => {
    const path = await save({ defaultPath: "tracker-sessions.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    const n = await api.exportSessionsCsv(path);
    pushToast({ kind: "success", title: `Exported ${n} sessions` });
  };
  const exportJson = async () => {
    const path = await save({ defaultPath: "tracker-data.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    await api.exportDataJson(path);
    pushToast({ kind: "success", title: "Exported full data" });
  };

  return (
    <div className="mt-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-800 tracking-tight">Session log</h2>
          <p className="text-sm text-ink-dim">
            {sessions ? `${sessions.length} sessions · ${dur(totals.active)} active` : "Your full play log"}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={exportJson} className="btn btn-ghost h-10">
            <FileJson className="h-4 w-4" /> JSON
          </button>
          <button onClick={exportCsv} className="btn btn-primary h-10">
            <Download className="h-4 w-4" /> Export CSV
          </button>
        </div>
      </div>

      <Panel panelKey="timeline.log.filters" games={games ?? []} sessions={sessions} className="mb-5 p-4">
        <div className="mb-4">
          <Segmented
            value={kind}
            onChange={(v) => { setKind(v); setGameId(""); }}
            options={[
              { value: "game" as const, label: "Games" },
              { value: "app" as const, label: "Apps" },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <SessionLogFilter label={kind === "game" ? "Game" : "App"}>
            <select className="input" value={gameId} onChange={(e) => setGameId(e.target.value)}>
              <option value="">{kind === "game" ? "All games" : "All apps"}</option>
              {filteredGames.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.displayName}
                </option>
              ))}
            </select>
          </SessionLogFilter>
          <SessionLogFilter label="From">
            <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </SessionLogFilter>
          <SessionLogFilter label="To">
            <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </SessionLogFilter>
          <SessionLogFilter label="Min minutes">
            <input className="input w-28" inputMode="numeric" placeholder="0" value={minMinutes} onChange={(e) => setMinMinutes(e.target.value.replace(/\D/g, ""))} />
          </SessionLogFilter>
          <div className="pb-2">
            <Toggle checked={excludeIdle} onChange={setExcludeIdle} label="Hide AFK-ended" />
          </div>
        </div>
      </Panel>

      <Panel panelKey="timeline.log.table" games={games ?? []} sessions={sessions} className="p-0">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : sessions && sessions.length > 0 ? (
          <div className="overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-line px-5 py-3 text-[11px] font-800 uppercase tracking-wider text-ink-dim">
              <span>Game</span>
              <span className="w-32 text-right">When</span>
              <span className="w-20 text-right">Active</span>
              <span className="w-20 text-right">Runtime</span>
            </div>
            <div className="max-h-[60vh] divide-y divide-line overflow-y-auto">
              {sessions.map((s, i) => (
                <motion.div
                  key={s.id}
                  className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-5 py-2.5 transition hover:bg-white/[0.02]"
                  initial={enabled ? { opacity: 0, x: -12 } : false}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(i * 0.02, 0.3), duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Link to={`/game/${s.gameId}`} className="flex min-w-0 items-center gap-3">
                    <GameArt id={s.gameId} name={s.gameName} cover={s.coverPath} icon={s.iconPath} accent={s.accentColor} className="h-8 w-8" rounded="rounded-lg" />
                    <span className="truncate text-sm font-700">{s.gameName}</span>
                    {s.wasIdleEnded && <Moon className="h-3.5 w-3.5 shrink-0 text-amber" />}
                  </Link>
                  <div className="w-32 text-right text-xs text-ink-dim">
                    {dateLabel(s.startUtc)}
                    <div className="text-[11px] text-ink-faint">{timeLabel(s.startUtc, use24)}</div>
                  </div>
                  <span className="flex w-20 items-center justify-end gap-1 text-right text-sm font-800 tabular-nums">
                    <Zap className="h-3 w-3 text-green" />
                    {dur(s.activeSeconds)}
                  </span>
                  <span className="flex w-20 items-center justify-end gap-1 text-right text-sm tabular-nums text-ink-soft">
                    <Clock className="h-3 w-3 text-ink-faint" />
                    {dur(s.runtimeSeconds)}
                  </span>
                </motion.div>
              ))}
            </div>
          </div>
        ) : (
          <div className="p-4">
            <EmptyState title="No sessions match" message="Adjust your filters or play a tracked game." />
          </div>
        )}
      </Panel>
    </div>
  );
}

function SessionLogFilter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[11px] font-700 text-ink-dim">{label}</div>
      {children}
    </label>
  );
}

function TimelineSection({
  title,
  icon,
  sessions,
  range,
  isLoading,
  legend,
  hidden,
  setHidden,
  colorFor,
  emptyMessage,
  barClassName,
}: {
  title: string;
  icon: ReactNode;
  sessions: Session[];
  range: TimelineRange;
  isLoading: boolean;
  legend: Game[];
  hidden: Set<string>;
  setHidden: React.Dispatch<React.SetStateAction<Set<string>>>;
  colorFor: (gameId: string, accent?: string | null) => string;
  emptyMessage: string;
  barClassName?: string;
}) {
  return (
    <div className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h2 className="font-display text-lg font-800 tracking-tight">{title}</h2>
        <span className="text-sm text-ink-dim">({sessions.length})</span>
      </div>
      <Panel
        panelKey={`timeline.section.${title.toLowerCase()}`}
        games={legend}
        sessions={sessions}
        className={`relative overflow-visible p-5 ${barClassName ?? ""}`}
      >
        <div className="relative z-10">
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : sessions.length > 0 ? (
            <Timeline sessions={sessions} range={range} compact maxLanes={8} showActiveApp colorFor={(s) => colorFor(s.gameId, s.accentColor)} />
          ) : (
            <EmptyState title={`No ${title.toLowerCase()} sessions`} message={emptyMessage} />
          )}
        </div>
      </Panel>
      {legend.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {legend.map((g) => {
            const off = hidden.has(g.id);
            const color = colorFor(g.id, g.accentColor);
            return (
              <button
                key={g.id}
                onClick={() =>
                  setHidden((h) => {
                    const n = new Set(h);
                    n.has(g.id) ? n.delete(g.id) : n.add(g.id);
                    return n;
                  })
                }
                className={`pill border border-line transition ${off ? "opacity-40" : ""}`}
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
                {g.kind === "app" ? <AppWindow className="h-3 w-3 text-ink-dim" /> : <Gamepad2 className="h-3 w-3 text-ink-dim" />}
                <span className="text-ink-soft">{g.displayName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TimelineInsights({
  sessions,
  games,
  colorFor,
  kind,
  title,
}: {
  sessions: Session[];
  games: Game[];
  colorFor: (id: string, accent?: string | null) => string;
  kind: EntryKind;
  title?: string;
}) {
  const enabled = useMotionEnabled();
  const use24 = useApp((s) => s.prefs.timeFormat === "24h");
  const isApp = kind === "app";

  const liveBonus = useLiveSessionBonus(sessions, kind);

  const { top, hours, peakHour, totals } = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; secs: number; sessions: number; accent: string | null }>();
    const hourBuckets = new Array(24).fill(0) as number[];
    const days = new Set<string>();
    let totalSecs = 0;
    let longest = 0;
    for (const s of sessions) {
      const secs = s.activeSeconds;
      totalSecs += secs;
      longest = Math.max(longest, s.activeSeconds);
      const e = byId.get(s.gameId) ?? { id: s.gameId, name: s.gameName, secs: 0, sessions: 0, accent: s.accentColor };
      e.secs += secs;
      e.sessions += 1;
      byId.set(s.gameId, e);
      const d = new Date(s.startUtc);
      hourBuckets[d.getHours()] += secs;
      days.add(d.toDateString());
    }
    const top = [...byId.values()].sort((a, b) => b.secs - a.secs).slice(0, 6);
    const peak = hourBuckets.reduce((best, v, i) => (v > hourBuckets[best] ? i : best), 0);
    return {
      top,
      hours: hourBuckets,
      peakHour: peak,
      totals: {
        sessions: sessions.length,
        secs: totalSecs,
        titles: byId.size,
        days: days.size,
        longest,
        avg: sessions.length ? totalSecs / sessions.length : 0,
      },
    };
  }, [sessions]);

  if (sessions.length === 0) return null;

  const maxTop = Math.max(1, ...top.map((t) => t.secs));
  const maxHour = Math.max(1, ...hours);
  const totalActive = totals.secs + liveBonus;

  return (
    <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-4">
      {title && (
        <div className="lg:col-span-2 2xl:col-span-4">
          <h3 className="text-sm font-700 uppercase tracking-wider text-ink-dim">{title}</h3>
        </div>
      )}
      {/* Top titles in view */}
      <Panel panelKey={`timeline.insights.top.${kind}`} games={games} sessions={sessions} className="lg:col-span-2 2xl:col-span-2">
        <SectionTitle
          title="Where your time went"
          subtitle={isApp ? "By focused active time" : "By active playtime in this view"}
        />
        <div className="mt-3 space-y-2.5">
          {top.map((t, i) => {
            const color = colorFor(t.id, t.accent);
            return (
              <motion.div
                key={t.id}
                className="flex items-center gap-3"
                initial={enabled ? { opacity: 0, x: -12 } : false}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04, duration: 0.4 }}
              >
                <Link to={`/game/${t.id}`} className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[10px]" style={{ background: `color-mix(in srgb, ${color} 22%, transparent)`, color }}>
                    {isApp ? <AppWindow className="h-3 w-3" /> : <Gamepad2 className="h-3 w-3" />}
                  </span>
                  <span className="w-32 shrink-0 truncate text-sm font-700 text-ink-soft hover:text-ink sm:w-44">{t.name}</span>
                  <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ background: color, boxShadow: `0 0 10px -2px ${color}` }}
                      initial={{ width: 0 }}
                      animate={{ width: `${(t.secs / maxTop) * 100}%` }}
                      transition={{ duration: 0.6, delay: i * 0.04 }}
                    />
                  </div>
                </Link>
                <span className="w-16 shrink-0 text-right text-sm font-800 tabular-nums">{dur(t.secs)}</span>
              </motion.div>
            );
          })}
        </div>
      </Panel>

      {/* Active by hour */}
      <Panel panelKey={`timeline.insights.hourly.${kind}`} games={games} sessions={sessions}>
        <SectionTitle title="Active by hour" subtitle={`Peak around ${hourLabel(peakHour, use24)}`} />
        <div className="mt-4 flex h-28 items-end gap-[3px]">
          {hours.map((v, h) => (
            <motion.div
              key={h}
              className="flex-1 rounded-t"
              style={{ background: h === peakHour ? "var(--accent-1)" : "rgba(255,255,255,0.12)" }}
              initial={enabled ? { height: 0 } : false}
              animate={{ height: `${Math.max(2, (v / maxHour) * 100)}%` }}
              transition={{ delay: h * 0.012, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
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

      {/* Summary stats */}
      <Panel panelKey={`timeline.insights.summary.${kind}`} games={games} sessions={sessions}>
        <SectionTitle title="Summary" subtitle="In this view" />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Stat label="Total active" value={dur(totalActive)} />
          <Stat label="Sessions" value={String(totals.sessions)} />
          <Stat label="Active days" value={String(totals.days)} />
          <Stat label="Titles" value={String(totals.titles)} />
          <Stat label="Avg session" value={dur(totals.avg)} />
          <Stat label="Longest active" value={dur(totals.longest)} />
        </div>
      </Panel>
    </div>
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

function completionSortKey(g: Game): number {
  const y = g.completedYear ?? 0;
  const m = g.completedMonth ?? 0;
  const d = g.completedDay ?? 0;
  return y * 10_000 + m * 100 + d;
}

function CompletionTimeline({ games, colorFor }: { games: Game[]; colorFor: (id: string, accent?: string | null) => string }) {
  const enabled = useMotionEnabled();
  const years = useMemo(() => {
    const map = new Map<number, Game[]>();
    for (const g of games) {
      if (g.completedYear) {
        if (!map.has(g.completedYear)) map.set(g.completedYear, []);
        map.get(g.completedYear)!.push(g);
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [games]);

  if (years.length === 0) return <EmptyState title="No completion years" message="Add completed years to your games to see them here." />;

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex items-end gap-4">
        {years.map(([year, list], yi) => (
          <motion.div
            key={year}
            className="flex flex-col items-center gap-2"
            initial={enabled ? { opacity: 0, y: 20 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: yi * 0.06, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex w-full flex-col-reverse gap-1.5">
              {list
                .sort((a, b) => completionSortKey(a) - completionSortKey(b) || (b.rating ?? 0) - (a.rating ?? 0))
                .map((g, gi) => {
                  const color = colorFor(g.id, g.accentColor);
                  const dateLabel = partialDate(g.completedYear, g.completedMonth, g.completedDay);
                  const playLabel = g.totalRuntimeSeconds > 0 ? dur(g.totalRuntimeSeconds) : null;
                  return (
                    <motion.div
                      key={g.id}
                      initial={enabled ? { opacity: 0, x: -24, scaleX: 0.6 } : false}
                      animate={{ opacity: 1, x: 0, scaleX: 1 }}
                      transition={{ delay: yi * 0.06 + gi * 0.04, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                      style={{ originX: 0 }}
                    >
                      <Link
                        to={`/game/${g.id}`}
                        title={[g.displayName, dateLabel !== "—" ? dateLabel : null, playLabel, scoreTooltip(g)].filter(Boolean).join(" · ")}
                        className="group/c relative flex h-7 min-w-[150px] items-center gap-2 overflow-hidden rounded-lg px-2 text-[11px] font-700 text-white transition hover:scale-[1.02]"
                        style={{ background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 55%, #0b0d16))`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 50%, transparent)` }}
                      >
                        {enabled && (
                          <motion.span
                            className="pointer-events-none absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-white/18 to-transparent"
                            initial={{ x: "-100%" }}
                            animate={{ x: "250%" }}
                            transition={{ duration: 1.4, delay: yi * 0.06 + gi * 0.04 + 0.25, ease: "easeInOut" }}
                          />
                        )}
                        <span className="relative truncate">{g.displayName}</span>
                        {playLabel && <span className="relative shrink-0 text-[10px] font-600 text-white/75">{playLabel}</span>}
                        <span className="relative ml-auto shrink-0">
                          <GameScores game={g} variant="inline" className="text-[10px] text-white" />
                        </span>
                      </Link>
                    </motion.div>
                  );
                })}
            </div>
            <span className="rounded-full bg-white/[0.05] px-3 py-1 font-display text-xs font-800 tabular-nums">{year}</span>
            <span className="text-[10px] text-ink-faint">{list.length} games</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
