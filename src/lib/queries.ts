import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, GameInput, GameStatus, SessionFilter, EntryKind } from "./api";

export const keys = {
  settings: ["settings"] as const,
  games: ["games"] as const,
  game: (id: string) => ["game", id] as const,
  screenshots: (id: string) => ["screenshots", id] as const,
  sessions: (f: SessionFilter) => ["sessions", f] as const,
  dashboard: ["dashboard"] as const,
  appsOverview: ["appsOverview"] as const,
  heatmap: (d: number, kind?: EntryKind) => ["heatmap", d, kind ?? "game"] as const,
  hourOfDay: (kind?: EntryKind) => ["hourOfDay", kind ?? "game"] as const,
  catalog: ["catalog"] as const,
  insights: (y: number, kind?: EntryKind) => ["insights", y, kind ?? "game"] as const,
  tags: ["tags"] as const,
  suggestions: ["suggestions"] as const,
  systemSpecs: ["systemSpecs"] as const,
  systemLive: ["systemLive"] as const,
  systemHistory: (m: number) => ["systemHistory", m] as const,
  systemAppHistory: (m: number) => ["systemAppHistory", m] as const,
  steamAchievements: (id: string) => ["steamAchievements", id] as const,
  steamAchievementsOverview: ["steamAchievementsOverview"] as const,
  musicOverview: ["music", "overview"] as const,
  musicHeatmap: (d: number) => ["music", "heatmap", d] as const,
  musicHourOfDay: ["music", "hourOfDay"] as const,
  musicTop: (l: number) => ["music", "top", l] as const,
  musicInsights: ["music", "insights"] as const,
  mediaTimeline: (from?: string | null, to?: string | null) =>
    ["music", "timeline", from ?? null, to ?? null] as const,
  mediaRecent: (l: number) => ["music", "recent", l] as const,
  foregroundSpans: (from?: string | null, to?: string | null) =>
    ["foregroundSpans", from ?? null, to ?? null] as const,
  playlists: ["playlists"] as const,
  playlist: (id: string) => ["playlist", id] as const,
};

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: api.getSettings });
}

export function useGames() {
  return useQuery({ queryKey: keys.games, queryFn: api.listGames });
}

export function useGame(id: string | undefined) {
  return useQuery({
    queryKey: keys.game(id ?? ""),
    queryFn: () => api.getGame(id!),
    enabled: !!id,
  });
}

export function useSteamAchievements(gameId: string | undefined) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: keys.steamAchievements(gameId ?? ""),
    queryFn: () => api.steamGameAchievements(gameId!, false),
    enabled: !!gameId,
    staleTime: 60_000,
  });
  const reload = async () => {
    if (!gameId) return;
    await qc.fetchQuery({
      queryKey: keys.steamAchievements(gameId),
      queryFn: () => api.steamGameAchievements(gameId, true),
    });
  };
  return { ...query, reload };
}

export function useSteamAchievementsOverview() {
  return useQuery({
    queryKey: keys.steamAchievementsOverview,
    queryFn: () => api.steamAchievementsOverview(),
    staleTime: 60_000,
  });
}

export function useSessions(filter: SessionFilter = {}) {
  return useQuery({ queryKey: keys.sessions(filter), queryFn: () => api.listSessions(filter) });
}

export function useScreenshots(id: string | undefined) {
  return useQuery({
    queryKey: keys.screenshots(id ?? ""),
    queryFn: () => api.listScreenshots(id!),
    enabled: !!id,
  });
}

export function useDashboard() {
  return useQuery({ queryKey: keys.dashboard, queryFn: api.dashboard, refetchInterval: 30_000 });
}

export function useAppsOverview() {
  return useQuery({ queryKey: keys.appsOverview, queryFn: api.appsOverview, refetchInterval: 30_000 });
}

export function useHeatmap(days: number, kind: EntryKind = "game") {
  return useQuery({ queryKey: keys.heatmap(days, kind), queryFn: () => api.heatmap(days, kind) });
}

export function useHourOfDay(kind: EntryKind = "game") {
  return useQuery({ queryKey: keys.hourOfDay(kind), queryFn: () => api.hourOfDay(kind) });
}

export function useCatalog() {
  return useQuery({ queryKey: keys.catalog, queryFn: api.catalogAnalytics });
}

export function useInsights(year: number, kind: EntryKind = "game") {
  return useQuery({ queryKey: keys.insights(year, kind), queryFn: () => api.insights(year, kind) });
}

export function useTagAnalytics() {
  return useQuery({ queryKey: keys.tags, queryFn: api.tagAnalytics });
}

export function useSystemSpecs() {
  return useQuery({ queryKey: keys.systemSpecs, queryFn: api.systemSpecs, refetchInterval: 60_000 });
}

export function useSystemLive(enabled = true) {
  return useQuery({
    queryKey: keys.systemLive,
    queryFn: api.systemLive,
    refetchInterval: enabled ? 2_000 : false,
    enabled,
  });
}

export function useSystemHistory(minutes: number, enabled = true) {
  return useQuery({
    queryKey: keys.systemHistory(minutes),
    queryFn: () => api.systemHistory(minutes),
    refetchInterval: enabled ? 4_000 : false,
    enabled,
  });
}

export function useSystemAppHistory(minutes: number, enabled = true) {
  return useQuery({
    queryKey: keys.systemAppHistory(minutes),
    queryFn: () => api.systemAppHistory(minutes),
    refetchInterval: enabled ? 8_000 : false,
    enabled,
  });
}

export function useSuggestions(enabled = true) {
  return useQuery({
    queryKey: keys.suggestions,
    queryFn: () => api.suggestGames(false),
    enabled,
    staleTime: 1000 * 60 * 60,
    retry: false,
  });
}

// ---------- Music / media listening ----------

export function useMusicOverview() {
  return useQuery({ queryKey: keys.musicOverview, queryFn: api.mediaOverview });
}
export function useMusicHeatmap(days: number) {
  return useQuery({ queryKey: keys.musicHeatmap(days), queryFn: () => api.mediaHeatmap(days) });
}
export function useMusicHourOfDay() {
  return useQuery({ queryKey: keys.musicHourOfDay, queryFn: () => api.mediaHourOfDay() });
}
export function useMusicTop(limit = 10) {
  return useQuery({ queryKey: keys.musicTop(limit), queryFn: () => api.mediaTop(limit) });
}
export function useMusicInsights() {
  return useQuery({ queryKey: keys.musicInsights, queryFn: api.mediaInsights });
}
export function useMediaTimeline(fromUtc?: string | null, toUtc?: string | null) {
  return useQuery({
    queryKey: keys.mediaTimeline(fromUtc, toUtc),
    queryFn: () => api.mediaTimeline(fromUtc, toUtc),
  });
}
export function useMediaRecent(limit = 12) {
  return useQuery({ queryKey: keys.mediaRecent(limit), queryFn: () => api.mediaRecent(limit) });
}

export function useForegroundSpans(fromUtc?: string | null, toUtc?: string | null, enabled = true) {
  return useQuery({
    queryKey: keys.foregroundSpans(fromUtc, toUtc),
    queryFn: () => api.foregroundSpans(fromUtc, toUtc),
    enabled,
  });
}

// ---------- Playlists ----------

export function usePlaylists() {
  return useQuery({ queryKey: keys.playlists, queryFn: api.playlistsList });
}
export function usePlaylist(id: string | undefined) {
  return useQuery({
    queryKey: keys.playlist(id ?? ""),
    queryFn: () => api.playlistGet(id!),
    enabled: !!id,
  });
}

export function usePlaylistMutations() {
  const qc = useQueryClient();
  const refresh = (id?: string) => {
    qc.invalidateQueries({ queryKey: keys.playlists });
    if (id) qc.invalidateQueries({ queryKey: keys.playlist(id) });
  };
  return {
    create: useMutation({ mutationFn: (name: string) => api.playlistCreate(name), onSuccess: () => refresh() }),
    rename: useMutation({
      mutationFn: (v: { id: string; name: string }) => api.playlistRename(v.id, v.name),
      onSuccess: (_d, v) => refresh(v.id),
    }),
    remove: useMutation({ mutationFn: (id: string) => api.playlistDelete(id), onSuccess: () => refresh() }),
    addTracks: useMutation({
      mutationFn: (v: { id: string; tracks: import("./api").PlaylistTrack[] }) =>
        api.playlistAddTracks(v.id, v.tracks),
      onSuccess: (_d, v) => refresh(v.id),
    }),
    removeTrack: useMutation({
      mutationFn: (v: { id: string; vid: string }) => api.playlistRemoveTrack(v.id, v.vid),
      onSuccess: (_d, v) => refresh(v.id),
    }),
    reorder: useMutation({
      mutationFn: (v: { id: string; vids: string[] }) => api.playlistReorder(v.id, v.vids),
      onSuccess: (_d, v) => refresh(v.id),
    }),
  };
}

/** Invalidate everything that depends on games/sessions after a mutation. */
export function useRefreshAll() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: keys.games });
    qc.invalidateQueries({ queryKey: keys.dashboard });
    qc.invalidateQueries({ queryKey: keys.appsOverview });
    qc.invalidateQueries({ queryKey: keys.catalog });
    qc.invalidateQueries({ queryKey: ["insights"] });
    qc.invalidateQueries({ queryKey: ["heatmap"] });
    qc.invalidateQueries({ queryKey: ["hourOfDay"] });
    qc.invalidateQueries({ queryKey: keys.tags });
    qc.invalidateQueries({ queryKey: ["sessions"] });
    qc.invalidateQueries({ queryKey: ["heatmap"] });
    qc.invalidateQueries({ queryKey: ["hourOfDay"] });
    qc.invalidateQueries({ queryKey: ["game"] });
    qc.invalidateQueries({ queryKey: ["steamAchievements"] });
    qc.invalidateQueries({ queryKey: keys.steamAchievementsOverview });
  };
}

export function useSaveGame() {
  const refresh = useRefreshAll();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GameInput) => api.saveGame(input),
    onSuccess: (game) => {
      refresh();
      qc.invalidateQueries({ queryKey: keys.game(game.id) });
    },
  });
}

export function useDeleteGame() {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (id: string) => api.deleteGame(id),
    onSuccess: refresh,
  });
}

export function useSetStatus() {
  const refresh = useRefreshAll();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: GameStatus }) =>
      api.setGameStatus(id, status),
    onSuccess: (_d, v) => {
      refresh();
      qc.invalidateQueries({ queryKey: keys.game(v.id) });
    },
  });
}
