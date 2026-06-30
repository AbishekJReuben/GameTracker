import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@/lib/tauri";
import { APP_VERSION } from "@/lib/version";
import {
  Power,
  Moon,
  Clock,
  Bell,
  PanelTopClose,
  DatabaseBackup,
  Upload,
  FileSpreadsheet,
  Gamepad2,
  Wifi,
  Palette,
  Sparkles,
  LayoutGrid,
  Clock4,
  CalendarRange,
  Home,
  Waves,
  Zap,
  ScanLine,
  ImageDown,
  Target,
  Download,
  ChevronDown,
  FileJson,
  Camera,
  Timer,
  RefreshCw,
  Music2,
  Compass,
  Gauge,
} from "lucide-react";
import { Page } from "@/components/Page";
import { SectionTitle, Segmented } from "@/components/ui";
import { Panel } from "@/components/Panel";
import { TIMELINE_RANGE_OPTIONS } from "@/lib/timelineZoom";
import { useSettings, useRefreshAll, useGames } from "@/lib/queries";
import { useApp, useMotionEnabled } from "@/store/app";
import type { AccentTheme, CustomAccent } from "@/store/app";
import { api, type Settings } from "@/lib/api";
import { runCsvImport } from "@/lib/bulkTasks";
import { ContentAuditPanel } from "@/components/ContentAuditPanel";
import { MetacriticBackfill } from "@/components/MetacriticBackfill";
import { LauncherSyncSection } from "@/components/LauncherSyncSection";

const ACCENTS: { id: AccentTheme; label: string; colors: [string, string, string] }[] = [
  { id: "aurora", label: "Aurora", colors: ["#7c5cff", "#3b82f6", "#22d3ee"] },
  { id: "toxic", label: "Toxic", colors: ["#34d399", "#a3e635", "#22d3ee"] },
  { id: "ember", label: "Ember", colors: ["#fb7185", "#fb923c", "#fbbf24"] },
  { id: "magma", label: "Magma", colors: ["#fb5d6a", "#f472b6", "#fb923c"] },
  { id: "ice", label: "Ice", colors: ["#38bdf8", "#6366f1", "#22d3ee"] },
  { id: "sunset", label: "Sunset", colors: ["#f472b6", "#c084fc", "#fbbf24"] },
  { id: "synthwave", label: "Synthwave", colors: ["#e94aff", "#7c5cff", "#22d3ee"] },
  { id: "gold", label: "Gold", colors: ["#fbbf24", "#f59e0b", "#fde68a"] },
  { id: "forest", label: "Forest", colors: ["#22c55e", "#14b8a6", "#a3e635"] },
  { id: "rose", label: "Rosé", colors: ["#fb7185", "#f472b6", "#c084fc"] },
  { id: "mono", label: "Mono", colors: ["#94a3b8", "#64748b", "#cbd5e1"] },
];

const LANDING_OPTS = [
  { value: "/", label: "Dashboard" },
  { value: "/library", label: "Library" },
  { value: "/apps", label: "Apps" },
  { value: "/system", label: "System" },
  { value: "/timeline", label: "Timeline" },
  { value: "/collection", label: "Collection" },
];

export default function SettingsPage() {
  const { data: settings } = useSettings();
  const { data: games } = useGames();
  const qc = useQueryClient();
  const pushToast = useApp((s) => s.pushToast);
  const refresh = useRefreshAll();
  const prefs = useApp((s) => s.prefs);
  const setPref = useApp((s) => s.setPref);
  const [autostart, setAutostart] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    api.autostartEnabled().then(setAutostart).catch(() => {});
    if (isTauri()) getVersion().then(setAppVersion).catch(() => {});
  }, []);

  const setVal = async (key: string, value: string) => {
    const prev = qc.getQueryData<Settings>(["settings"]);
    if (prev) {
      qc.setQueryData(["settings"], { ...prev, [key]: value });
    }
    try {
      await api.setSetting(key, value);
      await qc.invalidateQueries({ queryKey: ["settings"] });
    } catch {
      if (prev) qc.setQueryData(["settings"], prev);
      pushToast({ kind: "info", title: "Couldn't save setting" });
    }
  };
  const bool = (k: string) => settings?.[k] === "true";

  const toggleAutostart = async (v: boolean) => {
    try {
      await api.setAutostart(v);
      setAutostart(v);
      await setVal("start_with_windows", v ? "true" : "false");
    } catch {
      pushToast({ kind: "info", title: "Couldn't change startup setting" });
    }
  };

  const importCsv = async () => {
    const path = (await api.defaultCsvPath()) ?? (await open({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] }));
    if (typeof path !== "string") return;
    try {
      await runCsvImport(path, refresh, pushToast);
    } catch {
      pushToast({ kind: "info", title: "CSV import failed" });
    }
  };

  const backup = async () => {
    const path = await save({ defaultPath: "tracker-backup.db", filters: [{ name: "Database", extensions: ["db"] }] });
    if (!path) return;
    await api.backupDb(path);
    pushToast({ kind: "success", title: "Backup saved" });
  };
  const restore = async () => {
    const path = await open({ multiple: false, filters: [{ name: "Database", extensions: ["db"] }] });
    if (typeof path !== "string") return;
    await api.restoreDb(path);
  };

  const exportCsv = async () => {
    if (!isTauri()) return;
    const path = await save({ defaultPath: "tracker-sessions.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    const n = await api.exportSessionsCsv(path);
    pushToast({ kind: "success", title: `Exported ${n} sessions` });
  };

  const checkUpdates = async () => {
    if (!isTauri() || checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const status = await api.checkForUpdates();
      if (status.available) {
        pushToast({ kind: "success", title: `Update available — v${status.version}`, message: "Downloading and installing… the app will restart." });
        await api.installUpdate(); // restarts the app on success
      } else {
        pushToast({ kind: "info", title: "You're up to date", message: `Running the latest version (v${status.currentVersion}).` });
      }
    } catch {
      pushToast({ kind: "info", title: "Couldn't check for updates", message: "Check your connection and try again." });
    } finally {
      setCheckingUpdate(false);
    }
  };

  const exportJson = async () => {
    if (!isTauri()) return;
    const path = await save({ defaultPath: "tracker-export.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    await api.exportDataJson(path);
    pushToast({ kind: "success", title: "Full export saved" });
  };

  const setWidget = (key: keyof typeof prefs.widgets, v: boolean) => {
    setPref("widgets", { ...prefs.widgets, [key]: v });
  };

  const enabled = useMotionEnabled();

  const sections = [
    {
      id: "appearance",
      title: "Appearance",
      subtitle: "Make it yours — changes apply instantly",
      content: (
        <div className="space-y-1">
          <SettingRow icon={<Palette className="h-4 w-4" />} title="Accent theme" desc="The signature color of glows, gradients and highlights.">
            <div className="flex max-w-[280px] flex-wrap justify-end gap-2">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setPref("accent", a.id)}
                  title={a.label}
                  className={`h-8 w-8 rounded-lg border-2 transition ${prefs.accent === a.id ? "scale-110 border-white" : "border-transparent hover:scale-105"}`}
                  style={{ background: `linear-gradient(135deg, ${a.colors[0]}, ${a.colors[1]} 50%, ${a.colors[2]})` }}
                />
              ))}
              {/* Custom accent — the live gradient of the user's three stops. */}
              <button
                onClick={() => setPref("accent", "custom")}
                title="Custom"
                className={`relative grid h-8 w-8 place-items-center rounded-lg border-2 transition ${prefs.accent === "custom" ? "scale-110 border-white" : "border-transparent hover:scale-105"}`}
                style={{ background: `linear-gradient(135deg, ${prefs.customAccent[0]}, ${prefs.customAccent[1]} 50%, ${prefs.customAccent[2]})` }}
              >
                <Sparkles className="h-3.5 w-3.5 text-white/90 drop-shadow" />
              </button>
            </div>
          </SettingRow>
          <CustomAccentRow
            value={prefs.customAccent}
            active={prefs.accent === "custom"}
            onChange={(next) => {
              setPref("customAccent", next);
              if (prefs.accent !== "custom") setPref("accent", "custom");
            }}
          />
          <SettingRow icon={<Sparkles className="h-4 w-4" />} title="Animation level" desc="Full motion, reduced flourishes, or none (also the safest for low-end PCs).">
            <Segmented
              value={prefs.motion}
              onChange={(v) => setPref("motion", v)}
              size="sm"
              options={[
                { value: "full", label: "Full" },
                { value: "reduced", label: "Reduced" },
                { value: "off", label: "Off" },
              ]}
            />
          </SettingRow>
          <SettingRow icon={<Zap className="h-4 w-4" />} title="Performance" desc="Lite drops glass blur, shaders, ambient orbs & marquees for maximum smoothness. Auto picks based on your hardware.">
            <Segmented
              value={prefs.perfMode}
              onChange={(v) => setPref("perfMode", v)}
              size="sm"
              options={[
                { value: "auto", label: "Auto" },
                { value: "high", label: "High" },
                { value: "lite", label: "Lite" },
              ]}
            />
          </SettingRow>
          <SettingRow icon={<Waves className="h-4 w-4" />} title="Animated background" desc="Drifting accent orbs behind the app.">
            <SpringToggle checked={prefs.background} onChange={(v) => setPref("background", v)} />
          </SettingRow>
          <SettingRow icon={<ScanLine className="h-4 w-4" />} title="Scanlines" desc="Subtle CRT-style overlay for extra game feel.">
            <SpringToggle checked={prefs.scanlines} onChange={(v) => setPref("scanlines", v)} />
          </SettingRow>
          <SettingRow icon={<Sparkles className="h-4 w-4" />} title="Marquee backgrounds" desc="Drifting cover & screenshot art behind panels. Off, Compact (originals only), or Full (everywhere).">
            <Segmented
              value={prefs.marquee}
              onChange={(v) => setPref("marquee", v)}
              size="sm"
              options={[
                { value: "off", label: "Off" },
                { value: "compact", label: "Compact" },
                { value: "full", label: "Full" },
              ]}
            />
          </SettingRow>
          <SettingRow icon={<LayoutGrid className="h-4 w-4" />} title="Density" desc="Comfortable spacing or a tighter, info-dense layout.">
            <Segmented
              value={prefs.density}
              onChange={(v) => setPref("density", v)}
              size="sm"
              options={[
                { value: "cozy", label: "Cozy" },
                { value: "compact", label: "Compact" },
              ]}
            />
          </SettingRow>
        </div>
      ),
    },
    {
      id: "dashboard",
      title: "Dashboard",
      subtitle: "Choose what appears on your home screen",
      content: (
        <div className="space-y-1">
          <SettingRow icon={<Target className="h-4 w-4" />} title="Daily goal progress" desc="Show a progress bar when a daily play goal is set.">
            <SpringToggle checked={prefs.widgets.goal} onChange={(v) => setWidget("goal", v)} />
          </SettingRow>
          <SettingRow icon={<LayoutGrid className="h-4 w-4" />} title="Secondary stats row" desc="All-time hours, month stats, focus ratio, and unique games.">
            <SpringToggle checked={prefs.widgets.secondary} onChange={(v) => setWidget("secondary", v)} />
          </SettingRow>
          <SettingRow icon={<Sparkles className="h-4 w-4" />} title="Activity heatmap" desc="Six-month play heatmap on the dashboard.">
            <SpringToggle checked={prefs.widgets.heatmap} onChange={(v) => setWidget("heatmap", v)} />
          </SettingRow>
          <SettingRow icon={<Clock4 className="h-4 w-4" />} title="Play pattern charts" desc="Hour-of-day polar chart and weekday distribution.">
            <SpringToggle checked={prefs.widgets.patterns} onChange={(v) => setWidget("patterns", v)} />
          </SettingRow>
          <SettingRow icon={<Target className="h-4 w-4" />} title="Daily play goal" desc="Target active minutes per day (0 = off).">
            <NumberInput value={settings?.daily_goal_minutes ?? "0"} onCommit={(v) => setVal("daily_goal_minutes", v)} suffix="min" />
          </SettingRow>
        </div>
      ),
    },
    {
      id: "behavior",
      title: "Behavior",
      subtitle: "Defaults and formats",
      content: (
        <div className="space-y-1">
          <SettingRow icon={<Home className="h-4 w-4" />} title="Open on launch" desc="Which screen Tracker shows first.">
            <select className="input w-40" value={prefs.landing} onChange={(e) => setPref("landing", e.target.value)}>
              {LANDING_OPTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow icon={<Compass className="h-4 w-4" />} title="Suggested tab" desc="Show the game recommendations tab in the sidebar.">
            <SpringToggle checked={prefs.showSuggested} onChange={(v) => setPref("showSuggested", v)} />
          </SettingRow>
          <SettingRow icon={<CalendarRange className="h-4 w-4" />} title="Default timeline range" desc="Starting zoom for timeline views.">
            <Segmented
              value={prefs.timelineRange}
              onChange={(v) => setPref("timelineRange", v)}
              size="sm"
              options={TIMELINE_RANGE_OPTIONS}
            />
          </SettingRow>
          <SettingRow icon={<Clock4 className="h-4 w-4" />} title="Time format" desc="How times of day are displayed.">
            <Segmented
              value={prefs.timeFormat}
              onChange={(v) => setPref("timeFormat", v)}
              size="sm"
              options={[
                { value: "12h", label: "12h" },
                { value: "24h", label: "24h" },
              ]}
            />
          </SettingRow>
          <SettingRow icon={<CalendarRange className="h-4 w-4" />} title="Week starts on" desc="First day of the week for weekly views.">
            <Segmented
              value={prefs.weekStart}
              onChange={(v) => setPref("weekStart", v)}
              size="sm"
              options={[
                { value: "mon", label: "Mon" },
                { value: "sun", label: "Sun" },
              ]}
            />
          </SettingRow>
        </div>
      ),
    },
    {
      id: "tracking",
      title: "Tracking",
      content: (
        <div className="space-y-1">
          <SettingRow icon={<Power className="h-4 w-4" />} title="Start with Windows" desc="Launch Tracker to the tray at login.">
            <SpringToggle checked={autostart} onChange={toggleAutostart} />
          </SettingRow>
          <SettingRow icon={<Moon className="h-4 w-4" />} title="Idle threshold" desc="Pause active time after this many minutes of no input.">
            <NumberInput value={settings?.idle_minutes ?? "5"} onCommit={(v) => setVal("idle_minutes", v)} suffix="min" />
          </SettingRow>
          <SettingRow icon={<Clock className="h-4 w-4" />} title="Minimum session" desc="Ignore sessions shorter than this in stats.">
            <NumberInput value={settings?.min_session_seconds ?? "30"} onCommit={(v) => setVal("min_session_seconds", v)} suffix="sec" />
          </SettingRow>
          <SettingRow icon={<Bell className="h-4 w-4" />} title="Session notifications" desc="Toast when a tracked game starts or stops.">
            <SpringToggle checked={bool("notify_sessions")} onChange={(v) => setVal("notify_sessions", v ? "true" : "false")} />
          </SettingRow>
          <SettingRow icon={<Target className="h-4 w-4" />} title="Break reminder" desc="Toast nudge after this many minutes of continuous play (0 = off).">
            <NumberInput value={settings?.break_reminder_minutes ?? "0"} onCommit={(v) => setVal("break_reminder_minutes", v)} suffix="min" />
          </SettingRow>
          <SettingRow icon={<Gauge className="h-4 w-4" />} title="Performance tracking" desc="Record CPU, GPU, RAM & temperatures over time for the System dashboard.">
            <SpringToggle checked={settings ? settings.system_monitor_enabled !== "false" : true} onChange={(v) => setVal("system_monitor_enabled", v ? "true" : "false")} />
          </SettingRow>
        </div>
      ),
    },
    {
      id: "screenshots",
      title: "Screenshots",
      subtitle: "Auto-capture your game screen while you play",
      content: (
        <div className="space-y-1">
          <SettingRow icon={<Camera className="h-4 w-4" />} title="Auto screenshots" desc="Capture the focused game's screen on a timer. Saved to each game's detail page.">
            <SpringToggle checked={settings ? settings.auto_screenshots_enabled !== "false" : true} onChange={(v) => setVal("auto_screenshots_enabled", v ? "true" : "false")} />
          </SettingRow>
          <SettingRow icon={<Timer className="h-4 w-4" />} title="Capture interval" desc="How often to grab a screenshot while a game is focused.">
            <NumberInput value={settings?.screenshot_interval_minutes ?? "1"} onCommit={(v) => setVal("screenshot_interval_minutes", v)} suffix="min" />
          </SettingRow>
        </div>
      ),
    },
    {
      id: "privacy",
      title: "Window & privacy",
      content: (
        <div className="space-y-1">
          <SettingRow icon={<PanelTopClose className="h-4 w-4" />} title="Close to tray" desc="Keep tracking in the background when you close the window.">
            <SpringToggle checked={settings ? settings.close_to_tray !== "false" : true} onChange={(v) => setVal("close_to_tray", v ? "true" : "false")} />
          </SettingRow>
          <SettingRow icon={<Wifi className="h-4 w-4" />} title="Online metadata" desc="Enables Steam covers, genres & tags, suggested games, and HLTB on CSV import.">
            <SpringToggle checked={bool("online_metadata_enabled")} onChange={(v) => setVal("online_metadata_enabled", v ? "true" : "false")} />
          </SettingRow>
          <SettingRow icon={<Music2 className="h-4 w-4" />} title="Theme music" desc="Play each game's soundtrack on its detail page, streamed from YouTube. No API key needed.">
            <SpringToggle checked={settings ? settings.theme_music_enabled !== "false" : true} onChange={(v) => setVal("theme_music_enabled", v ? "true" : "false")} />
          </SettingRow>
          <SettingRow icon={<ImageDown className="h-4 w-4" />} title="Cover art" desc="Local-first. Fetch on demand from Library, or drag-drop your own.">
            <span className="text-xs text-ink-faint">On demand</span>
          </SettingRow>
          <MetacriticBackfill />
          <ContentAuditPanel />
        </div>
      ),
    },
    {
      id: "launchers",
      title: "Launcher sync",
      subtitle: "Steam, GOG, and local installs from Epic · Riot · Ubisoft · Rockstar",
      content: (
        <LauncherSyncSection />
      ),
    },
    {
      id: "data",
      title: "Data",
      content: (
        <div className="space-y-1">
          <SettingRow icon={<FileSpreadsheet className="h-4 w-4" />} title="Import games (CSV)" desc="Completed games list. Missing playtime columns are filled from HowLongToBeat (Main+Extra).">
            <button onClick={importCsv} className="btn btn-subtle h-9">
              Import
            </button>
          </SettingRow>
          <SettingRow icon={<DatabaseBackup className="h-4 w-4" />} title="Backup database" desc="Save a complete snapshot of your data.">
            <button onClick={backup} className="btn btn-subtle h-9">
              Backup
            </button>
          </SettingRow>
          <SettingRow icon={<Upload className="h-4 w-4" />} title="Restore database" desc="Replace all data from a backup (restarts the app).">
            <button onClick={restore} className="btn btn-ghost h-9 text-amber hover:text-amber">
              Restore
            </button>
          </SettingRow>
          <SettingRow icon={<Download className="h-4 w-4" />} title="Export sessions (CSV)" desc="Download your session history as a spreadsheet.">
            <button onClick={exportCsv} className="btn btn-subtle h-9" disabled={!isTauri()}>
              Export
            </button>
          </SettingRow>
          <SettingRow icon={<FileJson className="h-4 w-4" />} title="Export all data (JSON)" desc="Games + sessions for backup or migration.">
            <button onClick={exportJson} className="btn btn-subtle h-9" disabled={!isTauri()}>
              Export
            </button>
          </SettingRow>
        </div>
      ),
    },
    {
      id: "updates",
      title: "Updates",
      subtitle: "The app updates itself silently — check manually anytime",
      content: (
        <div className="space-y-1">
          <SettingRow icon={<RefreshCw className="h-4 w-4" />} title="Check for updates" desc="Looks for a newer signed release on GitHub. Installs automatically and restarts.">
            <button onClick={checkUpdates} className="btn btn-subtle h-9 min-w-[7rem]" disabled={!isTauri() || checkingUpdate}>
              {checkingUpdate ? "Checking…" : "Check now"}
            </button>
          </SettingRow>
          <SettingRow icon={<Sparkles className="h-4 w-4" />} title="Version" desc="The build of Tracker currently installed.">
            <span className="text-ink-soft text-sm tabular-nums">{appVersion ? `v${appVersion}` : "—"}</span>
          </SettingRow>
        </div>
      ),
    },
  ];

  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set(sections.map((s) => s.id)));

  const toggleSection = (id: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Page title="Settings" subtitle="Tune the look, the tracking, and your data">
      <div className="mx-auto max-w-3xl space-y-4">
        {sections.map((section, i) => (
          <motion.div
            key={section.id}
            initial={enabled ? { opacity: 0, y: 10 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            <Panel panelKey={`settings.${section.id}`} games={games ?? []} className="overflow-hidden p-0">
              <button
                type="button"
                onClick={() => toggleSection(section.id)}
                className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition hover:bg-white/[0.02]"
              >
                <SectionTitle title={section.title} subtitle={section.subtitle} />
                <motion.span animate={{ rotate: openSections.has(section.id) ? 180 : 0 }} transition={{ type: "spring", stiffness: 400, damping: 28 }}>
                  <ChevronDown className="h-4 w-4 text-ink-dim" />
                </motion.span>
              </button>
              <AnimatePresence initial={false}>
                {openSections.has(section.id) && (
                  <motion.div
                    initial={enabled ? { height: 0, opacity: 0 } : false}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={enabled ? { height: 0, opacity: 0 } : undefined}
                    transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="border-t border-line px-3 pb-4 pt-1">{section.content}</div>
                  </motion.div>
                )}
              </AnimatePresence>
            </Panel>
          </motion.div>
        ))}

        <motion.div
          initial={enabled ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="flex items-center gap-3 px-1 py-2 text-sm text-ink-dim"
        >
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent-sheen shadow-glow">
            <Gamepad2 className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="font-display font-800 text-ink">
              Tracker <span className="accent-text">{appVersion || APP_VERSION}</span>
            </div>
            <div className="text-xs">Local-first game playtime analytics · Tauri 2 · React 19 · Motion 12 · Tailwind 4</div>
          </div>
        </motion.div>
      </div>
    </Page>
  );
}

function SpringToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-center" aria-pressed={checked}>
      <span
        className={`relative h-6 w-11 rounded-full border transition-colors ${checked ? "border-transparent" : "border-line bg-white/10"}`}
        style={checked ? { backgroundImage: "linear-gradient(120deg,var(--accent-1),var(--accent-3))" } : undefined}
      >
        <motion.span
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow"
          animate={{ left: checked ? 22 : 2, scale: checked ? 1.02 : 1 }}
          transition={{ type: "spring", stiffness: 520, damping: 32 }}
        />
      </span>
    </button>
  );
}

function SettingRow({ icon, title, desc, children }: { icon: React.ReactNode; title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 rounded-xl px-2 py-3 transition hover:bg-white/[0.02]">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-ink-soft">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-700">{title}</div>
        <div className="text-xs text-ink-dim">{desc}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function CustomAccentRow({ value, active, onChange }: { value: CustomAccent; active: boolean; onChange: (next: CustomAccent) => void }) {
  const set = (i: number, c: string) => {
    const n = [...value] as CustomAccent;
    n[i] = c;
    onChange(n);
  };
  const labels = ["Start", "Mid", "End"];
  return (
    <div className={`rounded-xl px-2 py-3 transition ${active ? "bg-white/[0.03] ring-1 ring-inset ring-accent-3/30" : "hover:bg-white/[0.02]"}`}>
      <div className="flex items-center gap-4">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-ink-soft">
          <Palette className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-700">Custom accent {active && <span className="ml-1 text-[10px] font-700 uppercase tracking-wider text-accent-3">active</span>}</div>
          <div className="text-xs text-ink-dim">Craft your own three-stop gradient — applied when “Custom” is selected.</div>
        </div>
        <div className="flex shrink-0 items-end gap-2">
          {[0, 1, 2].map((i) => (
            <label key={i} className="flex cursor-pointer flex-col items-center gap-1">
              <span className="relative h-9 w-9 overflow-hidden rounded-lg border border-line shadow-card transition hover:scale-105">
                <span className="absolute inset-0" style={{ background: value[i] }} />
                <input type="color" value={value[i]} onChange={(e) => set(i, e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
              </span>
              <span className="text-[9px] font-700 uppercase tracking-wide text-ink-faint">{labels[i]}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="mt-3 h-2 w-full rounded-full" style={{ background: `linear-gradient(90deg, ${value[0]}, ${value[1]} 50%, ${value[2]})` }} />
    </div>
  );
}

function NumberInput({ value, onCommit, suffix }: { value: string; onCommit: (v: string) => void; suffix?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="flex items-center gap-2">
      <input className="input w-20 text-center" inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ""))} onBlur={() => v && onCommit(v)} />
      {suffix && <span className="text-xs text-ink-dim">{suffix}</span>}
    </div>
  );
}
