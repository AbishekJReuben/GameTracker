import { openUrl } from "@tauri-apps/plugin-opener";

/** True when running inside the Tauri webview (not Vite browser dev). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Open an https URL in the system browser (Tauri) or a new tab (Vite dev). */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
