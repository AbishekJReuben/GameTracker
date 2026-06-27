//! Optional online metadata — keyless lookup via Steam's public store APIs.
//! Triggered explicitly by the user (no automatic/background calls).
//!
//! APIs used (no key required):
//! - Store search: `store.steampowered.com/api/storesearch`
//! - App details:  `store.steampowered.com/api/appdetails`
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::thread;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(15);
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Tracker/2.1";

/// Categories that are store features, not game tags/genres.
const SKIP_CATEGORIES: &[&str] = &[
    "Steam Achievements",
    "Steam Trading Cards",
    "Steam Cloud",
    "Steam Workshop",
    "Steam Turn Notifications",
    "In-App Purchases",
    "Remote Play on Phone",
    "Remote Play on Tablet",
    "Remote Play on TV",
    "Remote Play Together",
    "Family Sharing",
    "Valve Anti-Cheat enabled",
    "Includes Source SDK",
    "Includes level editor",
    "Commentary available",
    "Stats",
    "Captions available",
    "Steam Leaderboards",
    "Partial Controller Support",
    "HDR available",
];

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameMetadata {
    pub developer: Option<String>,
    pub release_year: Option<i64>,
    pub metacritic: Option<i64>,
    pub genres: Vec<String>,
    pub short_description: Option<String>,
    pub cover_path: Option<String>,
    pub steam_app_id: Option<u64>,
    pub screenshots: Vec<String>,
    pub background_url: Option<String>,
    pub website: Option<String>,
    pub trailer_url: Option<String>,
    pub theme_youtube_id: Option<String>,
    pub theme_audio_url: Option<String>,
    pub theme_track_ids: Vec<String>,
    pub theme_playlist_id: Option<String>,
    pub theme_track_titles: HashMap<String, String>,
}

/// Resolved theme audio for a game: primary YouTube track, iTunes preview, the
/// full OST track list (scraped from a YouTube playlist when one is found), and
/// the source playlist id so the UI can link / export it.
#[derive(Debug, Clone, Default)]
pub struct ThemeResolution {
    pub youtube_id: Option<String>,
    pub audio_url: Option<String>,
    pub track_ids: Vec<String>,
    pub playlist_id: Option<String>,
    pub track_titles: HashMap<String, String>,
}

/// Percent-encode a query term (RFC 3986 unreserved kept).
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn normalize_name(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

pub fn names_match(query: &str, candidate: &str) -> bool {
    if name_similarity(query, candidate) >= 0.85 {
        return true;
    }
    let q = normalize_name(query);
    let c = normalize_name(candidate);
    if q.is_empty() || c.is_empty() {
        return false;
    }
    if q == c {
        return true;
    }
    let min = q.len().min(c.len()) as f32;
    let max = q.len().max(c.len()) as f32;
    if max == 0.0 {
        return false;
    }
    // Reject "Assassin's Creed" matching "Assassin's Creed Black Flag Resynced".
    if min / max < 0.72 {
        return false;
    }
    q.contains(&c) || c.contains(&q)
}

/// Token overlap 0..1 for ranking Steam / Metacritic candidates.
pub fn name_similarity(query: &str, candidate: &str) -> f32 {
    let q = normalize_name(query);
    let c = normalize_name(candidate);
    if q.is_empty() || c.is_empty() {
        return 0.0;
    }
    if q == c {
        return 1.0;
    }
    if c.contains(&q) || q.contains(&c) {
        let min = q.len().min(c.len()) as f32;
        let max = q.len().max(c.len()) as f32;
        return (min / max).clamp(0.55, 0.95);
    }
    let q_tokens: Vec<&str> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 2)
        .collect();
    if q_tokens.is_empty() {
        return 0.0;
    }
    let c_norm = normalize_name(candidate);
    let hits = q_tokens
        .iter()
        .filter(|t| c_norm.contains(&normalize_name(t)))
        .count();
    hits as f32 / q_tokens.len() as f32
}

fn parse_release_year(date: &str) -> Option<i64> {
    for word in date.split(|c: char| !c.is_ascii_digit()) {
        if word.len() == 4 {
            if let Ok(y) = word.parse::<i64>() {
                if (1970..=2100).contains(&y) {
                    return Some(y);
                }
            }
        }
    }
    None
}

fn steam_get(url: &str) -> Option<ureq::Response> {
    ureq::get(url)
        .set("User-Agent", UA)
        .set("Accept", "application/json,text/html,*/*")
        .set("Accept-Language", "en-US,en;q=0.9")
        .timeout(TIMEOUT)
        .call()
        .ok()
}

/// Lightweight reachability check — many CDNs (Steam, Akamai) reject HEAD.
pub fn head_ok(url: &str) -> bool {
    url_reachable(url)
}

/// GET with optional Range; follows redirects. Accepts 2xx and common CDN quirks.
pub fn url_reachable(url: &str) -> bool {
    if url.trim().is_empty() {
        return false;
    }
    let mut current = url.trim().to_string();
    for _ in 0..4 {
        let resp = ureq::get(&current)
            .set("User-Agent", UA)
            .set("Accept", "*/*")
            .set("Accept-Language", "en-US,en;q=0.9")
            .set("Range", "bytes=0-512")
            .timeout(Duration::from_secs(10))
            .call();
        match resp {
            Ok(r) => {
                let status = r.status();
                if (200..300).contains(&status) || status == 206 {
                    return true;
                }
                if (301..308).contains(&status) {
                    if let Some(loc) = r.header("Location") {
                        if loc.starts_with("http") {
                            current = loc.to_string();
                            continue;
                        }
                    }
                }
                // Some sites return 403 but still serve data to browsers with GET body.
                if status == 403 {
                    return r.into_string().map(|s| s.len() > 64).unwrap_or(false);
                }
                return false;
            }
            Err(ureq::Error::Status(code, _)) if (300..400).contains(&code) => return false,
            Err(_) => return false,
        }
    }
    false
}

/// Returns a playable trailer URL, trying `movie480` when `movie_max` 404s.
pub fn trailer_playable_url(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    if url_reachable(url) {
        return Some(url.to_string());
    }
    if url.contains("movie_max") {
        let alt = url.replace("movie_max", "movie480");
        if url_reachable(&alt) {
            return Some(alt);
        }
    }
    None
}

/// Steam library art exists for this app (CDN GET, not HEAD).
pub fn steam_cover_available(appid: u64) -> bool {
    url_reachable(&steam_cover_url(appid))
        || url_reachable(&steam_header_url(appid))
}

fn download(url: &str) -> Option<Vec<u8>> {
    let resp = steam_get(url)?;
    let mut buf = Vec::new();
    resp.into_reader()
        .take(12_000_000)
        .read_to_end(&mut buf)
        .ok()?;
    if buf.len() < 1024 {
        return None;
    }
    Some(buf)
}

#[derive(Debug, Deserialize)]
struct SearchItem {
    id: u64,
    name: String,
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    items: Option<Vec<SearchItem>>,
}

/// Resolve a Steam app id from a game name. When `stored` is set, keeps it only if
/// the Steam store title still matches; otherwise re-searches with strict scoring.
pub fn resolve_steam_appid(name: &str) -> Option<u64> {
    resolve_steam_appid_checked(name, None)
}

pub fn resolve_steam_appid_checked(name: &str, stored: Option<u64>) -> Option<u64> {
    if let Some(id) = stored.filter(|&id| id > 0) {
        if let Some(details) = fetch_steam_details(id) {
            if let Some(steam_name) = &details.name {
                if name_similarity(name, steam_name) >= 0.72 {
                    return Some(id);
                }
            }
        }
    }
    let items = search_steam_games(name, 12);
    let mut best: Option<(u64, f32, usize)> = None;
    for (id, n) in &items {
        let n_lower = n.to_lowercase();
        let q_lower = name.to_lowercase();
        if !q_lower.contains("demo")
            && (n_lower.contains("demo") || n_lower.contains("beta") || n_lower.contains("trial"))
        {
            continue;
        }
        if !q_lower.contains("replanted") && n_lower.contains("replanted") {
            continue;
        }
        let mut score = name_similarity(name, n);
        if names_match(name, n) {
            score = score.max(0.92);
        }
        if score < 0.42 {
            continue;
        }
        let n_len = n.len();
        let better = match best {
            None => true,
            Some((_, best_score, _best_len)) if score > best_score + 0.01 => true,
            Some((_, best_score, best_len)) if (score - best_score).abs() <= 0.08 => n_len < best_len,
            _ => false,
        };
        if better {
            best = Some((*id, score, n_len));
        }
    }
    best.map(|(id, _, _)| id)
}

/// Search Steam store (keyless). Returns `(appid, name)` pairs.
pub fn search_steam_games(term: &str, max: usize) -> Vec<(u64, String)> {
    if term.trim().is_empty() || max == 0 {
        return Vec::new();
    }
    let url = format!(
        "https://store.steampowered.com/api/storesearch/?term={}&l=english&cc=US",
        encode(term)
    );
    let resp = match steam_get(&url) {
        Some(r) => r,
        None => return Vec::new(),
    };
    let json: SearchResponse = match resp.into_json() {
        Ok(j) => j,
        Err(_) => return Vec::new(),
    };
    json.items
        .unwrap_or_default()
        .into_iter()
        .take(max)
        .map(|i| (i.id, i.name))
        .collect()
}

/// A title suggestion for the add-game autosuggest dropdown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSuggestion {
    pub name: String,
    pub steam_app_id: Option<u64>,
    pub cover_url: Option<String>,
    pub source: String,
}

/// Build autosuggest results for a typed query. Steam store hits come first
/// (they carry an exact appid + portrait thumbnail), then RAWG results fill in
/// the long tail — Riot, Battle.net, console-first and other non-Steam titles
/// that the keyless Steam search alone never surfaces. Deduped by name.
pub fn search_game_suggestions(query: &str, max: usize) -> Vec<GameSuggestion> {
    let mut out: Vec<GameSuggestion> = search_steam_games(query, max)
        .into_iter()
        .map(|(appid, name)| GameSuggestion {
            name,
            steam_app_id: Some(appid),
            cover_url: Some(steam_header_url(appid)),
            source: "Steam".to_string(),
        })
        .collect();

    let mut seen: std::collections::HashSet<String> =
        out.iter().map(|s| normalize_name(&s.name)).collect();
    for sug in rawg_search_games(query, max) {
        if out.len() >= max {
            break;
        }
        if seen.insert(normalize_name(&sug.name)) {
            out.push(sug);
        }
    }
    out
}

/// RAWG title search for the autosuggest (needs `RAWG_API_KEY`). RAWG's catalog
/// spans every storefront, so this is what lets non-Steam games autocomplete.
fn rawg_search_games(term: &str, max: usize) -> Vec<GameSuggestion> {
    let term = term.trim();
    if term.is_empty() || max == 0 {
        return Vec::new();
    }
    let Some(key) = rawg_key() else {
        return Vec::new();
    };
    let q = encode(term);
    let Some(json) = get_json(&format!(
        "https://api.rawg.io/api/games?key={key}&search={q}&page_size={max}"
    )) else {
        return Vec::new();
    };
    let Some(arr) = json.get("results").and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|g| {
            let name = g.get("name")?.as_str()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let cover_url = g
                .get("background_image")
                .and_then(|v| v.as_str())
                .map(String::from)
                .filter(|s| !s.trim().is_empty());
            Some(GameSuggestion {
                name,
                steam_app_id: None,
                cover_url,
                source: "RAWG".to_string(),
            })
        })
        .collect()
}

/// Public Steam CDN cover URL for an app (no download).
pub fn steam_cover_url(appid: u64) -> String {
    format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900_2x.jpg")
}

/// Wide header art fallback when vertical library cover is missing.
pub fn steam_header_url(appid: u64) -> String {
    format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/header.jpg")
}

#[derive(Debug, Deserialize)]
struct AppDetailsEnvelope {
    success: bool,
    data: Option<AppDetailsData>,
}

#[derive(Debug, Deserialize)]
pub struct AppDetailsData {
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub app_type: Option<String>,
    pub developers: Option<Vec<String>>,
    pub genres: Option<Vec<Genre>>,
    pub categories: Option<Vec<Genre>>,
    pub release_date: Option<ReleaseDate>,
    pub metacritic: Option<Metacritic>,
    pub short_description: Option<String>,
    pub screenshots: Option<Vec<Screenshot>>,
    pub movies: Option<Vec<Movie>>,
    pub background_raw: Option<String>,
    pub background: Option<String>,
    pub website: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Movie {
    pub id: Option<i64>,
    #[serde(default)]
    pub highlight: bool,
    pub mp4: Option<MovieFormats>,
    pub webm: Option<MovieFormats>,
}

#[derive(Debug, Deserialize)]
pub struct MovieFormats {
    #[serde(rename = "480")]
    pub low: Option<String>,
    pub max: Option<String>,
}

/// Pick the best playable trailer URL for a game (mp4 preferred, native `<video>`).
///
/// Newer Steam payloads ship only DASH/HLS manifests in `movies`, but the legacy
/// direct CDN mp4 (`store_trailers/<id>/movie_max.mp4`) is still served, so we
/// derive it from the movie id when no direct mp4/webm field is present.
pub fn trailer_url(details: &AppDetailsData) -> Option<String> {
    let movies = details.movies.as_ref()?;
    let movie = movies
        .iter()
        .find(|m| m.highlight)
        .or_else(|| movies.first())?;
    let direct = movie
        .mp4
        .as_ref()
        .and_then(|f| f.max.clone().or_else(|| f.low.clone()))
        .or_else(|| {
            movie
                .webm
                .as_ref()
                .and_then(|f| f.max.clone().or_else(|| f.low.clone()))
        })
        .filter(|s| s.starts_with("http"));
    direct.or_else(|| {
        movie.id.map(|id| {
            let max = format!("https://video.akamai.steamstatic.com/store_trailers/{id}/movie_max.mp4");
            trailer_playable_url(&max).unwrap_or(max)
        })
    })
}

#[derive(Debug, Deserialize)]
pub struct Screenshot {
    pub path_full: Option<String>,
    pub path_thumbnail: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Genre {
    pub description: String,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseDate {
    pub date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Metacritic {
    pub score: i64,
}

pub fn fetch_steam_details(appid: u64) -> Option<AppDetailsData> {
    let url = format!(
        "https://store.steampowered.com/api/appdetails?appids={appid}&l=english&cc=US"
    );
    let resp = steam_get(&url)?;
    let json: serde_json::Value = resp.into_json().ok()?;
    let envelope: AppDetailsEnvelope = serde_json::from_value(
        json.get(appid.to_string())?.clone(),
    )
    .ok()?;
    if !envelope.success {
        return None;
    }
    let data = envelope.data?;
    if data.app_type.as_deref() == Some("dlc") || data.app_type.as_deref() == Some("demo") {
        return None;
    }
    Some(data)
}

fn push_tag(set: &mut Vec<String>, seen: &mut std::collections::HashSet<String>, tag: &str) {
    let t = tag.trim();
    if t.is_empty() || t.len() > 48 {
        return;
    }
    let key = t.to_lowercase();
    if seen.insert(key) {
        set.push(t.to_string());
    }
}

fn category_is_useful(desc: &str) -> bool {
    !SKIP_CATEGORIES.iter().any(|s| *s == desc)
}

/// SteamSpy returns community tags with vote weights (keyless).
fn fetch_steamspy_tags(appid: u64) -> Vec<String> {
    let url = format!("https://steamspy.com/api.php?request=appdetails&appid={appid}");
    let resp = match steam_get(&url) {
        Some(r) => r,
        None => return Vec::new(),
    };
    let json: serde_json::Value = match resp.into_json().ok() {
        Some(j) => j,
        None => return Vec::new(),
    };
    let tags = match json.get("tags").and_then(|t| t.as_object()) {
        Some(t) => t,
        None => return Vec::new(),
    };
    let mut ranked: Vec<(String, i64)> = tags
        .iter()
        .filter_map(|(name, votes)| {
            let v = votes.as_i64().or_else(|| votes.as_u64().map(|u| u as i64))?;
            Some((name.clone(), v))
        })
        .collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1));
    ranked.into_iter().take(14).map(|(n, _)| n).collect()
}

/// Scrape user tags from the public store page (`app_tag` anchors).
fn fetch_store_page_tags(appid: u64) -> Vec<String> {
    let url = format!("https://store.steampowered.com/app/{appid}/?l=english");
    let resp = match steam_get(&url) {
        Some(r) => r,
        None => return Vec::new(),
    };
    let html = match resp.into_string().ok() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut rest = html.as_str();
    while let Some(idx) = rest.find("app_tag") {
        let chunk = &rest[idx..];
        if let Some(gt) = chunk.find('>') {
            let after = &chunk[gt + 1..];
            if let Some(lt) = after.find('<') {
                let text = after[..lt].trim();
                push_tag(&mut out, &mut seen, text);
            }
        }
        rest = &rest[idx + 7..];
        if out.len() >= 16 {
            break;
        }
    }
    out
}

/// Merge Steam genres, gameplay categories, SteamSpy tags, and store-page tags.
pub fn collect_tags(appid: u64, details: &AppDetailsData) -> Vec<String> {
    let mut tags = Vec::new();
    let mut seen = std::collections::HashSet::new();

    if let Some(genres) = &details.genres {
        for g in genres {
            push_tag(&mut tags, &mut seen, &g.description);
        }
    }
    if let Some(cats) = &details.categories {
        for c in cats {
            if category_is_useful(&c.description) {
                push_tag(&mut tags, &mut seen, &c.description);
            }
        }
    }

    for t in fetch_steamspy_tags(appid) {
        push_tag(&mut tags, &mut seen, &t);
    }
    if tags.len() < 6 {
        for t in fetch_store_page_tags(appid) {
            push_tag(&mut tags, &mut seen, &t);
        }
    }

    tags.truncate(20);
    tags
}

/// GET against the SteamGridDB v2 API with the bearer key. Returns parsed JSON.
fn sgdb_get_json(path: &str) -> Option<serde_json::Value> {
    let key = steamgriddb_key()?;
    let url = format!("https://www.steamgriddb.com/api/v2/{path}");
    ureq::get(&url)
        .set("Authorization", &format!("Bearer {key}"))
        .set("User-Agent", UA)
        .set("Accept", "application/json")
        .timeout(TIMEOUT)
        .call()
        .ok()?
        .into_json::<serde_json::Value>()
        .ok()
}

/// Resolve a portrait cover URL for a game name via SteamGridDB (needs a key).
/// Prefers static 600×900 grids; non-static (animated) grids are skipped.
pub fn steamgriddb_cover_url(name: &str) -> Option<String> {
    if name.trim().is_empty() {
        return None;
    }
    let search = sgdb_get_json(&format!("search/autocomplete/{}", encode(name.trim())))?;
    let items = search.get("data")?.as_array()?;
    // Pick the closest title match rather than blindly the first hit.
    let mut best: Option<(i64, f32)> = None;
    for item in items {
        let id = item.get("id").and_then(|v| v.as_i64());
        let n = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(id) = id {
            let score = name_similarity(name, n);
            if best.map(|(_, s)| score > s).unwrap_or(true) {
                best = Some((id, score));
            }
        }
    }
    let (game_id, _) = best?;
    let grids = sgdb_get_json(&format!(
        "grids/game/{game_id}?dimensions=600x900&types=static&nsfw=false&limit=8"
    ))?;
    grids
        .get("data")?
        .as_array()?
        .iter()
        .find_map(|g| g.get("url").and_then(|u| u.as_str()).map(str::to_string))
        .filter(|u| u.starts_with("http"))
}

/// Download an arbitrary cover image URL into `media_dir` as `cover_<game_id>.<ext>`.
pub fn download_cover_url(url: &str, media_dir: &Path, game_id: &str) -> Option<String> {
    let bytes = download(url)?;
    let ext = url
        .rsplit('.')
        .next()
        .map(|e| e.split(['?', '#']).next().unwrap_or(e).to_lowercase())
        .filter(|e| matches!(e.as_str(), "png" | "jpg" | "jpeg" | "webp"))
        .unwrap_or_else(|| "jpg".to_string());
    std::fs::create_dir_all(media_dir).ok()?;
    let dest = media_dir.join(format!("cover_{game_id}.{ext}"));
    std::fs::write(&dest, &bytes).ok()?;
    Some(dest.to_string_lossy().to_string())
}

fn download_cover(appid: u64, media_dir: &Path, game_id: &str) -> AppResult<Option<String>> {
    let candidates = [
        format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900_2x.jpg"),
        format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900.jpg"),
        format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/header.jpg"),
    ];
    for url in candidates {
        if let Some(bytes) = download(&url) {
            std::fs::create_dir_all(media_dir)?;
            let dest = media_dir.join(format!("cover_{game_id}.jpg"));
            std::fs::write(&dest, &bytes).map_err(|e| AppError::msg(e.to_string()))?;
            return Ok(Some(dest.to_string_lossy().to_string()));
        }
    }
    Ok(None)
}

/// Look up a game cover by name and save it into `media_dir`. Returns the saved
/// path. Tries Steam library art first, then SteamGridDB portrait art — so it
/// also covers Steam titles with no capsule yet (e.g. unreleased games) and
/// non-Steam games, matching the auto-enrichment-on-add behavior.
pub fn fetch_cover(name: &str, media_dir: &Path, game_id: &str) -> AppResult<Option<String>> {
    if let Some(appid) = resolve_steam_appid(name) {
        if let Some(cover) = download_cover(appid, media_dir, game_id)? {
            return Ok(Some(cover));
        }
    }
    Ok(steamgriddb_cover_url(name).and_then(|u| download_cover_url(&u, media_dir, game_id)))
}

/// Fetch rich metadata for a game. Tries Steam first (keyless); for titles not on
/// Steam, falls back to RAWG when a `RAWG_API_KEY` is configured (see `.env`).
pub fn fetch_game_info(
    name: &str,
    media_dir: &Path,
    game_id: &str,
    with_cover: bool,
) -> AppResult<Option<GameMetadata>> {
    if let Some(meta) = fetch_steam_game_info(name, media_dir, game_id, with_cover)? {
        return Ok(Some(meta));
    }
    fetch_rawg_game_info(name, media_dir, game_id, with_cover)
}

/// Fetch rich metadata (developer, year, metacritic, genres, blurb) from Steam.
fn fetch_steam_game_info(
    name: &str,
    media_dir: &Path,
    game_id: &str,
    with_cover: bool,
) -> AppResult<Option<GameMetadata>> {
    let appid = match resolve_steam_appid(name) {
        Some(a) => a,
        None => return Ok(None),
    };
    let details = match fetch_steam_details(appid) {
        Some(d) => d,
        None => return Ok(None),
    };

    // Reject obvious mismatches when Steam returns a different title.
    if let Some(steam_name) = &details.name {
        if !names_match(name, steam_name) {
            // Allow first search hit if names are still reasonably close.
            let q = normalize_name(name);
            let s = normalize_name(steam_name);
            let overlap = q.len().min(s.len()) as f32 / q.len().max(s.len()).max(1) as f32;
            if overlap < 0.45 && !s.contains(&q) && !q.contains(&s) {
                return Ok(None);
            }
        }
    }

    Ok(Some(build_steam_metadata(
        appid, &details, name, media_dir, game_id, with_cover,
    )))
}

/// Fetch rich metadata for a known Steam appid (skips the name search). Used when
/// the appid is already known from detection or the add-game autosuggest.
pub fn fetch_game_info_by_appid(
    appid: u64,
    media_dir: &Path,
    game_id: &str,
    with_cover: bool,
) -> AppResult<Option<GameMetadata>> {
    let details = match fetch_steam_details(appid) {
        Some(d) => d,
        None => return Ok(None),
    };
    let name = details.name.clone().unwrap_or_default();
    Ok(Some(build_steam_metadata(
        appid, &details, &name, media_dir, game_id, with_cover,
    )))
}

/// Assemble a `GameMetadata` from resolved Steam `AppDetailsData`.
fn build_steam_metadata(
    appid: u64,
    details: &AppDetailsData,
    name: &str,
    media_dir: &Path,
    game_id: &str,
    with_cover: bool,
) -> GameMetadata {
    let developer = details
        .developers
        .as_ref()
        .and_then(|d| d.first())
        .cloned()
        .filter(|s| !s.trim().is_empty());

    let release_year = details
        .release_date
        .as_ref()
        .and_then(|r| r.date.as_deref())
        .and_then(parse_release_year);

    let metacritic = details.metacritic.as_ref().map(|m| m.score);

    let genres = collect_tags(appid, details);

    let short_description = details
        .short_description
        .clone()
        .filter(|s| !s.trim().is_empty());

    let cover_path = if with_cover {
        match download_cover(appid, media_dir, game_id).ok().flatten() {
            Some(c) => Some(c),
            // A handful of titles on Steam have no library capsule on the CDN;
            // fall back to keyless Wikipedia art (or SteamGridDB if a key is set).
            None => resolve_fallback_cover(
                details.name.as_deref().unwrap_or(name),
                media_dir,
                game_id,
                None,
            ),
        }
    } else {
        None
    };

    let screenshots = screenshot_urls(details, 12);
    let background_url = details
        .background_raw
        .clone()
        .or_else(|| details.background.clone())
        .filter(|s| !s.trim().is_empty());
    let website = details.website.clone().filter(|s| !s.trim().is_empty());
    let trailer = trailer_url(details);
    let theme_name = details.name.as_deref().unwrap_or(name);
    let theme = resolve_theme(theme_name);

    GameMetadata {
        developer,
        release_year,
        metacritic,
        genres,
        short_description,
        cover_path,
        steam_app_id: Some(appid),
        screenshots,
        background_url,
        website,
        trailer_url: trailer,
        theme_youtube_id: theme.youtube_id,
        theme_audio_url: theme.audio_url,
        theme_track_ids: theme.track_ids,
        theme_playlist_id: theme.playlist_id,
        theme_track_titles: theme.track_titles,
    }
}

/// Full-resolution screenshot URLs (CDN-hosted, shown directly — no download).
pub fn screenshot_urls(details: &AppDetailsData, max: usize) -> Vec<String> {
    details
        .screenshots
        .as_ref()
        .map(|shots| {
            shots
                .iter()
                .filter_map(|s| s.path_full.clone().or_else(|| s.path_thumbnail.clone()))
                .filter(|u| !u.trim().is_empty())
                .take(max)
                .collect()
        })
        .unwrap_or_default()
}

// ---------- App / software metadata (Wikipedia, keyless) ----------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub description: Option<String>,
    pub developer: Option<String>,
    pub publisher: Option<String>,
    pub release_year: Option<i64>,
    pub cover_path: Option<String>,
    pub wiki_title: Option<String>,
    pub screenshots: Vec<String>,
    pub website: Option<String>,
    pub info_json: Option<String>,
    pub genre_tags: Vec<String>,
}

/// Images on a Wikipedia article (logos, screenshots, UI) — keyless REST media-list.
fn wiki_media_images(title: &str, max: usize) -> Vec<String> {
    let path = encode(&title.replace(' ', "_"));
    let url = format!("https://en.wikipedia.org/api/rest_v1/page/media-list/{path}");
    let resp = match steam_get(&url) {
        Some(r) => r,
        None => return Vec::new(),
    };
    let json: serde_json::Value = match resp.into_json().ok() {
        Some(j) => j,
        None => return Vec::new(),
    };
    let items = match json.get("items").and_then(|i| i.as_array()) {
        Some(i) => i,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in items {
        if item.get("type").and_then(|t| t.as_str()) != Some("image") {
            continue;
        }
        // srcset holds candidate URLs (protocol-relative); take the highest-res.
        let src = item
            .get("srcset")
            .and_then(|s| s.as_array())
            .and_then(|arr| arr.last())
            .and_then(|c| c.get("src"))
            .and_then(|s| s.as_str())
            .or_else(|| item.get("src").and_then(|s| s.as_str()));
        if let Some(raw) = src {
            let full = if raw.starts_with("//") {
                format!("https:{raw}")
            } else {
                raw.to_string()
            };
            // Skip SVG icons/logos that render poorly as gallery tiles.
            if full.to_lowercase().ends_with(".svg") {
                continue;
            }
            if seen.insert(full.clone()) {
                out.push(full);
            }
        }
        if out.len() >= max {
            break;
        }
    }
    out
}

/// Resolve the best-matching Wikipedia article title for an app name.
fn wiki_search_title(name: &str) -> Option<String> {
    wiki_search_title_ctx(name, "software")
}

/// Search Wikipedia for an article title, biasing the query with a context word
/// (e.g. "software", "video game") so we land on the right disambiguation.
fn wiki_search_title_ctx(name: &str, ctx: &str) -> Option<String> {
    let url = format!(
        "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={}&srlimit=1&format=json",
        encode(&format!("{name} {ctx}"))
    );
    let resp = steam_get(&url)?;
    let json: serde_json::Value = resp.into_json().ok()?;
    let title = json
        .get("query")?
        .get("search")?
        .as_array()?
        .first()?
        .get("title")?
        .as_str()?
        .to_string();
    Some(title)
}

/// Keyless cover art for a game from its Wikipedia article's lead image (usually
/// the official box/key art). The same pattern as the keyless iTunes theme
/// fallback — no API key required.
pub fn wiki_game_cover_url(name: &str) -> Option<String> {
    let title = wiki_search_title_ctx(name, "video game")?;
    // Reject a clearly-wrong article (e.g. a person/place) by name overlap.
    if name_similarity(name, &title) < 0.3 {
        return None;
    }
    let (_, image, _) = wiki_summary(&title)?;
    image.filter(|u| {
        let l = u.to_lowercase();
        !l.ends_with(".svg") && u.starts_with("http")
    })
}

/// Best-effort cover for a non-Steam (or Steam-art-missing) title, **keyless by
/// default**. Order: SteamGridDB *only if* a key is configured (best portrait
/// art) → Wikipedia lead image (keyless) → the caller's fallback URL (e.g. the
/// RAWG background). Saves into `media_dir` and returns the path.
fn resolve_fallback_cover(
    name: &str,
    media_dir: &Path,
    game_id: &str,
    fallback_url: Option<&str>,
) -> Option<String> {
    if let Some(path) =
        steamgriddb_cover_url(name).and_then(|u| download_cover_url(&u, media_dir, game_id))
    {
        return Some(path);
    }
    if let Some(path) =
        wiki_game_cover_url(name).and_then(|u| download_cover_url(&u, media_dir, game_id))
    {
        return Some(path);
    }
    fallback_url.and_then(|u| download_cover_url(u, media_dir, game_id))
}

/// Page summary -> (extract, image url).
fn wiki_summary(title: &str) -> Option<(Option<String>, Option<String>, Option<String>)> {
    let path = encode(&title.replace(' ', "_"));
    let url = format!("https://en.wikipedia.org/api/rest_v1/page/summary/{path}");
    let resp = steam_get(&url)?;
    let json: serde_json::Value = resp.into_json().ok()?;
    let extract = json
        .get("extract")
        .and_then(|e| e.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let wikibase = json
        .get("wikibase_item")
        .and_then(|e| e.as_str())
        .map(str::to_string);
    let image = json
        .get("originalimage")
        .and_then(|o| o.get("source"))
        .and_then(|s| s.as_str())
        .or_else(|| {
            json.get("thumbnail")
                .and_then(|t| t.get("source"))
                .and_then(|s| s.as_str())
        })
        .map(|s| s.to_string());
    Some((extract, image, wikibase))
}

fn download_app_image(url: &str, media_dir: &Path, game_id: &str) -> Option<String> {
    let bytes = download(url)?;
    let ext = url
        .rsplit('.')
        .next()
        .map(|e| e.to_lowercase())
        .filter(|e| matches!(e.as_str(), "png" | "jpg" | "jpeg" | "webp" | "svg"))
        .unwrap_or_else(|| "png".to_string());
    std::fs::create_dir_all(media_dir).ok()?;
    let dest = media_dir.join(format!("cover_{game_id}.{ext}"));
    std::fs::write(&dest, &bytes).ok()?;
    Some(dest.to_string_lossy().to_string())
}

/// Best-effort online info for a user-added app/software: description, logo, Wikidata facts.
pub fn fetch_app_info(
    name: &str,
    media_dir: &Path,
    game_id: &str,
    with_image: bool,
) -> AppResult<Option<AppInfo>> {
    let title = match wiki_search_title(name) {
        Some(t) => t,
        None => return Ok(None),
    };
    let (description, image_url, wikibase) = match wiki_summary(&title) {
        Some(v) => v,
        None => (None, None, None),
    };

    let mut developer = None;
    let mut publisher = None;
    let mut release_year = None;
    let mut website = None;
    let mut genre_tags = Vec::new();
    let mut info_map: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();

    if let Some(qid) = wikibase.as_deref() {
            if let Some(wd) = wikidata_facts(qid) {
            developer = wd.developer.clone();
            publisher = wd.publisher.clone();
            release_year = wd.release_year;
            website = wd.website.clone();
            genre_tags = wd.genres.clone();
            if let Some(v) = &wd.license {
                info_map.insert("License".into(), v.clone());
            }
            if let Some(v) = &wd.platforms {
                info_map.insert("Platforms".into(), v.clone());
            }
            if let Some(v) = &wd.version {
                info_map.insert("Version".into(), v.clone());
            }
            if let Some(v) = &wd.website {
                info_map.insert("Website".into(), v.clone());
            }
            if let Some(v) = &wd.developer {
                info_map.insert("Developer".into(), v.clone());
            }
            if let Some(v) = &wd.publisher {
                info_map.insert("Publisher".into(), v.clone());
            }
            if let Some(y) = wd.release_year {
                info_map.insert("Released".into(), y.to_string());
            }
            if image_url.is_none() {
                if let Some(logo) = wd.logo_url {
                    let _ = logo;
                }
            }
        }
    }

    if website.is_none() {
        website = Some(format!(
            "https://en.wikipedia.org/wiki/{}",
            encode(&title.replace(' ', "_"))
        ));
    }

    let mut cover_url = image_url;
    if cover_url.as_ref().is_some_and(|u| u.to_lowercase().ends_with(".svg")) {
        cover_url = None;
    }
    if cover_url.is_none() {
        if let Some(qid) = wikibase.as_deref() {
            cover_url = wikidata_logo_url(qid);
        }
    }
    if cover_url.is_none() {
        cover_url = og_image_from_site(website.as_deref());
    }

    if description.is_none() && cover_url.is_none() && info_map.is_empty() {
        return Ok(None);
    }

    let cover_path = if with_image {
        cover_url
            .as_deref()
            .and_then(|u| download_app_image(u, media_dir, game_id))
    } else {
        None
    };
    let screenshots = wiki_media_images(&title, 10);
    let info_json = if info_map.is_empty() {
        None
    } else {
        serde_json::to_string(&info_map).ok()
    };

    Ok(Some(AppInfo {
        description,
        developer,
        publisher,
        release_year,
        cover_path,
        wiki_title: Some(title),
        screenshots,
        website,
        info_json,
        genre_tags,
    }))
}

struct WikidataFacts {
    developer: Option<String>,
    publisher: Option<String>,
    release_year: Option<i64>,
    website: Option<String>,
    license: Option<String>,
    platforms: Option<String>,
    version: Option<String>,
    genres: Vec<String>,
    logo_url: Option<String>,
}

fn wikidata_string_claim(entity: &serde_json::Value, pid: &str) -> Option<String> {
    let claims = entity.get("claims")?.get(pid)?.as_array()?;
    let mainsnak = claims.first()?.get("mainsnak")?;
    if mainsnak.get("snaktype")?.as_str()? != "value" {
        return None;
    }
    mainsnak
        .get("datavalue")?
        .get("value")
        .and_then(|v| {
            v.as_str()
                .map(str::to_string)
                .or_else(|| v.get("text").and_then(|t| t.as_str()).map(str::to_string))
        })
        .filter(|s| !s.is_empty())
}

fn wikidata_entity_label(entity: &serde_json::Value, pid: &str) -> Option<String> {
    let claims = entity.get("claims")?.get(pid)?.as_array()?;
    let id = claims
        .first()?
        .get("mainsnak")?
        .get("datavalue")?
        .get("value")?
        .get("id")?
        .as_str()?;
    Some(id.to_string())
}

fn wikidata_time_year(entity: &serde_json::Value, pid: &str) -> Option<i64> {
    let claims = entity.get("claims")?.get(pid)?.as_array()?;
    let time = claims
        .first()?
        .get("mainsnak")?
        .get("datavalue")?
        .get("value")?
        .get("time")?
        .as_str()?;
    parse_release_year(time)
}

fn wikidata_commons_filename(entity: &serde_json::Value, pid: &str) -> Option<String> {
    let claims = entity.get("claims")?.get(pid)?.as_array()?;
    let filename = claims
        .first()?
        .get("mainsnak")?
        .get("datavalue")?
        .get("value")?
        .as_str()?;
    Some(filename.to_string())
}

fn wikidata_facts(qid: &str) -> Option<WikidataFacts> {
    let url = format!(
        "https://www.wikidata.org/w/api.php?action=wbgetentities&ids={qid}&format=json&props=claims"
    );
    let resp = steam_get(&url)?;
    let json: serde_json::Value = resp.into_json().ok()?;
    let entity = json.get("entities")?.get(qid)?;

    let mut genres = Vec::new();
    if let Some(arr) = entity.get("claims").and_then(|c| c.get("P136")).and_then(|v| v.as_array()) {
        for claim in arr.iter().take(5) {
            if let Some(id) = claim
                .get("mainsnak")
                .and_then(|m| m.get("datavalue"))
                .and_then(|d| d.get("value"))
                .and_then(|v| v.get("id"))
                .and_then(|i| i.as_str())
            {
                if let Some(label) = wikidata_item_label(id) {
                    genres.push(label);
                }
            }
        }
    }

    let mut platforms = Vec::new();
    if let Some(arr) = entity.get("claims").and_then(|c| c.get("P400")).and_then(|v| v.as_array()) {
        for claim in arr.iter().take(6) {
            if let Some(id) = claim
                .get("mainsnak")
                .and_then(|m| m.get("datavalue"))
                .and_then(|d| d.get("value"))
                .and_then(|v| v.get("id"))
                .and_then(|i| i.as_str())
            {
                if let Some(label) = wikidata_item_label(id) {
                    platforms.push(label);
                }
            }
        }
    }

    let developer_id = wikidata_entity_label(entity, "P178");
    let publisher_id = wikidata_entity_label(entity, "P123");
    let developer = developer_id.as_deref().and_then(wikidata_item_label);
    let publisher = publisher_id.as_deref().and_then(wikidata_item_label);
    let website = wikidata_string_claim(entity, "P856");
    let license = wikidata_entity_label(entity, "P275").as_deref().and_then(wikidata_item_label);
    let release_year = wikidata_time_year(entity, "P571").or_else(|| wikidata_time_year(entity, "P577"));
    let version = wikidata_string_claim(entity, "P348");
    let logo_file = wikidata_commons_filename(entity, "P154");
    let logo_url = logo_file.map(|f| {
        let name = encode(&f.replace(' ', "_"));
        format!("https://commons.wikimedia.org/wiki/Special:FilePath/{name}")
    });

    Some(WikidataFacts {
        developer,
        publisher,
        release_year,
        website,
        license,
        platforms: if platforms.is_empty() {
            None
        } else {
            Some(platforms.join(", "))
        },
        version,
        genres,
        logo_url,
    })
}

fn wikidata_item_label(qid: &str) -> Option<String> {
    let url = format!(
        "https://www.wikidata.org/w/api.php?action=wbgetentities&ids={qid}&format=json&props=labels&languages=en"
    );
    let resp = steam_get(&url)?;
    let json: serde_json::Value = resp.into_json().ok()?;
    json.get("entities")?
        .get(qid)?
        .get("labels")?
        .get("en")?
        .get("value")?
        .as_str()
        .map(str::to_string)
}

fn wikidata_logo_url(qid: &str) -> Option<String> {
    wikidata_facts(qid).and_then(|f| f.logo_url)
}

fn og_image_from_site(site: Option<&str>) -> Option<String> {
    let site = site?.trim();
    if site.is_empty() || site.contains("wikipedia.org") {
        return None;
    }
    let html = steam_get(site)?.into_string().ok()?;
    for marker in ["property=\"og:image\"", "property='og:image'"] {
        if let Some(idx) = html.find(marker) {
            let chunk = &html[idx..idx.min(idx + 400)];
            if let Some(content) = chunk.split("content=").nth(1) {
                let url = content
                    .trim()
                    .trim_start_matches(['"', '\''])
                    .split(['"', '\''])
                    .next()?
                    .to_string();
                if url.starts_with("http") {
                    return Some(url);
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamReview {
    pub author: String,
    pub text: String,
    pub voted_up: bool,
    pub votes_up: i64,
    pub votes_funny: i64,
    pub playtime_forever: i64,
}

/// Keyless Steam appreviews JSON API.
pub fn fetch_steam_reviews(app_id: u64) -> AppResult<Vec<SteamReview>> {
    let url = format!(
        "https://store.steampowered.com/appreviews/{app_id}?json=1&num_per_page=10&language=english&filter=recent"
    );
    let resp = steam_get(&url).ok_or_else(|| AppError::msg("Could not reach Steam reviews."))?;
    let json: serde_json::Value = resp
        .into_json()
        .map_err(|e| AppError::msg(format!("Invalid Steam reviews JSON: {e}")))?;
    let reviews = json
        .get("reviews")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for r in reviews {
        let author = r
            .get("author")
            .and_then(|a| a.get("steamid"))
            .and_then(|s| s.as_str())
            .unwrap_or("Steam user")
            .to_string();
        let text = r
            .get("review")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        if text.trim().is_empty() {
            continue;
        }
        out.push(SteamReview {
            author,
            text,
            voted_up: r.get("voted_up").and_then(|v| v.as_bool()).unwrap_or(true),
            votes_up: r.get("votes_up").and_then(|v| v.as_i64()).unwrap_or(0),
            votes_funny: r.get("votes_funny").and_then(|v| v.as_i64()).unwrap_or(0),
            playtime_forever: r
                .get("author")
                .and_then(|a| a.get("playtime_forever"))
                .and_then(|p| p.as_i64())
                .unwrap_or(0),
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetacriticReview {
    pub author: String,
    pub text: String,
    pub score: Option<i64>,
    pub date: Option<String>,
}

/// Well-known official sites for common tracked apps (exe name / display name).
pub fn known_app_website(name: &str) -> Option<String> {
    let key = normalize_name(name);
    let url = match key.as_str() {
        "chrome" | "googlechrome" => "https://www.google.com/chrome/",
        "telegram" => "https://telegram.org",
        "discord" => "https://discord.com",
        "spotify" => "https://www.spotify.com",
        "firefox" => "https://www.mozilla.org/firefox/",
        "zen" | "zenbrowser" => "https://zen-browser.app",
        "cursor" => "https://cursor.com",
        "whatsapp" => "https://www.whatsapp.com",
        "anydesk" => "https://anydesk.com",
        "dockerdesktop" | "docker" => "https://www.docker.com",
        "claude" => "https://claude.ai",
        "code" | "vscode" | "visualstudiocode" => "https://code.visualstudio.com",
        _ => return None,
    };
    Some(url.to_string())
}

fn fetch_html(url: &str) -> Option<String> {
    let resp = steam_get(url)?;
    let mut buf = String::new();
    resp.into_reader()
        .take(3_000_000)
        .read_to_string(&mut buf)
        .ok()?;
    if buf.len() < 200 {
        return None;
    }
    Some(buf)
}

fn slugify_metacritic(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if c.is_whitespace() || c == '-' || c == ':' || c == '\'' {
            if !prev_dash && !out.is_empty() {
                out.push('-');
                prev_dash = true;
            }
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// Platform/nav links on a Metacritic search page that aren't game slugs.
const MC_NAV_SLUGS: &[&str] = &[
    "all", "pc", "ps5", "ps4", "ps3", "ps2", "ps-vita", "playstation-5", "playstation-4",
    "xbox-series-x", "xbox-one", "xbox-360", "xbox", "switch", "switch-2", "nintendo-64",
    "wii-u", "wii", "3ds", "ds", "ios", "android", "stadia", "vita", "legacy", "new",
    "all-time", "upcoming", "popular", "game", "games",
];

fn mc_slug_segment(html: &str, start: usize) -> (String, usize) {
    let bytes = html.as_bytes();
    let mut len = 0;
    while start + len < bytes.len() {
        let c = bytes[start + len];
        if c.is_ascii_alphanumeric() || c == b'-' {
            len += 1;
        } else {
            break;
        }
    }
    let slug = html[start..start + len].trim_matches('-').to_string();
    (slug, start + len.max(1))
}

fn extract_mc_slugs(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = html[from..].find("/game/") {
        let mut pos = from + rel + "/game/".len();
        let (first, next) = mc_slug_segment(html, pos);
        pos = next;
        let slug = if MC_NAV_SLUGS.contains(&first.as_str()) && bytes_is_slash(html, pos) {
            let (second, next2) = mc_slug_segment(html, pos + 1);
            pos = next2;
            second
        } else {
            first
        };
        if !slug.is_empty()
            && slug.len() <= 120
            && !MC_NAV_SLUGS.contains(&slug.as_str())
            && !out.contains(&slug)
        {
            out.push(slug);
        }
        from = pos;
    }
    out
}

fn bytes_is_slash(html: &str, pos: usize) -> bool {
    html.as_bytes().get(pos) == Some(&b'/')
}

fn mc_page_title(html: &str) -> Option<String> {
    for needle in ["property=\"og:title\" content=\"", "property='og:title' content='"] {
        if let Some(i) = html.find(needle) {
            let rest = &html[i + needle.len()..];
            if let Some(end) = rest.find('"').or_else(|| rest.find('\'')) {
                return Some(decode_html_entities(rest[..end].trim()));
            }
        }
    }
    None
}

/// Whether a Metacritic slug belongs to this game (reviews or title match).
pub fn metacritic_slug_valid(slug: &str, name: &str) -> bool {
    let slug = slug.trim().trim_matches('/');
    if slug.is_empty() || slug.contains('/') || MC_NAV_SLUGS.contains(&slug) {
        return false;
    }
    let slug_words = slug.replace('-', " ");
    if name_similarity(name, &slug_words) >= 0.38 || names_match(name, &slug_words) {
        // fast path — slug itself is close enough
    } else {
        // still allow if the page title matches
        let url = format!("https://www.metacritic.com/game/{slug}/");
        let Some(html) = fetch_html(&url) else {
            return false;
        };
        if let Some(title) = mc_page_title(&html) {
            if name_similarity(name, &title) >= 0.38 || names_match(name, &title) {
                return true;
            }
        }
        return parse_metacritic_reviews(&html).len() >= 1
            && html.contains("data-testid=\"product-title\"");
    }
    let reviews = fetch_metacritic_reviews(slug);
    if reviews.map(|r| !r.is_empty()).unwrap_or(false) {
        return true;
    }
    let url = format!("https://www.metacritic.com/game/{slug}/");
    fetch_html(&url)
        .map(|html| {
            mc_page_title(&html)
                .map(|t| name_similarity(name, &t) >= 0.35 || names_match(name, &t))
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

/// Resolve a Metacritic game slug (e.g. `hollow-knight`) from a game name.
pub fn resolve_metacritic_slug(name: &str) -> Option<String> {
    let q = slugify_metacritic(name);
    if q.is_empty() {
        return None;
    }
    if metacritic_slug_valid(&q, name) {
        return Some(q.clone());
    }
    let url = format!("https://www.metacritic.com/search/{q}/?category=13");
    let Some(html) = fetch_html(&url) else {
        return None;
    };
    let mut candidates = extract_mc_slugs(&html);
    candidates.sort_by(|a, b| {
        name_similarity(name, b)
            .partial_cmp(&name_similarity(name, a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.dedup();
    for slug in candidates {
        if metacritic_slug_valid(&slug, name) {
            return Some(slug);
        }
    }
    None
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

fn strip_tags(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(c);
        }
    }
    decode_html_entities(out.trim())
}

/// Inner text of the first element carrying `data-testid="<id>"` within `block`.
fn testid_inner(block: &str, id: &str) -> Option<String> {
    let key = format!("data-testid=\"{id}\"");
    let i = block.find(&key)?;
    let after = &block[i + key.len()..];
    let gt = after.find('>')?;
    let rest = &after[gt + 1..];
    let end = rest.find("</")?;
    let text = strip_tags(&rest[..end]);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Scrape recent user reviews from a Metacritic game slug.
///
/// Reviews are server-rendered as `data-testid="review-card"` blocks (the old
/// `c-siteReviewReview` class is gone). Each card holds a date, a `/user/<name>/`
/// author link with a `User score N out of 10` badge, and a quote block.
pub fn fetch_metacritic_reviews(slug: &str) -> AppResult<Vec<MetacriticReview>> {
    let slug = slug.trim().trim_matches('/');
    if slug.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("https://www.metacritic.com/game/{slug}/user-reviews/");
    let html = fetch_html(&url).ok_or_else(|| AppError::msg("Could not reach Metacritic."))?;
    Ok(parse_metacritic_reviews(&html))
}

/// Pure HTML → reviews parser (kept separate so it can be unit-tested offline).
fn parse_metacritic_reviews(html: &str) -> Vec<MetacriticReview> {
    const CARD: &str = "data-testid=\"review-card\"";
    // Collect card start offsets so each block is bounded by the next card.
    let mut starts = Vec::new();
    let mut from = 0;
    while let Some(rel) = html[from..].find(CARD) {
        let at = from + rel;
        starts.push(at);
        from = at + CARD.len();
    }

    let mut out = Vec::new();
    for (idx, &start) in starts.iter().enumerate() {
        if out.len() >= 12 {
            break;
        }
        let end = starts.get(idx + 1).copied().unwrap_or(html.len());
        let block = &html[start..end];

        let text = match testid_inner(block, "review-card-quote-block") {
            Some(t) if t.len() >= 4 => t,
            _ => continue,
        };

        let date = testid_inner(block, "review-card-date");

        // Author from the /user/<name>/ profile link in the card header.
        let author = block
            .find("/user/")
            .and_then(|i| block[i + "/user/".len()..].split_once(['/', '"']))
            .map(|(u, _)| u.trim())
            .filter(|u| !u.is_empty())
            .map(|u| u.to_string())
            .unwrap_or_else(|| "Metacritic user".to_string());

        // Score from the `User score N out of 10` badge label.
        let score = block.find("User score ").and_then(|i| {
            block[i + "User score ".len()..]
                .split_whitespace()
                .next()?
                .parse::<i64>()
                .ok()
        });

        out.push(MetacriticReview {
            author,
            text,
            score,
            date,
        });
    }

    out
}

// ---------- API keys (compile-time baked from .env via build.rs) ----------

/// A runtime env var wins; otherwise the value baked at compile time by build.rs.
fn rawg_key() -> Option<String> {
    std::env::var("RAWG_API_KEY")
        .ok()
        .or_else(|| option_env!("RAWG_API_KEY").map(str::to_string))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn youtube_key() -> Option<String> {
    std::env::var("YOUTUBE_API_KEY")
        .ok()
        .or_else(|| option_env!("YOUTUBE_API_KEY").map(str::to_string))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn steamgriddb_key() -> Option<String> {
    std::env::var("STEAMGRIDDB_API_KEY")
        .ok()
        .or_else(|| option_env!("STEAMGRIDDB_API_KEY").map(str::to_string))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn get_json(url: &str) -> Option<serde_json::Value> {
    steam_get(url)?.into_json::<serde_json::Value>().ok()
}

// ---------- Per-game theme audio ----------

/// Max length for OST mix extras — longer uploads are usually full compilations.
const MAX_THEME_SECS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
struct YoutubeSearchHit {
    id: String,
    duration_secs: Option<u64>,
}

/// Parse YouTube `lengthText.simpleText` values like `3:45` or `1:02:30`.
fn parse_duration_simple_text(s: &str) -> Option<u64> {
    let parts: Vec<u64> = s
        .trim()
        .split(':')
        .filter_map(|p| p.parse().ok())
        .collect();
    match parts.as_slice() {
        [m, s] if *m < 100 => Some(m * 60 + s),
        [h, m, s] => Some(h * 3600 + m * 60 + s),
        _ => None,
    }
}

/// Read `lengthText.simpleText` from a `videoRenderer` window after a video id.
fn extract_length_text_secs(window: &str) -> Option<u64> {
    let idx = window.find("\"lengthText\"")?;
    let sub = &window[idx..window.len().min(idx + 500)];
    const SIMPLE: &str = "\"simpleText\":\"";
    let start = sub.find(SIMPLE)? + SIMPLE.len();
    let end = sub[start..].find('"')?;
    parse_duration_simple_text(&sub[start..start + end])
}

/// Scan a YouTube results page for video ids paired with duration when present.
fn extract_youtube_search_hits(html: &str, scan_limit: usize) -> Vec<YoutubeSearchHit> {
    if scan_limit == 0 {
        return Vec::new();
    }
    const NEEDLE: &str = "\"videoId\":\"";
    let mut from = 0;
    let mut out = Vec::new();
    while out.len() < scan_limit {
        let Some(rel) = html[from..].find(NEEDLE) else {
            break;
        };
        let id_start = from + rel + NEEDLE.len();
        let id: String = html[id_start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        if id.len() == 11 && !out.iter().any(|h: &YoutubeSearchHit| h.id == id) {
            let window_end = (id_start + 2500).min(html.len());
            let duration_secs = extract_length_text_secs(&html[id_start..window_end]);
            out.push(YoutubeSearchHit { id, duration_secs });
        }
        from = id_start;
    }
    out
}

fn theme_extra_duration_ok(hit: &YoutubeSearchHit) -> bool {
    hit.duration_secs.is_some_and(|s| s <= MAX_THEME_SECS)
}

/// Pick the main theme — always resolved via the targeted main-theme search first.
fn youtube_main_theme_id(name: &str) -> Option<String> {
    if let Some(key) = youtube_key() {
        if let Some(id) = youtube_theme_id_api(name, &key) {
            return Some(id);
        }
    }
    for query in [
        format!("{name} original soundtrack main theme"),
        format!("{name} main theme official"),
        format!("{name} original soundtrack"),
    ] {
        let Some(html) = youtube_search_html(&query) else {
            continue;
        };
        let hits = extract_youtube_search_hits(&html, 12);
        // Prefer a short main theme, but always return something if available.
        if let Some(id) = hits
            .iter()
            .find(|h| h.duration_secs.is_some_and(|s| s <= MAX_THEME_SECS))
            .map(|h| h.id.clone())
            .or_else(|| hits.first().map(|h| h.id.clone()))
        {
            return Some(id);
        }
    }
    None
}

/// How many tracks to keep per game from a found OST playlist. A YouTube playlist
/// page ships ~100 ids in its initial payload without continuation; that is the
/// effective ceiling and is plenty for a full game soundtrack.
const MAX_OST_TRACKS: usize = 100;

/// Resolve playable theme audio for a game. Preference order for the OST:
/// 1. a real YouTube **playlist** (full official/community OST → up to ~100 tracks);
/// 2. otherwise a duration-filtered scrape of OST search results (≤30 tracks);
/// always with the targeted main theme first and a keyless 30s iTunes preview.
pub fn resolve_theme(name: &str) -> ThemeResolution {
    let main = youtube_main_theme_id(name);

    let playlist_id = youtube_search_playlist_id(name);
    let mut track_ids: Vec<String> = Vec::new();
    let mut track_titles: HashMap<String, String> = HashMap::new();

    if let Some(ref id) = main {
        track_ids.push(id.clone());
    }

    if let Some(ref list) = playlist_id {
        let (ids, titles) = youtube_playlist_entries(list, MAX_OST_TRACKS);
        track_titles.extend(titles);
        for vid in ids {
            if track_ids.len() >= MAX_OST_TRACKS {
                break;
            }
            if !track_ids.contains(&vid) {
                track_ids.push(vid);
            }
        }
    }

    // Fallback (or top-up) when no playlist was found: scrape OST search results,
    // dropping hour-long compilations via the duration filter.
    if playlist_id.is_none() {
        if let Some(html) = youtube_search_html(&format!("{name} original soundtrack OST")) {
            track_titles.extend(extract_youtube_video_titles(&html, 60));
            for hit in extract_youtube_search_hits(&html, 60) {
                if track_ids.len() >= 30 {
                    break;
                }
                if track_ids.contains(&hit.id) {
                    continue;
                }
                if theme_extra_duration_ok(&hit) {
                    track_ids.push(hit.id);
                }
            }
        }
    }

    fill_youtube_titles_oembed(&mut track_titles, &track_ids, 24);

    ThemeResolution {
        youtube_id: main.or_else(|| track_ids.first().cloned()),
        audio_url: itunes_theme_url(name),
        track_ids,
        playlist_id,
        track_titles,
    }
}

/// Find a YouTube **playlist** id for a game's OST. Uses the "Playlist" search
/// filter (`sp=EgIQAw%3D%3D`) across a few query phrasings and returns the first
/// plausible list id (`PL…`, `OLAK5uy_…`, `RDCLAK…`, or any long id). Keyless.
fn youtube_search_playlist_id(name: &str) -> Option<String> {
    const PLAYLIST_FILTER: &str = "EgIQAw%3D%3D";
    for query in [
        format!("{name} full OST"),
        format!("{name} original soundtrack complete"),
        format!("{name} OST playlist"),
        format!("{name} soundtrack"),
    ] {
        let url = format!(
            "https://www.youtube.com/results?search_query={}&sp={}&hl=en&gl=US",
            encode(&query),
            PLAYLIST_FILTER
        );
        let Some(html) = youtube_get_html(&url) else {
            continue;
        };
        if let Some(id) = extract_youtube_playlist_id(&html) {
            return Some(id);
        }
    }
    None
}

/// Video ids plus human titles scraped from a playlist page (one HTTP round-trip).
fn youtube_playlist_entries(list_id: &str, limit: usize) -> (Vec<String>, HashMap<String, String>) {
    let url = format!(
        "https://www.youtube.com/playlist?list={}&hl=en&gl=US",
        encode(list_id)
    );
    youtube_get_html(&url)
        .map(|html| {
            let ids = extract_youtube_video_ids(&html, limit);
            let titles = extract_youtube_video_titles(&html, limit);
            (ids, titles)
        })
        .unwrap_or_default()
}

/// Parse a YouTube oEmbed JSON payload for the human video title.
pub(crate) fn parse_youtube_oembed_title(json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()?
        .get("title")?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Decode a JSON string fragment scraped from YouTube markup (`\u0026`, etc.).
fn decode_json_string_fragment(raw: &str) -> String {
    serde_json::from_str::<String>(&format!("\"{raw}\"")).unwrap_or_else(|_| raw.to_string())
}

/// First `"title":{"content":"…"}` in a YouTube page window.
fn extract_youtube_title_content(window: &str) -> Option<String> {
    const NEEDLE: &str = "\"title\":{\"content\":\"";
    let idx = window.find(NEEDLE)?;
    let start = idx + NEEDLE.len();
    let end = window[start..].find('"')?;
    Some(decode_json_string_fragment(&window[start..start + end]))
}

/// Pair video ids with titles from a YouTube playlist/search page.
pub(crate) fn extract_youtube_video_titles(html: &str, limit: usize) -> HashMap<String, String> {
    if limit == 0 {
        return HashMap::new();
    }
    const NEEDLE: &str = "\"videoId\":\"";
    let mut from = 0;
    let mut out = HashMap::new();
    while out.len() < limit {
        let Some(rel) = html[from..].find(NEEDLE) else {
            break;
        };
        let id_start = from + rel + NEEDLE.len();
        let id: String = html[id_start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        if id.len() != 11 || out.contains_key(&id) {
            from = id_start;
            continue;
        }
        let window_end = (id_start + 4500).min(html.len());
        if let Some(title) = extract_youtube_title_content(&html[id_start..window_end]) {
            out.insert(id, title);
        }
        from = id_start;
    }
    out
}

/// Keyless oEmbed title lookup for a single 11-char video id.
pub(crate) fn youtube_video_title_oembed(vid: &str) -> Option<String> {
    if vid.len() != 11 {
        return None;
    }
    let url = format!(
        "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={vid}&format=json"
    );
    youtube_get_oembed(&url).and_then(|body| parse_youtube_oembed_title(&body))
}

fn youtube_get_oembed(url: &str) -> Option<String> {
    let resp = ureq::get(url)
        .set("User-Agent", UA)
        .timeout(TIMEOUT)
        .call()
        .ok()?;
    if resp.status() != 200 {
        return None;
    }
    let mut body = String::new();
    resp.into_reader().read_to_string(&mut body).ok()?;
    Some(body)
}

/// Fill missing titles via oEmbed (throttled; capped so enrichment stays fast).
fn fill_youtube_titles_oembed(
    titles: &mut HashMap<String, String>,
    ids: &[String],
    max_fetch: usize,
) {
    let mut fetched = 0usize;
    for id in ids {
        if titles.contains_key(id) {
            continue;
        }
        if fetched >= max_fetch {
            break;
        }
        if let Some(title) = youtube_video_title_oembed(id) {
            titles.insert(id.clone(), title);
            fetched += 1;
            thread::sleep(Duration::from_millis(60));
        }
    }
}

/// First plausible `"playlistId":"…"` in a results/search page. Playlist ids are
/// longer than the 11-char video ids and usually start with a known prefix.
fn extract_youtube_playlist_id(html: &str) -> Option<String> {
    const NEEDLE: &str = "\"playlistId\":\"";
    let mut from = 0;
    while let Some(rel) = html[from..].find(NEEDLE) {
        let start = from + rel + NEEDLE.len();
        let id: String = html[start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        from = start;
        let looks_real = id.len() >= 16
            || id.starts_with("PL")
            || id.starts_with("OLAK5uy_")
            || id.starts_with("RDCLAK")
            || id.starts_with("RD");
        if looks_real && id.len() >= 13 {
            return Some(id);
        }
    }
    None
}

fn youtube_theme_id_api(name: &str, key: &str) -> Option<String> {
    let q = encode(&format!("{name} original soundtrack main theme"));
    let url = format!(
        "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&videoCategoryId=10&maxResults=1&q={q}&key={key}"
    );
    get_json(&url)?
        .get("items")?
        .as_array()?
        .first()?
        .get("id")?
        .get("videoId")?
        .as_str()
        .map(|s| s.to_string())
}

fn youtube_search_html(query: &str) -> Option<String> {
    let url = format!(
        "https://www.youtube.com/results?search_query={}&hl=en&gl=US",
        encode(query)
    );
    youtube_get_html(&url)
}

/// GET a YouTube page as HTML with browser-like headers, skipping the EU
/// cookie-consent interstitial so we get the real (data-bearing) page.
fn youtube_get_html(url: &str) -> Option<String> {
    let resp = ureq::get(url)
        .set("User-Agent", UA)
        .set("Accept-Language", "en-US,en;q=0.9")
        .set("Cookie", "CONSENT=YES+1; SOCS=CAI")
        .timeout(TIMEOUT)
        .call()
        .ok()?;
    let mut buf = String::new();
    resp.into_reader()
        .take(6_000_000)
        .read_to_string(&mut buf)
        .ok()?;
    if buf.len() < 1000 {
        return None;
    }
    Some(buf)
}

/// First `"videoId":"<id>"` in a YouTube results page. Ids are exactly 11 chars
/// of `[A-Za-z0-9_-]`. Kept pure so it can be unit-tested offline.
fn extract_youtube_video_id(html: &str) -> Option<String> {
    extract_youtube_video_ids(html, 1).into_iter().next()
}

/// Collect up to `limit` unique 11-char YouTube video ids from a results page.
fn extract_youtube_video_ids(html: &str, limit: usize) -> Vec<String> {
    if limit == 0 {
        return Vec::new();
    }
    const NEEDLE: &str = "\"videoId\":\"";
    let mut from = 0;
    let mut out = Vec::new();
    while out.len() < limit {
        let Some(rel) = html[from..].find(NEEDLE) else {
            break;
        };
        let start = from + rel + NEEDLE.len();
        let id: String = html[start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        if id.len() == 11 && !out.contains(&id) {
            out.push(id);
        }
        from = start;
    }
    out
}

fn itunes_theme_url(name: &str) -> Option<String> {
    let term = encode(&format!("{name} soundtrack"));
    let url = format!("https://itunes.apple.com/search?term={term}&entity=song&limit=1");
    get_json(&url)?
        .get("results")?
        .as_array()?
        .first()?
        .get("previewUrl")?
        .as_str()
        .map(|s| s.to_string())
}

// ---------- Live game statistics (players, owners, revenue, reviews) ----------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameStats {
    /// Live players in-game right now (Steam, exact).
    pub current_players: Option<i64>,
    /// Peak concurrent players yesterday (SteamSpy `ccu`).
    pub peak_concurrent: Option<i64>,
    pub owners_min: Option<i64>,
    pub owners_max: Option<i64>,
    pub owners_label: Option<String>,
    pub price_usd: Option<f64>,
    /// Rough gross estimate: owners midpoint × price. Marked "estimated" in UI.
    pub revenue_estimate_usd: Option<f64>,
    pub total_reviews: Option<i64>,
    pub positive_reviews: Option<i64>,
    pub positive_pct: Option<i64>,
    pub review_desc: Option<String>,
    pub avg_playtime_minutes: Option<i64>,
    pub median_playtime_minutes: Option<i64>,
}

/// Fetch live + estimated stats for a Steam appid (all keyless sources).
pub fn fetch_game_stats(appid: u64) -> GameStats {
    let mut s = GameStats::default();

    // Exact: players in-game right now.
    if let Some(json) = get_json(&format!(
        "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid={appid}"
    )) {
        s.current_players = json
            .get("response")
            .and_then(|r| r.get("player_count"))
            .and_then(|v| v.as_i64());
    }

    // Estimates: owners, peak concurrent, price, playtimes (SteamSpy).
    if let Some(json) = get_json(&format!(
        "https://steamspy.com/api.php?request=appdetails&appid={appid}"
    )) {
        s.peak_concurrent = json.get("ccu").and_then(|v| v.as_i64()).filter(|v| *v > 0);
        s.avg_playtime_minutes = json
            .get("average_forever")
            .and_then(|v| v.as_i64())
            .filter(|v| *v > 0);
        s.median_playtime_minutes = json
            .get("median_forever")
            .and_then(|v| v.as_i64())
            .filter(|v| *v > 0);
        s.price_usd = json
            .get("price")
            .and_then(|v| v.as_str())
            .and_then(|p| p.parse::<f64>().ok())
            .map(|cents| cents / 100.0);
        if let Some(owners) = json.get("owners").and_then(|v| v.as_str()) {
            let nums: Vec<i64> = owners
                .split("..")
                .filter_map(|part| {
                    let digits: String = part.chars().filter(|c| c.is_ascii_digit()).collect();
                    digits.parse::<i64>().ok()
                })
                .collect();
            s.owners_min = nums.first().copied();
            s.owners_max = nums.get(1).copied().or(s.owners_min);
            s.owners_label = Some(owners.replace("..", "–").split_whitespace().collect::<Vec<_>>().join(" "));
        }
        // SteamSpy review counts as a fallback before the richer Steam summary.
        let pos = json.get("positive").and_then(|v| v.as_i64());
        let neg = json.get("negative").and_then(|v| v.as_i64());
        if let (Some(p), Some(n)) = (pos, neg) {
            if p + n > 0 {
                s.total_reviews = Some(p + n);
                s.positive_reviews = Some(p);
                s.positive_pct = Some((p * 100) / (p + n));
            }
        }
    }

    // Exact: Steam's review summary (nicer description + authoritative totals).
    if let Some(json) = get_json(&format!(
        "https://store.steampowered.com/appreviews/{appid}?json=1&language=all&purchase_type=all&num_per_page=0"
    )) {
        if let Some(qs) = json.get("query_summary") {
            if let Some(t) = qs.get("total_reviews").and_then(|v| v.as_i64()).filter(|v| *v > 0) {
                s.total_reviews = Some(t);
            }
            if let Some(p) = qs.get("total_positive").and_then(|v| v.as_i64()) {
                s.positive_reviews = Some(p);
            }
            s.review_desc = qs
                .get("review_score_desc")
                .and_then(|v| v.as_str())
                .map(|x| x.to_string())
                .filter(|x| !x.is_empty() && x != "No user reviews");
            if let (Some(p), Some(t)) = (s.positive_reviews, s.total_reviews) {
                if t > 0 {
                    s.positive_pct = Some((p * 100) / t);
                }
            }
        }
    }

    // Estimate gross revenue from owners midpoint × price.
    if let (Some(min), Some(max), Some(price)) = (s.owners_min, s.owners_max, s.price_usd) {
        if price > 0.0 {
            let mid = (min + max) as f64 / 2.0;
            s.revenue_estimate_usd = Some(mid * price);
        }
    }

    s
}

// ---------- RAWG fallback for games not on Steam (needs RAWG_API_KEY) ----------

fn rawg_truncate(s: &str, max: usize) -> String {
    let t = s.trim();
    let mut out: String = t.chars().take(max).collect();
    if t.chars().count() > max {
        out.push('…');
    }
    out
}

fn fetch_rawg_game_info(
    name: &str,
    media_dir: &Path,
    game_id: &str,
    with_cover: bool,
) -> AppResult<Option<GameMetadata>> {
    let Some(key) = rawg_key() else {
        return Ok(None);
    };
    let q = encode(name);
    let Some(search) = get_json(&format!(
        "https://api.rawg.io/api/games?key={key}&search={q}&page_size=1&search_precise=true"
    )) else {
        return Ok(None);
    };
    let Some(first) = search
        .get("results")
        .and_then(|r| r.as_array())
        .and_then(|a| a.first())
    else {
        return Ok(None);
    };

    let rawg_name = first.get("name").and_then(|v| v.as_str()).unwrap_or("");
    if !rawg_name.is_empty() && !names_match(name, rawg_name) {
        let qn = normalize_name(name);
        let sn = normalize_name(rawg_name);
        let overlap = qn.len().min(sn.len()) as f32 / qn.len().max(sn.len()).max(1) as f32;
        if overlap < 0.45 && !sn.contains(&qn) && !qn.contains(&sn) {
            return Ok(None);
        }
    }

    let id = first.get("id").and_then(|v| v.as_i64());
    let release_year = first
        .get("released")
        .and_then(|v| v.as_str())
        .and_then(parse_release_year);
    let metacritic = first.get("metacritic").and_then(|v| v.as_i64());
    let background_url = first
        .get("background_image")
        .and_then(|v| v.as_str())
        .map(String::from)
        .filter(|s| !s.trim().is_empty());

    let mut genres: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(arr) = first.get("genres").and_then(|v| v.as_array()) {
        for g in arr {
            if let Some(n) = g.get("name").and_then(|v| v.as_str()) {
                push_tag(&mut genres, &mut seen, n);
            }
        }
    }
    if let Some(arr) = first.get("tags").and_then(|v| v.as_array()) {
        for t in arr.iter().take(12) {
            if let Some(n) = t.get("name").and_then(|v| v.as_str()) {
                push_tag(&mut genres, &mut seen, n);
            }
        }
    }
    genres.truncate(20);

    // Details endpoint: long description, developer, website.
    let mut short_description = None;
    let mut developer = None;
    let mut website = None;
    let mut trailer_url = None;
    let mut screenshots: Vec<String> = Vec::new();
    if let Some(id) = id {
        if let Some(det) = get_json(&format!("https://api.rawg.io/api/games/{id}?key={key}")) {
            short_description = det
                .get("description_raw")
                .and_then(|v| v.as_str())
                .map(|s| rawg_truncate(s, 600))
                .filter(|s| !s.is_empty());
            developer = det
                .get("developers")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|d| d.get("name"))
                .and_then(|v| v.as_str())
                .map(String::from);
            website = det
                .get("website")
                .and_then(|v| v.as_str())
                .map(String::from)
                .filter(|s| !s.trim().is_empty());
        }
        if let Some(sc) = get_json(&format!("https://api.rawg.io/api/games/{id}/screenshots?key={key}")) {
            if let Some(arr) = sc.get("results").and_then(|v| v.as_array()) {
                for shot in arr.iter().take(12) {
                    if let Some(img) = shot.get("image").and_then(|v| v.as_str()) {
                        screenshots.push(img.to_string());
                    }
                }
            }
        }
        if let Some(mv) = get_json(&format!("https://api.rawg.io/api/games/{id}/movies?key={key}")) {
            trailer_url = mv
                .get("results")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|m| m.get("data"))
                .and_then(|d| d.get("max").or_else(|| d.get("480")))
                .and_then(|v| v.as_str())
                .map(String::from);
        }
    }

    let theme_name = if rawg_name.is_empty() { name } else { rawg_name };
    let theme = resolve_theme(theme_name);

    // RAWG has no portrait cover. Keyless-first: Wikipedia box art (or SteamGridDB
    // if a key is set), then RAWG's landscape background image as a last resort.
    let cover_path = if with_cover {
        resolve_fallback_cover(theme_name, media_dir, game_id, background_url.as_deref())
    } else {
        None
    };

    Ok(Some(GameMetadata {
        developer,
        release_year,
        metacritic,
        genres,
        short_description,
        cover_path,
        steam_app_id: None,
        screenshots,
        background_url,
        website,
        trailer_url,
        theme_youtube_id: theme.youtube_id,
        theme_audio_url: theme.audio_url,
        theme_track_ids: theme.track_ids,
        theme_playlist_id: theme.playlist_id,
        theme_track_titles: theme.track_titles,
    }))
}

// ---------- Twitch live streams (keyless, public web GQL) ----------

const TWITCH_GQL: &str = "https://gql.twitch.tv/gql";
/// Twitch's public web Client-Id (used by twitch.tv itself); enables anonymous,
/// keyless GraphQL reads. No OAuth, no API key, no new `.env` entry.
const TWITCH_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";

/// A game's top live Twitch stream right now (plus the resolved category, so the
/// UI can deep-link the directory even when nobody is live).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwitchLive {
    pub game: String,
    pub slug: String,
    pub channel: Option<String>,
    pub channel_name: Option<String>,
    pub title: Option<String>,
    pub viewers: i64,
}

fn twitch_gql(body: serde_json::Value) -> Option<serde_json::Value> {
    ureq::post(TWITCH_GQL)
        .set("Client-Id", TWITCH_CLIENT_ID)
        .set("User-Agent", UA)
        .timeout(TIMEOUT)
        .send_json(body)
        .ok()?
        .into_json()
        .ok()
}

/// Best category match for a (possibly imperfect) game name → (canonical name, slug).
fn parse_search_categories(json: &serde_json::Value) -> Option<(String, String)> {
    let node = json
        .get("data")?
        .get("searchCategories")?
        .get("edges")?
        .get(0)?
        .get("node")?;
    let name = node.get("name")?.as_str()?.to_string();
    let slug = node.get("slug").and_then(|v| v.as_str()).unwrap_or("").to_string();
    Some((name, slug))
}

/// Top live stream from a batched `DirectoryPage_Game` response.
fn parse_top_stream(json: &serde_json::Value) -> Option<(String, String, String, i64)> {
    let node = json
        .get(0)?
        .get("data")?
        .get("game")?
        .get("streams")?
        .get("edges")?
        .get(0)?
        .get("node")?;
    let login = node.get("broadcaster")?.get("login")?.as_str()?.to_string();
    let display = node
        .get("broadcaster")?
        .get("displayName")
        .and_then(|v| v.as_str())
        .unwrap_or(&login)
        .to_string();
    let title = node.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let viewers = node.get("viewersCount").and_then(|v| v.as_i64()).unwrap_or(0);
    Some((login, display, title, viewers))
}

/// Resolve the game's Twitch category, then its current top live stream. Keyless.
pub fn twitch_top_live(query: &str) -> Option<TwitchLive> {
    // 1. Resolve the canonical category (tolerates casing/punctuation differences).
    let search = twitch_gql(serde_json::json!({
        "query": "query($q:String!){searchCategories(query:$q,first:1){edges{node{name slug}}}}",
        "variables": { "q": query }
    }))?;
    let (game, slug) = parse_search_categories(&search)?;

    // 2. Top live stream for that category (batched op, mirroring the web client).
    let streams = twitch_gql(serde_json::json!([{
        "operationName": "DirectoryPage_Game",
        "variables": { "name": game, "options": { "sort": "VIEWER_COUNT" }, "limit": 1, "includeIsDJ": false },
        "query": "query DirectoryPage_Game($name: String!, $options: GameStreamOptions, $limit: Int){game(name:$name){displayName streams(first:$limit,options:$options){edges{node{broadcaster{login displayName} title viewersCount}}}}}"
    }]));

    let top = streams.as_ref().and_then(parse_top_stream);
    Some(TwitchLive {
        game,
        slug,
        channel: top.as_ref().map(|t| t.0.clone()),
        channel_name: top.as_ref().map(|t| t.1.clone()),
        title: top.as_ref().map(|t| t.2.clone()),
        viewers: top.as_ref().map(|t| t.3).unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_punctuation() {
        assert_eq!(normalize_name("Halo: CE"), normalize_name("halo ce"));
    }

    #[test]
    fn names_match_substring() {
        assert!(name_similarity("The Witcher 3", "The Witcher 3: Wild Hunt") >= 0.55);
        assert!(!names_match(
            "Hollow Knight",
            "Hollow Knight - Silksong"
        ));
    }

    #[test]
    fn names_reject_loose_substring() {
        assert!(!names_match(
            "Assassin's Creed",
            "Assassin's Creed Black Flag Resynced"
        ));
        assert!(
            name_similarity("Assassin's Creed II", "Assassin's Creed 2") >= 0.65
        );
    }

    #[test]
    fn names_reject_unrelated() {
        assert!(!names_match("Minecraft", "Counter-Strike 2"));
    }

    #[test]
    fn parse_year_from_steam_date() {
        assert_eq!(parse_release_year("Sep 12, 2023"), Some(2023));
        assert_eq!(parse_release_year("2020"), Some(2020));
        assert_eq!(parse_release_year("Coming soon"), None);
    }

    #[test]
    fn name_similarity_ranks_ac_titles() {
        let ac = name_similarity("Assassin's Creed Odyssey", "Assassin's Creed Odyssey");
        let wrong = name_similarity(
            "Assassin's Creed Odyssey",
            "The Adventures of Elliot: The Millennium Tales",
        );
        assert!(ac > 0.9);
        assert!(wrong < 0.35);
    }

    #[test]
    fn slugify_matches_metacritic_slug() {
        assert_eq!(slugify_metacritic("Hollow Knight"), "hollow-knight");
        assert_eq!(slugify_metacritic("The Witcher 3: Wild Hunt"), "the-witcher-3-wild-hunt");
    }

    #[test]
    fn mc_extract_skips_platform_segment() {
        let html = r#"<a href="/game/pc/assassins-creed-valhalla/">AC</a><a href="/game/all/">All</a>"#;
        let slugs = extract_mc_slugs(html);
        assert!(slugs.contains(&"assassins-creed-valhalla".to_string()));
        assert!(!slugs.contains(&"all".to_string()));
    }

    #[test]
    fn extracts_first_youtube_video_id() {
        let html = r#"...{"videoRenderer":{"videoId":"dQw4w9WgXcQ","title":...}}..."#;
        assert_eq!(
            extract_youtube_video_id(html).as_deref(),
            Some("dQw4w9WgXcQ")
        );
        // Skips short/garbage ids, finds the first valid 11-char id.
        let messy = r#""videoId":"short","videoId":"abcdefghijk""#;
        assert_eq!(extract_youtube_video_id(messy).as_deref(), Some("abcdefghijk"));
        assert_eq!(extract_youtube_video_id("no ids here"), None);
    }

    #[test]
    fn extracts_multiple_youtube_video_ids() {
        let html = r#"
            "videoId":"dQw4w9WgXcQ"
            "videoId":"abcdefghijk"
            "videoId":"dQw4w9WgXcQ"
            "videoId":"12345678901"
        "#;
        assert_eq!(
            extract_youtube_video_ids(html, 5),
            vec![
                "dQw4w9WgXcQ".to_string(),
                "abcdefghijk".to_string(),
                "12345678901".to_string()
            ]
        );
    }

    /// Live, network-gated end-to-end check of the OST resolver. Run explicitly
    /// with `cargo test --lib -- --ignored resolve_full_ost_live`.
    #[test]
    #[ignore]
    fn resolve_full_ost_live() {
        for name in ["Hollow Knight", "Baldur's Gate 3", "Batman: Arkham Knight"] {
            let theme = resolve_theme(name);
            println!(
                "{name}: playlist={:?} tracks={}",
                theme.playlist_id,
                theme.track_ids.len()
            );
            assert!(
                theme.track_ids.len() >= 10,
                "{name} should resolve a full OST (got {})",
                theme.track_ids.len()
            );
        }
    }

    /// Live, network-gated end-to-end check of the Twitch resolver. Run with
    /// `cargo test --lib -- --ignored twitch_top_live_live --nocapture`.
    #[test]
    #[ignore]
    fn twitch_top_live_live() {
        for name in ["Black Myth Wukong", "Elden Ring", "Baldur's Gate 3"] {
            let live = twitch_top_live(name);
            println!("{name} => {live:?}");
            let live = live.expect("should resolve a Twitch category");
            assert!(!live.slug.is_empty(), "{name} should resolve a slug");
        }
    }

    #[test]
    fn parses_twitch_search_and_stream() {
        let search = serde_json::json!({
            "data": { "searchCategories": { "edges": [
                { "node": { "name": "Black Myth: Wukong", "slug": "black-myth-wukong" } }
            ] } }
        });
        assert_eq!(
            parse_search_categories(&search),
            Some(("Black Myth: Wukong".to_string(), "black-myth-wukong".to_string()))
        );

        let streams = serde_json::json!([{
            "data": { "game": { "displayName": "Black Myth: Wukong", "streams": { "edges": [
                { "node": { "broadcaster": { "login": "zarkevich", "displayName": "Zarkevich" }, "title": "wukong run", "viewersCount": 39 } }
            ] } } }
        }]);
        assert_eq!(
            parse_top_stream(&streams),
            Some(("zarkevich".to_string(), "Zarkevich".to_string(), "wukong run".to_string(), 39))
        );

        // No live streams → None (UI then shows the directory fallback).
        let empty = serde_json::json!([{ "data": { "game": { "streams": { "edges": [] } } } }]);
        assert_eq!(parse_top_stream(&empty), None);
    }

    #[test]
    fn extracts_youtube_playlist_id() {
        // Skips a short/garbage id, returns the first real-looking list id.
        let html = r#"{"playlistId":"short"}{"playlistRenderer":{"playlistId":"PLi1CK-rsvz1Nfz83RMBp"}}"#;
        assert_eq!(
            extract_youtube_playlist_id(html).as_deref(),
            Some("PLi1CK-rsvz1Nfz83RMBp")
        );
        // Album-style (OLAK5uy_) ids are accepted too.
        let album = r#""playlistId":"OLAK5uy_kABCDEFGHIJKLMNOPQRSTUVWX1234567""#;
        assert_eq!(
            extract_youtube_playlist_id(album).as_deref(),
            Some("OLAK5uy_kABCDEFGHIJKLMNOPQRSTUVWX1234567")
        );
        assert_eq!(extract_youtube_playlist_id("no lists here"), None);
    }

    #[test]
    fn parse_duration_simple_text_variants() {
        assert_eq!(parse_duration_simple_text("3:45"), Some(225));
        assert_eq!(parse_duration_simple_text("1:02:30"), Some(3750));
        assert_eq!(parse_duration_simple_text("bad"), None);
    }

    #[test]
    fn search_hits_skip_long_compilations_for_extras() {
        let html = r#"
            "videoId":"comp1111111","lengthText":{"simpleText":"1:40:56"}
            "videoId":"short222222","lengthText":{"simpleText":"3:45"}
            "videoId":"short333333","lengthText":{"simpleText":"4:12"}
        "#;
        let hits = extract_youtube_search_hits(html, 10);
        let short: Vec<_> = hits
            .iter()
            .filter(|h| theme_extra_duration_ok(h))
            .map(|h| h.id.as_str())
            .collect();
        assert_eq!(short, vec!["short222222", "short333333"]);
    }

    #[test]
    fn resolve_theme_puts_main_first() {
        // Main-theme query is tried before the OST scrape; stub via hits parser only.
        let html_main = r#""videoId":"maintheme11","lengthText":{"simpleText":"2:58"}"#;
        let main = extract_youtube_search_hits(html_main, 1)
            .first()
            .map(|h| h.id.clone());
        assert_eq!(main.as_deref(), Some("maintheme11"));
    }

    #[test]
    fn parse_youtube_oembed_title_parses_json() {
        let json = r#"{"title":"Hollow Knight OST - Dirtmouth","author_name":"Amellifera"}"#;
        assert_eq!(
            parse_youtube_oembed_title(json).as_deref(),
            Some("Hollow Knight OST - Dirtmouth")
        );
        assert_eq!(parse_youtube_oembed_title("{}"), None);
    }

    #[test]
    fn extract_youtube_title_content_from_markup() {
        let html = r#""videoId":"NSlkW1fFkyo","title":{"content":"Hollow Knight OST - Dirtmouth"}"#;
        let titles = extract_youtube_video_titles(html, 5);
        assert_eq!(
            titles.get("NSlkW1fFkyo").map(String::as_str),
            Some("Hollow Knight OST - Dirtmouth")
        );
    }

    #[test]
    fn extract_youtube_video_titles_pairs_multiple_ids() {
        let html = r#"
            "videoId":"aaaaaaaaaaa","title":{"content":"Track One"}
            "videoId":"bbbbbbbbbbb","title":{"content":"Track Two"}
            "videoId":"aaaaaaaaaaa","title":{"content":"Track One Duplicate"}
        "#;
        let titles = extract_youtube_video_titles(html, 10);
        assert_eq!(titles.len(), 2);
        assert_eq!(titles.get("aaaaaaaaaaa").map(String::as_str), Some("Track One"));
        assert_eq!(titles.get("bbbbbbbbbbb").map(String::as_str), Some("Track Two"));
    }

    /// Live oEmbed check — run with:
    /// `cargo test --lib youtube_video_title_oembed_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn youtube_video_title_oembed_live() {
        let title = youtube_video_title_oembed("NSlkW1fFkyo").unwrap_or_default();
        println!("oEmbed title: {title}");
        assert!(
            title.to_lowercase().contains("dirtmouth"),
            "expected Dirtmouth in title, got: {title}"
        );
    }

    /// Live playlist title scrape — run with:
    /// `cargo test --lib youtube_playlist_titles_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn youtube_playlist_titles_live() {
        let list = "PLmOldskd2VbL7_t-NE9p6rEboq_v0AHko";
        let (ids, titles) = youtube_playlist_entries(list, 12);
        assert!(ids.len() >= 8, "expected playlist ids, got {}", ids.len());
        let with_titles = ids.iter().filter(|id| titles.contains_key(*id)).count();
        println!("{with_titles}/{} ids have scraped titles", ids.len());
        assert!(
            with_titles >= 6,
            "expected most playlist entries to have titles, got {with_titles}"
        );
        if let Some(t) = titles.get("NSlkW1fFkyo") {
            assert!(
                t.to_lowercase().contains("dirtmouth"),
                "unexpected Dirtmouth title: {t}"
            );
        }
    }

    #[test]
    fn known_app_website_chrome() {
        assert_eq!(
            known_app_website("chrome").as_deref(),
            Some("https://www.google.com/chrome/")
        );
        assert_eq!(
            known_app_website("Telegram").as_deref(),
            Some("https://telegram.org")
        );
        assert_eq!(
            known_app_website("zen").as_deref(),
            Some("https://zen-browser.app")
        );
    }

    #[test]
    fn parses_review_cards_from_current_markup() {
        // Mirrors the live Metacritic user-reviews DOM (review-card test ids,
        // score badge label, /user/ link, quote block).
        let html = r#"
        <div data-testid="review-card"><div data-testid="review-card-content">
          <div data-testid="review-card-date">Jun 10, 2026</div>
          <a data-testid="review-card-header" href="/user/CompactHyena/">
            <div class="c-siteReviewScore" aria-label="User score 9 out of 10"><span>9</span></div>
            CompactHyena</a>
          <div data-testid="review-card-quote-block"><div class="line-clamp-7">Certainly the best platformer I have played.</div></div>
        </div></div>
        <div data-testid="review-card"><div data-testid="review-card-content">
          <div data-testid="review-card-date">Jun 3, 2026</div>
          <a data-testid="review-card-header" href="/user/AnotherPlayer/">
            <div class="c-siteReviewScore" aria-label="User score 4 out of 10"><span>4</span></div>
            AnotherPlayer</a>
          <div data-testid="review-card-quote-block"><div class="line-clamp-7">Too hard for me.</div></div>
        </div></div>
        "#;
        let reviews = parse_metacritic_reviews(html);
        assert_eq!(reviews.len(), 2);
        assert_eq!(reviews[0].author, "CompactHyena");
        assert_eq!(reviews[0].score, Some(9));
        assert_eq!(reviews[0].date.as_deref(), Some("Jun 10, 2026"));
        assert!(reviews[0].text.contains("best platformer"));
        assert_eq!(reviews[1].author, "AnotherPlayer");
        assert_eq!(reviews[1].score, Some(4));
    }
}
