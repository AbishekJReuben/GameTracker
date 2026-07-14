/**
 * In-app updater for the Android companion.
 *
 * Tauri's updater plugin doesn't support Android, so this is a small custom
 * check: on launch we fetch a tiny manifest published alongside the APK in the
 * GitHub Release, compare its version to the running app, and — if newer — let
 * the user tap to download + install (the native side hands the APK to Android's
 * package installer; see `companion/src-tauri/src/update.rs`).
 *
 * Install is a staged fallback chain (clear reasons at each step):
 *   1. PackageInstaller session + legacy ACTION_VIEW (cache FileProvider)
 *   2. Copy APK into public Downloads
 *   3. Open that Downloads file with the system installer
 *   4. Manual instructions (open Files → Downloads → tap the APK)
 */

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

/**
 * Update manifest, published to the release as `apk-latest.json` and served from
 * the stable `releases/latest/download/` URL (no GitHub API → no rate limits).
 * Must match the release repo (same host as the desktop updater's latest.json).
 */
const MANIFEST_URL =
  "https://github.com/AbishekJReuben/GameTracker/releases/latest/download/apk-latest.json";

/** GitHub Releases page (same host as the desktop updater / APK assets). */
export const RELEASES_URL = "https://github.com/AbishekJReuben/GameTracker/releases";

/** Open the Releases page (or a specific tag) in the system browser. */
export async function openReleasePage(version?: string | null): Promise<void> {
  const ver = version?.trim().replace(/^v/i, "");
  const url = ver ? `${RELEASES_URL}/tag/v${ver}` : RELEASES_URL;
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export interface UpdateInfo {
  version: string;
  url: string;
  notes?: string;
  /** Hex sha256 of the APK, published by CI — verified natively after download. */
  sha256?: string;
  /** Exact APK byte size, published by CI. */
  size?: number;
}

interface Manifest {
  version: string;
  url: string;
  notes?: string;
  sha256?: string;
  size?: number;
}

/** True when running inside a real Tauri webview (Android APK / desktop). */
function isTauri(): boolean {
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI_INTERNALS__ ||
      (window as unknown as { __TAURI__?: unknown }).__TAURI__,
  );
}

/** True when running inside the phone companion bundle. */
function isCompanion(): boolean {
  return Boolean((window as unknown as { __GT_COMPANION__?: boolean }).__GT_COMPANION__);
}

/**
 * Fetch + parse the update manifest through the native side (ureq), not the
 * webview `fetch`: GitHub's asset host doesn't send CORS headers for our origin,
 * so an in-page fetch fails with "Failed to fetch". The native command has no
 * such restriction.
 */
async function loadManifest(): Promise<Manifest> {
  const text = await invoke<string>("fetch_update_manifest", { url: MANIFEST_URL });
  return JSON.parse(text) as Manifest;
}

/** Compare dotted versions (ignoring any `-prerelease` suffix). >0 if a>b. */
function cmpVersion(a: string, b: string): number {
  const norm = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e.trim()) return e;
  return fallback;
}

/**
 * Returns update info if a newer APK is published, else null. Never throws —
 * failures (offline, malformed manifest, non-Tauri context) resolve to null so
 * a missed check is invisible.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isCompanion() || !isTauri()) return null;
  try {
    const current = await getVersion();
    const m = await loadManifest();
    if (!m?.version || !m?.url) return null;
    if (cmpVersion(m.version, current) <= 0) return null;
    return { version: m.version, url: m.url, notes: m.notes, sha256: m.sha256, size: m.size };
  } catch {
    return null;
  }
}

/** Outcome of a user-initiated update check (surfaces errors, unlike the silent
 * launch check which collapses everything to null). */
export type UpdateCheck =
  | { status: "update-available"; info: UpdateInfo; current: string }
  | { status: "up-to-date"; current: string }
  | { status: "error"; current: string | null; message: string };

/**
 * Verbose update check for the Settings screen's "Check for updates" button. It
 * reports *why* nothing happened (offline, malformed manifest, already current),
 * so a stuck auto-update is diagnosable instead of silently doing nothing.
 */
export async function checkForUpdateVerbose(): Promise<UpdateCheck> {
  if (!isCompanion() || !isTauri()) {
    return { status: "error", current: null, message: "Updates are only available in the installed Android app." };
  }
  let current: string | null = null;
  try {
    current = await getVersion();
    const m = await loadManifest();
    if (!m?.version || !m?.url) {
      return { status: "error", current, message: "The update manifest was malformed." };
    }
    if (cmpVersion(m.version, current) <= 0) {
      return { status: "up-to-date", current };
    }
    return {
      status: "update-available",
      info: { version: m.version, url: m.url, notes: m.notes, sha256: m.sha256, size: m.size },
      current,
    };
  } catch (e) {
    const message =
      e instanceof Error && e.message ? e.message : "Couldn't reach the update server. Check your connection.";
    return { status: "error", current, message };
  }
}

/**
 * Whether Android currently allows this app to install packages ("install
 * unknown apps"). We check this BEFORE downloading so we can send the user to
 * grant it, rather than downloading and then failing at the install step (which
 * is where the app historically appeared to "close" before any prompt). Defaults
 * to `true` on any error / non-Android so the flow never gets stuck.
 */
export async function installPermissionGranted(): Promise<boolean> {
  try {
    return await invoke<boolean>("install_permission_status");
  } catch {
    return true;
  }
}

/** Open the system "install unknown apps" settings screen for this app. */
export async function openInstallSettings(): Promise<void> {
  await invoke("open_install_settings");
}

/**
 * Download the APK and launch the system installer (PackageInstaller session,
 * then legacy ACTION_VIEW). Resolves once the installer has been handed the
 * file — stock Android still shows its own one-tap confirm dialog. The native
 * side verifies the download against the manifest's sha256/size when present.
 */
export async function installUpdate(info: UpdateInfo): Promise<void> {
  await invoke("download_and_install_apk", {
    url: info.url,
    sha256: info.sha256 ?? null,
    size: info.size ?? null,
  });
}

/** Copy the APK into public Downloads; returns a display path like `Download/…`. */
export async function saveApkToDownloads(info: UpdateInfo): Promise<string> {
  return invoke<string>("save_apk_to_downloads", {
    url: info.url,
    version: info.version ?? null,
    sha256: info.sha256 ?? null,
    size: info.size ?? null,
  });
}

/** Open the APK previously saved by {@link saveApkToDownloads}. */
export async function openDownloadedApk(): Promise<void> {
  await invoke("open_downloaded_apk");
}

/** Stage in the install fallback chain (shown in Settings / the update panel). */
export type InstallStep =
  | "permission"
  | "installer"
  | "save-downloads"
  | "open-downloads"
  | "manual";

export type InstallProgress = {
  step: InstallStep;
  /** Short status line for the UI. */
  message: string;
  /** Native failure reason for the previous step, when advancing. */
  reason?: string;
  /** Display path after a successful Downloads save. */
  savedPath?: string;
};

export type InstallOutcome =
  | { status: "handed-off"; method: "installer" | "downloads" }
  | { status: "needs-permission"; message: string }
  | {
      status: "manual";
      /** Why automatic install stopped. */
      reason: string;
      /** Where the APK was saved, if the Downloads step succeeded. */
      savedPath?: string;
      /** Per-step failure notes for the panel. */
      failures: { step: InstallStep; reason: string }[];
    };

/**
 * Run the full install fallback chain with clear reasons at each step:
 * installer → save to Downloads → open Downloads → manual instructions.
 */
export async function installUpdateWithFallbacks(
  info: UpdateInfo,
  onProgress?: (p: InstallProgress) => void,
): Promise<InstallOutcome> {
  const failures: { step: InstallStep; reason: string }[] = [];
  const progress = (p: InstallProgress) => onProgress?.(p);

  if (!(await installPermissionGranted())) {
    progress({
      step: "permission",
      message: 'Android needs "Allow from this source" before updates can install.',
    });
    try {
      await openInstallSettings();
    } catch {
      /* best-effort */
    }
    return {
      status: "needs-permission",
      message:
        'Enable "Allow from this source" for GameTracker Remote, then try Update again.',
    };
  }

  progress({ step: "installer", message: "Downloading and opening the system installer…" });
  try {
    await installUpdate(info);
    return { status: "handed-off", method: "installer" };
  } catch (e) {
    const reason = errMessage(
      e,
      "The system installer did not start after the download finished.",
    );
    failures.push({ step: "installer", reason });
    progress({
      step: "save-downloads",
      message: "Installer failed — saving the APK to Downloads…",
      reason,
    });
  }

  let savedPath: string | undefined;
  try {
    savedPath = await saveApkToDownloads(info);
    progress({
      step: "open-downloads",
      message: `Saved to ${savedPath}. Opening it with the system installer…`,
      savedPath,
    });
  } catch (e) {
    const reason = errMessage(e, "Couldn't copy the APK into Downloads.");
    failures.push({ step: "save-downloads", reason });
    progress({
      step: "manual",
      message: "Couldn't save to Downloads — install manually from a browser download.",
      reason,
    });
    return {
      status: "manual",
      reason: failures.map((f) => f.reason).join(" → "),
      failures,
    };
  }

  try {
    await openDownloadedApk();
    return { status: "handed-off", method: "downloads" };
  } catch (e) {
    const reason = errMessage(
      e,
      "Couldn't open the Downloads APK with the system installer.",
    );
    failures.push({ step: "open-downloads", reason });
    progress({
      step: "manual",
      message: `Open Files → Downloads and tap ${savedPath ?? "the APK"} to install.`,
      reason,
      savedPath,
    });
    return {
      status: "manual",
      reason: failures.map((f) => f.reason).join(" → "),
      savedPath,
      failures,
    };
  }
}
