import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  AppWindow,
  Plus,
  Radar,
  FileCode2,
  Search,
  Clock,
  Hash,
  Loader2,
  ImageDown,
  Sparkles,
  Zap,
  CalendarDays,
  Flame,
  Layers,
  Moon,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Page } from "@/components/Page";
import { GameArt } from "@/components/GameArt";
import { DetectModal } from "@/components/DetectModal";
import { Heatmap } from "@/components/Heatmap";
import { StatTile } from "@/components/StatTile";
import { PolarHours } from "@/components/Charts";
import { SectionTitle, EmptyState, Skeleton } from "@/components/ui";
import { Panel } from "@/components/Panel";
import { useGames, useAppsOverview, useHeatmap, useHourOfDay, useRefreshAll } from "@/lib/queries";
import { useApp, useMotionEnabled } from "@/store/app";
import { useProgress } from "@/store/progress";
import { runBulkAppImages, runBulkAppInfo } from "@/lib/bulkTasks";
import { clockString, dur, hours, relativeTime } from "@/lib/format";
import { api, Game } from "@/lib/api";

function AppCard({ app, index }: { app: Game; index: number }) {
  const enabled = useMotionEnabled();
  return (
    <motion.div
      initial={enabled ? { opacity: 0, y: 18 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.4), duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
      whileHover={enabled ? { y: -4 } : undefined}
    >
      <Link
        to={`/game/${app.id}`}
        className="card group relative block overflow-hidden p-0 transition-shadow hover:shadow-[0_18px_44px_-16px_color-mix(in_srgb,var(--accent-1)_42%,transparent)]"
      >
        <div className="flex items-center gap-4 p-4">
          <GameArt
            id={app.id}
            name={app.displayName}
            cover={app.coverPath}
            icon={app.iconPath}
            accent={app.accentColor}
            variant="icon"
            rounded="rounded-2xl"
            className="h-16 w-16 shrink-0 shadow-card"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <AppWindow className="h-3.5 w-3.5 shrink-0 text-ink-dim" />
              <h3 className="truncate font-display text-base font-800 tracking-tight">{app.displayName}</h3>
            </div>
            {app.developer && <div className="truncate text-xs text-ink-dim">{app.developer}</div>}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-soft">
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3 text-accent-3" /> {dur(app.totalRuntimeSeconds)}
              </span>
              {app.totalActiveSeconds > 0 && app.totalActiveSeconds < app.totalRuntimeSeconds - 30 && (
                <span className="inline-flex items-center gap-1 text-ink-faint">
                  <Zap className="h-3 w-3" /> {dur(app.totalActiveSeconds)} focused
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Hash className="h-3 w-3" /> {app.sessionCount}
              </span>
              <span className="text-ink-faint">{app.lastPlayedUtc ? relativeTime(app.lastPlayedUtc) : "Not used yet"}</span>
            </div>
          </div>
        </div>
        {app.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pb-4">
            {app.tags.slice(0, 4).map((t) => (
              <span key={t} className="pill border border-line bg-white/[0.03] text-[10px] text-ink-dim">
                {t}
              </span>
            ))}
          </div>
        )}
      </Link>
    </motion.div>
  );
}

/** Live "now using" strip — the app-side analogue of NowPlaying, never mixing in games. */
function AppNowUsing() {
  const tracking = useApp((s) => s.tracking);
  const enabled = useMotionEnabled();
  const active = !!tracking?.appIsActive && !tracking?.paused;
  const idle = !!tracking?.isIdle;

  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(0);
  }, [tracking?.appSessionActiveSeconds, tracking?.appSessionRuntimeSeconds, tracking?.appId]);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);

  if (!active || !tracking?.appId) return null;
  // Runtime keeps counting in the background (like games); focused pauses when AFK.
  const liveRuntime = (tracking.appSessionRuntimeSeconds ?? tracking.appSessionActiveSeconds ?? 0) + tick;
  const liveActive = (tracking.appSessionActiveSeconds ?? 0) + (idle ? 0 : tick);

  return (
    <motion.div
      layout
      initial={enabled ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-2xl border border-line bg-bg-850/70 p-4 shadow-card"
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(120% 120% at 0% 0%, color-mix(in srgb, var(--accent-3) 16%, transparent), transparent 55%)",
        }}
      />
      <div className="relative flex items-center gap-4">
        <div className="relative">
          <GameArt
            id={tracking.appId}
            name={tracking.appName ?? "App"}
            cover={tracking.appCoverPath}
            icon={tracking.appIconPath}
            accent={tracking.appAccentColor}
            className="h-14 w-14 shadow-card"
            rounded="rounded-2xl"
          />
          <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5">
            <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-accent-3/70" />
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full border-2 border-bg-850 bg-accent-3" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] font-800 uppercase tracking-[0.2em] text-ink-dim">
            ● Now using
            {idle && (
              <span className="pill bg-amber/15 text-amber">
                <Moon className="h-3 w-3" /> AFK
              </span>
            )}
            {(tracking.appActiveCount ?? 0) > 1 && (
              <span className="pill border border-line bg-white/[0.04] text-ink-soft">+{tracking.appActiveCount - 1} more</span>
            )}
          </div>
          <div className="mt-0.5 truncate font-display text-lg font-800 tracking-tight">{tracking.appName}</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl font-700 tabular-nums text-ink">{clockString(liveRuntime)}</div>
          <div className="text-[11px] text-ink-dim">
            {dur(tracking.appTodayRuntimeSeconds ?? tracking.appTodayActiveSeconds ?? 0)} today
            {liveActive < liveRuntime - 5 && (
              <span className="text-ink-faint"> · {dur(liveActive)} focused</span>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export default function AppsPage() {
  const { data: games, isLoading } = useGames();
  const { data: overview } = useAppsOverview();
  const { data: heat } = useHeatmap(182, "app");
  const { data: hourOfDay } = useHourOfDay("app");
  const openGameModal = useApp((s) => s.openGameModal);
  const pushToast = useApp((s) => s.pushToast);
  const use24 = useApp((s) => s.prefs.timeFormat === "24h");
  const refresh = useRefreshAll();
  const imagesJob = useProgress((s) => s.getJob("app-images"));
  const infoJob = useProgress((s) => s.getJob("app-info"));
  const anyBusy = useProgress((s) => s.isAnyBusy());
  const [q, setQ] = useState("");
  const [detectOpen, setDetectOpen] = useState(false);
  const [picking, setPicking] = useState(false);

  const allApps = useMemo(() => (games ?? []).filter((g) => g.kind === "app"), [games]);
  const jobLabel = (job: typeof imagesJob, fallback: string) =>
    job ? (job.total > 0 ? `${job.done}/${job.total}` : `${job.done}…`) : fallback;

  const apps = useMemo(() => {
    const filtered = q
      ? allApps.filter((g) => `${g.displayName} ${g.developer ?? ""}`.toLowerCase().includes(q.toLowerCase()))
      : allApps;
    return [...filtered].sort(
      (a, b) =>
        b.totalRuntimeSeconds - a.totalRuntimeSeconds ||
        b.totalActiveSeconds - a.totalActiveSeconds ||
        a.displayName.localeCompare(b.displayName)
    );
  }, [allApps, q]);

  const totalApps = allApps.length;
  const missingArt = allApps.filter((a) => !a.coverPath && !a.iconPath).length;
  const hasUsage =
    (overview?.totalRuntime ?? overview?.totalActive ?? 0) > 0 ||
    (hourOfDay?.some((h) => h > 0) ?? false);

  const pickExe = async () => {
    setPicking(true);
    try {
      const sel = await open({ multiple: false, filters: [{ name: "Executable", extensions: ["exe"] }] });
      if (typeof sel === "string") {
        const app = await api.addAppFromPath(sel);
        refresh();
        pushToast({ kind: "success", title: `Added ${app.displayName}`, message: "Now tracking this app" });
      }
    } catch {
      pushToast({ kind: "info", title: "Couldn't add that app" });
    } finally {
      setPicking(false);
    }
  };

  return (
    <Page
      title="Apps"
      subtitle={
        totalApps > 0
          ? `${totalApps} tracked ${totalApps === 1 ? "app" : "apps"} · ${dur(overview?.totalRuntime ?? overview?.totalActive ?? 0)} all-time`
          : "Track the software you use"
      }
      actions={
        <>
          <button
            onClick={() => runBulkAppImages(allApps, refresh, pushToast)}
            disabled={anyBusy || allApps.length === 0}
            className="btn btn-ghost h-10"
            title="Fetch logos and cover images online (Wikipedia / Wikidata)"
          >
            {imagesJob ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageDown className="h-4 w-4" />}
            {jobLabel(imagesJob, "Get images")}
          </button>
          <button
            onClick={() => runBulkAppInfo(allApps, refresh, pushToast)}
            disabled={anyBusy || allApps.length === 0}
            className="btn btn-ghost h-10"
            title="Fetch description, developer, and details online"
          >
            {infoJob ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {jobLabel(infoJob, "Get info")}
          </button>
          <button onClick={pickExe} disabled={picking} className="btn btn-ghost h-10" title="Add an app from its .exe">
            {picking ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCode2 className="h-4 w-4" />}
            Pick .exe
          </button>
          <button onClick={() => setDetectOpen(true)} className="btn btn-ghost h-10">
            <Radar className="h-4 w-4" /> Detect running
          </button>
          <button onClick={() => openGameModal({ kind: "app" })} className="btn btn-primary h-10">
            <Plus className="h-4 w-4" /> Add app
          </button>
        </>
      }
    >
      {totalApps > 0 ? (
        <div className="space-y-6">
          <AppNowUsing />

          {/* App-only usage stats — never compared against games. */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile
              icon={<Clock className="h-[18px] w-[18px]" />}
              label="Today"
              value={overview ? (overview.todayRuntime ?? overview.todayActive) / 3600 : 0}
              decimals={1}
              suffix="h"
              accent="#22d3ee"
              delay={0.02}
              hint={overview ? `${dur(overview.todayActive)} focused` : "total app time"}
            />
            <StatTile
              icon={<CalendarDays className="h-[18px] w-[18px]" />}
              label="This week"
              value={overview ? (overview.weekRuntime ?? overview.weekActive) / 3600 : 0}
              decimals={1}
              suffix="h"
              accent="#34d399"
              delay={0.06}
              hint={overview ? `${dur(overview.monthRuntime ?? overview.monthActive)} this month` : ""}
            />
            <StatTile
              icon={<Flame className="h-[18px] w-[18px]" />}
              label="Streak"
              value={overview?.currentStreak ?? 0}
              suffix={overview?.currentStreak === 1 ? " day" : " days"}
              accent="#fbbf24"
              delay={0.1}
              hint={overview ? `Longest ${overview.longestStreak} days` : ""}
            />
            <StatTile
              icon={<Layers className="h-[18px] w-[18px]" />}
              label="Apps tracked"
              value={overview?.appsTracked ?? totalApps}
              accent="var(--accent-1)"
              delay={0.14}
              hint={overview ? `${overview.sessionCount} sessions` : ""}
            />
          </div>

          {missingArt > 0 && (
            <button
              onClick={() => runBulkAppImages(allApps, refresh, pushToast)}
              disabled={anyBusy}
              className="card flex w-full items-center justify-between gap-4 border border-accent-1/25 bg-accent-1/[0.06] px-4 py-3 text-left transition hover:bg-accent-1/[0.1] disabled:opacity-60"
            >
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-sheen/20 text-accent-3">
                  <ImageDown className="h-4 w-4" />
                </span>
                <div>
                  <div className="text-sm font-700">{missingArt} {missingArt === 1 ? "app is" : "apps are"} missing artwork</div>
                  <div className="text-xs text-ink-dim">Fetch logos from Wikipedia so every app shows its icon.</div>
                </div>
              </div>
              <span className="text-xs font-700 text-accent-3">Get images →</span>
            </button>
          )}

          {hasUsage && (
            <div className="grid gap-6 lg:grid-cols-3">
              <motion.div className="lg:col-span-2" initial={false}>
                <Panel panelKey="apps.activity" games={apps} art="icon" className="h-full">
                  <SectionTitle
                    sheen
                    title="App activity"
                    subtitle="Total app time over the last 6 months (background included)"
                    right={
                      <span className="text-sm font-700 text-ink">
                        {overview ? hours(overview.totalRuntime ?? overview.totalActive, 0) : 0}
                        <span className="ml-1 text-xs font-500 text-ink-dim">h all-time</span>
                      </span>
                    }
                  />
                  {heat ? <Heatmap data={heat} /> : <Skeleton className="h-28 w-full" />}
                </Panel>
              </motion.div>

              <Panel panelKey="apps.top" games={apps} art="icon" className="h-full">
                <SectionTitle sheen title="Top apps" subtitle="By total time" />
                {overview && overview.topApps.length > 0 ? (
                  <div className="space-y-1">
                    {overview.topApps.map((a, i) => {
                      const max = overview.topApps[0].runtimeSeconds || 1;
                      return (
                        <Link key={a.id} to={`/game/${a.id}`} className="group flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-white/[0.03]">
                          <span className="w-4 text-center text-xs font-800 text-ink-faint">{i + 1}</span>
                          <GameArt id={a.id} name={a.name} cover={a.coverPath} icon={a.iconPath} accent={a.accentColor} className="h-9 w-9" rounded="rounded-lg" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-700">{a.name}</div>
                            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
                              <motion.div className="h-full rounded-full bg-accent-sheen" initial={{ width: 0 }} animate={{ width: `${(a.runtimeSeconds / max) * 100}%` }} transition={{ duration: 0.7, delay: i * 0.05 }} />
                            </div>
                          </div>
                          <span className="shrink-0 text-xs font-800 tabular-nums text-ink-soft">{dur(a.runtimeSeconds)}</span>
                        </Link>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState title="No app usage yet" message="Run a tracked app and it'll rank here." />
                )}
              </Panel>
            </div>
          )}

          {hasUsage && hourOfDay && hourOfDay.some((h) => h > 0) && (
            <Panel panelKey="apps.hourly" games={apps} art="icon">
              <SectionTitle sheen title="When you use apps" subtitle="Focused app time by hour of day" />
              <PolarHours values={hourOfDay} use24={use24} />
            </Panel>
          )}

          {/* App library */}
          <Panel panelKey="apps.library" games={apps} art="icon" className="!p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 p-4 pb-0">
              <SectionTitle title="Your apps" subtitle={`${totalApps} tracked`} />
              <div className="relative min-w-[220px]">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim" />
                <input className="input pl-9" placeholder="Search apps…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>
            <div className="p-4">
              {apps.length > 0 ? (
                <AnimatePresence mode="popLayout">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 min-[2200px]:grid-cols-5">
                    {apps.map((app, i) => (
                      <AppCard key={app.id} app={app} index={i} />
                    ))}
                  </div>
                </AnimatePresence>
              ) : (
                <EmptyState title="No apps match your search" />
              )}
            </div>
          </Panel>
        </div>
      ) : isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<AppWindow className="h-6 w-6" />}
          title="No apps tracked yet"
          message="Add software you want to measure — a code editor, a browser, a creative tool. Apps keep accruing time in the background like games, and only tracks what you add."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <button onClick={() => openGameModal({ kind: "app" })} className="btn btn-primary">
                <Plus className="h-4 w-4" /> Add an app
              </button>
              <button onClick={() => setDetectOpen(true)} className="btn btn-ghost">
                <Radar className="h-4 w-4" /> Detect running apps
              </button>
            </div>
          }
        />
      )}

      <DetectModal open={detectOpen} onClose={() => setDetectOpen(false)} mode="app" />
    </Page>
  );
}
