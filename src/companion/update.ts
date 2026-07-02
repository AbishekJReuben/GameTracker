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

/** True when running inside the phone companion bundle. */
function isCompanion(): boolean {
  return Boolean((window as unknown as { __GT_COMPANION__?: boolean }).__GT_COMPANION__);
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
  if (!isCompanion()) return null;
  try {
    const current = await getVersion();
    const res = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!res.ok) return null;
    const m = (await res.json()) as Manifest;
    if (!m?.version || !m?.url) return null;
    if (cmpVersion(m.version, current) <= 0) return null;
    return { version: m.version, url: m.url, notes: m.notes };
  } catch {
    return null;
  }
}

/**
 * Download the APK and launch the system installer. Resolves once the installer
 * has been handed the file (the OS then shows its one-tap install prompt).
 */
export async function installUpdate(url: string): Promise<void> {
  await invoke("download_and_install_apk", { url });
}
