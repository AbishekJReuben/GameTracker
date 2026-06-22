import type { Game } from "./api";

function completedMs(g: Game): number | null {
  if (!g.completedYear) return null;
  const month = (g.completedMonth ?? 12) - 1;
  const day = g.completedDay ?? 28;
  return new Date(g.completedYear, month, day).getTime();
}

/** Same default ordering as Library (games) and Apps pages. */
export function sortedLibraryEntries(games: Game[], kind: "game" | "app"): Game[] {
  const list = kind === "app" ? games.filter((g) => g.kind === "app") : games.filter((g) => g.kind !== "app");
  if (kind === "app") {
    return [...list].sort(
      (a, b) =>
        b.totalRuntimeSeconds - a.totalRuntimeSeconds ||
        b.totalActiveSeconds - a.totalActiveSeconds ||
        a.displayName.localeCompare(b.displayName)
    );
  }
  return [...list].sort((a, b) => {
    const ca = completedMs(a);
    const cb = completedMs(b);
    if (ca != null && cb != null) return cb - ca;
    if (ca != null) return -1;
    if (cb != null) return 1;
    return new Date(b.lastPlayedUtc ?? b.createdAt).getTime() - new Date(a.lastPlayedUtc ?? a.createdAt).getTime();
  });
}

export function libraryNeighbors(games: Game[], currentId: string, kind: "game" | "app") {
  const sorted = sortedLibraryEntries(games, kind);
  const index = sorted.findIndex((g) => g.id === currentId);
  if (index < 0) {
    return { prev: null as Game | null, next: null as Game | null, index: -1, total: sorted.length };
  }
  return {
    prev: index > 0 ? sorted[index - 1] : null,
    next: index < sorted.length - 1 ? sorted[index + 1] : null,
    index,
    total: sorted.length,
  };
}
