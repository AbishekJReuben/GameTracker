import type {
  CatalogAnalytics,
  Dashboard,
  DayValue,
  EntryKind,
  Game,
  GameInput,
  GameStatus,
  Insights,
  Session,
  SessionFilter,
  SessionHighlight,
  Settings,
  TagStat,
  TrackingState,
} from "./api";

export { isTauri } from "./tauri";

/* -------------------------------------------------------------------------
   Mock backend — drives the browser preview (npm run dev) when not in Tauri.
   Rich enough to exercise the Gantt timeline, heatmap, dashboard & collection.
   ------------------------------------------------------------------------- */

const nowIso = new Date().toISOString();

interface Seed {
  id: string;
  name: string;
  status: GameStatus;
  rating: number | null;
  metacritic: number | null;
  developer: string | null;
  releaseYear: number | null;
  completedYear: number | null;
  accent: string;
  tags: string[];
  tracked: boolean;
  kind?: EntryKind;
  screenshots?: string[];
}

const SEEDS: Seed[] = [
  { id: "g-hk", name: "Hollow Knight", status: "playing", rating: 96, metacritic: 90, developer: "Team Cherry", releaseYear: 2017, completedYear: null, accent: "#22d3ee", tags: ["Metroidvania", "Action"], tracked: true, screenshots: [
    "https://cdn.cloudflare.steamstatic.com/steam/apps/367520/ss_5d806f1e8a6f4c8b0b8c8e0a9b0a9b0a9b0a9b0a.1920x1080.jpg",
    "https://cdn.cloudflare.steamstatic.com/steam/apps/367520/ss_2.1920x1080.jpg",
    "https://cdn.cloudflare.steamstatic.com/steam/apps/367520/ss_3.1920x1080.jpg",
  ] },
  { id: "g-elden", name: "Elden Ring", status: "playing", rating: 94, metacritic: 96, developer: "FromSoftware", releaseYear: 2022, completedYear: null, accent: "#fbbf24", tags: ["Souls", "RPG"], tracked: true },
  { id: "g-hades", name: "Hades", status: "completed", rating: 92, metacritic: 93, developer: "Supergiant Games", releaseYear: 2020, completedYear: 2021, accent: "#fb5d6a", tags: ["Roguelike", "Action"], tracked: true },
  { id: "g-celeste", name: "Celeste", status: "completed", rating: 100, metacritic: 94, developer: "Maddy Makes Games", releaseYear: 2018, completedYear: 2019, accent: "#f472b6", tags: ["Platformer"], tracked: true },
  { id: "g-stardew", name: "Stardew Valley", status: "playing", rating: 90, metacritic: 89, developer: "ConcernedApe", releaseYear: 2016, completedYear: null, accent: "#34d399", tags: ["Sim", "Cozy"], tracked: true },
  { id: "g-witcher", name: "The Witcher 3", status: "completed", rating: 98, metacritic: 93, developer: "CD Projekt Red", releaseYear: 2015, completedYear: 2020, accent: "#a78bfa", tags: ["RPG", "Open World"], tracked: true },
  { id: "g-doom", name: "DOOM Eternal", status: "completed", rating: 88, metacritic: 88, developer: "id Software", releaseYear: 2020, completedYear: 2022, accent: "#fb923c", tags: ["FPS", "Action"], tracked: true },
  { id: "g-portal", name: "Portal 2", status: "completed", rating: 97, metacritic: 95, developer: "Valve", releaseYear: 2011, completedYear: 2018, accent: "#3b82f6", tags: ["Puzzle"], tracked: true },
  { id: "g-disco", name: "Disco Elysium", status: "completed", rating: 95, metacritic: 91, developer: "ZA/UM", releaseYear: 2019, completedYear: 2023, accent: "#7c5cff", tags: ["RPG", "Story"], tracked: false },
  { id: "g-outer", name: "Outer Wilds", status: "completed", rating: 99, metacritic: 85, developer: "Mobius Digital", releaseYear: 2019, completedYear: 2023, accent: "#60a5fa", tags: ["Exploration", "Mystery"], tracked: false },
  { id: "g-baldur", name: "Baldur's Gate 3", status: "backlog", rating: null, metacritic: 96, developer: "Larian Studios", releaseYear: 2023, completedYear: null, accent: "#34d399", tags: ["RPG"], tracked: false },
  { id: "g-cyber", name: "Cyberpunk 2077", status: "dropped", rating: 70, metacritic: 86, developer: "CD Projekt Red", releaseYear: 2020, completedYear: null, accent: "#fbbf24", tags: ["RPG", "Open World"], tracked: true },
  // Apps / software — tracked the same way, kept distinct via `kind`.
  { id: "a-vscode", name: "Visual Studio Code", status: "playing", rating: null, metacritic: null, developer: "Microsoft", releaseYear: 2015, completedYear: null, accent: "#3b82f6", tags: ["Editor", "Productivity"], tracked: true, kind: "app" },
  { id: "a-figma", name: "Figma", status: "playing", rating: null, metacritic: null, developer: "Figma Inc.", releaseYear: 2016, completedYear: null, accent: "#f472b6", tags: ["Design"], tracked: true, kind: "app" },
  { id: "a-blender", name: "Blender", status: "playing", rating: null, metacritic: null, developer: "Blender Foundation", releaseYear: 1998, completedYear: null, accent: "#fb923c", tags: ["3D", "Creative"], tracked: true, kind: "app" },
];

function makeGame(s: Seed, runtime: number, active: number, sessions: number, last: string | null, first: string | null): Game {
  return {
    id: s.id,
    kind: s.kind ?? "game",
    displayName: s.name,
    installFolder: null,
    exePaths: s.tracked ? [`C:\\Games\\${s.name}\\game.exe`] : [],
    iconPath: null,
    coverPath: null,
    status: s.status,
    rating: s.rating,
    developer: s.developer,
    releaseYear: s.releaseYear,
    startedYear: null,
    startedMonth: null,
    startedDay: null,
    completedYear: s.completedYear,
    completedMonth: null,
    completedDay: null,
    metacritic: s.metacritic,
    notes: null,
    timeToBeatMinutes: null,
    manualPlaytimeSeconds: 0,
    hltbMainMinutes: null,
    hltbMainExtraMinutes: null,
    hltbCompletionistMinutes: null,
    accentColor: s.accent,
    isEnabled: true,
    isTracked: s.tracked,
    createdAt: nowIso,
    tags: s.tags,
    screenshots: s.screenshots ?? [],
    backgroundUrl: null,
    website: null,
    countBackground: true,
    steamAppId: s.id.startsWith("g-hk") ? 367520 : null,
    metacriticSlug: null,
    infoJson: s.kind === "app" ? JSON.stringify({ Developer: s.developer, Released: String(s.releaseYear ?? "") }) : null,
    trailerUrl: s.id.startsWith("g-hk") ? "https://video.akamai.steamstatic.com/store_trailers/256679401/movie_max.mp4" : null,
    themeYoutubeId: s.id.startsWith("g-hk") ? "UWZSi5dkb_Q" : null,
    themeAudioUrl: null,
    steamAchievementsUnlocked: s.id.startsWith("g-hk") ? 42 : null,
    steamAchievementsTotal: s.id.startsWith("g-hk") ? 63 : null,
    steamAchievementsSyncedUtc: s.id.startsWith("g-hk") ? nowIso : null,
    gogProductId: null,
    gogAchievementsUnlocked: null,
    gogAchievementsTotal: null,
    gogAchievementsSyncedUtc: null,
    trackedRuntimeSeconds: runtime,
    trackedActiveSeconds: active,
    totalRuntimeSeconds: runtime,
    totalActiveSeconds: active,
    sessionCount: sessions,
    lastPlayedUtc: last,
    firstPlayedUtc: first,
  };
}

// Deterministic PRNG so previews are stable across reloads.
let _seed = 1337;
function rnd() {
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
}

function buildSessions(): Session[] {
  const out: Session[] = [];
  const trackable = SEEDS.filter((s) => s.tracked);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  // A curated "today" with deliberate overlaps (shows vertical lane stacking).
  const today: [string, number, number][] = [
    // [gameId, startHour, durationHours]
    ["g-hk", 8.5, 2.5],
    ["g-celeste", 10.0, 0.75], // overlaps Hollow Knight
    ["g-stardew", 13.0, 2.0],
    ["g-hades", 14.25, 1.5], // overlaps Stardew
    ["a-vscode", 9.5, 4.0], // work app alongside gaming
    ["a-figma", 12.0, 1.5],
    ["g-elden", 20.0, 3.25],
    ["g-doom", 21.0, 0.6], // overlaps Elden Ring
  ];
  let sid = 1;
  for (const [gid, sh, dh] of today) {
    const seed = SEEDS.find((s) => s.id === gid)!;
    const start = new Date(startOfToday.getTime() + sh * 3600_000);
    if (start.getTime() > Date.now()) continue;
    const end = new Date(Math.min(Date.now(), start.getTime() + dh * 3600_000));
    const runtime = Math.round((end.getTime() - start.getTime()) / 1000);
    out.push({
      id: `s${sid++}`,
      gameId: gid,
      gameName: seed.name,
      kind: seed.kind ?? "game",
      iconPath: null,
      accentColor: seed.accent,
      startUtc: start.toISOString(),
      endUtc: end.toISOString(),
      lastSeenUtc: end.toISOString(),
      runtimeSeconds: runtime,
      activeSeconds: Math.round(runtime * (0.7 + rnd() * 0.25)),
      wasIdleEnded: rnd() > 0.8,
    });
  }

  // Historical sessions across the past ~75 days for heatmap / history / week stats.
  for (let day = 1; day < 75; day++) {
    const base = new Date(startOfToday.getTime() - day * 86_400_000);
    const count = rnd() < 0.28 ? 0 : 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < count; k++) {
      const seed = trackable[Math.floor(rnd() * trackable.length)];
      const sh = 8 + rnd() * 13;
      const dh = 0.4 + rnd() * 2.6;
      const start = new Date(base.getTime() + sh * 3600_000);
      const end = new Date(start.getTime() + dh * 3600_000);
      const runtime = Math.round((end.getTime() - start.getTime()) / 1000);
      out.push({
        id: `s${sid++}`,
        gameId: seed.id,
        gameName: seed.name,
        kind: seed.kind ?? "game",
        iconPath: null,
        accentColor: seed.accent,
        startUtc: start.toISOString(),
        endUtc: end.toISOString(),
        lastSeenUtc: end.toISOString(),
        runtimeSeconds: runtime,
        activeSeconds: Math.round(runtime * (0.65 + rnd() * 0.3)),
        wasIdleEnded: rnd() > 0.85,
      });
    }
  }
  return out.sort((a, b) => new Date(b.startUtc).getTime() - new Date(a.startUtc).getTime());
}

const SESSIONS = buildSessions();

function aggregate(): Game[] {
  return SEEDS.map((s) => {
    const mine = SESSIONS.filter((x) => x.gameId === s.id);
    const runtime = mine.reduce((a, x) => a + x.runtimeSeconds, 0);
    const active = mine.reduce((a, x) => a + x.activeSeconds, 0);
    const times = mine.map((x) => new Date(x.startUtc).getTime());
    return makeGame(
      s,
      runtime,
      active,
      mine.length,
      times.length ? new Date(Math.max(...times)).toISOString() : null,
      times.length ? new Date(Math.min(...times)).toISOString() : null
    );
  });
}

export const MOCK_GAMES: Game[] = aggregate();

const MOCK_SETTINGS: Settings = {
  onboarded: "true",
  tracking_paused: "false",
  close_to_tray: "true",
  notify_sessions: "true",
  idle_minutes: "5",
  min_session_seconds: "30",
  daily_goal_minutes: "90",
  online_metadata_enabled: "false",
};

const liveGame = MOCK_GAMES.find((g) => g.id === "g-elden")!;
const liveApp = MOCK_GAMES.find((g) => g.kind === "app");
const MOCK_TRACKING: TrackingState = {
  paused: false,
  isIdle: false,
  isPlaying: true,
  kind: "game",
  gameId: liveGame.id,
  gameName: liveGame.displayName,
  iconPath: null,
  accentColor: liveGame.accentColor,
  sessionRuntimeSeconds: 4_320,
  sessionActiveSeconds: 3_980,
  todayRuntimeSeconds: 21_600,
  todayActiveSeconds: 18_400,
  activeCount: 1,
  appIsActive: !!liveApp,
  appId: liveApp?.id ?? null,
  appName: liveApp?.displayName ?? null,
  appIconPath: liveApp?.iconPath ?? null,
  appAccentColor: liveApp?.accentColor ?? null,
  appSessionActiveSeconds: 1_860,
  appTodayActiveSeconds: 9_200,
  appActiveCount: liveApp ? 2 : 0,
};

function localDayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function gameSessions() {
  return SESSIONS.filter((s) => s.kind === "game");
}

function appSessions() {
  return SESSIONS.filter((s) => s.kind === "app");
}

function buildHeatmap(days: number, kind: EntryKind = "game"): DayValue[] {
  const list = kind === "app" ? appSessions() : gameSessions();
  const map = new Map<string, number>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    map.set(localDayKey(new Date(today.getTime() - i * 86_400_000)), 0);
  }
  for (const s of list) {
    const k = localDayKey(new Date(s.startUtc));
    if (map.has(k)) map.set(k, map.get(k)! + s.activeSeconds);
  }
  return Array.from(map.entries()).map(([date, seconds]) => ({ date, seconds }));
}

function buildDashboard(): Dashboard {
  const list = gameSessions();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekStart = today.getTime() - 6 * 86_400_000;
  const prevWeekStart = today.getTime() - 13 * 86_400_000;
  const todays = list.filter((s) => new Date(s.startUtc).getTime() >= today.getTime());
  const week = list.filter((s) => new Date(s.startUtc).getTime() >= weekStart);
  const prevWeek = list.filter((s) => {
    const t = new Date(s.startUtc).getTime();
    return t >= prevWeekStart && t < weekStart;
  });
  const byGame = new Map<string, { rt: number; at: number; n: number }>();
  for (const s of list) {
    const e = byGame.get(s.gameId) ?? { rt: 0, at: 0, n: 0 };
    e.rt += s.runtimeSeconds;
    e.at += s.activeSeconds;
    e.n += 1;
    byGame.set(s.gameId, e);
  }
  const topGames = [...byGame.entries()]
    .sort((a, b) => b[1].rt - a[1].rt)
    .slice(0, 5)
    .map(([id, v]) => {
      const g = MOCK_GAMES.find((x) => x.id === id)!;
      return { id, name: g.displayName, iconPath: null, accentColor: g.accentColor, runtimeSeconds: v.rt, activeSeconds: v.at, sessionCount: v.n };
    })
    .filter((g) => MOCK_GAMES.find((x) => x.id === g.id)?.kind === "game");
  const last14: DayValue[] = buildHeatmap(14, "game");
  const totalRuntime = list.reduce((a, s) => a + s.runtimeSeconds, 0);
  const totalActive = list.reduce((a, s) => a + s.activeSeconds, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  const month = list.filter((s) => new Date(s.startUtc).getTime() >= monthStart);
  const longest = [...list].sort((a, b) => b.runtimeSeconds - a.runtimeSeconds)[0];
  const longestSession: SessionHighlight | null = longest
    ? { seconds: longest.runtimeSeconds, gameId: longest.gameId, gameName: longest.gameName, startUtc: longest.startUtc }
    : null;
  return {
    todayRuntime: todays.reduce((a, s) => a + s.runtimeSeconds, 0),
    todayActive: todays.reduce((a, s) => a + s.activeSeconds, 0),
    weekRuntime: week.reduce((a, s) => a + s.runtimeSeconds, 0),
    weekActive: week.reduce((a, s) => a + s.activeSeconds, 0),
    monthRuntime: month.reduce((a, s) => a + s.runtimeSeconds, 0),
    monthActive: month.reduce((a, s) => a + s.activeSeconds, 0),
    totalRuntime,
    totalActive,
    sessionCount: list.length,
    gamesTotal: MOCK_GAMES.filter((g) => g.kind === "game").length,
    gamesTracked: MOCK_GAMES.filter((g) => g.kind === "game" && g.isTracked).length,
    gamesCompleted: MOCK_GAMES.filter((g) => g.kind === "game" && g.status === "completed").length,
    gamesBacklog: MOCK_GAMES.filter((g) => g.kind === "game" && g.status === "backlog").length,
    gamesPlaying: MOCK_GAMES.filter((g) => g.kind === "game" && g.status === "playing").length,
    gamesDropped: MOCK_GAMES.filter((g) => g.kind === "game" && g.status === "dropped").length,
    currentStreak: 4,
    longestStreak: 11,
    uniqueGamesPlayed: new Set(list.map((s) => s.gameId)).size,
    avgSessionRuntime: list.length ? totalRuntime / list.length : 0,
    avgSessionActive: list.length ? totalActive / list.length : 0,
    focusRatio: totalRuntime > 0 ? (totalActive / totalRuntime) * 100 : 0,
    topGames,
    recentSessions: list.slice(0, 6),
    last14,
    weekActivePrev: prevWeek.reduce((a, s) => a + s.activeSeconds, 0),
    weekRuntimePrev: prevWeek.reduce((a, s) => a + s.runtimeSeconds, 0),
    longestSession,
  };
}

function buildAppsOverview() {
  const list = appSessions();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekStart = today.getTime() - 6 * 86_400_000;
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  const todays = list.filter((s) => new Date(s.startUtc).getTime() >= today.getTime());
  const week = list.filter((s) => new Date(s.startUtc).getTime() >= weekStart);
  const month = list.filter((s) => new Date(s.startUtc).getTime() >= monthStart);
  const byApp = new Map<string, { rt: number; at: number; n: number }>();
  for (const s of list) {
    const e = byApp.get(s.gameId) ?? { rt: 0, at: 0, n: 0 };
    e.rt += s.runtimeSeconds;
    e.at += s.activeSeconds;
    e.n += 1;
    byApp.set(s.gameId, e);
  }
  const topApps = [...byApp.entries()]
    .sort((a, b) => b[1].rt - a[1].rt)
    .slice(0, 5)
    .map(([id, v]) => {
      const g = MOCK_GAMES.find((x) => x.id === id)!;
      return { id, name: g.displayName, iconPath: null, accentColor: g.accentColor, runtimeSeconds: v.rt, activeSeconds: v.at, sessionCount: v.n };
    });
  return {
    todayActive: todays.reduce((a, s) => a + s.activeSeconds, 0),
    weekActive: week.reduce((a, s) => a + s.activeSeconds, 0),
    monthActive: month.reduce((a, s) => a + s.activeSeconds, 0),
    totalActive: list.reduce((a, s) => a + s.activeSeconds, 0),
    todayRuntime: todays.reduce((a, s) => a + s.runtimeSeconds, 0),
    weekRuntime: week.reduce((a, s) => a + s.runtimeSeconds, 0),
    monthRuntime: month.reduce((a, s) => a + s.runtimeSeconds, 0),
    totalRuntime: list.reduce((a, s) => a + s.runtimeSeconds, 0),
    sessionCount: list.length,
    appsTotal: MOCK_GAMES.filter((g) => g.kind === "app").length,
    appsTracked: MOCK_GAMES.filter((g) => g.kind === "app" && g.isTracked).length,
    currentStreak: 3,
    longestStreak: 8,
    topApps,
    recentSessions: list.slice(0, 6),
    last14: buildHeatmap(14, "app"),
  };
}

function buildCatalog(): CatalogAnalytics {
  const completed = MOCK_GAMES.filter((g) => g.status === "completed");
  const withScore = completed.filter((g) => g.rating != null);
  const avgMy = withScore.reduce((a, g) => a + (g.rating ?? 0), 0) / Math.max(1, withScore.length);
  const withMeta = completed.filter((g) => g.metacritic != null);
  const avgMeta = withMeta.reduce((a, g) => a + (g.metacritic ?? 0), 0) / Math.max(1, withMeta.length);
  const perYearMap = new Map<number, Game[]>();
  for (const g of completed) {
    if (g.completedYear) {
      if (!perYearMap.has(g.completedYear)) perYearMap.set(g.completedYear, []);
      perYearMap.get(g.completedYear)!.push(g);
    }
  }
  const perYear = [...perYearMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, list]) => ({
      year,
      count: list.length,
      avgScore: list.reduce((a, g) => a + (g.rating ?? 0), 0) / list.length,
      avgMetacritic: list.reduce((a, g) => a + (g.metacritic ?? 0), 0) / list.length,
    }));
  const studioMap = new Map<string, Game[]>();
  for (const g of completed) {
    if (g.developer) {
      if (!studioMap.has(g.developer)) studioMap.set(g.developer, []);
      studioMap.get(g.developer)!.push(g);
    }
  }
  const topStudios = [...studioMap.entries()]
    .map(([studio, list]) => ({ studio, count: list.length, avgScore: list.reduce((a, g) => a + (g.rating ?? 0), 0) / list.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  return {
    totalCompleted: completed.length,
    avgMyScore: Math.round(avgMy * 10) / 10,
    avgMetacritic: Math.round(avgMeta * 10) / 10,
    totalPlaytimeSeconds: completed.reduce((a, g) => a + g.totalActiveSeconds, 0),
    avgTimeToBeatMinutes: 0,
    perfectScores: completed.filter((g) => (g.rating ?? 0) >= 95).length,
    scoredCount: withScore.length,
    backlogCount: MOCK_GAMES.filter((g) => g.status === "backlog").length,
    droppedCount: MOCK_GAMES.filter((g) => g.status === "dropped").length,
    perYear,
    topStudios,
    scorePoints: withScore
      .filter((g) => g.metacritic != null)
      .map((g) => ({ name: g.displayName, my: g.rating!, metacritic: g.metacritic!, year: g.completedYear })),
    statusCounts: [
      ["playing", MOCK_GAMES.filter((g) => g.status === "playing").length],
      ["completed", completed.length],
      ["backlog", MOCK_GAMES.filter((g) => g.status === "backlog").length],
      ["dropped", MOCK_GAMES.filter((g) => g.status === "dropped").length],
    ],
  };
}

function buildSystemSpecs() {
  return {
    cpuName: "AMD Ryzen 9 7950X 16-Core Processor",
    cpuCores: 16,
    cpuThreads: 32,
    cpuGhz: 4.5,
    gpuNames: ["NVIDIA GeForce RTX 4080", "AMD Radeon Graphics"],
    gpuVramMb: 16376,
    ramTotalGb: 32,
    swapTotalGb: 8,
    motherboard: "ASUS ROG STRIX X670E-E",
    osName: "Windows 11 Pro",
    osVersion: "26200",
    kernel: "10.0.26200",
    hostname: "BATTLESTATION",
    uptimeSecs: 5 * 3600 + 23 * 60,
    bootUtc: new Date(Date.now() - (5 * 3600 + 23 * 60) * 1000).toISOString(),
    disks: [
      { name: "Samsung 990 Pro", mount: "C:\\", kind: "SSD", fs: "NTFS", totalGb: 1862, usedGb: 1140, availableGb: 722 },
      { name: "WD Black SN850X", mount: "D:\\", kind: "SSD", fs: "NTFS", totalGb: 3725, usedGb: 2380, availableGb: 1345 },
      { name: "Seagate BarraCuda", mount: "E:\\", kind: "HDD", fs: "NTFS", totalGb: 7452, usedGb: 5100, availableGb: 2352 },
    ],
    hasCpuTemp: true,
    hasGpuSensors: true,
    sidecarPresent: true,
  };
}

// Smooth-ish wandering series so the preview charts feel alive and plausible.
function buildSystemSamples(count: number, stepSec: number) {
  const now = Date.now();
  const out: ReturnType<typeof oneSample>[] = [];
  let cpu = 22, gpu = 30, ram = 48, disk = 6;
  for (let i = count - 1; i >= 0; i--) {
    cpu = clampPct(cpu + (rnd() - 0.5) * 18);
    gpu = clampPct(gpu + (rnd() - 0.5) * 22);
    ram = clampPct(ram + (rnd() - 0.5) * 4);
    disk = clampPct(disk + (rnd() - 0.5) * 24);
    out.push(oneSample(new Date(now - i * stepSec * 1000), cpu, gpu, ram, disk));
  }
  return out;
}

function clampPct(v: number) {
  return Math.max(1, Math.min(99, v));
}

function oneSample(d: Date, cpu: number, gpu: number, ram: number, disk: number) {
  const cpuTemp = Math.round(38 + cpu * 0.42 + rnd() * 4);
  const gpuTemp = Math.round(40 + gpu * 0.4 + rnd() * 3);
  return {
    ts: d.toISOString(),
    cpu: Math.round(cpu),
    cpuTemp,
    cpuClockMhz: Math.round(3600 + cpu * 14),
    cpuPowerW: Math.round(35 + cpu * 1.1),
    perCore: Array.from({ length: 16 }, () => Math.round(clampPct(cpu + (rnd() - 0.5) * 40))),
    gpu: Math.round(gpu),
    gpuTemp,
    gpuClockMhz: Math.round(1800 + gpu * 8),
    gpuPowerW: Math.round(40 + gpu * 2.4),
    gpuMemUsedMb: Math.round(3000 + gpu * 90),
    gpuMemTotalMb: 16376,
    ram: Math.round(ram),
    ramUsedGb: Math.round((ram / 100) * 32 * 10) / 10,
    ramTotalGb: 32,
    ramTemp: Math.round(36 + ram * 0.12 + rnd() * 2),
    swap: Math.round(clampPct(ram - 30)),
    diskUsage: 61,
    disk: Math.round(disk),
    diskTemp: Math.round(34 + disk * 0.1),
  };
}

export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    case "get_settings":
      return MOCK_SETTINGS as T;
    case "set_setting": {
      const { key, value } = args as { key: string; value: string };
      (MOCK_SETTINGS as Record<string, string>)[key] = value;
      return undefined as T;
    }
    case "complete_onboarding":
      return undefined as T;
    case "list_games":
      return [...MOCK_GAMES] as T;
    case "get_game": {
      const id = args?.id as string;
      return (MOCK_GAMES.find((g) => g.id === id) ?? null) as T;
    }
    case "list_screenshots":
      return [] as T;
    case "delete_screenshot":
      return undefined as T;
    case "list_sessions": {
      const f = (args?.filter ?? {}) as SessionFilter;
      let list = [...SESSIONS];
      if (f.gameId) list = list.filter((s) => s.gameId === f.gameId);
      if (f.fromUtc) list = list.filter((s) => new Date(s.startUtc) >= new Date(f.fromUtc!));
      if (f.toUtc) list = list.filter((s) => new Date(s.startUtc) <= new Date(f.toUtc!));
      if (f.minSeconds) list = list.filter((s) => s.runtimeSeconds >= f.minSeconds!);
      if (f.kind) list = list.filter((s) => s.kind === f.kind);
      if (f.excludeIdleEnded) list = list.filter((s) => !s.wasIdleEnded);
      if (f.limit) list = list.slice(0, f.limit);
      return list as T;
    }
    case "dashboard":
      return buildDashboard() as T;
    case "apps_overview":
      return buildAppsOverview() as T;
    case "heatmap":
      return buildHeatmap((args?.days as number) ?? 182, (args?.kind as EntryKind) ?? "game") as T;
    case "hour_of_day": {
      const kind = (args?.kind as EntryKind) ?? "game";
      const list = kind === "app" ? appSessions() : gameSessions();
      const buckets = Array(24).fill(0) as number[];
      for (const s of list) buckets[new Date(s.startUtc).getHours()] += s.activeSeconds;
      return buckets as T;
    }
    case "catalog_analytics":
      return buildCatalog() as T;
    case "insights": {
      const year = (args?.year as number) ?? new Date().getFullYear();
      const kind = (args?.kind as EntryKind) ?? "game";
      const dash = kind === "app" ? buildAppsOverview() : buildDashboard();
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const totalActive = dash.totalActive;
      const monthly = months.map((label, i) => ({
        month: `${year}-${String(i + 1).padStart(2, "0")}`,
        label,
        seconds: Math.round(totalActive * (0.04 + rnd() * 0.12)),
      }));
      const ins: Insights = {
        year,
        activeSeconds: totalActive,
        runtimeSeconds: kind === "app" ? totalActive : (dash as ReturnType<typeof buildDashboard>).totalRuntime,
        sessionCount: dash.sessionCount,
        uniqueGames: kind === "app"
          ? new Set(appSessions().map((s) => s.gameId)).size
          : (dash as ReturnType<typeof buildDashboard>).uniqueGamesPlayed,
        completions: kind === "app" ? 0 : MOCK_GAMES.filter((g) => g.kind === "game" && g.status === "completed" && g.completedYear === year).length,
        bestMonth: "Mar",
        bestMonthSeconds: Math.max(...monthly.map((m) => m.seconds)),
        peakStreak: kind === "app" ? buildAppsOverview().longestStreak : (dash as ReturnType<typeof buildDashboard>).longestStreak,
        topGames: kind === "app" ? buildAppsOverview().topApps : (dash as ReturnType<typeof buildDashboard>).topGames,
        monthly,
      };
      return ins as T;
    }
    case "system_specs":
      return buildSystemSpecs() as T;
    case "system_live":
      return { specs: buildSystemSpecs(), samples: buildSystemSamples(150, 2) } as T;
    case "system_history": {
      const minutes = (args?.minutes as number) ?? 60;
      const stepSec = minutes <= 60 ? 30 : minutes <= 360 ? 120 : 600;
      const count = Math.min(900, Math.floor((minutes * 60) / stepSec));
      const samples = buildSystemSamples(count, stepSec);
      const from = Date.now() - minutes * 60_000;
      const points = samples.map((s) => ({ ts: s.ts, cpu: s.cpu, cpuTemp: s.cpuTemp, gpu: s.gpu, gpuTemp: s.gpuTemp, ram: s.ram, ramTemp: s.ramTemp, disk: s.disk }));
      const sessions = SESSIONS.filter((s) => new Date(s.startUtc).getTime() >= from);
      return { points, sessions } as T;
    }
    case "fetch_steam_reviews":
      return [
        { author: "PreviewUser", text: "Mock review — great game in browser preview mode.", votedUp: true, votesUp: 42, votesFunny: 3, playtimeForever: 7200 },
      ] as T;
    case "fetch_metacritic_reviews":
      return [
        { author: "CriticFan", text: "A tight mock Metacritic blurb for preview mode.", score: 8, date: "Jan 2026" },
        { author: "BacklogHero", text: "Short take: worth your evening.", score: 7, date: "Dec 2025" },
      ] as T;
    case "audit_online_content":
    case "repair_library_content":
      return undefined as T;
    case "write_text_file":
      return undefined as T;
    case "fetch_game_stats":
      return {
        currentPlayers: 4332,
        peakConcurrent: 4912,
        ownersMin: 5_000_000,
        ownersMax: 10_000_000,
        ownersLabel: "5,000,000 – 10,000,000",
        priceUsd: 14.99,
        revenueEstimateUsd: 112_425_000,
        totalReviews: 488781,
        positiveReviews: 474039,
        positivePct: 97,
        reviewDesc: "Overwhelmingly Positive",
        avgPlaytimeMinutes: 1840,
        medianPlaytimeMinutes: 1290,
      } as T;
    case "launch_game":
      return undefined as T;
    case "open_embed":
    case "set_embed_bounds":
    case "set_embed_visible":
    case "close_embed":
      return undefined as T;
    case "tag_analytics": {
      const map = new Map<string, TagStat>();
      for (const g of MOCK_GAMES) {
        for (const tag of g.tags) {
          const e = map.get(tag) ?? { tag, gameCount: 0, completedCount: 0, activeSeconds: 0, avgRating: 0 };
          e.gameCount += 1;
          if (g.status === "completed") e.completedCount += 1;
          e.activeSeconds += g.totalActiveSeconds;
          map.set(tag, e);
        }
      }
      return [...map.values()]
        .map((t) => {
          const rated = MOCK_GAMES.filter((g) => g.tags.includes(t.tag) && g.rating != null);
          return { ...t, avgRating: rated.length ? rated.reduce((a, g) => a + (g.rating ?? 0), 0) / rated.length : 0 };
        })
        .sort((a, b) => b.activeSeconds - a.activeSeconds) as T;
    }
    case "list_tags":
      return [...new Set(MOCK_GAMES.flatMap((g) => g.tags))].sort() as T;
    case "suggest_games":
      return {
        generatedAt: new Date().toISOString(),
        cached: false,
        taste: {
          lovedCount: 4,
          dislikedCount: 1,
          neutralCount: 2,
          topTags: [
            { tag: "Roguelike", weight: 4.2, lovedGames: 2 },
            { tag: "RPG", weight: 3.1, lovedGames: 2 },
          ],
          topDevelopers: [{ name: "Supergiant Games", weight: 3.5 }],
          preferredHours: 18,
          preferredYear: 2020,
          avgMyScore: 92,
          avgMetacritic: 91,
        },
        suggestions: [
          {
            steamAppId: 1145360,
            name: "Hades II",
            developer: "Supergiant Games",
            releaseYear: 2024,
            metacritic: 94,
            genres: ["Action", "Roguelike"],
            shortDescription: "Battle beyond the Underworld using dark sorcery.",
            coverUrl: "https://cdn.cloudflare.steamstatic.com/steam/apps/1145360/library_600x900_2x.jpg",
            headerImageUrl: "https://cdn.cloudflare.steamstatic.com/steam/apps/1145360/header.jpg",
            matchScore: 8.4,
            matchPercent: 88,
            reasons: ["From Supergiant Games, a studio you've enjoyed", "You rated 2 Roguelike games highly"],
            estimatedHours: null,
          },
        ],
        excludedTags: [],
      } as T;
    case "set_suggested_excluded_tags":
      return undefined as T;
    case "add_suggested_game": {
      const input = args?.input as { name: string; developer?: string | null; releaseYear?: number | null; metacritic?: number | null; genres?: string[] };
      const id = `g-sug-${Date.now()}`;
      const g = {
        ...MOCK_GAMES[0],
        id,
        displayName: input.name,
        status: "backlog" as const,
        developer: input.developer ?? null,
        releaseYear: input.releaseYear ?? null,
        metacritic: input.metacritic ?? null,
        tags: input.genres ?? [],
        isTracked: false,
      };
      MOCK_GAMES.push(g);
      return g as T;
    }
    case "tracking_state":
      return MOCK_TRACKING as T;
    case "set_paused":
      return undefined as T;
    case "fetch_cover":
    case "fetch_game_info":
    case "fetch_hltb":
      return null as T;
    case "import_games_csv":
      return { imported: 0, skippedDuplicates: 0, hltbFetched: 0, warnings: [] } as T;
    case "detect_games":
      return [] as T;
    case "detect_apps":
      return [
        { name: "Spotify", installFolder: "C:\\Users\\me\\AppData\\Roaming\\Spotify", exePath: "C:\\Users\\me\\AppData\\Roaming\\Spotify\\Spotify.exe", source: "Running app" },
        { name: "Notion", installFolder: "C:\\Users\\me\\AppData\\Local\\Programs\\Notion", exePath: "C:\\Users\\me\\AppData\\Local\\Programs\\Notion\\Notion.exe", source: "Running app" },
        { name: "Obsidian", installFolder: "C:\\Users\\me\\AppData\\Local\\Obsidian", exePath: "C:\\Users\\me\\AppData\\Local\\Obsidian\\Obsidian.exe", source: "Running app" },
      ] as T;
    case "import_detected_apps":
      return ((args?.candidates as unknown[])?.length ?? 0) as T;
    case "fetch_app_info":
      return null as T;
    case "add_app_from_path": {
      const path = args?.path as string;
      const name = path.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") ?? "App";
      const g = { ...MOCK_GAMES[0], id: `a-${Date.now()}`, kind: "app" as const, displayName: name, status: "playing" as const, tags: [], isTracked: true, exePaths: [path], trackedRuntimeSeconds: 0, trackedActiveSeconds: 0, totalRuntimeSeconds: 0, totalActiveSeconds: 0, sessionCount: 0 };
      MOCK_GAMES.push(g);
      return g as T;
    }
    case "default_csv_path":
      return null as T;
    case "set_game_status": {
      const { id, status } = args as { id: string; status: GameStatus };
      const g = MOCK_GAMES.find((x) => x.id === id);
      if (g) g.status = status;
      return undefined as T;
    }
    case "save_game": {
      const input = args?.input as GameInput;
      const existing = input.id ? MOCK_GAMES.find((g) => g.id === input.id) : undefined;
      if (existing) {
        Object.assign(existing, { displayName: input.displayName, status: input.status ?? existing.status });
        return existing as T;
      }
      const created: Game = {
        id: `game-${MOCK_GAMES.length}`,
        kind: input.kind ?? "game",
        displayName: input.displayName,
        installFolder: input.installFolder ?? null,
        exePaths: input.exePaths ?? [],
        iconPath: null,
        coverPath: input.coverPath ?? null,
        status: input.status ?? "backlog",
        rating: input.rating ?? null,
        developer: input.developer ?? null,
        releaseYear: input.releaseYear ?? null,
        startedYear: input.startedYear ?? null,
        startedMonth: input.startedMonth ?? null,
        startedDay: input.startedDay ?? null,
        completedYear: input.completedYear ?? null,
        completedMonth: input.completedMonth ?? null,
        completedDay: input.completedDay ?? null,
        metacritic: input.metacritic ?? null,
        notes: input.notes ?? null,
        timeToBeatMinutes: input.timeToBeatMinutes ?? null,
        manualPlaytimeSeconds: input.manualPlaytimeSeconds ?? 0,
        hltbMainMinutes: null,
        hltbMainExtraMinutes: null,
        hltbCompletionistMinutes: null,
        accentColor: input.accentColor ?? null,
        isEnabled: true,
        isTracked: (input.exePaths?.length ?? 0) > 0,
        createdAt: nowIso,
        tags: input.tags ?? [],
        screenshots: [],
        backgroundUrl: null,
        website: null,
        countBackground: input.countBackground ?? true,
        steamAppId: null,
        metacriticSlug: null,
        infoJson: null,
        trailerUrl: null,
        themeYoutubeId: null,
        themeAudioUrl: null,
        steamAchievementsUnlocked: null,
        steamAchievementsTotal: null,
        steamAchievementsSyncedUtc: null,
        gogProductId: null,
        gogAchievementsUnlocked: null,
        gogAchievementsTotal: null,
        gogAchievementsSyncedUtc: null,
        trackedRuntimeSeconds: 0,
        trackedActiveSeconds: 0,
        totalRuntimeSeconds: input.manualPlaytimeSeconds ?? 0,
        totalActiveSeconds: input.manualPlaytimeSeconds ?? 0,
        sessionCount: 0,
        lastPlayedUtc: null,
        firstPlayedUtc: null,
      };
      MOCK_GAMES.push(created);
      return created as T;
    }
    case "delete_game":
      return undefined as T;
    case "steam_session":
      return {
        linked: true,
        apiConfigured: true,
        steamId: "76561198000000000",
        personaName: "Mock Player",
        avatarUrl: null,
      } as T;
    case "steam_login":
      return {
        steamId: "76561198000000000",
        gameCount: 42,
        personaName: "Mock Player",
        avatarUrl: null,
      } as T;
    case "steam_logout":
      return undefined as T;
    case "steam_validate":
      return {
        steamId: "76561198000000000",
        gameCount: 42,
        personaName: "Mock Player",
      } as T;
    case "steam_library":
      return [
        {
          appid: 367520,
          name: "Hollow Knight",
          playtimeForeverMinutes: 1200,
          playtime2WeeksMinutes: 45,
          hasAchievements: true,
          imported: true,
          trackerGameId: "g-hk",
          headerImageUrl: "https://cdn.cloudflare.steamstatic.com/steam/apps/367520/header.jpg",
        },
        {
          appid: 1145360,
          name: "Hades II",
          playtimeForeverMinutes: 0,
          playtime2WeeksMinutes: 0,
          hasAchievements: true,
          imported: false,
          trackerGameId: null,
          headerImageUrl: "https://cdn.cloudflare.steamstatic.com/steam/apps/1145360/header.jpg",
        },
      ] as T;
    case "steam_import":
    case "steam_sync":
      return undefined as T;
    case "steam_game_achievements":
      return [
        {
          apiName: "ACH_FIRST_STEPS",
          displayName: "First Steps",
          description: "Complete the tutorial.",
          iconUrl: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/367520/ach1.jpg",
          unlocked: true,
          hidden: false,
          unlockTimeUtc: new Date(Date.now() - 86400000 * 30).toISOString(),
        },
        {
          apiName: "ACH_HIDDEN",
          displayName: "Hidden Achievement",
          description: "",
          iconUrl: "",
          unlocked: false,
          hidden: true,
          unlockTimeUtc: null,
        },
        {
          apiName: "ACH_BOSS",
          displayName: "False Knight",
          description: "Defeat the False Knight.",
          iconUrl: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/367520/ach2.jpg",
          unlocked: false,
          hidden: false,
          unlockTimeUtc: null,
        },
      ] as T;
    case "steam_achievements_overview":
      return {
        gamesTracked: 2,
        totalUnlocked: 42,
        totalPossible: 63,
        completedGames: 0,
        avgPercent: 67,
        hiddenUnlocked: 3,
        hiddenRemaining: 5,
        recentUnlocks30d: 4,
        highlights: [
          {
            gameId: "g-hk",
            gameName: "Hollow Knight",
            apiName: "ACH_FIRST",
            displayName: "First Steps",
            description: "",
            iconUrl: "",
            unlocked: true,
            hidden: false,
            unlockTimeUtc: new Date().toISOString(),
            kind: "recent",
          },
        ],
        recentUnlocks: [],
      } as T;
    case "gog_session":
      return { linked: false, userId: null, username: null } as T;
    case "gog_login_url":
      return "https://auth.gog.com/auth?client_id=mock" as T;
    case "gog_login_finish":
    case "gog_login":
      return { userId: "48628349957132247", username: "Mock Gogger", gameCount: 12 } as T;
    case "gog_logout":
    case "gog_import":
    case "gog_sync":
      return undefined as T;
    case "gog_validate":
      return { userId: "48628349957132247", username: "Mock Gogger", gameCount: 12 } as T;
    case "gog_library":
      return [] as T;
    case "gog_game_achievements":
      return [] as T;
    case "launcher_capabilities":
      return [
        {
          id: "steam",
          name: "Steam",
          library: "online",
          playtime: "online",
          achievements: "online",
          notes: "",
        },
        {
          id: "gog",
          name: "GOG",
          library: "online",
          playtime: "online",
          achievements: "online",
          notes: "",
        },
        {
          id: "epic",
          name: "Epic Games",
          library: "local",
          playtime: "none",
          achievements: "none",
          notes: "Local installs only.",
        },
      ] as T;
    case "local_launcher_library":
      return [] as T;
    case "local_launcher_import":
      return [0, 0] as T;
    default:
      throw new Error(`Mock invoke not implemented: ${cmd}`);
  }
}

export function mockListSessions(_filter: SessionFilter): Session[] {
  return SESSIONS;
}
