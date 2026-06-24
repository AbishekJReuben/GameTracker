/**
 * App version, injected at build time from `package.json` (see `vite.config.ts`
 * `define`). Because the version bump script (`scripts/bump-version.ps1`) edits
 * `package.json`, every version label in the UI updates automatically on the
 * next build — no hand-edited strings to keep in sync.
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

/** Compact "major.minor" form for tight spots (e.g. "3.1"). */
export const APP_VERSION_SHORT: string = APP_VERSION.split(".").slice(0, 2).join(".");
