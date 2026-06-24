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
  steamAchievements: (id: string) => ["steamAchievements", id] as const,
  steamAchievementsOverview: ["steamAchievementsOverview"] as const,
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

export function useSuggestions(enabled = true) {
  return useQuery({
    queryKey: keys.suggestions,
    queryFn: () => api.suggestGames(false),
    enabled,
    staleTime: 1000 * 60 * 60,
    retry: false,
  });
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
