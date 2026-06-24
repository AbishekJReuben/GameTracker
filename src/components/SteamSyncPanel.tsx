import { useEffect, useState } from "react";

import { listen } from "@tauri-apps/api/event";

import { Download, Gamepad2, Loader2, LogOut, RefreshCw } from "lucide-react";

import {

  api,

  type SteamSession,

  type SteamSyncProgress,

  type SteamSyncResult,

  type SteamValidateResult,

} from "@/lib/api";

import { useRefreshAll } from "@/lib/queries";

import { useApp } from "@/store/app";

import { isTauri } from "@/lib/tauri";

import { SteamImportModal } from "./SteamImportModal";



export function SteamSyncPanel() {

  const pushToast = useApp((s) => s.pushToast);

  const refresh = useRefreshAll();

  const [session, setSession] = useState<SteamSession | null>(null);

  const [signingIn, setSigningIn] = useState(false);

  const [syncing, setSyncing] = useState(false);

  const [importOpen, setImportOpen] = useState(false);

  const [progress, setProgress] = useState<SteamSyncProgress | null>(null);



  const loadSession = () => {

    if (!isTauri()) return;

    api.steamSession().then(setSession).catch(() => setSession(null));

  };



  useEffect(() => {

    loadSession();

  }, []);



  useEffect(() => {

    if (!isTauri()) return;

    const unsubs: Array<() => void> = [];

    listen<SteamSyncProgress>("steam://progress", (e) => setProgress(e.payload)).then((u) =>

      unsubs.push(u)

    );

    listen<SteamSyncResult>("steam://complete", (e) => {

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

        title: "Steam sync complete",

        message: parts.length ? `${parts.join(" · ")}${errNote}` : `Up to date${errNote}`,

      });

    }).then((u) => unsubs.push(u));

    listen<string>("steam://error", (e) => {

      setSyncing(false);

      setProgress(null);

      pushToast({ kind: "info", title: "Steam sync failed", message: e.payload });

    }).then((u) => unsubs.push(u));

    return () => unsubs.forEach((u) => u());

  }, [pushToast, refresh]);



  const signIn = async () => {

    if (!isTauri()) return;

    setSigningIn(true);

    try {

      const res: SteamValidateResult = await api.steamLogin();

      setSession({

        linked: true,

        apiConfigured: true,

        steamId: res.steamId,

        personaName: res.personaName,

        avatarUrl: res.avatarUrl,

      });

      pushToast({

        kind: "success",

        title: "Signed in with Steam",

        message: res.personaName

          ? `${res.personaName} · ${res.gameCount} games`

          : `${res.gameCount} games in library`,

      });

    } catch (e) {

      pushToast({ kind: "info", title: "Steam sign-in failed", message: String(e) });

    } finally {

      setSigningIn(false);

    }

  };



  const signOut = async () => {

    if (!isTauri()) return;

    try {

      await api.steamLogout();

      setSession({ linked: false, apiConfigured: session?.apiConfigured ?? false, steamId: null, personaName: null, avatarUrl: null });

      pushToast({ kind: "info", title: "Signed out of Steam" });

    } catch (e) {

      pushToast({ kind: "info", title: "Could not sign out", message: String(e) });

    }

  };



  const sync = async (playtime: boolean, achievements: boolean) => {

    if (!isTauri()) return;

    setSyncing(true);

    setProgress(null);

    try {

      await api.steamSync({ playtime, achievements });

    } catch (e) {

      setSyncing(false);

      pushToast({ kind: "info", title: "Could not start sync", message: String(e) });

    }

  };



  const progressLabel = progress

    ? `${progress.phase} · ${progress.done + 1}/${progress.total} · ${progress.label}`

    : null;



  const linked = session?.linked ?? false;

  const apiReady = session?.apiConfigured ?? false;



  return (

    <div className="space-y-4">

      <p className="text-sm text-ink-dim">

        Sign in with Steam to pick games to import, sync official lifetime playtime, and pull

        achievements. Steam does <span className="text-ink-soft">not</span> provide per-session

        play history — Tracker still records sessions locally when you play. Your Game details

        profile must be <span className="text-ink-soft">Public</span>. Playtime never decreases

        local totals.

      </p>



      {!apiReady && (

        <p className="rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">

          This build has no developer Steam API key — sync is disabled until the app is rebuilt with{" "}

          <code className="text-ink-soft">STEAM_WEB_API_KEY</code> in <code>.env</code>.

        </p>

      )}



      {linked && session ? (

        <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-base-850/60 px-4 py-3">

          {session.avatarUrl ? (

            <img src={session.avatarUrl} alt="" className="h-10 w-10 rounded-full" />

          ) : (

            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-800">

              <Gamepad2 className="h-5 w-5 text-ink-dim" />

            </div>

          )}

          <div className="min-w-0 flex-1">

            <p className="truncate font-600 text-ink">{session.personaName ?? "Steam account"}</p>

            <p className="truncate text-xs text-ink-dim">{session.steamId}</p>

          </div>

          <button

            type="button"

            className="btn btn-ghost h-9 shrink-0"

            disabled={signingIn || syncing}

            onClick={signOut}

          >

            <LogOut className="h-4 w-4" />

            Sign out

          </button>

        </div>

      ) : (

        <button

          type="button"

          className="btn btn-primary h-10 w-full sm:w-auto"

          disabled={!isTauri() || !apiReady || signingIn || syncing}

          onClick={signIn}

        >

          {signingIn ? (

            <Loader2 className="h-4 w-4 animate-spin" />

          ) : (

            <Gamepad2 className="h-4 w-4" />

          )}

          Sign in with Steam

        </button>

      )}



      {progressLabel && (

        <p className="flex items-center gap-2 text-xs text-ink-soft">

          <Loader2 className="h-3.5 w-3.5 animate-spin" />

          {progressLabel}

        </p>

      )}



      <div className="flex flex-wrap gap-2">

        <button

          type="button"

          className="btn btn-primary h-9"

          disabled={!isTauri() || !apiReady || !linked || syncing}

          onClick={() => setImportOpen(true)}

        >

          <Download className="h-4 w-4" />

          Import games

        </button>

        <button

          type="button"

          className="btn btn-ghost h-9"

          disabled={!isTauri() || !apiReady || !linked || syncing}

          onClick={() => sync(true, true)}

        >

          {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}

          Sync playtime & achievements

        </button>

        <button

          type="button"

          className="btn btn-ghost h-9"

          disabled={!isTauri() || !apiReady || !linked || syncing}

          onClick={() => sync(true, false)}

        >

          Playtime only

        </button>

        <button

          type="button"

          className="btn btn-ghost h-9"

          disabled={!isTauri() || !apiReady || !linked || syncing}

          onClick={() => sync(false, true)}

        >

          Achievements only

        </button>

      </div>



      <details className="rounded-lg border border-line bg-white/[0.02] px-3 py-2 text-xs text-ink-dim">

        <summary className="cursor-pointer font-700 text-ink-soft">What else can Steam provide?</summary>

        <ul className="mt-2 list-disc space-y-1 pl-4">

          <li>Lifetime playtime and last-2-weeks playtime (aggregate, not sessions)</li>

          <li>Achievement unlock counts (not individual unlock dates via Web API)</li>

          <li>Store metadata we already fetch: cover, dev, year, tags, trailer, reviews</li>

          <li>Friend lists, inventory, and workshop items need extra APIs and are not synced</li>

        </ul>

      </details>



      <SteamImportModal open={importOpen} onClose={() => setImportOpen(false)} />

    </div>

  );

}

