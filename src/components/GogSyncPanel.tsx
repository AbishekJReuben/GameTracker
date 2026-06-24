import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Download, Loader2, LogOut, RefreshCw } from "lucide-react";
import { api, type GogSession, type GogSyncProgress, type GogSyncResult, type GogValidateResult } from "@/lib/api";
import { useRefreshAll } from "@/lib/queries";
import { useApp } from "@/store/app";
import { isTauri } from "@/lib/tauri";
import { GogImportModal } from "./GogImportModal";
import { GogLoginModal } from "./GogLoginModal";

export function GogSyncPanel() {
  const pushToast = useApp((s) => s.pushToast);
  const refresh = useRefreshAll();
  const [session, setSession] = useState<GogSession | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [progress, setProgress] = useState<GogSyncProgress | null>(null);

  const loadSession = () => {
    if (!isTauri()) return;
    api.gogSession().then(setSession).catch(() => setSession(null));
  };

  useEffect(() => {
    loadSession();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const unsubs: Array<() => void> = [];
    listen<GogSyncProgress>("gog://progress", (e) => setProgress(e.payload)).then((u) => unsubs.push(u));
    listen<GogSyncResult>("gog://complete", (e) => {
      const r = e.payload;
      setSyncing(false);
      setProgress(null);
      refresh();
      loadSession();
      const errNote = r.errors.length ? ` (${r.errors.length} warnings)` : "";
      const parts = [
        r.libraryAdded > 0 ? `+${r.libraryAdded} imported` : null,
        r.playtimeUpdated > 0 ? `${r.playtimeUpdated} playtimes` : null,
        r.achievementsUpdated > 0 ? `${r.achievementsUpdated} achievements` : null,
      ].filter(Boolean);
      pushToast({
        kind: r.errors.length ? "info" : "success",
        title: "GOG sync complete",
        message: parts.length ? `${parts.join(" · ")}${errNote}` : `Up to date${errNote}`,
      });
    }).then((u) => unsubs.push(u));
    listen<string>("gog://error", (e) => {
      setSyncing(false);
      setProgress(null);
      pushToast({ kind: "info", title: "GOG sync failed", message: e.payload });
    }).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, [pushToast, refresh]);

  const onLoginSuccess = (res: GogValidateResult) => {
    setSession({ linked: true, userId: res.userId, username: res.username });
    pushToast({
      kind: "success",
      title: "Signed in with GOG",
      message: res.username ? `${res.username} · ${res.gameCount} games` : `${res.gameCount} games in library`,
    });
  };

  const signOut = async () => {
    if (!isTauri()) return;
    try {
      await api.gogLogout();
      setSession({ linked: false, userId: null, username: null });
      pushToast({ kind: "info", title: "Signed out of GOG" });
    } catch (e) {
      pushToast({ kind: "info", title: "Could not sign out", message: String(e) });
    }
  };

  const sync = async () => {
    if (!isTauri()) return;
    setSyncing(true);
    setProgress(null);
    try {
      await api.gogSync({ playtime: true, achievements: true });
    } catch (e) {
      setSyncing(false);
      pushToast({ kind: "info", title: "Could not start sync", message: String(e) });
    }
  };

  const progressLabel = progress
    ? `${progress.phase} · ${progress.done + 1}/${progress.total} · ${progress.label}`
    : null;

  const linked = session?.linked ?? false;

  return (
    <div className="space-y-3 rounded-xl border border-white/8 bg-base-900/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-700 text-ink">GOG Galaxy</h3>
        <span className="pill text-xs text-emerald">Online · library · playtime · achievements</span>
      </div>
      <p className="text-sm text-ink-dim">
        Sign in with your GOG account to import owned games, sync Galaxy playtime, and pull GOG
        achievements. Sign-in opens in your browser (GOG&apos;s login page does not load in an
        in-app window). Playtime never decreases local totals.
      </p>

      {linked && session ? (
        <div className="flex items-center gap-3 rounded-lg border border-white/8 bg-base-850/60 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-600 text-ink">{session.username ?? "GOG account"}</p>
            <p className="truncate text-xs text-ink-dim">ID {session.userId}</p>
          </div>
          <button type="button" className="btn btn-ghost h-9" onClick={signOut} disabled={syncing}>
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-primary" onClick={() => setLoginOpen(true)}>
          Sign in with GOG
        </button>
      )}

      {linked && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-subtle h-9" onClick={() => setImportOpen(true)} disabled={syncing}>
            <Download className="h-4 w-4" />
            Import games…
          </button>
          <button type="button" className="btn btn-subtle h-9" onClick={sync} disabled={syncing}>
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sync playtime & achievements
          </button>
        </div>
      )}

      {progressLabel && (
        <p className="text-xs text-ink-dim tabular-nums">{progressLabel}</p>
      )}

      <GogImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      <GogLoginModal open={loginOpen} onClose={() => setLoginOpen(false)} onSuccess={onLoginSuccess} />
    </div>
  );
}
