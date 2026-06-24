import { api, Game, ImportSummary } from "./api";
import { useProgress, scheduleDismiss } from "@/store/progress";
import type { Toast } from "@/store/app";

type ToastFn = (t: Omit<Toast, "id">) => void;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runCsvImport(path: string, refresh: () => void, pushToast: ToastFn): Promise<ImportSummary> {
  const prog = useProgress.getState();
  if (prog.isKindBusy("csv-import")) {
    throw new Error("CSV import already running");
  }
  const id = prog.startJob({ kind: "csv-import", label: "Importing CSV", total: 0, detail: "Reading file…" });
  try {
    const summary = await api.importGamesCsv(path, id);
    prog.patchJob(id, { done: prog.getJob("csv-import")?.total || summary.imported + summary.skippedDuplicates, total: summary.imported + summary.skippedDuplicates || 1 });
    prog.finishJob(id);
    scheduleDismiss(id);
    refresh();
    pushToast({
      kind: "success",
      title: summary.imported > 0 ? `Imported ${summary.imported} games` : "CSV import complete",
      message:
        [
          summary.skippedDuplicates > 0 ? `Updated ${summary.skippedDuplicates} existing` : null,
          summary.hltbFetched > 0 ? `HLTB for ${summary.hltbFetched} games` : null,
          summary.warnings.length ? `${summary.warnings.length} warnings` : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined,
    });
    return summary;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    prog.finishJob(id, false, msg);
    scheduleDismiss(id, 8000);
    throw e;
  }
}

export async function runBulkCovers(games: Game[], refresh: () => void, pushToast: ToastFn) {
  const prog = useProgress.getState();
  if (prog.isKindBusy("covers")) return;
  const targets = games.filter((g) => g.kind !== "app" && !g.coverPath);
  if (targets.length === 0) {
    pushToast({ kind: "info", title: "Every game already has a cover" });
    return;
  }
  const id = prog.startJob({ kind: "covers", label: "Fetching covers", total: targets.length });
  let found = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const g = targets[i];
      prog.patchJob(id, { done: i, detail: g.displayName });
      try {
        if (await api.fetchCover(g.id, g.displayName)) found++;
      } catch {
        /* skip */
      }
      prog.patchJob(id, { done: i + 1 });
      if (i % 6 === 5) refresh();
    }
    prog.finishJob(id);
    scheduleDismiss(id);
    refresh();
    pushToast({ kind: "success", title: `Fetched ${found} covers`, message: `from ${targets.length} games` });
  } catch (e) {
    prog.finishJob(id, false, e instanceof Error ? e.message : String(e));
    scheduleDismiss(id, 8000);
  }
}

export async function runBulkGameInfo(games: Game[], refresh: () => void, pushToast: ToastFn) {
  const prog = useProgress.getState();
  if (prog.isKindBusy("game-info")) return;
  const targets = games.filter((g) => g.kind !== "app");
  if (targets.length === 0) {
    pushToast({ kind: "info", title: "No games in library" });
    return;
  }
  const id = prog.startJob({ kind: "game-info", label: "Fetching game info", total: targets.length });
  let found = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const g = targets[i];
      prog.patchJob(id, { done: i, detail: g.displayName });
      try {
        if (await api.fetchGameInfo(g.id, g.displayName || "Unknown", false)) found++;
      } catch {
        /* skip */
      }
      prog.patchJob(id, { done: i + 1 });
      if (i % 4 === 3) refresh();
      await sleep(400);
    }
    prog.finishJob(id);
    scheduleDismiss(id);
    refresh();
    pushToast({ kind: "success", title: `Updated info for ${found} games`, message: `from ${targets.length} in your library` });
  } catch (e) {
    prog.finishJob(id, false, e instanceof Error ? e.message : String(e));
    scheduleDismiss(id, 8000);
  }
}

export async function runBulkAppImages(apps: Game[], refresh: () => void, pushToast: ToastFn) {
  const prog = useProgress.getState();
  if (prog.isKindBusy("app-images")) return;
  const targets = apps.filter((g) => g.kind === "app" && !g.coverPath);
  if (targets.length === 0) {
    pushToast({ kind: "info", title: "Every app already has a logo or cover" });
    return;
  }
  const id = prog.startJob({ kind: "app-images", label: "Fetching app images", total: targets.length });
  let found = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const g = targets[i];
      prog.patchJob(id, { done: i, detail: g.displayName });
      try {
        if (await api.fetchAppInfo(g.id, g.displayName || "Unknown", true)) found++;
      } catch {
        /* skip */
      }
      prog.patchJob(id, { done: i + 1 });
      if (i % 4 === 3) refresh();
      await sleep(500);
    }
    prog.finishJob(id);
    scheduleDismiss(id);
    refresh();
    pushToast({ kind: "success", title: `Fetched images for ${found} apps`, message: `from ${targets.length} without cover art` });
  } catch (e) {
    prog.finishJob(id, false, e instanceof Error ? e.message : String(e));
    scheduleDismiss(id, 8000);
  }
}

export async function runBulkAppInfo(apps: Game[], refresh: () => void, pushToast: ToastFn) {
  const prog = useProgress.getState();
  if (prog.isKindBusy("app-info")) return;
  const targets = apps.filter((g) => g.kind === "app");
  if (targets.length === 0) {
    pushToast({ kind: "info", title: "No apps in library" });
    return;
  }
  const id = prog.startJob({ kind: "app-info", label: "Fetching app info", total: targets.length });
  let found = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const g = targets[i];
      prog.patchJob(id, { done: i, detail: g.displayName });
      try {
        if (await api.fetchAppInfo(g.id, g.displayName || "Unknown", false)) found++;
      } catch {
        /* skip */
      }
      prog.patchJob(id, { done: i + 1 });
      if (i % 4 === 3) refresh();
      await sleep(500);
    }
    prog.finishJob(id);
    scheduleDismiss(id);
    refresh();
    pushToast({ kind: "success", title: `Updated info for ${found} apps`, message: `from ${targets.length} in your library` });
  } catch (e) {
    prog.finishJob(id, false, e instanceof Error ? e.message : String(e));
    scheduleDismiss(id, 8000);
  }
}

/**
 * One-tap library enrichment: fetch covers, then game info, then HowLongToBeat
 * for every game, in sequence. Each step manages its own progress job + toast.
 */
export async function runEnrichAll(games: Game[], refresh: () => void, pushToast: ToastFn) {
  const prog = useProgress.getState();
  if (prog.isKindBusy("covers") || prog.isKindBusy("game-info") || prog.isKindBusy("hltb")) return;
  await runBulkCovers(games, refresh, pushToast);
  await runBulkGameInfo(games, refresh, pushToast);
  await runBulkHltb(games, refresh, pushToast);
}

export async function runBulkHltb(games: Game[], refresh: () => void, pushToast: ToastFn) {
  const prog = useProgress.getState();
  if (prog.isKindBusy("hltb")) return;
  const targets = games.filter((g) => !g.hltbMainExtraMinutes && g.manualPlaytimeSeconds === 0);
  const list = targets.length > 0 ? targets : games;
  if (list.length === 0) {
    pushToast({ kind: "info", title: "No games to look up" });
    return;
  }
  const id = prog.startJob({
    kind: "hltb",
    label: "HowLongToBeat lookup",
    total: list.length,
    detail: targets.length > 0 ? "Games missing playtime" : "Refreshing all games",
  });
  let found = 0;
  try {
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      prog.patchJob(id, { done: i, detail: g.displayName });
      try {
        if (await api.fetchHltb(g.id, g.displayName || "Unknown", true)) found++;
      } catch {
        /* skip */
      }
      prog.patchJob(id, { done: i + 1 });
      if (i % 3 === 2) refresh();
      await sleep(400);
    }
    prog.finishJob(id);
    scheduleDismiss(id);
    refresh();
    pushToast({
      kind: "success",
      title: `HLTB playtimes for ${found} games`,
      message: found < list.length ? `${list.length - found} had no match` : undefined,
    });
  } catch (e) {
    prog.finishJob(id, false, e instanceof Error ? e.message : String(e));
    scheduleDismiss(id, 8000);
  }
}
