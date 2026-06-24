//! GOG Galaxy API integration — library, playtime, and achievement sync.
//!
//! OAuth credentials are stored in settings after browser sign-in. Playtime sync
//! never decreases local totals (same policy as Steam).

use crate::db::models::GameInput;
use crate::db::{games, settings, DbPool};
use crate::error::{AppError, AppResult};
use crate::gog_auth::{self, GogTokenResponse};
use serde::{Deserialize, Serialize};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Tracker/3.0";
const TIMEOUT: Duration = Duration::from_secs(20);
const ACHIEVEMENT_DELAY: Duration = Duration::from_millis(120);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GogCredentials {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: String,
    pub username: Option<String>,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GogSession {
    pub linked: bool,
    pub user_id: Option<String>,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GogValidateResult {
    pub user_id: String,
    pub username: Option<String>,
    pub game_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GogSyncResult {
    pub library_added: i64,
    pub library_updated: i64,
    pub playtime_updated: i64,
    pub achievements_updated: i64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GogSyncProgress {
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GogLibraryGame {
    pub product_id: u64,
    pub name: String,
    pub playtime_minutes: u32,
    pub has_achievements: bool,
    pub imported: bool,
    pub tracker_game_id: Option<String>,
    pub cover_image_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GogAchievement {
    pub achievement_id: String,
    pub achievement_key: String,
    pub name: String,
    pub description: String,
    pub image_url_unlocked: Option<String>,
    pub image_url_locked: Option<String>,
    pub unlocked: bool,
    pub unlock_time_utc: Option<String>,
}

#[derive(Debug, Clone)]
struct OwnedProduct {
    product_id: u64,
    name: String,
    cover_image_url: Option<String>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn save_credentials(pool: &DbPool, creds: &GogCredentials) -> AppResult<()> {
    let json = serde_json::to_string(creds).map_err(|e| AppError::msg(e.to_string()))?;
    settings::set(pool, "gog_credentials", &json)?;
    settings::set(pool, "gog_linked", "true")?;
    Ok(())
}

fn load_credentials(pool: &DbPool) -> AppResult<GogCredentials> {
    let raw = settings::get(pool, "gog_credentials")?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::msg("Sign in with GOG first (Settings → Launcher sync)."))?;
    serde_json::from_str(&raw).map_err(|e| AppError::msg(format!("Invalid GOG credentials: {e}")))
}

fn ensure_token(pool: &DbPool) -> AppResult<GogCredentials> {
    let mut creds = load_credentials(pool)?;
    if creds.expires_at <= now_secs().saturating_add(120) {
        let refreshed = gog_auth::refresh_token(&creds.refresh_token)?;
        creds.access_token = refreshed.access_token;
        if !refreshed.refresh_token.is_empty() {
            creds.refresh_token = refreshed.refresh_token;
        }
        creds.user_id = refreshed.user_id;
        creds.expires_at = now_secs().saturating_add(refreshed.expires_in);
        save_credentials(pool, &creds)?;
    }
    Ok(creds)
}

fn bearer_get(url: &str, token: &str) -> AppResult<serde_json::Value> {
    let resp = ureq::get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", UA)
        .timeout(TIMEOUT)
        .call()
        .map_err(|e| AppError::msg(format!("GOG request failed: {e}")))?;
    resp.into_json()
        .map_err(|e| AppError::msg(format!("Invalid GOG JSON from {url}: {e}")))
}

pub fn session(pool: &DbPool) -> AppResult<GogSession> {
    match load_credentials(pool) {
        Ok(creds) => Ok(GogSession {
            linked: true,
            user_id: Some(creds.user_id),
            username: creds.username,
        }),
        Err(_) => Ok(GogSession {
            linked: false,
            user_id: None,
            username: None,
        }),
    }
}

pub fn logout(pool: &DbPool) -> AppResult<()> {
    settings::set(pool, "gog_credentials", "")?;
    settings::set(pool, "gog_linked", "")?;
    Ok(())
}

pub fn complete_login(pool: &DbPool, token: GogTokenResponse) -> AppResult<GogValidateResult> {
    let mut creds = GogCredentials {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        user_id: token.user_id,
        username: None,
        expires_at: now_secs().saturating_add(token.expires_in),
    };
    if let Ok(profile) = bearer_get("https://embed.gog.com/userData.json", &creds.access_token) {
        creds.username = profile
            .get("username")
            .and_then(|v| v.as_str())
            .map(str::to_string);
    }
    save_credentials(pool, &creds)?;
    validate_session(pool)
}

pub fn validate_session(pool: &DbPool) -> AppResult<GogValidateResult> {
    let creds = ensure_token(pool)?;
    let owned = fetch_owned_products(&creds)?;
    Ok(GogValidateResult {
        user_id: creds.user_id,
        username: creds.username,
        game_count: owned.len(),
    })
}

fn fetch_owned_products(creds: &GogCredentials) -> AppResult<Vec<OwnedProduct>> {
    let mut entries: Vec<(u64, String)> = Vec::new();
    let mut page_token: Option<String> = None;
    loop {
        let mut url = format!(
            "https://galaxy-library.gog.com/users/{}/releases",
            creds.user_id
        );
        if let Some(ref token) = page_token {
            url.push_str(&format!("?page_token={}", pct(token)));
        }
        let data = bearer_get(&url, &creds.access_token)?;
        if let Some(items) = data.get("items").and_then(|v| v.as_array()) {
            for item in items {
                let owned = item.get("owned").and_then(|v| v.as_bool()).unwrap_or(false);
                if !owned {
                    continue;
                }
                let Some(ext) = item.get("external_id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Ok(product_id) = ext.parse::<u64>() else {
                    continue;
                };
                if product_id == 0 {
                    continue;
                }
                let cert = item
                    .get("certificate")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if cert.contains("redistributable") {
                    continue;
                }
                entries.push((product_id, String::new()));
            }
        }
        page_token = data
            .get("next_page_token")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        if page_token.is_none() {
            break;
        }
    }

    entries.sort_by_key(|(id, _)| *id);
    entries.dedup_by_key(|(id, _)| *id);

    let mut out = Vec::with_capacity(entries.len());
    for (i, (product_id, _)) in entries.iter().enumerate() {
        let meta = fetch_product_meta(*product_id, &creds.access_token);
        out.push(OwnedProduct {
            product_id: *product_id,
            name: meta.0,
            cover_image_url: meta.1,
        });
        if i % 8 == 7 {
            thread::sleep(Duration::from_millis(80));
        }
    }
    Ok(out)
}

fn fetch_product_meta(product_id: u64, token: &str) -> (String, Option<String>) {
    let url = format!("https://api.gog.com/products/{product_id}?locale=en-US");
    let Ok(data) = bearer_get(&url, token) else {
        return (format!("GOG #{product_id}"), None);
    };
    let title = data
        .get("title")
        .and_then(|v| v.as_str())
        .or_else(|| data.get("title").and_then(|v| v.as_object()).and_then(|o| o.get("*")).and_then(|v| v.as_str()))
        .unwrap_or("Unknown")
        .trim()
        .to_string();
    let cover = data
        .get("images")
        .and_then(|v| v.get("background"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            data.get("cover")
                .and_then(|v| v.get("url"))
                .and_then(|v| v.as_str())
        })
        .map(str::to_string);
    (title, cover)
}

fn fetch_playtime_minutes(creds: &GogCredentials, product_id: u64) -> Option<u32> {
    let url = format!(
        "https://gameplay.gog.com/games/{product_id}/users/{}/sessions",
        creds.user_id
    );
    let data = bearer_get(&url, &creds.access_token).ok()?;
    data.get("time_sum")
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n as u64)))
        .map(|m| m.min(u32::MAX as u64) as u32)
}

fn has_achievements(creds: &GogCredentials, product_id: u64) -> bool {
    let url = format!(
        "https://gameplay.gog.com/clients/{product_id}/users/{}/achievements?limit=1",
        creds.user_id
    );
    bearer_get(&url, &creds.access_token)
        .ok()
        .and_then(|d| d.get("total_count").and_then(|v| v.as_u64()))
        .unwrap_or(0)
        > 0
}

pub fn library(pool: &DbPool) -> AppResult<Vec<GogLibraryGame>> {
    let creds = ensure_token(pool)?;
    let owned = fetch_owned_products(&creds)?;
    let mut out = Vec::with_capacity(owned.len());
    for game in owned {
        let playtime = fetch_playtime_minutes(&creds, game.product_id).unwrap_or(0);
        let has_ach = has_achievements(&creds, game.product_id);
        let tracker_game_id = games::id_by_gog_product_id(pool, game.product_id as i64)
            .ok()
            .flatten();
        out.push(GogLibraryGame {
            product_id: game.product_id,
            name: game.name,
            playtime_minutes: playtime,
            has_achievements: has_ach,
            imported: tracker_game_id.is_some(),
            tracker_game_id,
            cover_image_url: game.cover_image_url,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub fn import_games(
    pool: &DbPool,
    product_ids: &[u64],
    enrich: impl Fn(&str) + Send + Sync,
) -> AppResult<GogSyncResult> {
    let creds = ensure_token(pool)?;
    let owned = fetch_owned_products(&creds)?;
    let selected: Vec<&OwnedProduct> = owned
        .iter()
        .filter(|g| product_ids.contains(&g.product_id))
        .collect();

    let mut result = GogSyncResult::default();
    for game in selected {
        match import_one(pool, &creds, game) {
            Ok((added, id)) => {
                if added {
                    result.library_added += 1;
                    enrich(&id);
                } else {
                    result.library_updated += 1;
                }
            }
            Err(e) => result.errors.push(format!("{}: {e}", game.name)),
        }
    }
    Ok(result)
}

fn import_one(
    pool: &DbPool,
    creds: &GogCredentials,
    game: &OwnedProduct,
) -> AppResult<(bool, String)> {
    let existing_id = games::id_by_gog_product_id(pool, game.product_id as i64)?
        .or_else(|| games::find_by_name(pool, &game.name).ok().flatten());

    if let Some(ref id) = existing_id {
        games::set_gog_product_id(pool, id, game.product_id as i64)?;
        if let Some(mins) = fetch_playtime_minutes(creds, game.product_id) {
            let secs = i64::from(mins) * 60;
            let _ = games::apply_steam_playtime(pool, id, secs);
        }
        return Ok((false, id.clone()));
    }

    let input = GameInput {
        id: None,
        kind: "game".to_string(),
        display_name: game.name.clone(),
        install_folder: None,
        exe_paths: vec![],
        cover_path: None,
        status: "backlog".to_string(),
        rating: None,
        developer: None,
        release_year: None,
        started_year: None,
        started_month: None,
        started_day: None,
        completed_year: None,
        completed_month: None,
        completed_day: None,
        metacritic: None,
        notes: None,
        time_to_beat_minutes: None,
        manual_playtime_seconds: None,
        accent_color: None,
        tags: vec![],
        count_background: None,
        steam_app_id: None,
        gog_product_id: Some(game.product_id as i64),
    };
    let id = games::upsert(pool, input)?;
    games::set_gog_product_id(pool, &id, game.product_id as i64)?;

    if let Some(mins) = fetch_playtime_minutes(creds, game.product_id) {
        let secs = i64::from(mins) * 60;
        let _ = games::apply_steam_playtime(pool, &id, secs);
    }
    Ok((true, id))
}

pub fn sync(
    pool: &DbPool,
    playtime: bool,
    achievements: bool,
    progress: Option<&dyn Fn(GogSyncProgress)>,
) -> AppResult<GogSyncResult> {
    let creds = ensure_token(pool)?;
    let mut result = GogSyncResult::default();
    let tracked = games::list_with_gog_product_id(pool)?;
    let total = tracked.len();

    for (i, game) in tracked.iter().enumerate() {
        let Some(product_id) = game.gog_product_id else {
            continue;
        };
        let label = game.display_name.clone();
        if let Some(cb) = progress {
            cb(GogSyncProgress {
                phase: if playtime { "playtime" } else { "achievements" }.into(),
                done: i,
                total,
                label: label.clone(),
            });
        }

        if playtime {
            if let Some(mins) = fetch_playtime_minutes(&creds, product_id as u64) {
                let secs = i64::from(mins) * 60;
                if games::apply_steam_playtime(pool, &game.id, secs)? {
                    result.playtime_updated += 1;
                }
            }
        }

        if achievements {
            match sync_achievements_for_game(pool, &creds, product_id as u64, &game.id) {
                Ok(true) => result.achievements_updated += 1,
                Ok(false) => {}
                Err(e) => result.errors.push(format!("{label}: {e}")),
            }
            thread::sleep(ACHIEVEMENT_DELAY);
        }
    }

    if let Some(cb) = progress {
        cb(GogSyncProgress {
            phase: "done".into(),
            done: total,
            total,
            label: String::new(),
        });
    }
    Ok(result)
}

fn sync_achievements_for_game(
    pool: &DbPool,
    creds: &GogCredentials,
    product_id: u64,
    game_id: &str,
) -> AppResult<bool> {
    let url = format!(
        "https://gameplay.gog.com/clients/{product_id}/users/{}/achievements?limit=1000",
        creds.user_id
    );
    let data = bearer_get(&url, &creds.access_token)?;
    let items = data
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if items.is_empty() {
        return Ok(false);
    }

    let mut achievements: Vec<GogAchievement> = Vec::new();
    let mut unlocked = 0i64;
    for item in &items {
        let date = item.get("date_unlocked").and_then(|v| v.as_str());
        let is_unlocked = date.is_some();
        if is_unlocked {
            unlocked += 1;
        }
        achievements.push(GogAchievement {
            achievement_id: item
                .get("achievement_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            achievement_key: item
                .get("achievement_key")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            name: item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Achievement")
                .to_string(),
            description: item
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            image_url_unlocked: item
                .get("image_url_unlocked")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            image_url_locked: item
                .get("image_url_locked")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            unlocked: is_unlocked,
            unlock_time_utc: date.map(str::to_string),
        });
    }
    let total = items.len() as i64;
    let json = serde_json::to_string(&achievements).ok();
    games::set_gog_achievements(pool, game_id, unlocked, total, json.as_deref())?;
    Ok(true)
}

pub fn game_achievements(pool: &DbPool, game_id: &str, refresh: bool) -> AppResult<Vec<GogAchievement>> {
    if refresh {
        let creds = ensure_token(pool)?;
        let game = games::get(pool, game_id)?;
        let Some(game) = game else {
            return Ok(vec![]);
        };
        let Some(product_id) = game.gog_product_id else {
            return Ok(vec![]);
        };
        let _ = sync_achievements_for_game(pool, &creds, product_id as u64, game_id)?;
    }
    let json = games::gog_achievements_json(pool, game_id)?;
    let Some(raw) = json.filter(|s| !s.trim().is_empty()) else {
        return Ok(vec![]);
    };
    serde_json::from_str(&raw).map_err(|e| AppError::msg(e.to_string()))
}

fn pct(s: &str) -> String {
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
