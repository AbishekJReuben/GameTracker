/**
 * Best-effort Twitch directory (category) URL for a game. Twitch slugs are mostly
 * `lowercase-with-hyphens`, apostrophes dropped and `&`→`and`. It can't predict
 * Twitch's numeric disambiguation suffixes (e.g. `encounter-1`), so the UI also
 * offers an "Open on Twitch" search fallback for the rare mismatch.
 *
 * The directory page is loaded as a top-level native webview (not an iframe), so
 * it needs no `parent` param, no API key, and no CSP changes.
 */
export function twitchCategorySlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function twitchDirectoryUrl(name: string): string {
  return `https://www.twitch.tv/directory/category/${twitchCategorySlug(name)}`;
}

/** Reliable fallback: Twitch search lands on the category + live channels. */
export function twitchSearchUrl(name: string): string {
  return `https://www.twitch.tv/search?term=${encodeURIComponent(name)}`;
}
