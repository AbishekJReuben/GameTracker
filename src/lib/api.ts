import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { mockInvoke } from "./mock";
import { isTauri } from "./tauri";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    return invoke<T>(cmd, args);
  }
  return mockInvoke<T>(cmd, args);
}

// ---------- Types (mirror the Rust DTOs) ----------

export type GameStatus = "playing" | "completed" | "backlog" | "dropped" | "on_hold" | "watched";
export type EntryKind = "game" | "app";

export interface Game {
  id: string;
  kind: EntryKind;
  displayName: string;
  installFolder: string | null;
  exePaths: string[];
  iconPath: string | null;
  coverPath: string | null;
  status: GameStatus;
  rating: number | null;
  developer: string | null;
  releaseYear: number | null;
  startedYear: number | null;
  startedMonth: number | null;
  startedDay: number | null;
  completedYear: number | null;
  completedMonth: number | null;
  completedDay: number | null;
  metacritic: number | null;
  notes: string | null;
  timeToBeatMinutes: number | null;
  manualPlaytimeSeconds: number;
  hltbMainMinutes: number | null;
  hltbMainExtraMinutes: number | null;
  hltbCompletionistMinutes: number | null;
  accentColor: string | null;
  isEnabled: boolean;
  isTracked: boolean;
  createdAt: string;
  tags: string[];
  screenshots: string[];
  backgroundUrl: string | null;
  website: string | null;
  countBackground: boolean;
  steamAppId: number | null;
  metacriticSlug: string | null;
  infoJson: string | null;
  trailerUrl: string | null;
  themeYoutubeId: string | null;
  themeAudioUrl: string | null;
  steamAchievementsUnlocked: number | null;
  steamAchievementsTotal: number | null;
  steamAchievementsSyncedUtc: string | null;
  gogProductId: number | null;
  gogAchievementsUnlocked: number | null;
  gogAchievementsTotal: number | null;
  gogAchievementsSyncedUtc: string | null;
  trackedRuntimeSeconds: number;
  trackedActiveSeconds: number;
  totalRuntimeSeconds: number;
  totalActiveSeconds: number;
  sessionCount: number;
  lastPlayedUtc: string | null;
  firstPlayedUtc: string | null;
}

export interface GameInput {
  id?: string | null;
  kind?: EntryKind;
  displayName: string;
  installFolder?: string | null;
  exePaths?: string[];
  coverPath?: string | null;
  status?: GameStatus;
  rating?: number | null;
  developer?: string | null;
  releaseYear?: number | null;
  startedYear?: number | null;
  startedMonth?: number | null;
  startedDay?: number | null;
  completedYear?: number | null;
  completedMonth?: number | null;
  completedDay?: number | null;
  metacritic?: number | null;
  notes?: string | null;
  timeToBeatMinutes?: number | null;
  manualPlaytimeSeconds?: number | null;
  accentColor?: string | null;
  tags?: string[];
  countBackground?: boolean;
  steamAppId?: number | null;
}

export interface GameSearchResult {
  name: string;
  steamAppId: number | null;
  coverUrl: string | null;
  source: string;
}

export interface UpdateStatus {
  available: boolean;
  version: string | null;
  currentVersion: string;
}

export interface FocusSpan {
  startUtc: string;
  endUtc?: string | null;
  focused: boolean;
}

export interface ActivitySpan {
  startUtc: string;
  endUtc?: string | null;
  title?: string | null;
  url?: string | null;
}

export interface Screenshot {
  id: string;
  gameId: string;
  sessionId: string | null;
  path: string;
  capturedUtc: string;
}

export interface Session {
  id: string;
  gameId: string;
  gameName: string;
  kind: EntryKind;
  iconPath: string | null;
  coverPath?: string | null;
  accentColor: string | null;
  startUtc: string;
  endUtc: string | null;
  lastSeenUtc: string;
  runtimeSeconds: number;
  activeSeconds: number;
  wasIdleEnded: boolean;
  focusSpans?: FocusSpan[];
  activitySpans?: ActivitySpan[];
}

export interface SessionFilter {
  gameId?: string | null;
  fromUtc?: string | null;
  toUtc?: string | null;
  minSeconds?: number | null;
  excludeIdleEnded?: boolean | null;
  limit?: number | null;
  kind?: EntryKind | null;
}

export interface TopGame {
  id: string;
  name: string;
  iconPath: string | null;
  coverPath?: string | null;
  accentColor: string | null;
  runtimeSeconds: number;
  activeSeconds: number;
  sessionCount: number;
}

export interface DayValue {
  date: string;
  seconds: number;
}

export interface SessionHighlight {
  seconds: number;
  gameId: string;
  gameName: string;
  startUtc: string;
}

export interface Dashboard {
  todayRuntime: number;
  todayActive: number;
  weekRuntime: number;
  weekActive: number;
  monthRuntime: number;
  monthActive: number;
  totalRuntime: number;
  totalActive: number;
  sessionCount: number;
  gamesTotal: number;
  gamesTracked: number;
  gamesCompleted: number;
  gamesBacklog: number;
  gamesPlaying: number;
  gamesDropped: number;
  gamesOnHold: number;
  gamesWatched: number;
  currentStreak: number;
  longestStreak: number;
  uniqueGamesPlayed: number;
  avgSessionRuntime: number;
  avgSessionActive: number;
  focusRatio: number;
  topGames: TopGame[];
  recentSessions: Session[];
  last14: DayValue[];
  weekActivePrev: number;
  weekRuntimePrev: number;
  longestSession: SessionHighlight | null;
}

export interface AppsOverview {
  todayActive: number;
  weekActive: number;
  monthActive: number;
  totalActive: number;
  todayRuntime?: number;
  weekRuntime?: number;
  monthRuntime?: number;
  totalRuntime?: number;
  sessionCount: number;
  appsTotal: number;
  appsTracked: number;
  currentStreak: number;
  longestStreak: number;
  topApps: TopGame[];
  recentSessions: Session[];
  last14: DayValue[];
}

export interface SteamReview {
  author: string;
  text: string;
  votedUp: boolean;
  votesUp: number;
  votesFunny: number;
  playtimeForever: number;
}

export interface MetacriticReview {
  author: string;
  text: string;
  score: number | null;
  date: string | null;
}

export interface ContentProbe {
  key: string;
  label: string;
  status: "available" | "stored" | "missing" | "n/a" | "error" | string;
  detail: string | null;
}

export interface ContentAuditRow {
  gameId: string;
  displayName: string;
  kind: EntryKind;
  probes: ContentProbe[];
}

export interface RepairSummary {
  gameId: string;
  displayName: string;
  fixes: string[];
}

export interface GameStats {
  currentPlayers: number | null;
  peakConcurrent: number | null;
  ownersMin: number | null;
  ownersMax: number | null;
  ownersLabel: string | null;
  priceUsd: number | null;
  revenueEstimateUsd: number | null;
  totalReviews: number | null;
  positiveReviews: number | null;
  positivePct: number | null;
  reviewDesc: string | null;
  avgPlaytimeMinutes: number | null;
  medianPlaytimeMinutes: number | null;
}

export interface Candidate {
  name: string;
  installFolder: string | null;
  exePath: string | null;
  source: string;
}

export interface ImportSummary {
  imported: number;
  skippedDuplicates: number;
  hltbFetched: number;
  warnings: string[];
}

export interface YearStat {
  year: number;
  count: number;
  avgScore: number;
  avgMetacritic: number;
}
export interface StudioStat {
  studio: string;
  count: number;
  avgScore: number;
}
export interface ScorePoint {
  name: string;
  my: number;
  metacritic: number;
  year: number | null;
}
export interface CatalogAnalytics {
  totalCompleted: number;
  avgMyScore: number;
  avgMetacritic: number;
  totalPlaytimeSeconds: number;
  avgTimeToBeatMinutes: number;
  perfectScores: number;
  scoredCount: number;
  backlogCount: number;
  droppedCount: number;
  perYear: YearStat[];
  topStudios: StudioStat[];
  scorePoints: ScorePoint[];
  statusCounts: [string, number][];
}

export interface MonthValue {
  month: string;
  label: string;
  seconds: number;
}

export interface Insights {
  year: number;
  activeSeconds: number;
  runtimeSeconds: number;
  sessionCount: number;
  uniqueGames: number;
  completions: number;
  bestMonth: string;
  bestMonthSeconds: number;
  peakStreak: number;
  topGames: TopGame[];
  monthly: MonthValue[];
}

export interface TagStat {
  tag: string;
  gameCount: number;
  completedCount: number;
  activeSeconds: number;
  avgRating: number;
}

export interface TasteTag {
  tag: string;
  weight: number;
  lovedGames: number;
}

export interface TasteDeveloper {
  name: string;
  weight: number;
}

export interface TasteProfile {
  lovedCount: number;
  dislikedCount: number;
  neutralCount: number;
  topTags: TasteTag[];
  topDevelopers: TasteDeveloper[];
  preferredHours: number | null;
  preferredYear: number | null;
  avgMyScore: number | null;
  avgMetacritic: number | null;
}

export interface GameSuggestion {
  steamAppId: number;
  name: string;
  developer: string | null;
  releaseYear: number | null;
  metacritic: number | null;
  genres: string[];
  shortDescription: string | null;
  coverUrl: string;
  headerImageUrl: string;
  matchScore: number;
  matchPercent: number;
  reasons: string[];
  estimatedHours: number | null;
}

export interface SuggestionsResult {
  generatedAt: string;
  cached: boolean;
  taste: TasteProfile;
  suggestions: GameSuggestion[];
  excludedTags: string[];
}

export interface AddSuggestionInput {
  name: string;
  developer?: string | null;
  releaseYear?: number | null;
  metacritic?: number | null;
  genres?: string[];
  steamAppId?: number | null;
}

export interface TrackingState {
  paused: boolean;
  isIdle: boolean;
  // Game side
  isPlaying: boolean;
  kind: EntryKind | null;
  gameId: string | null;
  gameName: string | null;
  iconPath: string | null;
  coverPath?: string | null;
  accentColor: string | null;
  sessionRuntimeSeconds: number;
  sessionActiveSeconds: number;
  todayRuntimeSeconds: number;
  todayActiveSeconds: number;
  activeCount: number;
  // App side — kept separate so apps and games are never conflated
  appIsActive: boolean;
  appId: string | null;
  appName: string | null;
  appIconPath: string | null;
  appCoverPath?: string | null;
  appAccentColor: string | null;
  appSessionActiveSeconds: number;
  appSessionRuntimeSeconds?: number;
  appTodayActiveSeconds: number;
  appTodayRuntimeSeconds?: number;
  appActiveCount: number;
}

// ---------- System monitor ----------

export interface DiskSpec {
  name: string;
  mount: string;
  kind: string; // "SSD" | "HDD" | "Removable" | "Unknown"
  fs: string;
  totalGb: number;
  usedGb: number;
  availableGb: number;
}

export interface SystemSpecs {
  cpuName: string;
  cpuCores: number;
  cpuThreads: number;
  cpuGhz: number;
  gpuNames: string[];
  gpuVramMb: number | null;
  ramTotalGb: number;
  swapTotalGb: number;
  motherboard: string | null;
  osName: string;
  osVersion: string;
  kernel: string;
  hostname: string;
  uptimeSecs: number;
  bootUtc: string;
  disks: DiskSpec[];
  hasCpuTemp: boolean;
  hasGpuSensors: boolean;
  sidecarPresent: boolean;
}

export interface SystemSample {
  ts: string;
  cpu: number;
  cpuTemp: number | null;
  cpuClockMhz: number | null;
  cpuPowerW: number | null;
  perCore: number[];
  gpu: number | null;
  gpuTemp: number | null;
  gpuClockMhz: number | null;
  gpuPowerW: number | null;
  gpuMemUsedMb: number | null;
  gpuMemTotalMb: number | null;
  ram: number;
  ramUsedGb: number;
  ramTotalGb: number;
  ramTemp: number | null;
  swap: number;
  diskUsage: number;
  disk: number | null;
  diskTemp: number | null;
}

export interface SystemLive {
  specs: SystemSpecs;
  samples: SystemSample[];
}

export interface HistoryPoint {
  ts: string;
  cpu: number;
  cpuTemp: number | null;
  gpu: number | null;
  gpuTemp: number | null;
  ram: number;
  ramTemp: number | null;
  disk: number | null;
}

export interface SystemHistory {
  points: HistoryPoint[];
  sessions: Session[];
}

export type Settings = Record<string, string>;

export interface SteamSession {
  linked: boolean;
  apiConfigured: boolean;
  steamId: string | null;
  personaName: string | null;
  avatarUrl: string | null;
}

export interface SteamValidateResult {
  steamId: string;
  gameCount: number;
  personaName: string | null;
  avatarUrl: string | null;
}

export interface SteamAchievement {
  apiName: string;
  displayName: string;
  description: string;
  iconUrl: string;
  unlocked: boolean;
  hidden: boolean;
  unlockTimeUtc: string | null;
}

export interface AchievementHighlight {
  gameId: string;
  gameName: string;
  apiName: string;
  displayName: string;
  description: string;
  iconUrl: string;
  unlocked: boolean;
  hidden: boolean;
  unlockTimeUtc: string | null;
  kind: string;
}

export interface SteamAchievementsOverview {
  gamesTracked: number;
  totalUnlocked: number;
  totalPossible: number;
  completedGames: number;
  avgPercent: number;
  hiddenUnlocked: number;
  hiddenRemaining: number;
  recentUnlocks30d: number;
  highlights: AchievementHighlight[];
  recentUnlocks: AchievementHighlight[];
}

export interface SteamSyncResult {
  libraryAdded: number;
  libraryUpdated: number;
  playtimeUpdated: number;
  achievementsUpdated: number;
  errors: string[];
}

export interface SteamSyncProgress {
  phase: string;
  done: number;
  total: number;
  label: string;
}

export interface SteamLibraryGame {
  appid: number;
  name: string;
  playtimeForeverMinutes: number;
  playtime2WeeksMinutes: number;
  hasAchievements: boolean;
  imported: boolean;
  trackerGameId: string | null;
  headerImageUrl: string;
}

export interface SteamSyncOptions {
  playtime?: boolean;
  achievements?: boolean;
}

export interface SteamImportOptions {
  appIds: number[];
  playtime?: boolean;
  achievements?: boolean;
}

export interface GogSession {
  linked: boolean;
  userId: string | null;
  username: string | null;
}

export interface GogValidateResult {
  userId: string;
  username: string | null;
  gameCount: number;
}

export interface GogSyncResult {
  libraryAdded: number;
  libraryUpdated: number;
  playtimeUpdated: number;
  achievementsUpdated: number;
  errors: string[];
}

export interface GogSyncProgress {
  phase: string;
  done: number;
  total: number;
  label: string;
}

export interface GogLibraryGame {
  productId: number;
  name: string;
  playtimeMinutes: number;
  hasAchievements: boolean;
  imported: boolean;
  trackerGameId: string | null;
  coverImageUrl: string | null;
}

export interface GogAchievement {
  achievementId: string;
  achievementKey: string;
  name: string;
  description: string;
  imageUrlUnlocked: string | null;
  imageUrlLocked: string | null;
  unlocked: boolean;
  unlockTimeUtc: string | null;
}

export interface LauncherCapability {
  id: string;
  name: string;
  library: string;
  playtime: string;
  achievements: string;
  notes: string;
}

export interface LocalLauncherGame {
  name: string;
  installFolder: string | null;
  exePath: string | null;
  source: string;
  imported: boolean;
  trackerGameId: string | null;
}

// ---------- Command wrappers ----------

export const api = {
  getSettings: () => call<Settings>("get_settings"),
  setSetting: (key: string, value: string) => call<void>("set_setting", { key, value }),
  completeOnboarding: () => call<void>("complete_onboarding"),

  listGames: () => call<Game[]>("list_games"),
  getGame: (id: string) => call<Game | null>("get_game", { id }),
  saveGame: (input: GameInput) => call<Game>("save_game", { input }),
  deleteGame: (id: string) => call<void>("delete_game", { id }),
  setGameStatus: (id: string, status: GameStatus) =>
    call<void>("set_game_status", { id, status }),
  setGameCover: (id: string, source: string) => call<Game>("set_game_cover", { id, source }),
  fetchCover: (id: string, name: string) => call<Game | null>("fetch_cover", { id, name }),
  fetchGameInfo: (id: string, name: string, withCover = false) =>
    call<Game | null>("fetch_game_info", { id, name, withCover }),
  searchGamesOnline: (query: string) =>
    call<GameSearchResult[]>("search_games_online", { query }),
  checkForUpdates: () => call<UpdateStatus>("check_for_updates"),
  installUpdate: () => call<void>("install_update"),
  fetchHltb: (id: string, name: string, applyAsManual = true) =>
    call<Game | null>("fetch_hltb", { id, name, applyAsManual }),
  addFromPath: (path: string) => call<Game>("add_from_path", { path }),
  addAppFromPath: (path: string) => call<Game>("add_app_from_path", { path }),
  fetchAppInfo: (id: string, name: string, withImage = true) =>
    call<Game | null>("fetch_app_info", { id, name, withImage }),

  detectGames: () => call<Candidate[]>("detect_games"),
  detectApps: () => call<Candidate[]>("detect_apps"),
  importDetected: (candidates: Candidate[]) => call<number>("import_detected", { candidates }),
  importDetectedApps: (candidates: Candidate[]) =>
    call<number>("import_detected_apps", { candidates }),
  importGamesCsv: (path: string, jobId?: string) =>
    call<ImportSummary>("import_games_csv", { path, jobId }),
  defaultCsvPath: () => call<string | null>("default_csv_path"),

  listScreenshots: (gameId: string) => call<Screenshot[]>("list_screenshots", { gameId }),
  deleteScreenshot: (id: string) => call<void>("delete_screenshot", { id }),

  listSessions: (filter: SessionFilter = {}) => call<Session[]>("list_sessions", { filter }),
  dashboard: () => call<Dashboard>("dashboard"),
  appsOverview: () => call<AppsOverview>("apps_overview"),
  heatmap: (days: number, kind?: EntryKind) => call<DayValue[]>("heatmap", { days, kind }),
  hourOfDay: (kind?: EntryKind) => call<number[]>("hour_of_day", { kind }),
  catalogAnalytics: () => call<CatalogAnalytics>("catalog_analytics"),
  insights: (year?: number, kind?: EntryKind) => call<Insights>("insights", { year, kind }),
  fetchSteamReviews: (appId: number) => call<SteamReview[]>("fetch_steam_reviews", { appId }),
  fetchMetacriticReviews: (gameId: string, slug?: string | null) =>
    call<MetacriticReview[]>("fetch_metacritic_reviews", { gameId, slug: slug ?? null }),
  auditOnlineContent: () => call<void>("audit_online_content"),
  repairLibraryContent: () => call<void>("repair_library_content"),
  fetchGameStats: (gameId: string) => call<GameStats | null>("fetch_game_stats", { gameId }),
  launchGame: (id: string) => call<void>("launch_game", { id }),
  openEmbed: (label: string, url: string, x: number, y: number, w: number, h: number) =>
    call<void>("open_embed", { label, url, x, y, w, h }),
  setEmbedBounds: (label: string, x: number, y: number, w: number, h: number) =>
    call<void>("set_embed_bounds", { label, x, y, w, h }),
  setEmbedVisible: (label: string, visible: boolean) =>
    call<void>("set_embed_visible", { label, visible }),
  closeEmbed: (label: string) => call<void>("close_embed", { label }),
  tagAnalytics: () => call<TagStat[]>("tag_analytics"),
  listTags: () => call<string[]>("list_tags"),
  suggestGames: (refresh = false) => call<SuggestionsResult>("suggest_games", { refresh }),
  addSuggestedGame: (input: AddSuggestionInput) => call<Game>("add_suggested_game", { input }),
  setSuggestedExcludedTags: (tags: string[]) =>
    call<void>("set_suggested_excluded_tags", { tags }),

  trackingState: () => call<TrackingState>("tracking_state"),
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),

  systemSpecs: () => call<SystemSpecs>("system_specs"),
  systemLive: () => call<SystemLive>("system_live"),
  systemHistory: (minutes: number) => call<SystemHistory>("system_history", { minutes }),

  autostartEnabled: () => call<boolean>("autostart_enabled"),
  setAutostart: (enabled: boolean) => call<void>("set_autostart", { enabled }),

  exportSessionsCsv: (path: string) => call<number>("export_sessions_csv", { path }),
  exportDataJson: (path: string) => call<void>("export_data_json", { path }),
  writeTextFile: (path: string, contents: string) => call<void>("write_text_file", { path, contents }),
  backupDb: (path: string) => call<void>("backup_db", { path }),
  restoreDb: (path: string) => call<void>("restore_db", { path }),

  steamSession: () => call<SteamSession>("steam_session"),
  steamLogin: () => call<SteamValidateResult>("steam_login"),
  steamLogout: () => call<void>("steam_logout"),
  steamValidate: () => call<SteamValidateResult>("steam_validate"),
  steamLibrary: () => call<SteamLibraryGame[]>("steam_library"),
  steamImport: (options: SteamImportOptions) =>
    call<void>("steam_import", {
      appIds: options.appIds,
      playtime: options.playtime ?? true,
      achievements: options.achievements ?? true,
    }),
  steamGameAchievements: (gameId: string, refresh = false) =>
    call<SteamAchievement[]>("steam_game_achievements", { gameId, refresh }),
  steamAchievementsOverview: () => call<SteamAchievementsOverview>("steam_achievements_overview"),
  steamSync: (options: SteamSyncOptions = {}) =>
    call<void>("steam_sync", {
      playtime: options.playtime ?? true,
      achievements: options.achievements ?? true,
    }),

  gogSession: () => call<GogSession>("gog_session"),
  gogLoginUrl: () => call<string>("gog_login_url"),
  gogLoginFinish: (callback: string) =>
    call<GogValidateResult>("gog_login_finish", { callback }),
  gogLogin: () => call<GogValidateResult>("gog_login"),
  gogLogout: () => call<void>("gog_logout"),
  gogValidate: () => call<GogValidateResult>("gog_validate"),
  gogLibrary: () => call<GogLibraryGame[]>("gog_library"),
  gogImport: (productIds: number[]) => call<void>("gog_import", { productIds }),
  gogGameAchievements: (gameId: string, refresh = false) =>
    call<GogAchievement[]>("gog_game_achievements", { gameId, refresh }),
  gogSync: (options: SteamSyncOptions = {}) =>
    call<void>("gog_sync", {
      playtime: options.playtime ?? true,
      achievements: options.achievements ?? true,
    }),

  launcherCapabilities: () => call<LauncherCapability[]>("launcher_capabilities"),
  localLauncherLibrary: (platform: string) =>
    call<LocalLauncherGame[]>("local_launcher_library", { platform }),
  localLauncherImport: (platform: string, names: string[]) =>
    call<[number, number]>("local_launcher_import", { platform, names }),
};

/** Convert a stored absolute file path to a webview-loadable asset URL. */
export function assetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  try {
    return convertFileSrc(path);
  } catch {
    return null;
  }
}
