//! Steam Web API integration — library, playtime, and achievement sync.
//!
//! Uses a developer Steam Web API key baked in at compile time (`STEAM_WEB_API_KEY`)
//! plus the user's SteamID from OpenID sign-in (stored in settings).
//!
//! Playtime sync never decreases local totals (ZGameLib-style).

use crate::db::models::GameInput;
use crate::db::{games, settings, DbPool};
use crate::error::{AppError, AppResult};
use crate::metadata;
use serde::{Deserialize, Serialize};
use std::thread;
use std::time::Duration;

const API_BASE: &str = "https://api.steampowered.com";
const TIMEOUT: Duration = Duration::from_secs(20);
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Tracker/3.0";
const ACHIEVEMENT_DELAY: Duration = Duration::from_millis(120);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamSession {
    pub linked: bool,
    pub api_configured: bool,
    pub steam_id: Option<String>,
    pub persona_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamValidateResult {
    pub steam_id: String,
    pub game_count: usize,
    pub persona_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamSyncResult {
    pub library_added: i64,
    pub library_updated: i64,
    pub playtime_updated: i64,
    pub achievements_updated: i64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamSyncProgress {
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamLibraryGame {
    pub appid: u64,
    pub name: String,
    pub playtime_forever_minutes: u32,
    pub playtime_2weeks_minutes: u32,
    pub has_achievements: bool,
    pub imported: bool,
    pub tracker_game_id: Option<String>,
    pub header_image_url: String,
}

#[derive(Debug, Clone)]
pub struct ImportedGame {
    pub id: String,
    pub appid: u64,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct OwnedGame {
    pub appid: u64,
    pub name: String,
    pub playtime_forever_minutes: u32,
    pub playtime_2weeks_minutes: u32,
    pub has_community_visible_stats: bool,
}

#[derive(Debug, Clone, Default)]
pub struct AchievementCounts {
    pub unlocked: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamAchievement {
    pub api_name: String,
    pub display_name: String,
    pub description: String,
    pub icon_url: String,
    pub unlocked: bool,
    pub hidden: bool,
    pub unlock_time_utc: Option<String>,
}

pub fn api_key_configured() -> bool {
    dev_api_key().is_some()
}

pub fn steam_api_key() -> AppResult<String> {
    require_api_key()
}

fn dev_api_key() -> Option<String> {
    std::env::var("STEAM_WEB_API_KEY")
        .ok()
        .or_else(|| option_env!("STEAM_WEB_API_KEY").map(str::to_string))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn require_api_key() -> AppResult<String> {
    dev_api_key().ok_or_else(|| {
        AppError::msg(
            "Steam sync is not available in this build (developer API key missing).",
        )
    })
}

fn load_steam_id(pool: &DbPool) -> AppResult<String> {
    let steam_id = settings::get(pool, "steam_id")?
        .unwrap_or_default()
        .trim()
        .to_string();
    if steam_id.is_empty() {
        return Err(AppError::msg(
            "Sign in with Steam first (Settings → Steam sync).",
        ));
    }
    Ok(steam_id)
}

pub fn session(pool: &DbPool) -> AppResult<SteamSession> {
    let steam_id = settings::get(pool, "steam_id")?.filter(|s| !s.trim().is_empty());
    Ok(SteamSession {
        linked: steam_id.is_some(),
        api_configured: api_key_configured(),
        steam_id,
        persona_name: settings::get(pool, "steam_persona_name")?.filter(|s| !s.is_empty()),
        avatar_url: settings::get(pool, "steam_avatar_url")?.filter(|s| !s.is_empty()),
    })
}

pub fn logout(pool: &DbPool) -> AppResult<()> {
    for key in [
        "steam_id",
        "steam_persona_name",
        "steam_avatar_url",
        "steam_linked",
    ] {
        settings::set(pool, key, "")?;
    }
    Ok(())
}

pub fn complete_login(pool: &DbPool, steam_id: &str) -> AppResult<SteamValidateResult> {
    settings::set(pool, "steam_id", steam_id)?;
    settings::set(pool, "steam_linked", "true")?;
    validate_session(pool)
}

pub fn validate_session(pool: &DbPool) -> AppResult<SteamValidateResult> {
    let api_key = require_api_key()?;
    let steam_id = load_steam_id(pool)?;
    let owned = fetch_owned_games(&api_key, &steam_id)?;
    let profile = fetch_player_profile(&api_key, &steam_id);
    if let Some(ref name) = profile.persona_name {
        settings::set(pool, "steam_persona_name", name)?;
    }
    if let Some(ref url) = profile.avatar_url {
        settings::set(pool, "steam_avatar_url", url)?;
    }
    Ok(SteamValidateResult {
        steam_id,
        game_count: owned.len(),
        persona_name: profile.persona_name,
        avatar_url: profile.avatar_url,
    })
}

#[derive(Default)]
struct PlayerProfile {
    persona_name: Option<String>,
    avatar_url: Option<String>,
}

pub fn library(pool: &DbPool) -> AppResult<Vec<SteamLibraryGame>> {
    let api_key = require_api_key()?;
    let steam_id = load_steam_id(pool)?;
    let owned = fetch_owned_games(&api_key, &steam_id)?;
    Ok(owned
        .into_iter()
        .map(|g| {
            let tracker_game_id = games::id_by_steam_app_id(pool, g.appid as i64).ok().flatten();
            SteamLibraryGame {
                appid: g.appid,
                name: g.name,
                playtime_forever_minutes: g.playtime_forever_minutes,
                playtime_2weeks_minutes: g.playtime_2weeks_minutes,
                has_achievements: g.has_community_visible_stats,
                imported: tracker_game_id.is_some(),
                tracker_game_id,
                header_image_url: metadata::steam_header_url(g.appid),
            }
        })
        .collect())
}

/// Sync playtime and/or achievements for games already in the tracker library.
/// Does not bulk-import the Steam library — use `import_games` for that.
pub fn sync(
    pool: &DbPool,
    playtime: bool,
    achievements: bool,
    on_progress: Option<&dyn Fn(SteamSyncProgress)>,
) -> AppResult<SteamSyncResult> {
    if !playtime && !achievements {
        return Err(AppError::msg("Select at least one sync action."));
    }
    let api_key = require_api_key()?;
    let steam_id = load_steam_id(pool)?;

    let owned = fetch_owned_games(&api_key, &steam_id)?;
    let mut result = SteamSyncResult::default();
    let total = owned.len();

    if playtime {
        for (i, game) in owned.iter().enumerate() {
            if let Some(cb) = on_progress {
                cb(SteamSyncProgress {
                    phase: "playtime".into(),
                    done: i,
                    total,
                    label: game.name.clone(),
                });
            }
            match apply_owned_game(pool, game, false, true) {
                Ok(actions) => {
                    if actions.updated {
                        result.library_updated += 1;
                    }
                    if actions.playtime_updated {
                        result.playtime_updated += 1;
                    }
                }
                Err(e) => result.errors.push(format!("{}: {e}", game.name)),
            }
        }
    }

    if achievements {
        let achievables: Vec<&OwnedGame> = owned
            .iter()
            .filter(|g| g.has_community_visible_stats)
            .collect();
        let ach_total = achievables.len();
        for (i, game) in achievables.iter().enumerate() {
            if let Some(cb) = on_progress {
                cb(SteamSyncProgress {
                    phase: "achievements".into(),
                    done: i,
                    total: ach_total,
                    label: game.name.clone(),
                });
            }
            thread::sleep(ACHIEVEMENT_DELAY);
            match sync_achievements_for_game(pool, &api_key, &steam_id, game.appid) {
                Ok(true) => result.achievements_updated += 1,
                Ok(false) => {}
                Err(e) => result.errors.push(format!("{} achievements: {e}", game.name)),
            }
        }
    }

    if let Some(cb) = on_progress {
        cb(SteamSyncProgress {
            phase: "done".into(),
            done: total,
            total,
            label: "Done".into(),
        });
    }

    Ok(result)
}

/// Import selected Steam games into the tracker library.
pub fn import_games(
    pool: &DbPool,
    app_ids: &[u64],
    playtime: bool,
    achievements: bool,
    on_progress: Option<&dyn Fn(SteamSyncProgress)>,
) -> AppResult<(SteamSyncResult, Vec<ImportedGame>)> {
    if app_ids.is_empty() {
        return Err(AppError::msg("Select at least one game to import."));
    }
    let api_key = require_api_key()?;
    let steam_id = load_steam_id(pool)?;
    let owned = fetch_owned_games(&api_key, &steam_id)?;
    let pick: std::collections::HashSet<u64> = app_ids.iter().copied().collect();
    let selected: Vec<&OwnedGame> = owned.iter().filter(|g| pick.contains(&g.appid)).collect();
    if selected.is_empty() {
        return Err(AppError::msg("None of the selected games were found in your Steam library."));
    }

    let mut result = SteamSyncResult::default();
    let mut imported = Vec::new();
    let total = selected.len();

    for (i, game) in selected.iter().enumerate() {
        if let Some(cb) = on_progress {
            cb(SteamSyncProgress {
                phase: "import".into(),
                done: i,
                total,
                label: game.name.clone(),
            });
        }
        match apply_owned_game(pool, game, true, playtime) {
            Ok(actions) => {
                if actions.added {
                    result.library_added += 1;
                    if let Some(id) = games::id_by_steam_app_id(pool, game.appid as i64)? {
                        imported.push(ImportedGame {
                            id,
                            appid: game.appid,
                            name: game.name.clone(),
                        });
                    }
                } else if actions.updated {
                    result.library_updated += 1;
                }
                if actions.playtime_updated {
                    result.playtime_updated += 1;
                }
            }
            Err(e) => result.errors.push(format!("{}: {e}", game.name)),
        }
    }

    if achievements {
        let ach_total = selected
            .iter()
            .filter(|g| g.has_community_visible_stats)
            .count();
        let mut ach_i = 0usize;
        for game in selected {
            if !game.has_community_visible_stats {
                continue;
            }
            if let Some(cb) = on_progress {
                cb(SteamSyncProgress {
                    phase: "achievements".into(),
                    done: ach_i,
                    total: ach_total,
                    label: game.name.clone(),
                });
            }
            ach_i += 1;
            thread::sleep(ACHIEVEMENT_DELAY);
            match sync_achievements_for_game(pool, &api_key, &steam_id, game.appid) {
                Ok(true) => result.achievements_updated += 1,
                Ok(false) => {}
                Err(e) => result.errors.push(format!("{} achievements: {e}", game.name)),
            }
        }
    }

    if let Some(cb) = on_progress {
        cb(SteamSyncProgress {
            phase: "done".into(),
            done: total,
            total,
            label: "Done".into(),
        });
    }

    Ok((result, imported))
}

#[derive(Debug, Default)]
struct ApplyActions {
    added: bool,
    updated: bool,
    playtime_updated: bool,
}

fn apply_owned_game(
    pool: &DbPool,
    game: &OwnedGame,
    do_import: bool,
    do_playtime: bool,
) -> AppResult<ApplyActions> {
    let mut actions = ApplyActions::default();
    let existing_id = games::id_by_steam_app_id(pool, game.appid as i64)?
        .or_else(|| games::id_by_fuzzy_name(pool, &game.name).ok().flatten());

    let game_id = if let Some(id) = existing_id {
        if do_import {
            games::set_steam_app_id(pool, &id, game.appid as i64)?;
            actions.updated = true;
        }
        id
    } else if do_import {
        let input = GameInput {
            id: None,
            kind: "game".to_string(),
            display_name: game.name.clone(),
            install_folder: None,
            exe_paths: vec![],
            cover_path: None,
            status: if game.playtime_forever_minutes > 0 {
                "playing".to_string()
            } else {
                "backlog".to_string()
            },
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
            steam_app_id: Some(game.appid as i64),
            gog_product_id: None,
        };
        let id = games::upsert(pool, input)?;
        actions.added = true;
        id
    } else if do_playtime {
        // Playtime-only sync: skip games not already in the library.
        return Ok(actions);
    } else {
        return Ok(actions);
    };

    if do_playtime && game.playtime_forever_minutes > 0 {
        let steam_seconds = i64::from(game.playtime_forever_minutes) * 60;
        if games::apply_steam_playtime(pool, &game_id, steam_seconds)? {
            actions.playtime_updated = true;
        }
    }

    Ok(actions)
}

fn sync_achievements_for_game(
    pool: &DbPool,
    api_key: &str,
    steam_id: &str,
    appid: u64,
) -> AppResult<bool> {
    let game_id = match games::id_by_steam_app_id(pool, appid as i64)? {
        Some(id) => id,
        None => return Ok(false),
    };
    let install_folder = games::get(pool, &game_id)?
        .and_then(|g| g.install_folder);
    let achievements = fetch_achievements(
        api_key,
        steam_id,
        appid,
        install_folder.as_deref(),
    )?;
    if achievements.is_empty() {
        return Ok(false);
    }
    let unlocked = achievements.iter().filter(|a| a.unlocked).count() as i64;
    let total = achievements.len() as i64;
    let json = serde_json::to_string(&achievements).ok();
    games::set_steam_achievements(
        pool,
        &game_id,
        unlocked,
        total,
        json.as_deref(),
    )?;
    Ok(true)
}

pub fn fetch_owned_games(api_key: &str, steam_id: &str) -> AppResult<Vec<OwnedGame>> {
    let url = format!(
        "{API_BASE}/IPlayerService/GetOwnedGames/v1/?key={}&steamid={}&include_appinfo=1&include_played_free_games=1&format=json",
        encode(api_key),
        encode(steam_id)
    );
    let json = get_json_with_retry(&url, 3).ok_or_else(|| {
        AppError::msg(
            "Steam did not return your library. Check that your profile game details are Public.",
        )
    })?;
    let games_arr = json
        .pointer("/response/games")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            AppError::msg(
                "Steam returned no games. Set your profile Game details to Public under Privacy Settings.",
            )
        })?;
    let mut out = Vec::with_capacity(games_arr.len());
    for g in games_arr {
        let appid = g.get("appid").and_then(|v| v.as_u64()).unwrap_or(0);
        if appid == 0 {
            continue;
        }
        let name = g
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown")
            .to_string();
        out.push(OwnedGame {
            appid,
            name,
            playtime_forever_minutes: g
                .get("playtime_forever")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            playtime_2weeks_minutes: g
                .get("playtime_2weeks")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            has_community_visible_stats: g
                .get("has_community_visible_stats")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

fn fetch_player_profile(api_key: &str, steam_id: &str) -> PlayerProfile {
    let url = format!(
        "{API_BASE}/ISteamUser/GetPlayerSummaries/v0002/?key={}&steamids={}",
        encode(api_key),
        encode(steam_id)
    );
    let Some(json) = get_json(&url) else {
        return PlayerProfile::default();
    };
    let player = json.pointer("/response/players/0");
    PlayerProfile {
        persona_name: player
            .and_then(|p| p.get("personaname"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        avatar_url: player
            .and_then(|p| p.get("avatarfull"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementHighlight {
    pub game_id: String,
    pub game_name: String,
    pub api_name: String,
    pub display_name: String,
    pub description: String,
    pub icon_url: String,
    pub unlocked: bool,
    pub hidden: bool,
    pub unlock_time_utc: Option<String>,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamAchievementsOverview {
    pub games_tracked: usize,
    pub total_unlocked: i64,
    pub total_possible: i64,
    pub completed_games: i64,
    pub avg_percent: i64,
    pub hidden_unlocked: i64,
    pub hidden_remaining: i64,
    pub recent_unlocks_30d: i64,
    pub highlights: Vec<AchievementHighlight>,
    pub recent_unlocks: Vec<AchievementHighlight>,
}

pub fn achievements_overview(pool: &DbPool) -> AppResult<SteamAchievementsOverview> {
    let rows = games::list_steam_achievement_rows(pool)?;
    let now = chrono::Utc::now();
    let cutoff = now - chrono::Duration::days(30);

    let mut games_tracked = 0usize;
    let mut total_unlocked = 0i64;
    let mut total_possible = 0i64;
    let mut completed_games = 0i64;
    let mut percent_sum = 0f64;
    let mut hidden_unlocked = 0i64;
    let mut hidden_remaining = 0i64;
    let mut recent_unlocks_30d = 0i64;
    let mut recent_pool: Vec<AchievementHighlight> = Vec::new();
    let mut hidden_pool: Vec<AchievementHighlight> = Vec::new();

    for (game_id, game_name, json) in rows {
        let achievements: Vec<SteamAchievement> = serde_json::from_str(&json).unwrap_or_default();
        if achievements.is_empty() {
            continue;
        }
        games_tracked += 1;
        let unlocked = achievements.iter().filter(|a| a.unlocked).count() as i64;
        let total = achievements.len() as i64;
        total_unlocked += unlocked;
        total_possible += total;
        if unlocked >= total {
            completed_games += 1;
        }
        percent_sum += (unlocked as f64 / total as f64) * 100.0;

        for a in achievements {
            if a.hidden && a.unlocked {
                hidden_unlocked += 1;
                hidden_pool.push(AchievementHighlight {
                    game_id: game_id.clone(),
                    game_name: game_name.clone(),
                    api_name: a.api_name.clone(),
                    display_name: a.display_name.clone(),
                    description: a.description.clone(),
                    icon_url: a.icon_url.clone(),
                    unlocked: true,
                    hidden: true,
                    unlock_time_utc: a.unlock_time_utc.clone(),
                    kind: "hidden".into(),
                });
            } else if a.hidden && !a.unlocked {
                hidden_remaining += 1;
            }

            if a.unlocked {
                if let Some(ref ts) = a.unlock_time_utc {
                    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(ts) {
                        let utc = dt.with_timezone(&chrono::Utc);
                        if utc >= cutoff {
                            recent_unlocks_30d += 1;
                        }
                    }
                }
                recent_pool.push(AchievementHighlight {
                    game_id: game_id.clone(),
                    game_name: game_name.clone(),
                    api_name: a.api_name.clone(),
                    display_name: a.display_name.clone(),
                    description: a.description.clone(),
                    icon_url: a.icon_url.clone(),
                    unlocked: true,
                    hidden: a.hidden,
                    unlock_time_utc: a.unlock_time_utc.clone(),
                    kind: "recent".into(),
                });
            }
        }
    }

    recent_pool.sort_by(|a, b| b.unlock_time_utc.cmp(&a.unlock_time_utc));
    let recent_unlocks: Vec<AchievementHighlight> = recent_pool.into_iter().take(8).collect();

    hidden_pool.sort_by(|a, b| b.unlock_time_utc.cmp(&a.unlock_time_utc));
    let mut highlights = recent_unlocks.clone();
    for h in hidden_pool.into_iter().take(4) {
        if highlights.len() >= 10 {
            break;
        }
        if !highlights.iter().any(|x| x.api_name == h.api_name && x.game_id == h.game_id) {
            highlights.push(h);
        }
    }

    Ok(SteamAchievementsOverview {
        games_tracked,
        total_unlocked,
        total_possible,
        completed_games,
        avg_percent: if games_tracked > 0 {
            (percent_sum / games_tracked as f64).round() as i64
        } else {
            0
        },
        hidden_unlocked,
        hidden_remaining,
        recent_unlocks_30d,
        highlights: highlights.into_iter().take(10).collect(),
        recent_unlocks,
    })
}

pub fn achievements_for_game(pool: &DbPool, game_id: &str) -> AppResult<Vec<SteamAchievement>> {
    match games::steam_achievements_json(pool, game_id)? {
        Some(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
        None => Ok(Vec::new()),
    }
}

pub fn refresh_achievements_for_game(
    pool: &DbPool,
    game_id: &str,
    api_key: &str,
    steam_id: &str,
    appid: u64,
    install_folder: Option<&str>,
) -> AppResult<Vec<SteamAchievement>> {
    let achievements = fetch_achievements(api_key, steam_id, appid, install_folder)?;
    if !achievements.is_empty() {
        let unlocked = achievements.iter().filter(|a| a.unlocked).count() as i64;
        let json = serde_json::to_string(&achievements).ok();
        games::set_steam_achievements(
            pool,
            game_id,
            unlocked,
            achievements.len() as i64,
            json.as_deref(),
        )?;
    }
    Ok(achievements)
}

pub fn fetch_achievement_counts(
    api_key: &str,
    steam_id: &str,
    appid: u64,
) -> AppResult<AchievementCounts> {
    let achievements = fetch_achievements(api_key, steam_id, appid, None)?;
    Ok(AchievementCounts {
        unlocked: achievements.iter().filter(|a| a.unlocked).count() as i64,
        total: achievements.len() as i64,
    })
}

pub fn fetch_achievements(
    api_key: &str,
    steam_id: &str,
    appid: u64,
    install_folder: Option<&str>,
) -> AppResult<Vec<SteamAchievement>> {
    let from_steam = fetch_achievements_from_steam(api_key, steam_id, appid)?;
    if !from_steam.is_empty() {
        return Ok(from_steam);
    }
    fetch_achievements_from_emu(api_key, appid, install_folder)
}

fn fetch_achievements_from_steam(
    api_key: &str,
    steam_id: &str,
    appid: u64,
) -> AppResult<Vec<SteamAchievement>> {
    use std::collections::HashMap;

    let schema_url = format!(
        "{API_BASE}/ISteamUserStats/GetSchemaForGame/v2/?key={}&appid={appid}",
        encode(api_key)
    );
    let schema = get_json_with_retry(&schema_url, 2);
    let mut meta: HashMap<String, (String, String, String, String, bool)> = HashMap::new();
    if let Some(ref j) = schema {
        if let Some(arr) = j
            .pointer("/game/availableGameStats/achievements")
            .and_then(|a| a.as_array())
        {
            for a in arr {
                let api_name = a
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if api_name.is_empty() {
                    continue;
                }
                let display = a
                    .get("displayName")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&api_name)
                    .to_string();
                let description = a
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let icon = a
                    .get("icon")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let icon_gray = a
                    .get("icongray")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&icon)
                    .to_string();
                let hidden = a.get("hidden").and_then(|v| v.as_i64()).unwrap_or(0) != 0;
                meta.insert(api_name, (display, description, icon, icon_gray, hidden));
            }
        }
    }

    let ach_url = format!(
        "{API_BASE}/ISteamUserStats/GetPlayerAchievements/v1/?key={}&steamid={}&appid={appid}",
        encode(api_key),
        encode(steam_id)
    );
    let player_json = match get_json_with_retry(&ach_url, 2) {
        Some(j) => j,
        None => return Ok(Vec::new()),
    };
    let success = player_json
        .pointer("/playerstats/success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !success {
        return Ok(Vec::new());
    }
    let Some(player_arr) = player_json
        .pointer("/playerstats/achievements")
        .and_then(|a| a.as_array())
    else {
        return Ok(Vec::new());
    };

    let mut out = Vec::with_capacity(player_arr.len());
    for p in player_arr {
        let api_name = p
            .get("apiname")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if api_name.is_empty() {
            continue;
        }
        let unlocked = p.get("achieved").and_then(|v| v.as_i64()) == Some(1);
        let unlock_time_utc = p
            .get("unlocktime")
            .and_then(|v| v.as_i64())
            .filter(|&t| t > 0)
            .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
            .map(|dt| dt.to_rfc3339());

        let (mut display_name, mut description, icon, icon_gray, hidden) = meta
            .get(&api_name)
            .cloned()
            .unwrap_or_else(|| (api_name.clone(), String::new(), String::new(), String::new(), false));

        if hidden && !unlocked {
            display_name = "Hidden Achievement".to_string();
            description = String::new();
        }

        let icon_url = if unlocked && !icon.is_empty() {
            icon
        } else if !icon_gray.is_empty() {
            icon_gray
        } else {
            icon
        };

        out.push(SteamAchievement {
            api_name,
            display_name,
            description,
            icon_url,
            unlocked,
            hidden,
            unlock_time_utc,
        });
    }

    sort_achievements(&mut out);
    Ok(out)
}
fn fetch_achievements_from_emu(
    api_key: &str,
    appid: u64,
    install_folder: Option<&str>,
) -> AppResult<Vec<SteamAchievement>> {
    use std::collections::HashMap;

    let Some(emu) = crate::steam_emu::read_emu_unlocks(appid, install_folder) else {
        return Ok(Vec::new());
    };
    let appid = emu.app_id;

    let mut meta: HashMap<String, (String, String, String, String, bool)> =
        load_achievement_schema_meta(api_key, appid);

    if meta.is_empty() {
        for def in crate::steam_emu::read_local_definitions(install_folder) {
            if def.name.is_empty() {
                continue;
            }
            meta.insert(
                def.name.clone(),
                (
                    if def.display_name.is_empty() {
                        def.name.clone()
                    } else {
                        def.display_name
                    },
                    def.description,
                    def.icon,
                    def.icon_gray,
                    def.hidden,
                ),
            );
        }
    }

    if meta.is_empty() {
        for name in emu.unlocks.keys() {
            meta.insert(
                name.clone(),
                (name.clone(), String::new(), String::new(), String::new(), false),
            );
        }
    }

    let mut out = Vec::with_capacity(meta.len());
    for (api_name, (display_name, description, icon, icon_gray, hidden)) in meta {
        let unlocked = emu.unlocks.contains_key(&api_name);
        let unlock_time_utc = emu
            .unlocks
            .get(&api_name)
            .filter(|&&t| t > 0)
            .and_then(|&t| chrono::DateTime::from_timestamp(t, 0))
            .map(|dt| dt.to_rfc3339());

        let (mut display_name, mut description) = (display_name, description);
        if hidden && !unlocked {
            display_name = "Hidden Achievement".to_string();
            description = String::new();
        }

        let icon_url = if unlocked && !icon.is_empty() {
            icon
        } else if !icon_gray.is_empty() {
            icon_gray
        } else {
            icon
        };

        out.push(SteamAchievement {
            api_name: api_name.clone(),
            display_name,
            description,
            icon_url,
            unlocked,
            hidden,
            unlock_time_utc,
        });
    }

    sort_achievements(&mut out);
    Ok(out)
}

fn load_achievement_schema_meta(
    api_key: &str,
    appid: u64,
) -> std::collections::HashMap<String, (String, String, String, String, bool)> {
    use std::collections::HashMap;

    let schema_url = format!(
        "{API_BASE}/ISteamUserStats/GetSchemaForGame/v2/?key={}&appid={appid}",
        encode(api_key)
    );
    let schema = get_json_with_retry(&schema_url, 2);
    let mut meta: HashMap<String, (String, String, String, String, bool)> = HashMap::new();
    if let Some(ref j) = schema {
        if let Some(arr) = j
            .pointer("/game/availableGameStats/achievements")
            .and_then(|a| a.as_array())
        {
            for a in arr {
                let api_name = a
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if api_name.is_empty() {
                    continue;
                }
                let display = a
                    .get("displayName")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&api_name)
                    .to_string();
                let description = a
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let icon = a
                    .get("icon")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let icon_gray = a
                    .get("icongray")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&icon)
                    .to_string();
                let hidden = a.get("hidden").and_then(|v| v.as_i64()).unwrap_or(0) != 0;
                meta.insert(api_name, (display, description, icon, icon_gray, hidden));
            }
        }
    }
    meta
}

fn sort_achievements(out: &mut [SteamAchievement]) {
    out.sort_by(|a, b| {
        match (a.unlocked, b.unlocked) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (true, true) => b
                .unlock_time_utc
                .cmp(&a.unlock_time_utc)
                .then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase())),
            (false, false) => a
                .display_name
                .to_lowercase()
                .cmp(&b.display_name.to_lowercase()),
        }
    });
}

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

fn get_json(url: &str) -> Option<serde_json::Value> {
    ureq::get(url)
        .set("User-Agent", UA)
        .timeout(TIMEOUT)
        .call()
        .ok()?
        .into_json::<serde_json::Value>()
        .ok()
}

fn get_json_with_retry(url: &str, attempts: u32) -> Option<serde_json::Value> {
    for attempt in 0..attempts {
        match ureq::get(url)
            .set("User-Agent", UA)
            .timeout(TIMEOUT)
            .call()
        {
            Ok(resp) => {
                let status = resp.status();
                if status == 429 || status == 500 || status == 503 {
                    thread::sleep(Duration::from_millis(400 * (attempt as u64 + 1)));
                    continue;
                }
                if status != 200 {
                    return None;
                }
                return resp.into_json::<serde_json::Value>().ok();
            }
            Err(_) => {
                thread::sleep(Duration::from_millis(300 * (attempt as u64 + 1)));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNED_SAMPLE: &str = r#"{
        "response": {
            "game_count": 2,
            "games": [
                {
                    "appid": 730,
                    "name": "Counter-Strike 2",
                    "playtime_forever": 120,
                    "has_community_visible_stats": true
                },
                {
                    "appid": 570,
                    "name": "Dota 2",
                    "playtime_forever": 0,
                    "has_community_visible_stats": true
                }
            ]
        }
    }"#;

    const ACH_SAMPLE: &str = r#"{
        "playerstats": {
            "success": true,
            "achievements": [
                {"apiname": "a1", "achieved": 1},
                {"apiname": "a2", "achieved": 0},
                {"apiname": "a3", "achieved": 1}
            ]
        }
    }"#;

    #[test]
    fn parse_owned_games_json_shape() {
        let json: serde_json::Value = serde_json::from_str(OWNED_SAMPLE).unwrap();
        let games_arr = json.pointer("/response/games").unwrap().as_array().unwrap();
        assert_eq!(games_arr.len(), 2);
        assert_eq!(games_arr[0]["playtime_forever"].as_u64(), Some(120));
    }

    #[test]
    fn count_unlocked_achievements() {
        let json: serde_json::Value = serde_json::from_str(ACH_SAMPLE).unwrap();
        let unlocked = json
            .pointer("/playerstats/achievements")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter(|a| a.get("achieved").and_then(|v| v.as_i64()) == Some(1))
            .count();
        assert_eq!(unlocked, 2);
    }

    #[test]
    fn encode_query_param() {
        assert_eq!(encode("hello world"), "hello%20world");
    }

    /// Run with: STEAM_WEB_API_KEY=… STEAM_ID=… cargo test live_steam --lib -- --ignored
    #[test]
    #[ignore = "requires STEAM_WEB_API_KEY and STEAM_ID environment variables"]
    fn live_steam_owned_games() {
        let key = std::env::var("STEAM_WEB_API_KEY").expect("STEAM_WEB_API_KEY");
        let id = std::env::var("STEAM_ID").expect("STEAM_ID");
        let games = fetch_owned_games(&key, &id).expect("owned");
        assert!(!games.is_empty(), "expected at least one owned game");
    }
}
