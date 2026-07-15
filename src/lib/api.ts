import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc, type Channel } from "@tauri-apps/api/core";
import { mockInvoke } from "./mock";
import { isTauri } from "./tauri";
import { isCompanion, remoteMediaUrl } from "./remoteClient";

function isPcOnlyCommand(cmd: string): boolean {
  const pcOnly = [
    "complete_onboarding",
    "check_for_updates",
    "install_update",
    "add_from_path",
    "add_app_from_path",
    "detect_games",
    "detect_apps",
    "import_detected",
    "import_detected_apps",
    "import_games_csv",
    "audit_online_content",
    "repair_library_content",
    "backup_db",
    "restore_db",
    "steam_login",
    "steam_logout",
    "steam_validate",
    "steam_library",
    "steam_import",
    "steam_sync",
    "gog_login_url",
    "gog_login_finish",
    "gog_login",
    "gog_logout",
    "gog_validate",
    "gog_library",
    "gog_import",
    "gog_sync",
    "local_launcher_library",
    "local_launcher_import",
    "remote_status",
    "remote_set_enabled",
    "remote_set_show_uac",
    "remote_regen_pin",
    "remote_set_cloud",
    "remote_regen_code"
  ];
  return pcOnly.includes(cmd);
}

function mapCommandToPath(cmd: string, args?: Record<string, unknown>): string {
  switch (cmd) {
    case "get_settings": return "/api/settings";
    case "list_games": return "/api/games";
    case "get_game": return `/api/games/${args?.id}`;
    case "list_sessions": {
      const f = args?.filter as any;
      const q = new URLSearchParams();
      if (f?.kind) q.append("kind", f.kind);
      if (f?.limit) q.append("limit", String(f.limit));
      return `/api/sessions?${q.toString()}`;
    }
    case "dashboard": return "/api/dashboard";
    case "apps_overview": return "/api/apps";
    case "heatmap": {
      const q = new URLSearchParams();
      if (args?.days) q.append("days", String(args.days));
      if (args?.kind) q.append("kind", String(args.kind));
      return `/api/heatmap?${q.toString()}`;
    }
    case "hour_of_day": {
      const q = new URLSearchParams();
      if (args?.kind) q.append("kind", String(args.kind));
      return `/api/hourofday?${q.toString()}`;
    }
    case "catalog_analytics": return "/api/catalog";
    case "insights": {
      const q = new URLSearchParams();
      if (args?.year) q.append("year", String(args.year));
      if (args?.kind) q.append("kind", String(args.kind));
      return `/api/insights?${q.toString()}`;
    }
    case "tag_analytics": return "/api/tags";
    case "list_tags": return "/api/tags/list";
    case "system_specs": return "/api/system/specs";
    case "system_live": return "/api/system/live";
    case "system_history": return `/api/system/history?minutes=${args?.minutes || 60}`;
    case "steam_game_achievements": return `/api/games/${args?.gameId}/achievements/steam?refresh=${args?.refresh || false}`;
    case "steam_achievements_overview": return "/api/games/achievements/steam/overview";
    case "gog_game_achievements": return `/api/games/${args?.gameId}/achievements/gog?refresh=${args?.refresh || false}`;
    case "list_screenshots": return `/api/games/${args?.gameId}/screenshots`;
    case "get_game_stats": return `/api/games/${args?.gameId}/stats`;
    case "media_overview": return "/api/music/overview";
    case "media_heatmap": return `/api/music/heatmap?days=${args?.days || 140}`;
    case "media_hour_of_day": return "/api/music/hourofday";
    case "media_top": return `/api/music/top?limit=${args?.limit || 10}`;
    case "media_insights": return "/api/music/insights";
    case "media_timeline": {
      const q = new URLSearchParams();
      if (args?.fromUtc) q.append("from", String(args.fromUtc));
      if (args?.toUtc) q.append("to", String(args.toUtc));
      return `/api/music/timeline?${q.toString()}`;
    }
    case "media_recent": return `/api/music/recent?limit=${args?.limit || 16}`;
    case "playlists_list": return "/api/playlists";
    case "playlist_get": return `/api/playlists/${args?.id}`;

    // Write commands
    case "set_paused": return "/api/tracking/pause";
    case "launch_game": return `/api/games/${args?.id}/launch`;
    case "set_game_status": return `/api/games/${args?.id}/status`;
    case "save_game": return `/api/games/${(args?.game as any)?.id}/save`;
    case "delete_game": return `/api/games/${args?.id}/delete`;
    case "delete_screenshot": return `/api/screenshots/${args?.id}/delete`;
    case "stop_media_play": return "/api/music/stop";
    case "playlist_create": return "/api/playlists/create";
    case "playlist_rename": return `/api/playlists/${args?.id}/rename`;
    case "playlist_delete": return `/api/playlists/${args?.id}/delete`;
    case "playlist_add_tracks": return `/api/playlists/${args?.id}/add_tracks`;
    case "playlist_remove_track": return `/api/playlists/${args?.id}/remove_track`;
    case "playlist_reorder": return `/api/playlists/${args?.id}/reorder`;

    default:
      throw new Error(`Command ${cmd} is not mapped to an API path.`);
  }
}

function isWriteCommand(cmd: string): boolean {
  const writes = [
    "set_paused",
    "launch_game",
    "set_game_status",
    "save_game",
    "delete_game",
    "delete_screenshot",
    "stop_media_play",
    "playlist_create",
    "playlist_rename",
    "playlist_delete",
    "playlist_add_tracks",
    "playlist_remove_track",
    "playlist_reorder"
  ];
  return writes.includes(cmd);
}

function mapCommandToBody(cmd: string, args?: Record<string, unknown>): any {
  switch (cmd) {
    case "set_paused": return { paused: args?.paused };
    case "set_game_status": return { status: args?.status };
    case "save_game": return { game: args?.game };
    case "playlist_create": return { name: args?.name };
    case "playlist_rename": return { name: args?.name };
    case "playlist_add_tracks": return { tracks: args?.tracks };
    case "playlist_remove_track": return { vid: args?.vid };
    case "playlist_reorder": return { vids: args?.vids };
    default: return undefined;
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isCompanion()) {
    if (isPcOnlyCommand(cmd)) {
      throw new Error(`This command is only available on the PC.`);
    }
    const path = mapCommandToPath(cmd, args);
    const { apiGet, apiPost } = await import("@/companion/link");
    if (isWriteCommand(cmd)) {
      const body = mapCommandToBody(cmd, args);
      return apiPost<T>(path, body);
    }
    return apiGet<T>(path);
  }

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
  /** Full OST track list (up to ~100), scraped from a YouTube playlist when found. */
  themeTrackIds: string[];
  /** Source YouTube playlist id for the full OST, when one was found. */
  themePlaylistId: string | null;
  /** Human-readable YouTube titles keyed by video id (from playlist scrape / oEmbed). */
  themeTrackTitles: Record<string, string>;
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

/** Cached live stats served instantly from the DB, plus when they were fetched. */
export interface CachedGameStats {
  stats: GameStats | null;
  fetchedUtc: string | null;
}

export interface TwitchLive {
  /** Resolved canonical Twitch category name. */
  game: string;
  /** Twitch directory slug (for deep-linking even when nobody is live). */
  slug: string;
  /** Top live channel login, or null when no one is streaming the game. */
  channel: string | null;
  channelName: string | null;
  title: string | null;
  viewers: number;
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

// ---------- Media listening / music ----------

export type MediaType = "music" | "video" | "podcast" | "other";

export interface MediaPlay {
  id: string;
  source: string; // 'smtc' | 'jukebox'
  sourceApp: string | null;
  appName: string | null;
  mediaType: MediaType | string;
  title: string | null;
  artist: string | null;
  album: string | null;
  thumbPath: string | null;
  gameId: string | null;
  vid: string | null;
  startUtc: string;
  endUtc: string | null;
  lastSeenUtc: string;
  playedSeconds: number;
}

/** Live "now listening" event payload (`media://state`). */
export interface MediaState {
  playing: boolean;
  source: string | null;
  app: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  mediaType: string | null;
  thumbPath: string | null;
}

export interface TypeSlice {
  mediaType: string;
  seconds: number;
  count: number;
}

export interface MusicOverview {
  totalSeconds: number;
  todaySeconds: number;
  weekSeconds: number;
  monthSeconds: number;
  playCount: number;
  distinctArtists: number;
  distinctTracks: number;
  distinctAlbums: number;
  distinctApps: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  avgPerActiveDay: number;
  byType: TypeSlice[];
}

export interface MusicEntry {
  key: string;
  label: string;
  secondary: string | null;
  seconds: number;
  count: number;
  art: string | null;
}

export interface MusicTop {
  artists: MusicEntry[];
  tracks: MusicEntry[];
  albums: MusicEntry[];
  apps: MusicEntry[];
}

export interface MusicInsights {
  mostRepeated: MusicEntry | null;
  longestPlaySeconds: number;
  longestPlayLabel: string | null;
  nightOwlSeconds: number;
  peakHour: number;
  newArtistsThisMonth: number;
  gamingWithMusicPct: number;
  busiestDay: DayValue | null;
  firstListenUtc: string | null;
}

export interface ForegroundSpan {
  id: string;
  appKey: string;
  name: string;
  exePath: string | null;
  iconPath: string | null;
  gameId: string | null;
  startUtc: string;
  endUtc: string | null;
  lastSeenUtc: string;
}

// ---------- Playlists ----------

export interface PlaylistTrack {
  vid: string;
  gameId?: string | null;
  title?: string | null;
  artist?: string | null;
  coverPath?: string | null;
  iconPath?: string | null;
  position?: number;
}

export interface Playlist {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  trackCount: number;
  covers: string[];
  tracks: PlaylistTrack[];
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

export interface AppUsagePoint {
  ts: string;
  gameId: string;
  cpu: number;
  ramMb: number;
  gpu: number | null;
}

export interface AppUsageMeta {
  gameId: string;
  name: string;
  kind: string;
  iconPath: string | null;
  coverPath: string | null;
  accentColor: string | null;
}

export interface AppUsageHistory {
  apps: AppUsageMeta[];
  points: AppUsagePoint[];
  hasGpu: boolean;
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
  /** Cached live stats from the DB — instant, no network (renders immediately). */
  getGameStats: (gameId: string) => call<CachedGameStats>("get_game_stats", { gameId }),
  /** Kick off a background refresh; result arrives via the `game://stats` event. */
  refreshGameStats: (gameId: string) => call<void>("refresh_game_stats", { gameId }),
  /** Resolve a single game's full OST now; refetch on the `game://enriched` event. */
  fetchFullOst: (gameId: string) => call<void>("fetch_full_ost", { gameId }),
  /** Backfill full OSTs across the library; returns the count queued, progress via `ost://progress`. */
  buildOstLibrary: () => call<number>("build_ost_library"),
  /** The game's top live Twitch stream right now (keyless); null if offline/unresolved. */
  fetchTwitchLive: (gameName: string) => call<TwitchLive | null>("fetch_twitch_live", { gameName }),
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
  renameTag: (old: string, name: string) => call<void>("rename_tag", { old, new: name }),
  deleteTag: (name: string) => call<void>("delete_tag", { name }),
  mergeTags: (sources: string[], target: string) => call<void>("merge_tags", { sources, target }),
  suggestGames: (refresh = false) => call<SuggestionsResult>("suggest_games", { refresh }),
  addSuggestedGame: (input: AddSuggestionInput) => call<Game>("add_suggested_game", { input }),
  setSuggestedExcludedTags: (tags: string[]) =>
    call<void>("set_suggested_excluded_tags", { tags }),

  trackingState: () => call<TrackingState>("tracking_state"),
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),

  systemSpecs: () => call<SystemSpecs>("system_specs"),
  systemLive: () => call<SystemLive>("system_live"),
  systemHistory: (minutes: number) => call<SystemHistory>("system_history", { minutes }),
  systemAppHistory: (minutes: number) => call<AppUsageHistory>("system_app_history", { minutes }),

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

  // media listening / music
  mediaOverview: () => call<MusicOverview>("media_overview"),
  mediaHeatmap: (days?: number) => call<DayValue[]>("media_heatmap", { days }),
  mediaHourOfDay: () => call<number[]>("media_hour_of_day"),
  mediaTop: (limit?: number) => call<MusicTop>("media_top", { limit }),
  mediaInsights: () => call<MusicInsights>("media_insights"),
  mediaTimeline: (fromUtc?: string | null, toUtc?: string | null) =>
    call<MediaPlay[]>("media_timeline", { fromUtc: fromUtc ?? null, toUtc: toUtc ?? null }),
  mediaRecent: (limit?: number) => call<MediaPlay[]>("media_recent", { limit }),
  recordMediaPlay: (track: { vid: string; title?: string | null; artist?: string | null; gameId?: string | null; coverPath?: string | null }) =>
    call<void>("record_media_play", { track }),
  stopMediaPlay: () => call<void>("stop_media_play"),
  foregroundSpans: (fromUtc?: string | null, toUtc?: string | null) =>
    call<ForegroundSpan[]>("foreground_spans", { fromUtc: fromUtc ?? null, toUtc: toUtc ?? null }),

  // playlists
  playlistsList: () => call<Playlist[]>("playlists_list"),
  playlistGet: (id: string) => call<Playlist | null>("playlist_get", { id }),
  playlistCreate: (name: string) => call<string>("playlist_create", { name }),
  playlistRename: (id: string, name: string) => call<void>("playlist_rename", { id, name }),
  playlistDelete: (id: string) => call<void>("playlist_delete", { id }),
  playlistAddTracks: (id: string, tracks: PlaylistTrack[]) =>
    call<void>("playlist_add_tracks", { id, tracks }),
  playlistRemoveTrack: (id: string, vid: string) =>
    call<void>("playlist_remove_track", { id, vid }),
  playlistReorder: (id: string, vids: string[]) => call<void>("playlist_reorder", { id, vids }),

  // metacritic
  backfillMetacritic: () => call<number>("backfill_metacritic"),

  // remote access (companion phone app)
  remoteStatus: () => call<RemoteStatus>("remote_status"),
  remoteSetEnabled: (enabled: boolean) => call<RemoteStatus>("remote_set_enabled", { enabled }),
  remoteSetShowUac: (enabled: boolean) => call<RemoteStatus>("remote_set_show_uac", { enabled }),
  remoteRegenPin: () => call<RemoteStatus>("remote_regen_pin"),
  remoteSetCloud: (enabled: boolean, signalUrl: string) =>
    call<RemoteStatus>("remote_set_cloud", { enabled, signalUrl }),
  remoteRegenCode: () => call<RemoteStatus>("remote_regen_code"),
  remoteRegenSecret: () => call<RemoteStatus>("remote_regen_secret"),
  // Per-device access grants (permanent trust + temporary timed grants).
  remoteListGrants: () => call<RemoteGrants>("remote_list_grants"),
  remoteGrant: (deviceId: string, name: string, kind: "permanent" | "temporary", durationSecs?: number) =>
    call<RemoteGrants>("remote_grant", { deviceId, name, kind, durationSecs }),
  remoteRevoke: (deviceId: string) => call<RemoteGrants>("remote_revoke", { deviceId }),
  remoteCheckAuth: (deviceId: string, name?: string, secret?: string) =>
    call<"secret" | "permanent" | "temporary" | "none">("remote_check_auth", { deviceId, name, secret }),
  // USB direct-install via adb.
  remoteAdbDevices: () => call<string[]>("remote_adb_devices"),
  remoteAdbInstall: () => call<string>("remote_adb_install"),
  remoteGrabFrame: (maxW?: number, quality?: number) =>
    call<string | null>("remote_grab_frame", { maxW, quality }),
  remoteGrabDelta: (maxW?: number, quality?: number, key?: boolean) =>
    call<string | null>("remote_grab_delta", { maxW, quality, key }),
  // Streaming capture for the cloud WebRTC video-track path (frames arrive as
  // ArrayBuffer JPEGs over the channel; no per-frame invoke round-trip).
  remoteStartCapture: (onFrame: Channel<ArrayBuffer>, maxW: number, fps: number, quality: number) =>
    call<void>("remote_start_capture", { onFrame, maxW, fps, quality }),
  remoteStartAuxCapture: (
    monitor: number,
    onFrame: Channel<ArrayBuffer>,
    maxW: number,
    fps: number,
    quality: number,
  ) => call<void>("remote_start_aux_capture", { monitor, onFrame, maxW, fps, quality }),
  // `bitrateKbps` drives the NATIVE H.264 encoder (0/omitted = derive from
  // resolution × fps × quality). It does nothing on the JPEG fallback.
  remoteSetCaptureQuality: (
    maxW: number,
    fps: number,
    quality: number,
    content?: number,
    bitrateKbps?: number,
  ) => call<void>("remote_set_capture_quality", { maxW, fps, quality, content, bitrateKbps }),
  /// Ask the native encoder for a keyframe (infinite GOP, so a fresh decoder needs one).
  remoteRequestKeyframe: () => call<void>("remote_request_keyframe"),
  /// Allow native H.264 frames. Only DIRECT guests can take them — the RTC track path
  /// needs pixels for its canvas, so this must be false whenever DIRECT isn't up.
  /// Resolves true when this host actually has a native (NVENC) encoder.
  remoteSetCaptureNative: (on: boolean) => call<boolean>("remote_set_capture_native", { on }),
  remoteStopCapture: () => call<void>("remote_stop_capture"),
  remoteStopAuxCapture: (monitor?: number) => call<void>("remote_stop_aux_capture", { monitor }),
  // Desktop-audio (WASAPI loopback) for the WebRTC audio track. PCM float32 frames
  // arrive as ArrayBuffers; returns the mix format to decode them with.
  remoteStartAudio: (onPcm: Channel<ArrayBuffer>) =>
    call<RemoteAudioFormat | null>("remote_start_audio", { onPcm }),
  remoteStopAudio: () => call<void>("remote_stop_audio"),
  remoteTextfieldActive: () => call<boolean>("remote_textfield_active"),
  remoteCursorKind: () => call<string>("remote_cursor_kind"),
  remoteCaptureStats: () => call<RemoteCaptureStats>("remote_capture_stats"),
  remoteListMonitors: () => call<RemoteMonitor[]>("remote_list_monitors"),
  remoteReadMedia: (path: string) => call<string | null>("remote_read_media", { path }),
  remoteInject: (event: Record<string, unknown>) => call<void>("remote_inject", { event }),
  remoteInjectOn: (monitor: number, event: Record<string, unknown>) =>
    call<void>("remote_inject_on", { monitor, event }),
  remoteGamepadAvailable: () => call<boolean>("remote_gamepad_available"),
};

export interface RemoteMonitor {
  index: number;
  name: string;
  width: number;
  height: number;
  isPrimary: boolean;
  /** The display the host is currently capturing (persists across connections). */
  selected: boolean;
}

/** Desktop-audio loopback PCM format (see remote_start_audio). */
export interface RemoteAudioFormat {
  sampleRate: number;
  channels: number;
}

/** Host capture-pipeline telemetry (see remote_capture_stats). */
export interface RemoteCaptureStats {
  captureMs: number;
  scaleMs: number;
  encodeMs: number;
  frameBytes: number;
  nativeW: number;
  nativeH: number;
  outW: number;
  outH: number;
  producedFrames: number;
  maxW: number;
  fps: number;
  quality: number;
  /** Content-optimization mode: 0 auto / 1 text / 2 video. */
  content: number;
  running: boolean;
  /**
   * True when frames are leaving as NVENC H.264 rather than JPEG. When set,
   * `encodeMs` is real NVENC time and `frameBytes` is the H.264 frame (~30KB) rather
   * than a JPEG (~334KB).
   */
  native: boolean;
}

export interface RemoteStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  pin: string;
  host: string | null;
  clients: number;
  cloudEnabled: boolean;
  signalUrl: string;
  code: string;
  /** Secret "permanent key" (code 2), revealed behind the eye toggle. */
  secretCode: string;
  /** AnyDesk-style UAC handling — UAC secure desktop disabled so admin prompts
   * are visible/controllable from the phone (opt-in, restored on disable/exit). */
  showUac: boolean;
}

export interface TrustedDevice {
  id: string;
  name: string;
  addedUtc: string;
}

export interface TempGrant {
  id: string;
  name: string;
  expiresUtc: string;
}

export interface RemoteGrants {
  trusted: TrustedDevice[];
  temporary: TempGrant[];
}

/** Convert a stored absolute file path to a webview-loadable asset URL. */
export function assetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (isCompanion()) {
    return remoteMediaUrl(path);
  }
  try {
    return convertFileSrc(path);
  } catch {
    return null;
  }
}
