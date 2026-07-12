/**
 * In-app updater for the Android companion.
 *
 * Tauri's updater plugin doesn't support Android, so this is a small custom
 * check: on launch we fetch a tiny manifest published alongside the APK in the
 * GitHub Release, compare its version to the running app, and — if newer — let
 * the user tap to download + install (the native side hands the APK to Android's
 * package installer; see `companion/src-tauri/src/update.rs`).
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

export interface UpdateInfo {
  version: string;
  url: string;
  notes?: string;
}

interface Manifest {
  version: string;
  url: string;
  notes?: string;
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
    return { version: m.version, url: m.url, notes: m.notes };
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
    return { status: "update-available", info: { version: m.version, url: m.url, notes: m.notes }, current };
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
 * Download the APK and launch the system installer. Resolves once the installer
 * has been handed the file (the OS then shows its one-tap install prompt).
 */
export async function installUpdate(url: string): Promise<void> {
  await invoke("download_and_install_apk", { url });
}
