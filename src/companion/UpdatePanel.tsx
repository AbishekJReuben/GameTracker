/**
 * Shared Android update UI: used by the top banner panel and Settings.
 * Runs the staged install fallback chain and surfaces clear failure reasons
 * plus Downloads / manual workarounds.
 */

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  FolderDown,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import {
  installUpdateWithFallbacks,
  openDownloadedApk,
  openInstallSettings,
  openReleasePage,
  saveApkToDownloads,
  type InstallOutcome,
  type InstallProgress,
  type UpdateInfo,
} from "./update";

export type UpdatePanelProps = {
  info: UpdateInfo;
  /** Optional current app version for the subtitle. */
  current?: string | null;
  /** When true, render as a full-screen sheet (banner tap). */
  sheet?: boolean;
  onClose?: () => void;
};

export function UpdatePanel({ info, current, sheet, onClose }: UpdatePanelProps) {
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!busy) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ phase: string; received: number; total: number }>("apk-update://progress", (e) => {
          const { phase, received, total } = e.payload;
          if (phase === "installing" || phase === "saving") setPct(100);
          else setPct(total > 0 ? Math.round((received / total) * 100) : null);
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* not in Tauri */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [busy]);

  const runInstall = async () => {
    setBusy(true);
    setPct(null);
    setLocalError(null);
    setOutcome(null);
    setProgress({ step: "installer", message: "Starting update…" });
    try {
      const result = await installUpdateWithFallbacks(info, (p) => {
        setProgress(p);
        if (p.savedPath) setSavedPath(p.savedPath);
      });
      setOutcome(result);
      if (result.status === "manual" && result.savedPath) setSavedPath(result.savedPath);
      if (result.status === "handed-off" && result.method === "downloads" && savedPath == null) {
        /* path may already be in progress */
      }
    } catch (e) {
      setLocalError(e instanceof Error && e.message ? e.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  };

  const saveOnly = async () => {
    setBusy(true);
    setLocalError(null);
    setProgress({ step: "save-downloads", message: "Saving APK to Downloads…" });
    try {
      const path = await saveApkToDownloads(info);
      setSavedPath(path);
      setProgress({
        step: "open-downloads",
        message: `Saved to ${path}. You can open it below or install from Files.`,
        savedPath: path,
      });
      setOutcome({
        status: "manual",
        reason: "APK saved to Downloads for manual install.",
        savedPath: path,
        failures: [],
      });
    } catch (e) {
      setLocalError(e instanceof Error && e.message ? e.message : "Couldn't save to Downloads.");
    } finally {
      setBusy(false);
    }
  };

  const openSaved = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      await openDownloadedApk();
      setOutcome({ status: "handed-off", method: "downloads" });
    } catch (e) {
      setLocalError(
        e instanceof Error && e.message
          ? e.message
          : "Couldn't open the saved APK. Open Files → Downloads and tap it.",
      );
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-accent-sheen shadow-glow">
          <Download className="h-4 w-4 text-white" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-display text-base font-800">Update to v{info.version}</div>
          <div className="text-[11px] text-ink-faint">
            {current ? `You're on v${current}. ` : null}
            If the install prompt doesn't appear, we'll save the APK to Downloads.
          </div>
          {info.notes ? (
            <p className="mt-1.5 whitespace-pre-wrap text-[12px] text-ink-dim">{info.notes}</p>
          ) : null}
        </div>
        {sheet && onClose ? (
          <button onClick={onClose} className="btn btn-ghost h-8 w-8 p-0 text-ink-dim" title="Close">
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {busy ? (
        <div className="rounded-xl border border-line bg-white/[0.02] px-3 py-2.5">
          <div className="mb-1.5 flex items-center justify-between text-[12px] font-700">
            <span className="flex items-center gap-2 text-accent-3">
              <Loader2 className="h-4 w-4 animate-spin" />
              {progress?.message ??
                (pct == null ? "Working…" : pct >= 100 ? "Opening installer…" : `Downloading… ${pct}%`)}
            </span>
            {pct != null && pct < 100 ? <span className="tabular-nums text-ink-dim">{pct}%</span> : null}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-accent-sheen transition-[width]" style={{ width: `${pct ?? 8}%` }} />
          </div>
        </div>
      ) : null}

      {outcome?.status === "handed-off" ? (
        <div className="flex items-start gap-2 rounded-xl border border-green/30 bg-green/5 px-3 py-2 text-[12px] text-green">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {outcome.method === "installer"
              ? "Handed to Android's installer — confirm the system prompt if it appears."
              : "Opened the Downloads APK — confirm the system install prompt."}
            {" "}If nothing appears, use the buttons below or install from Files → Downloads.
          </span>
        </div>
      ) : null}

      {outcome?.status === "needs-permission" ? (
        <div className="space-y-2">
          <div className="flex items-start gap-2 rounded-xl border border-amber/30 bg-amber/5 px-3 py-2 text-[12px] text-amber">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{outcome.message}</span>
          </div>
          <button onClick={() => void openInstallSettings()} className="btn btn-subtle h-10 w-full gap-2 text-xs">
            Open install permission
          </button>
        </div>
      ) : null}

      {outcome?.status === "manual" ? (
        <div className="space-y-2 rounded-xl border border-amber/30 bg-amber/5 px-3 py-2.5 text-[12px]">
          <div className="flex items-start gap-2 text-amber">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 space-y-1">
              <div className="font-700">Couldn't finish automatic install</div>
              {outcome.failures.map((f) => (
                <div key={f.step} className="text-ink-dim">
                  <span className="font-600 text-ink-soft">{labelForStep(f.step)}:</span> {f.reason}
                </div>
              ))}
              {outcome.savedPath ? (
                <div className="text-ink-soft">
                  APK saved to <span className="font-700 text-ink">{outcome.savedPath}</span>. Open Files →
                  Downloads and tap it to install.
                </div>
              ) : (
                <div className="text-ink-dim">{outcome.reason}</div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {localError ? (
        <div className="flex items-start gap-2 rounded-xl border border-red/30 bg-red/5 px-3 py-2 text-[12px] text-red">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {localError}
        </div>
      ) : null}

      {!busy ? (
        <div className="flex flex-col gap-2">
          <button onClick={() => void runInstall()} className="btn btn-primary h-11 w-full gap-2">
            <Download className="h-4 w-4" />
            {outcome ? "Try install again" : "Download & install"}
          </button>
          <div className="flex gap-2">
            <button onClick={() => void saveOnly()} className="btn btn-subtle h-10 flex-1 gap-2 text-xs">
              <FolderDown className="h-4 w-4" /> Save to Downloads
            </button>
            <button
              onClick={() => void openSaved()}
              disabled={!savedPath}
              className="btn btn-subtle h-10 flex-1 gap-2 text-xs disabled:opacity-40"
            >
              <RefreshCw className="h-4 w-4" /> Open saved APK
            </button>
          </div>
          <button
            onClick={() => void openReleasePage(info.version)}
            className="btn btn-ghost h-10 w-full gap-2 text-xs text-ink-dim"
          >
            <ExternalLink className="h-4 w-4" /> Open release page
          </button>
          <p className="text-center text-[11px] text-ink-faint">
            Manual: Files → Downloads → GameTrackerRemote-{info.version}.apk → Install
          </p>
        </div>
      ) : null}
    </div>
  );

  if (sheet) {
    return (
      <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 p-3 backdrop-blur-sm sm:items-center">
        <div
          className="w-full max-w-md rounded-2xl border border-line bg-bg-900 p-4 shadow-float"
          style={{ marginBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
        >
          {body}
        </div>
      </div>
    );
  }

  return <div className="rounded-2xl border border-line bg-bg-900/60 p-4">{body}</div>;
}

function labelForStep(step: InstallProgress["step"]): string {
  switch (step) {
    case "permission":
      return "Permission";
    case "installer":
      return "System installer";
    case "save-downloads":
      return "Save to Downloads";
    case "open-downloads":
      return "Open Downloads APK";
    case "manual":
      return "Manual";
  }
}
