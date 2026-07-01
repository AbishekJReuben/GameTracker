use crate::content_audit;
use crate::content_repair;
use crate::db::models::{GameDto, GameInput, ScreenshotDto, SessionDto, SessionFilter};
use crate::db::stats::{AppsOverview, CatalogAnalytics, Dashboard, DayValue, Insights, TagStat};
use crate::db::{games, screenshots, sessions, settings, stats};
use crate::detect::{self, Candidate};
use crate::error::{AppError, AppResult};
use crate::hltb;
use crate::importer::{self, ImportSummary};
use crate::metadata;
use crate::state::AppState;
use crate::suggestions::{self, AddSuggestionInput, SuggestionsResult};
use crate::system;
use crate::tracking::TrackingState;
use crate::{icons, util};
use chrono::Datelike;
use std::collections::HashMap;
use std::path::Path;
use tauri::{Emitter, State};
use tauri_plugin_opener::OpenerExt;

/// Run blocking work (network / file I/O) off Tauri's main thread so the UI never
/// janks while a command is in flight. The online-fetch commands use this so that
/// opening a game or pressing "Get data" no longer freezes the app.
async fn run_blocking<T, F>(f: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::msg(format!("background task failed: {e}")))?
}

// ---------- settings ----------

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> AppResult<HashMap<String, String>> {
    settings::all(&state.pool)
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> AppResult<()> {
    settings::set(&state.pool, &key, &value)
}

#[tauri::command]
pub fn complete_onboarding(state: State<AppState>) -> AppResult<()> {
    settings::set(&state.pool, "onboarded", "true")
}

// ---------- games ----------

#[tauri::command]
pub fn list_games(state: State<AppState>) -> AppResult<Vec<GameDto>> {
    games::list(&state.pool)
}

#[tauri::command]
pub fn get_game(state: State<AppState>, id: String) -> AppResult<Option<GameDto>> {
    games::get(&state.pool, &id)
}

#[tauri::command]
pub fn save_game(
    app: tauri::AppHandle,
    state: State<AppState>,
    input: GameInput,
) -> AppResult<GameDto> {
    let was_new = input.id.is_none();
    let exe_paths = input.exe_paths.clone();
    let kind = input.kind.clone();
    let display_name = input.display_name.clone();
    let steam_app_id = input.steam_app_id.filter(|&a| a > 0).map(|a| a as u64);
    let id = games::upsert(&state.pool, input)?;

    // Best-effort icon extraction for freshly-added tracked games.
    if was_new {
        if let Some(first_exe) = exe_paths.first() {
            if let Ok(Some(icon)) = icons::extract_icon_png(first_exe, &state.media_dir, &id) {
                let _ = games::set_icon_path(&state.pool, &id, &icon);
            }
        }
        // Auto-enrich freshly added games (cover + info) in the background.
        if kind == "game" {
            enrich_game_async(
                app,
                state.pool.clone(),
                state.media_dir.clone(),
                id.clone(),
                display_name,
                steam_app_id,
            );
        }
    }

    games::get(&state.pool, &id)?.ok_or_else(|| AppError::msg("Game not found after save."))
}

#[tauri::command]
pub fn delete_game(state: State<AppState>, id: String) -> AppResult<()> {
    games::delete(&state.pool, &id)
}

#[tauri::command]
pub fn set_game_status(state: State<AppState>, id: String, status: String) -> AppResult<()> {
    games::set_status(&state.pool, &id, &status)
}

#[tauri::command]
pub fn set_game_cover(state: State<AppState>, id: String, source: String) -> AppResult<GameDto> {
    let cover = icons::import_cover(&source, &state.media_dir, &id)?;
    games::set_cover_path(&state.pool, &id, &cover)?;
    games::get(&state.pool, &id)?.ok_or_else(|| AppError::msg("Game not found."))
}

/// User-triggered only. Requires online metadata opt-in.
#[tauri::command]
pub async fn fetch_cover(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<Option<GameDto>> {
    let pool = state.pool.clone();
    let media_dir = state.media_dir.clone();
    run_blocking(move || {
        if !settings::get_bool(&pool, "online_metadata_enabled")? {
            return Err(AppError::msg(
                "Turn on Online metadata in Settings to fetch covers from Steam.",
            ));
        }
        match metadata::fetch_cover(&name, &media_dir, &id)? {
            Some(cover) => {
                games::set_cover_path(&pool, &id, &cover)?;
                games::get(&pool, &id)
            }
            None => Ok(None),
        }
    })
    .await
}

/// Fetch developer, release year, metacritic, genres, and blurb from Steam (keyless).
/// Fills empty fields and merges genre tags. Optionally downloads cover too.
#[tauri::command]
pub async fn fetch_game_info(
    state: State<'_, AppState>,
    id: String,
    name: String,
    with_cover: Option<bool>,
) -> AppResult<Option<GameDto>> {
    let pool = state.pool.clone();
    let media_dir = state.media_dir.clone();
    run_blocking(move || {
        if !settings::get_bool(&pool, "online_metadata_enabled")? {
            return Err(AppError::msg(
                "Turn on Online metadata in Settings to fetch game info from Steam.",
            ));
        }
        let with_cover = with_cover.unwrap_or(false);
        match metadata::fetch_game_info(&name, &media_dir, &id, with_cover)? {
            Some(meta) => {
                apply_game_metadata(&pool, &id, &meta)?;
                games::get(&pool, &id)
            }
            None => Ok(None),
        }
    })
    .await
}

/// Outcome of a manual "check for updates" — whether a newer signed release is
/// available, plus both version strings for the UI to show.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub available: bool,
    pub version: Option<String>,
    pub current_version: String,
}

/// Manually check GitHub Releases for a newer signed build (the "Check for
/// updates" button). Does not install — the UI calls `install_update` next.
#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> AppResult<UpdateStatus> {
    use tauri_plugin_updater::UpdaterExt;
    let current_version = app.package_info().version.to_string();
    let updater = app.updater().map_err(|e| AppError::msg(e.to_string()))?;
    let update = updater
        .check()
        .await
        .map_err(|e| AppError::msg(e.to_string()))?;
    Ok(UpdateStatus {
        available: update.is_some(),
        version: update.map(|u| u.version.clone()),
        current_version,
    })
}

/// Download + install the available update and relaunch (no-op if none). Drives
/// the same silent path as the automatic check, but on explicit user request.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> AppResult<()> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| AppError::msg(e.to_string()))?;
    if let Some(update) = updater
        .check()
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
    {
        update
            .download_and_install(|_chunk, _total| {}, || {})
            .await
            .map_err(|e| AppError::msg(e.to_string()))?;
        app.restart();
    }
    Ok(())
}

/// Autosuggest titles for the add-game form (keyless Steam store search). Safe to
/// call without the online-metadata opt-in — it's an explicit, user-typed search.
#[tauri::command]
pub fn search_games_online(query: String) -> AppResult<Vec<metadata::GameSuggestion>> {
    if query.trim().len() < 2 {
        return Ok(Vec::new());
    }
    Ok(metadata::search_game_suggestions(query.trim(), 10))
}

/// Persist a fetched `GameMetadata` onto a game row (fields, media, appid, theme).
/// Shared by the manual `fetch_game_info` command and the auto-enrich-on-add path.
fn apply_game_metadata(
    pool: &crate::db::DbPool,
    id: &str,
    meta: &metadata::GameMetadata,
) -> AppResult<()> {
    games::apply_metadata(
        pool,
        id,
        meta.developer.as_deref(),
        meta.release_year,
        meta.metacritic,
        meta.short_description.as_deref(),
        &meta.genres,
        meta.cover_path.as_deref(),
    )?;
    games::set_media(
        pool,
        id,
        &meta.screenshots,
        meta.background_url.as_deref(),
        meta.website.as_deref(),
        meta.trailer_url.as_deref(),
    )?;
    if let Some(appid) = meta.steam_app_id {
        games::set_steam_app_id(pool, id, appid as i64)?;
    }
    games::set_theme(
        pool,
        id,
        meta.theme_youtube_id.as_deref(),
        meta.theme_audio_url.as_deref(),
        &meta.theme_track_ids,
        meta.theme_playlist_id.as_deref(),
        &meta.theme_track_titles,
    )?;
    Ok(())
}

/// Fire-and-forget online enrichment for a freshly added game. Runs on a worker
/// thread (network must not block the sync command) and emits `game://enriched`
/// with `{ id }` when done so the UI can refetch. No-op when online metadata is
/// off. `steam_app_id`, when known from detection/autosuggest, makes the lookup
/// exact instead of a name search.
pub(crate) fn enrich_game_async(
    app: tauri::AppHandle,
    pool: crate::db::DbPool,
    media_dir: std::path::PathBuf,
    id: String,
    name: String,
    steam_app_id: Option<u64>,
) {
    if !settings::get_bool(&pool, "online_metadata_enabled").unwrap_or(false) {
        return;
    }
    std::thread::spawn(move || {
        let meta = if let Some(appid) = steam_app_id {
            metadata::fetch_game_info_by_appid(appid, &media_dir, &id, true)
                .ok()
                .flatten()
        } else {
            None
        };
        let meta = match meta {
            Some(m) => Some(m),
            None => metadata::fetch_game_info(&name, &media_dir, &id, true)
                .ok()
                .flatten(),
        };
        if let Some(meta) = meta {
            let _ = apply_game_metadata(&pool, &id, &meta);
        }
        // Also pull HowLongToBeat estimates so a freshly-added game has its
        // playtimes ready alongside its cover & info. We store the estimates
        // only (apply=false) — auto-enrichment never inflates a game's manual
        // playtime; the user can still apply it from the "Get data" action.
        if let Ok(Some(times)) = hltb::lookup(&name) {
            let _ = games::apply_hltb(&pool, &id, &times, false);
        }
        let _ = app.emit("game://enriched", serde_json::json!({ "id": id }));
    });
}

/// A game's OST is "sparse" if we have no source playlist and only a handful of
/// tracks — i.e. it predates the full-OST resolver and should be backfilled.
fn ost_is_sparse(g: &crate::db::models::GameDto) -> bool {
    g.theme_playlist_id.is_none() && g.theme_track_ids.len() < 6
}

/// Resolve a game's **full** OST (playlist scrape → up to ~100 tracks) on demand
/// and persist it, then emit `game://enriched` so the open page refetches. Runs
/// on a worker thread. Gated by the online-metadata opt-in.
#[tauri::command]
pub fn fetch_full_ost(
    app: tauri::AppHandle,
    state: State<AppState>,
    game_id: String,
) -> AppResult<()> {
    if !settings::get_bool(&state.pool, "online_metadata_enabled")? {
        return Err(AppError::msg(
            "Turn on Online metadata in Settings to fetch soundtracks.",
        ));
    }
    let pool = state.pool.clone();
    std::thread::spawn(move || {
        let Ok(Some(game)) = games::get(&pool, &game_id) else {
            let _ = app.emit("game://enriched", serde_json::json!({ "id": game_id }));
            return;
        };
        let theme = metadata::resolve_theme(&game.display_name);
        let _ = games::set_theme(
            &pool,
            &game_id,
            theme.youtube_id.as_deref(),
            theme.audio_url.as_deref(),
            &theme.track_ids,
            theme.playlist_id.as_deref(),
            &theme.track_titles,
        );
        let _ = app.emit("game://enriched", serde_json::json!({ "id": game_id }));
    });
    Ok(())
}

/// Backfill full OSTs across the whole library. Spawns a throttled worker that
/// scrapes a full YouTube OST playlist for every game whose soundtrack is still
/// sparse, persists each result, and emits `ost://progress` `{ done, total,
/// gameId, name, tracks }` per game then `ost://done` `{ count }`. Returns the
/// number of games queued so the UI can show a total immediately. Gated by the
/// online-metadata opt-in.
#[tauri::command]
pub fn build_ost_library(app: tauri::AppHandle, state: State<AppState>) -> AppResult<usize> {
    if !settings::get_bool(&state.pool, "online_metadata_enabled")? {
        return Err(AppError::msg(
            "Turn on Online metadata in Settings to build the soundtrack library.",
        ));
    }
    let pool = state.pool.clone();
    let pending: Vec<crate::db::models::GameDto> = games::list(&pool)?
        .into_iter()
        .filter(|g| g.kind == "game" && ost_is_sparse(g))
        .collect();
    let total = pending.len();

    std::thread::spawn(move || {
        for (i, game) in pending.into_iter().enumerate() {
            let theme = metadata::resolve_theme(&game.display_name);
            let tracks = theme.track_ids.len();
            let _ = games::set_theme(
                &pool,
                &game.id,
                theme.youtube_id.as_deref(),
                theme.audio_url.as_deref(),
                &theme.track_ids,
                theme.playlist_id.as_deref(),
                &theme.track_titles,
            );
            let _ = app.emit(
                "ost://progress",
                serde_json::json!({
                    "done": i + 1,
                    "total": total,
                    "gameId": game.id,
                    "name": game.display_name,
                    "tracks": tracks,
                }),
            );
            // Be polite to YouTube between games.
            std::thread::sleep(std::time::Duration::from_millis(600));
        }
        let _ = app.emit("ost://done", serde_json::json!({ "count": total }));
        // Refresh any open lists so newly-linked OSTs appear.
        let _ = app.emit("game://enriched", serde_json::json!({ "id": "" }));
    });

    Ok(total)
}

/// The game's top live Twitch stream right now (keyless, public web GQL). Returns
/// `None` when online metadata is off or the category can't be resolved; a result
/// with `channel: None` means the game has a Twitch category but nobody is live.
#[tauri::command]
pub async fn fetch_twitch_live(
    state: State<'_, AppState>,
    game_name: String,
) -> AppResult<Option<metadata::TwitchLive>> {
    if !settings::get_bool(&state.pool, "online_metadata_enabled")? {
        return Ok(None);
    }
    run_blocking(move || Ok(metadata::twitch_top_live(&game_name))).await
}

/// Cached live stats served instantly from the DB, plus when they were fetched.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedGameStats {
    pub stats: Option<metadata::GameStats>,
    pub fetched_utc: Option<String>,
}

/// Return the *cached* live stats for a game (no network), so GameDetail renders
/// them instantly without hanging. Empty when never fetched — the UI then calls
/// `refresh_game_stats` to populate them in the background.
#[tauri::command]
pub fn get_game_stats(state: State<AppState>, game_id: String) -> AppResult<CachedGameStats> {
    let (json, fetched_utc) = games::get_stats_cache(&state.pool, &game_id)?;
    let stats = json.and_then(|j| serde_json::from_str::<metadata::GameStats>(&j).ok());
    Ok(CachedGameStats { stats, fetched_utc })
}

/// Kick off a background refresh of a game's live stats. Returns immediately; the
/// fetch runs on a worker thread (network must not block the UI), caches the
/// result with the game, and emits `game://stats` with `{ id, stats, fetchedUtc }`
/// so the open GameDetail updates in place. Gated by the online-metadata opt-in.
#[tauri::command]
pub fn refresh_game_stats(
    app: tauri::AppHandle,
    state: State<AppState>,
    game_id: String,
) -> AppResult<()> {
    if !settings::get_bool(&state.pool, "online_metadata_enabled")? {
        return Err(AppError::msg(
            "Turn on Online metadata in Settings to fetch live game stats.",
        ));
    }
    let pool = state.pool.clone();
    std::thread::spawn(move || {
        refresh_game_stats_inner(&app, &pool, &game_id);
    });
    Ok(())
}

fn refresh_game_stats_inner(app: &tauri::AppHandle, pool: &crate::db::DbPool, game_id: &str) {
    let emit = |stats: Option<&metadata::GameStats>, fetched: Option<&str>| {
        let _ = app.emit(
            "game://stats",
            serde_json::json!({ "id": game_id, "stats": stats, "fetchedUtc": fetched }),
        );
    };
    let Ok(Some(game)) = games::get(pool, game_id) else {
        emit(None, None);
        return;
    };
    let appid = match game.steam_app_id {
        Some(a) if a > 0 => Some(a as u64),
        _ => metadata::resolve_steam_appid(&game.display_name),
    };
    let Some(appid) = appid else {
        // Non-Steam game: no stats source. Tell the UI so it can stop "updating".
        emit(None, None);
        return;
    };
    // Cache the resolved appid so subsequent loads (and covers) are exact.
    if game.steam_app_id.is_none() {
        let _ = games::set_steam_app_id(pool, game_id, appid as i64);
    }
    let stats = metadata::fetch_game_stats(appid);
    let now = chrono::Utc::now().to_rfc3339();
    if let Ok(json) = serde_json::to_string(&stats) {
        let _ = games::set_stats_cache(pool, game_id, &json, &now);
    }
    emit(Some(&stats), Some(&now));
}

/// Fetch HowLongToBeat estimates (main, main+extra, completionist).
#[tauri::command]
pub async fn fetch_hltb(
    state: State<'_, AppState>,
    id: String,
    name: String,
    apply_as_manual: Option<bool>,
) -> AppResult<Option<GameDto>> {
    let pool = state.pool.clone();
    run_blocking(move || {
        let apply = apply_as_manual.unwrap_or(true);
        match hltb::lookup(&name)? {
            Some(times) => {
                games::apply_hltb(&pool, &id, &times, apply)?;
                games::get(&pool, &id)?
                    .ok_or_else(|| AppError::msg("Game not found"))
                    .map(Some)
            }
            None => Ok(None),
        }
    })
    .await
}

/// Add a game from a dropped/selected path (exe or folder). Returns the saved game.
#[tauri::command]
pub fn add_from_path(
    app: tauri::AppHandle,
    state: State<AppState>,
    path: String,
) -> AppResult<GameDto> {
    let p = Path::new(&path);
    let (name, exe_paths, install_folder) = if p.is_dir() {
        (
            p.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("Game")
                .to_string(),
            Vec::new(),
            Some(path.clone()),
        )
    } else {
        (util::name_from_exe(&path), vec![path.clone()], None)
    };
    let input = GameInput {
        id: None,
        kind: "game".to_string(),
        display_name: name,
        install_folder,
        exe_paths,
        cover_path: None,
        status: "playing".to_string(),
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
        tags: Vec::new(),
        count_background: None,
        steam_app_id: None,
        gog_product_id: None,
    };
    save_game(app, state, input)
}

/// Add a tracked application/software from an exe path. Kept distinct from games.
#[tauri::command]
pub fn add_app_from_path(
    app: tauri::AppHandle,
    state: State<AppState>,
    path: String,
) -> AppResult<GameDto> {
    let input = GameInput {
        id: None,
        kind: "app".to_string(),
        display_name: util::name_from_exe(&path),
        install_folder: Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string()),
        exe_paths: vec![path.clone()],
        cover_path: None,
        status: "playing".to_string(),
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
        tags: Vec::new(),
        count_background: Some(true),
        steam_app_id: None,
        gog_product_id: None,
    };
    save_game(app, state, input)
}

/// Fetch a one-line description + logo for an app from Wikipedia (keyless).
/// Requires the online-metadata opt-in, like the game equivalents.
#[tauri::command]
pub async fn fetch_app_info(
    state: State<'_, AppState>,
    id: String,
    name: String,
    with_image: Option<bool>,
) -> AppResult<Option<GameDto>> {
    let pool = state.pool.clone();
    let media_dir = state.media_dir.clone();
    run_blocking(move || {
        if !settings::get_bool(&pool, "online_metadata_enabled")? {
            return Err(AppError::msg(
                "Turn on Online metadata in Settings to fetch app info.",
            ));
        }
        let with_image = with_image.unwrap_or(true);
        match metadata::fetch_app_info(&name, &media_dir, &id, with_image)? {
            Some(info) => {
                games::apply_metadata(
                    &pool,
                    &id,
                    info.developer.as_deref(),
                    info.release_year,
                    None,
                    info.description.as_deref(),
                    &info.genre_tags,
                    info.cover_path.as_deref(),
                )?;
                games::set_media(&pool, &id, &info.screenshots, None, info.website.as_deref(), None)?;
                if let Some(json) = info.info_json.as_deref() {
                    games::set_info_json(&pool, &id, json)?;
                }
                games::get(&pool, &id)
            }
            None => Ok(None),
        }
    })
    .await
}

// ---------- detection ----------

#[tauri::command]
pub fn detect_games(state: State<AppState>) -> AppResult<Vec<Candidate>> {
    detect::detect(&state.pool)
}

#[tauri::command]
pub fn import_detected(
    app: tauri::AppHandle,
    state: State<AppState>,
    candidates: Vec<Candidate>,
) -> AppResult<i64> {
    let mut added = 0;
    for c in candidates {
        if games::exists_by_name(&state.pool, &c.name)? {
            continue;
        }
        let name = c.name.clone();
        let steam_app_id = c.steam_app_id;
        let input = GameInput {
            id: None,
            kind: "game".to_string(),
            display_name: c.name,
            install_folder: c.install_folder,
            exe_paths: c.exe_path.into_iter().collect(),
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
            tags: Vec::new(),
            count_background: None,
            steam_app_id: steam_app_id.map(|a| a as i64),
            gog_product_id: None,
        };
        let first_exe = input.exe_paths.first().cloned();
        let id = games::upsert(&state.pool, input)?;
        if let Some(exe) = first_exe {
            if let Ok(Some(icon)) = icons::extract_icon_png(&exe, &state.media_dir, &id) {
                let _ = games::set_icon_path(&state.pool, &id, &icon);
            }
        }
        // Pull cover + info online in the background for each imported game.
        enrich_game_async(
            app.clone(),
            state.pool.clone(),
            state.media_dir.clone(),
            id.clone(),
            name,
            steam_app_id,
        );
        added += 1;
    }
    Ok(added)
}

/// Detect running user applications (visible-window processes) not yet registered.
#[tauri::command]
pub fn detect_apps(state: State<AppState>) -> AppResult<Vec<Candidate>> {
    detect::detect_apps(&state.pool)
}

#[tauri::command]
pub fn import_detected_apps(state: State<AppState>, candidates: Vec<Candidate>) -> AppResult<i64> {
    let mut added = 0;
    for c in candidates {
        if games::exists_by_name(&state.pool, &c.name)? {
            continue;
        }
        let input = GameInput {
            id: None,
            kind: "app".to_string(),
            display_name: c.name,
            install_folder: c.install_folder,
            exe_paths: c.exe_path.into_iter().collect(),
            cover_path: None,
            status: "playing".to_string(),
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
            tags: Vec::new(),
            count_background: Some(true),
            steam_app_id: None,
            gog_product_id: None,
        };
        let first_exe = input.exe_paths.first().cloned();
        let id = games::upsert(&state.pool, input)?;
        // Apps lean on their executable icon for art — extract it on import.
        if let Some(exe) = first_exe {
            if let Ok(Some(icon)) = icons::extract_icon_png(&exe, &state.media_dir, &id) {
                let _ = games::set_icon_path(&state.pool, &id, &icon);
            }
        }
        added += 1;
    }
    Ok(added)
}

// ---------- CSV import ----------

#[tauri::command]
pub fn import_games_csv(
    state: State<AppState>,
    app: tauri::AppHandle,
    path: String,
    job_id: Option<String>,
) -> AppResult<ImportSummary> {
    let jid = job_id.filter(|s| !s.is_empty());
    importer::import_csv(
        &state.pool,
        Path::new(&path),
        jid.as_deref(),
        Some(&|ev| {
            let _ = app.emit("task://progress", &ev);
        }),
    )
}

/// The owner's known completed-games CSV, if it still exists on disk.
#[tauri::command]
pub fn default_csv_path() -> Option<String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    // Shipped-from-this-repo copy (present on the dev machine that built the app).
    if let Some(p) = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|d| d.join("Games List - Games.csv"))
    {
        candidates.push(p);
    }

    if let Some(d) = dirs::download_dir() {
        candidates.push(d.join("Telegram Desktop").join("Games List - Games.csv"));
        candidates.push(d.join("Games List - Games.csv"));
    }

    for c in candidates {
        if c.is_file() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}

// ---------- screenshots (auto-captured in-game) ----------

#[tauri::command]
pub fn list_screenshots(state: State<AppState>, game_id: String) -> AppResult<Vec<ScreenshotDto>> {
    screenshots::list(&state.pool, &game_id)
}

#[tauri::command]
pub fn delete_screenshot(state: State<AppState>, id: String) -> AppResult<()> {
    if let Some(path) = screenshots::delete(&state.pool, &id)? {
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

// ---------- sessions & analytics ----------

#[tauri::command]
pub fn list_sessions(state: State<AppState>, filter: SessionFilter) -> AppResult<Vec<SessionDto>> {
    sessions::list(&state.pool, &filter)
}

#[tauri::command]
pub fn dashboard(state: State<AppState>) -> AppResult<Dashboard> {
    stats::dashboard(&state.pool)
}

#[tauri::command]
pub fn apps_overview(state: State<AppState>) -> AppResult<AppsOverview> {
    stats::apps_overview(&state.pool)
}

#[tauri::command]
pub fn heatmap(state: State<AppState>, days: i64, kind: Option<String>) -> AppResult<Vec<DayValue>> {
    stats::heatmap(&state.pool, days.clamp(7, 400), kind.as_deref())
}

#[tauri::command]
pub fn hour_of_day(state: State<AppState>, kind: Option<String>) -> AppResult<Vec<i64>> {
    stats::hour_of_day(&state.pool, kind.as_deref())
}

#[tauri::command]
pub fn catalog_analytics(state: State<AppState>) -> AppResult<CatalogAnalytics> {
    stats::catalog_analytics(&state.pool)
}

#[tauri::command]
pub fn insights(state: State<AppState>, year: Option<i64>, kind: Option<String>) -> AppResult<Insights> {
    let y = year.unwrap_or_else(|| chrono::Local::now().year() as i64);
    stats::insights(&state.pool, y, kind.as_deref())
}

#[tauri::command]
pub fn tag_analytics(state: State<AppState>) -> AppResult<Vec<TagStat>> {
    stats::tag_analytics(&state.pool)
}

#[tauri::command]
pub fn list_tags(state: State<AppState>) -> AppResult<Vec<String>> {
    stats::list_tags(&state.pool)
}

/// Rename a tag everywhere (merges into the target if it already exists).
#[tauri::command]
pub fn rename_tag(state: State<AppState>, old: String, new: String) -> AppResult<()> {
    games::rename_tag(&state.pool, &old, &new)
}

/// Delete a tag, removing it from every game.
#[tauri::command]
pub fn delete_tag(state: State<AppState>, name: String) -> AppResult<()> {
    games::delete_tag(&state.pool, &name)
}

/// Merge several tags into one target tag.
#[tauri::command]
pub fn merge_tags(state: State<AppState>, sources: Vec<String>, target: String) -> AppResult<()> {
    games::merge_tags(&state.pool, &sources, &target)
}

// ---------- suggestions ----------

#[tauri::command]
pub fn suggest_games(state: State<AppState>, refresh: Option<bool>) -> AppResult<SuggestionsResult> {
    suggestions::generate(&state.pool, refresh.unwrap_or(false))
}

/// Replace the muted-tags list used to filter game suggestions.
#[tauri::command]
pub fn set_suggested_excluded_tags(state: State<AppState>, tags: Vec<String>) -> AppResult<()> {
    suggestions::set_excluded_tags(&state.pool, &tags)
}

#[tauri::command]
pub fn add_suggested_game(state: State<AppState>, input: AddSuggestionInput) -> AppResult<GameDto> {
    let game_input = GameInput {
        id: None,
        kind: "game".to_string(),
        display_name: input.name.clone(),
        install_folder: None,
        exe_paths: Vec::new(),
        cover_path: None,
        status: "backlog".to_string(),
        rating: None,
        developer: input.developer,
        release_year: input.release_year,
        started_year: None,
        started_month: None,
        started_day: None,
        completed_year: None,
        completed_month: None,
        completed_day: None,
        metacritic: input.metacritic,
        notes: None,
        time_to_beat_minutes: None,
        manual_playtime_seconds: None,
        accent_color: None,
        tags: input.genres,
        count_background: None,
        steam_app_id: input.steam_app_id.map(|a| a as i64),
        gog_product_id: None,
    };
    let id = games::upsert(&state.pool, game_input)?;
    if let Some(appid) = input.steam_app_id {
        if let Some(bytes_url) = try_download_steam_cover(appid, &state.media_dir, &id) {
            let _ = games::set_cover_path(&state.pool, &id, &bytes_url);
        }
    } else if settings::get_bool(&state.pool, "online_metadata_enabled")? {
        if let Ok(Some(_)) = metadata::fetch_cover(&input.name, &state.media_dir, &id) {
            /* cover saved by fetch_cover */
        }
    }
    games::get(&state.pool, &id)?.ok_or_else(|| AppError::msg("Game not found"))
}

fn try_download_steam_cover(appid: u64, media_dir: &std::path::Path, game_id: &str) -> Option<String> {
    let url = metadata::steam_cover_url(appid);
    let resp = ureq::get(&url).timeout(std::time::Duration::from_secs(12)).call().ok()?;
    let mut buf = Vec::new();
    use std::io::Read;
    resp.into_reader().take(12_000_000).read_to_end(&mut buf).ok()?;
    if buf.len() < 1024 {
        return None;
    }
    std::fs::create_dir_all(media_dir).ok()?;
    let dest = media_dir.join(format!("cover_{game_id}.jpg"));
    std::fs::write(&dest, &buf).ok()?;
    Some(dest.to_string_lossy().to_string())
}

// ---------- tracking ----------

#[tauri::command]
pub fn tracking_state(state: State<AppState>) -> TrackingState {
    state.shared.state.lock().clone()
}

#[tauri::command]
pub fn set_paused(state: State<AppState>, paused: bool) -> AppResult<()> {
    settings::set(&state.pool, "tracking_paused", if paused { "true" } else { "false" })
}

// ---------- system monitor ----------

#[tauri::command]
pub fn system_specs(state: State<AppState>) -> system::SystemSpecs {
    system::specs(&state.sys)
}

#[tauri::command]
pub fn system_live(state: State<AppState>) -> system::SystemLive {
    system::live(&state.sys)
}

#[tauri::command]
pub fn system_history(state: State<AppState>, minutes: i64) -> AppResult<system::SystemHistory> {
    system::history(&state.pool, &state.sys, minutes)
}

// ---------- autostart (elevated, via scheduled task) ----------

#[tauri::command]
pub fn autostart_enabled() -> bool {
    crate::autostart::is_enabled()
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> AppResult<()> {
    crate::autostart::set(enabled)
}

// ---------- reviews ----------

#[tauri::command]
pub async fn fetch_steam_reviews(app_id: i64) -> AppResult<Vec<metadata::SteamReview>> {
    run_blocking(move || {
        if app_id <= 0 {
            return Ok(Vec::new());
        }
        metadata::fetch_steam_reviews(app_id as u64)
    })
    .await
}

#[tauri::command]
pub async fn fetch_metacritic_reviews(
    state: State<'_, AppState>,
    game_id: String,
    slug: Option<String>,
) -> AppResult<Vec<metadata::MetacriticReview>> {
    let pool = state.pool.clone();
    run_blocking(move || {
        if !settings::get_bool(&pool, "online_metadata_enabled")? {
            return Err(AppError::msg(
                "Turn on Online metadata in Settings to fetch Metacritic reviews.",
            ));
        }
        let game = games::get(&pool, &game_id)?.ok_or_else(|| AppError::msg("Game not found."))?;
        let resolved = if let Some(s) = slug.filter(|s| !s.trim().is_empty()) {
            if metadata::metacritic_slug_valid(&s, &game.display_name) {
                s
            } else {
                metadata::resolve_metacritic_slug(&game.display_name)
                    .ok_or_else(|| AppError::msg("Could not find this game on Metacritic."))?
            }
        } else if let Some(s) = game.metacritic_slug.as_ref().filter(|s| !s.trim().is_empty()) {
            if metadata::metacritic_slug_valid(s, &game.display_name) {
                s.clone()
            } else {
                metadata::resolve_metacritic_slug(&game.display_name)
                    .ok_or_else(|| AppError::msg("Could not find this game on Metacritic."))?
            }
        } else {
            metadata::resolve_metacritic_slug(&game.display_name)
                .ok_or_else(|| AppError::msg("Could not find this game on Metacritic."))?
        };
        if game.metacritic_slug.as_deref() != Some(resolved.as_str()) {
            let _ = games::set_metacritic_slug(&pool, &game_id, &resolved);
        }
        metadata::fetch_metacritic_reviews(&resolved)
    })
    .await
}

/// Probe Steam, Metacritic, HLTB, trailer, theme, website & reviews for every entry (background).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditProgressEvent {
    pub done: usize,
    pub total: usize,
    pub name: String,
}

#[tauri::command]
pub fn audit_online_content(state: State<AppState>, app: tauri::AppHandle) -> AppResult<()> {
    if !settings::get_bool(&state.pool, "online_metadata_enabled")? {
        return Err(AppError::msg(
            "Turn on Online metadata in Settings before running the content audit.",
        ));
    }
    let games = games::list(&state.pool)?;
    let media_dir = state.media_dir.clone();
    let total = games.len();

    std::thread::spawn(move || {
        let mut out = Vec::with_capacity(total);
        for (i, game) in games.iter().enumerate() {
            let _ = app.emit(
                "audit://progress",
                AuditProgressEvent {
                    done: i,
                    total,
                    name: game.display_name.clone(),
                },
            );
            if i > 0 {
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            out.push(content_audit::audit_one(game, &media_dir));
        }
        let _ = app.emit(
            "audit://progress",
            AuditProgressEvent {
                done: total,
                total,
                name: "Done".into(),
            },
        );
        if app.emit("audit://complete", out).is_err() {
            let _ = app.emit("audit://error", "Could not deliver audit results.");
        }
    });
    Ok(())
}

/// Re-resolve and persist Steam ids, Metacritic slugs, trailers, websites & themes.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairProgressEvent {
    pub done: usize,
    pub total: usize,
    pub name: String,
}

#[tauri::command]
pub fn repair_library_content(state: State<AppState>, app: tauri::AppHandle) -> AppResult<()> {
    if !settings::get_bool(&state.pool, "online_metadata_enabled")? {
        return Err(AppError::msg(
            "Turn on Online metadata in Settings before repairing library content.",
        ));
    }
    let games = games::list(&state.pool)?;
    let pool = state.pool.clone();
    let media_dir = state.media_dir.clone();
    let total = games.len();

    std::thread::spawn(move || {
        let mut summaries = Vec::with_capacity(total);
        for (i, game) in games.iter().enumerate() {
            let _ = app.emit(
                "repair://progress",
                RepairProgressEvent {
                    done: i,
                    total,
                    name: game.display_name.clone(),
                },
            );
            if i > 0 {
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
            match content_repair::repair_one(&pool, &media_dir, game) {
                Ok(s) => summaries.push(s),
                Err(e) => {
                    let _ = app.emit("repair://error", e.to_string());
                    return;
                }
            }
        }
        let _ = app.emit("repair://complete", summaries);
    });
    Ok(())
}

/// Launch the primary executable for a tracked game (Windows only).
#[tauri::command]
pub fn launch_game(state: State<AppState>, id: String) -> AppResult<()> {
    let game = games::get(&state.pool, &id)?.ok_or_else(|| AppError::msg("Game not found."))?;
    if game.kind != "game" {
        return Err(AppError::msg("Only games can be launched."));
    }
    let exe = util::first_existing_exe(&game.exe_paths)
        .ok_or_else(|| AppError::msg("Executable not found. The file may have been moved or deleted."))?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x00000008;
        let work_dir = exe.parent().unwrap_or(Path::new("."));
        std::process::Command::new(&exe)
            .current_dir(work_dir)
            .creation_flags(DETACHED_PROCESS)
            .spawn()
            .map_err(|e| AppError::msg(format!("Failed to launch: {e}")))?;
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        let _ = (state, exe);
        Err(AppError::msg("Launch is only supported on Windows."))
    }
}

// ---------- export / backup ----------

#[tauri::command]
pub fn export_sessions_csv(state: State<AppState>, path: String) -> AppResult<i64> {
    let rows = sessions::list(&state.pool, &SessionFilter::default())?;
    let mut wtr = csv::Writer::from_path(&path)?;
    wtr.write_record([
        "Game",
        "Start (UTC)",
        "End (UTC)",
        "Runtime (s)",
        "Active (s)",
        "Idle ended",
    ])?;
    for r in &rows {
        wtr.write_record([
            r.game_name.as_str(),
            r.start_utc.as_str(),
            r.end_utc.as_deref().unwrap_or(""),
            &r.runtime_seconds.to_string(),
            &r.active_seconds.to_string(),
            if r.was_idle_ended { "yes" } else { "no" },
        ])?;
    }
    wtr.flush()?;
    Ok(rows.len() as i64)
}

#[tauri::command]
pub fn export_data_json(state: State<AppState>, path: String) -> AppResult<()> {
    let games = games::list(&state.pool)?;
    let sessions = sessions::list(&state.pool, &SessionFilter::default())?;
    let payload = serde_json::json!({
        "exportedAt": util::now_utc_string(),
        "games": games,
        "sessions": sessions,
    });
    std::fs::write(&path, serde_json::to_string_pretty(&payload)?)?;
    Ok(())
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> AppResult<()> {
    std::fs::write(&path, contents.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub fn backup_db(state: State<AppState>, path: String) -> AppResult<()> {
    if Path::new(&path).exists() {
        std::fs::remove_file(&path)?;
    }
    let conn = state.pool.get()?;
    conn.execute("VACUUM INTO ?1", [&path])?;
    Ok(())
}

/// Stage a database file to be swapped in on next launch, then restart.
#[tauri::command]
pub fn restore_db(state: State<AppState>, path: String, app: tauri::AppHandle) -> AppResult<()> {
    let src = Path::new(&path);
    if !src.is_file() {
        return Err(AppError::msg("Backup file not found."));
    }
    let pending = state.data_dir.join("pending_restore.db");
    std::fs::copy(src, &pending)?;
    // `restart()` diverges (`-> !`), satisfying the return type.
    app.restart()
}

// ---------- Steam sync ----------

#[tauri::command]
pub fn steam_session(state: State<AppState>) -> AppResult<crate::steam::SteamSession> {
    crate::steam::session(&state.pool)
}

#[tauri::command]
pub fn steam_login(
    app: tauri::AppHandle,
    state: State<AppState>,
) -> AppResult<crate::steam::SteamValidateResult> {
    if !crate::steam::api_key_configured() {
        return Err(AppError::msg(
            "Steam sync is not available in this build (developer API key missing).",
        ));
    }
    let pool = state.pool.clone();
    let steam_id = crate::steam_openid::login_blocking(|url| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| AppError::msg(format!("Could not open browser: {e}")))
    })?;
    crate::steam::complete_login(&pool, &steam_id)
}

#[tauri::command]
pub fn steam_logout(state: State<AppState>) -> AppResult<()> {
    crate::steam::logout(&state.pool)
}

#[tauri::command]
pub fn steam_validate(state: State<AppState>) -> AppResult<crate::steam::SteamValidateResult> {
    crate::steam::validate_session(&state.pool)
}

#[tauri::command]
pub fn steam_library(state: State<AppState>) -> AppResult<Vec<crate::steam::SteamLibraryGame>> {
    crate::steam::library(&state.pool)
}

#[tauri::command]
pub fn steam_game_achievements(
    state: State<AppState>,
    game_id: String,
    refresh: Option<bool>,
) -> AppResult<Vec<crate::steam::SteamAchievement>> {
    let pool = &state.pool;
    let force = refresh.unwrap_or(false);
    if !force {
        let cached = crate::steam::achievements_for_game(pool, &game_id)?;
        if !cached.is_empty() {
            return Ok(cached);
        }
    }

    let game = games::get(pool, &game_id)?.ok_or_else(|| AppError::msg("Game not found."))?;
    let appid = game
        .steam_app_id
        .filter(|&a| a > 0)
        .ok_or_else(|| AppError::msg("This game has no linked Steam app ID."))?;
    let api_key = crate::steam::steam_api_key()?;
    let steam_id = settings::get(pool, "steam_id")?.unwrap_or_default();
    let install_folder = game.install_folder.clone();

    crate::steam::refresh_achievements_for_game(
        pool,
        &game_id,
        &api_key,
        &steam_id,
        appid as u64,
        install_folder.as_deref(),
    )
}

#[tauri::command]
pub fn steam_achievements_overview(
    state: State<AppState>,
) -> AppResult<crate::steam::SteamAchievementsOverview> {
    crate::steam::achievements_overview(&state.pool)
}

#[tauri::command]
pub fn steam_import(
    state: State<AppState>,
    app: tauri::AppHandle,
    app_ids: Vec<u64>,
    playtime: bool,
    achievements: bool,
) -> AppResult<()> {
    let pool = state.pool.clone();
    let media_dir = state.media_dir.clone();
    std::thread::spawn(move || {
        let progress = |ev: crate::steam::SteamSyncProgress| {
            let _ = app.emit("steam://progress", &ev);
        };
        match crate::steam::import_games(
            &pool,
            &app_ids,
            playtime,
            achievements,
            Some(&progress),
        ) {
            Ok((result, imported)) => {
                for game in imported {
                    enrich_game_async(
                        app.clone(),
                        pool.clone(),
                        media_dir.clone(),
                        game.id,
                        game.name,
                        Some(game.appid),
                    );
                }
                let _ = app.emit("steam://complete", &result);
            }
            Err(e) => {
                let _ = app.emit("steam://error", e.to_string());
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn steam_sync(
    state: State<AppState>,
    app: tauri::AppHandle,
    playtime: bool,
    achievements: bool,
) -> AppResult<()> {
    let pool = state.pool.clone();
    std::thread::spawn(move || {
        let progress = |ev: crate::steam::SteamSyncProgress| {
            let _ = app.emit("steam://progress", &ev);
        };
        match crate::steam::sync(&pool, playtime, achievements, Some(&progress)) {
            Ok(result) => {
                let _ = app.emit("steam://complete", &result);
            }
            Err(e) => {
                let _ = app.emit("steam://error", e.to_string());
            }
        }
    });
    Ok(())
}

// ---------- GOG sync ----------

#[tauri::command]
pub fn gog_session(state: State<AppState>) -> AppResult<crate::gog::GogSession> {
    crate::gog::session(&state.pool)
}

#[tauri::command]
pub fn gog_login_url() -> String {
    crate::gog_auth::login_url()
}

#[tauri::command]
pub fn gog_login_finish(
    state: State<AppState>,
    callback: String,
) -> AppResult<crate::gog::GogValidateResult> {
    let pool = state.pool.clone();
    let token = crate::gog_auth::complete_from_user_input(&callback)?;
    crate::gog::complete_login(&pool, token)
}

#[tauri::command]
pub fn gog_login(
    app: tauri::AppHandle,
    state: State<AppState>,
) -> AppResult<crate::gog::GogValidateResult> {
    let _ = app;
    let _ = state;
    Err(AppError::msg(
        "Use the browser sign-in flow: open the login URL, then call gogLoginFinish with the redirect URL.",
    ))
}

#[tauri::command]
pub fn gog_logout(state: State<AppState>) -> AppResult<()> {
    crate::gog::logout(&state.pool)
}

#[tauri::command]
pub fn gog_validate(state: State<AppState>) -> AppResult<crate::gog::GogValidateResult> {
    crate::gog::validate_session(&state.pool)
}

#[tauri::command]
pub fn gog_library(state: State<AppState>) -> AppResult<Vec<crate::gog::GogLibraryGame>> {
    crate::gog::library(&state.pool)
}

#[tauri::command]
pub fn gog_import(
    state: State<AppState>,
    app: tauri::AppHandle,
    product_ids: Vec<u64>,
) -> AppResult<()> {
    let pool = state.pool.clone();
    let media_dir = state.media_dir.clone();
    std::thread::spawn(move || {
        let app_handle = app.clone();
        match crate::gog::import_games(&pool, &product_ids, |id| {
            if let Ok(Some(game)) = games::get(&pool, id) {
                enrich_game_async(
                    app_handle.clone(),
                    pool.clone(),
                    media_dir.clone(),
                    id.to_string(),
                    game.display_name,
                    None,
                );
            }
        }) {
            Ok(result) => {
                let _ = app.emit("gog://complete", &result);
            }
            Err(e) => {
                let _ = app.emit("gog://error", e.to_string());
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn gog_sync(
    state: State<AppState>,
    app: tauri::AppHandle,
    playtime: bool,
    achievements: bool,
) -> AppResult<()> {
    let pool = state.pool.clone();
    std::thread::spawn(move || {
        let progress = |ev: crate::gog::GogSyncProgress| {
            let _ = app.emit("gog://progress", &ev);
        };
        match crate::gog::sync(&pool, playtime, achievements, Some(&progress)) {
            Ok(result) => {
                let _ = app.emit("gog://complete", &result);
            }
            Err(e) => {
                let _ = app.emit("gog://error", e.to_string());
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn gog_game_achievements(
    state: State<AppState>,
    game_id: String,
    refresh: bool,
) -> AppResult<Vec<crate::gog::GogAchievement>> {
    crate::gog::game_achievements(&state.pool, &game_id, refresh)
}

// ---------- Launcher catalog (local + capabilities) ----------

#[tauri::command]
pub fn launcher_capabilities() -> Vec<crate::launcher_catalog::LauncherCapability> {
    crate::launcher_catalog::capabilities()
}

#[tauri::command]
pub fn local_launcher_library(
    state: State<AppState>,
    platform: String,
) -> AppResult<Vec<crate::launcher_catalog::LocalLauncherGame>> {
    crate::launcher_catalog::local_library(&state.pool, &platform)
}

#[tauri::command]
pub fn local_launcher_import(
    state: State<AppState>,
    app: tauri::AppHandle,
    platform: String,
    names: Vec<String>,
) -> AppResult<(i64, i64)> {
    let pool = state.pool.clone();
    let media_dir = state.media_dir.clone();
    let app_handle = app.clone();
    let pool_for_closure = pool.clone();
    crate::launcher_catalog::import_local(&pool, &platform, &names, move |id| {
        if let Ok(Some(game)) = games::get(&pool_for_closure, id) {
            enrich_game_async(
                app_handle.clone(),
                pool_for_closure.clone(),
                media_dir.clone(),
                id.to_string(),
                game.display_name,
                None,
            );
        }
    })
}

// ---------- media listening (SMTC) + global foreground log ----------

#[tauri::command]
pub fn media_overview(state: State<AppState>) -> AppResult<crate::db::music::MusicOverview> {
    crate::db::music::overview(&state.pool)
}

#[tauri::command]
pub fn media_heatmap(state: State<AppState>, days: Option<i64>) -> AppResult<Vec<crate::db::stats::DayValue>> {
    crate::db::music::heatmap(&state.pool, days.unwrap_or(140).clamp(7, 800))
}

#[tauri::command]
pub fn media_hour_of_day(state: State<AppState>) -> AppResult<Vec<i64>> {
    crate::db::music::hour_of_day(&state.pool)
}

#[tauri::command]
pub fn media_top(state: State<AppState>, limit: Option<i64>) -> AppResult<crate::db::music::MusicTop> {
    crate::db::music::top(&state.pool, limit.unwrap_or(10))
}

#[tauri::command]
pub fn media_insights(state: State<AppState>) -> AppResult<crate::db::music::MusicInsights> {
    crate::db::music::insights(&state.pool)
}

#[tauri::command]
pub fn media_timeline(
    state: State<AppState>,
    from_utc: Option<String>,
    to_utc: Option<String>,
) -> AppResult<Vec<crate::db::media::MediaPlayDto>> {
    crate::db::media::list_plays(&state.pool, from_utc.as_deref(), to_utc.as_deref())
}

#[tauri::command]
pub fn media_recent(state: State<AppState>, limit: Option<i64>) -> AppResult<Vec<crate::db::media::MediaPlayDto>> {
    crate::db::media::recent(&state.pool, limit.unwrap_or(12).clamp(1, 100))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JukeboxPlayInput {
    pub vid: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub game_id: Option<String>,
    pub cover_path: Option<String>,
}

/// Record an in-app jukebox play. Closes the previous jukebox row first so each
/// track is its own play. Independent of the SMTC bridge (which skips our app).
#[tauri::command]
pub fn record_media_play(state: State<AppState>, track: JukeboxPlayInput) -> AppResult<()> {
    crate::db::media::close_open_for_source(&state.pool, "jukebox")?;
    let m = crate::db::media::NewMediaPlay {
        source: "jukebox".into(),
        source_app: Some("gametracker".into()),
        app_name: Some("GameTracker Jukebox".into()),
        media_type: "music".into(),
        title: track.title,
        artist: track.artist,
        album: None,
        thumb_path: track.cover_path,
        game_id: track.game_id,
        vid: Some(track.vid),
    };
    crate::db::media::start_play(&state.pool, &m)?;
    Ok(())
}

/// Stop accruing for the in-app jukebox (pause / stop / closed).
#[tauri::command]
pub fn stop_media_play(state: State<AppState>) -> AppResult<()> {
    crate::db::media::close_open_for_source(&state.pool, "jukebox")
}

#[tauri::command]
pub fn foreground_spans(
    state: State<AppState>,
    from_utc: Option<String>,
    to_utc: Option<String>,
) -> AppResult<Vec<crate::db::foreground::ForegroundSpanDto>> {
    crate::db::foreground::list(&state.pool, from_utc.as_deref(), to_utc.as_deref())
}

// ---------- playlists ----------

#[tauri::command]
pub fn playlists_list(state: State<AppState>) -> AppResult<Vec<crate::db::playlists::PlaylistDto>> {
    crate::db::playlists::list(&state.pool)
}

#[tauri::command]
pub fn playlist_get(state: State<AppState>, id: String) -> AppResult<Option<crate::db::playlists::PlaylistDto>> {
    crate::db::playlists::get(&state.pool, &id)
}

#[tauri::command]
pub fn playlist_create(state: State<AppState>, name: String) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::msg("Playlist name can't be empty"));
    }
    crate::db::playlists::create(&state.pool, trimmed)
}

#[tauri::command]
pub fn playlist_rename(state: State<AppState>, id: String, name: String) -> AppResult<()> {
    crate::db::playlists::rename(&state.pool, &id, &name)
}

#[tauri::command]
pub fn playlist_delete(state: State<AppState>, id: String) -> AppResult<()> {
    crate::db::playlists::delete(&state.pool, &id)
}

#[tauri::command]
pub fn playlist_add_tracks(
    state: State<AppState>,
    id: String,
    tracks: Vec<crate::db::playlists::PlaylistTrack>,
) -> AppResult<()> {
    crate::db::playlists::add_tracks(&state.pool, &id, &tracks)
}

#[tauri::command]
pub fn playlist_remove_track(state: State<AppState>, id: String, vid: String) -> AppResult<()> {
    crate::db::playlists::remove_track(&state.pool, &id, &vid)
}

#[tauri::command]
pub fn playlist_reorder(state: State<AppState>, id: String, vids: Vec<String>) -> AppResult<()> {
    crate::db::playlists::reorder(&state.pool, &id, &vids)
}

// ---------- metacritic backfill ----------

/// Backfill Metacritic scores for games that have none. Spawns a throttled worker
/// (network) that resolves each title and stores its score (only when missing —
/// never overwrites a user/CSV value), emitting `metacritic://progress` per game
/// and `metacritic://done` at the end. Gated by the online-metadata opt-in.
#[tauri::command]
pub fn backfill_metacritic(app: tauri::AppHandle, state: State<AppState>) -> AppResult<usize> {
    if !settings::get_bool(&state.pool, "online_metadata_enabled")? {
        return Err(AppError::msg(
            "Turn on Online metadata in Settings to fetch Metacritic scores.",
        ));
    }
    let pool = state.pool.clone();
    let media_dir = state.media_dir.clone();
    let pending: Vec<crate::db::models::GameDto> = games::list(&pool)?
        .into_iter()
        .filter(|g| g.kind == "game" && g.metacritic.is_none())
        .collect();
    let total = pending.len();
    std::thread::spawn(move || {
        let mut updated = 0usize;
        for (i, game) in pending.into_iter().enumerate() {
            let meta = if let Some(appid) = game.steam_app_id {
                metadata::fetch_game_info_by_appid(appid as u64, &media_dir, &game.id, false)
                    .ok()
                    .flatten()
            } else {
                metadata::fetch_game_info(&game.display_name, &media_dir, &game.id, false)
                    .ok()
                    .flatten()
            };
            if let Some(meta) = meta {
                if meta.metacritic.is_some() {
                    let _ = games::apply_metadata(
                        &pool, &game.id, None, None, meta.metacritic, None, &[], None,
                    );
                    updated += 1;
                }
            }
            let _ = app.emit(
                "metacritic://progress",
                serde_json::json!({ "done": i + 1, "total": total, "name": game.display_name }),
            );
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        let _ = app.emit(
            "metacritic://done",
            serde_json::json!({ "count": total, "updated": updated }),
        );
        let _ = app.emit("game://enriched", serde_json::json!({ "id": "" }));
    });
    Ok(total)
}

// ---------- remote access (companion phone app) ----------

use std::sync::atomic::Ordering;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub pin: String,
    pub host: Option<String>,
    pub clients: usize,
}

fn remote_snapshot(state: &State<AppState>) -> RemoteStatus {
    let r = &state.remote;
    RemoteStatus {
        enabled: r.enabled.load(Ordering::SeqCst),
        running: r.running.load(Ordering::SeqCst),
        port: r.port.load(Ordering::SeqCst),
        pin: r.pin.lock().clone(),
        host: crate::remote::best_host_ip(),
        clients: r.clients.load(Ordering::SeqCst),
    }
}

/// Current remote-server status for the Remote screen (poll for live client count).
#[tauri::command]
pub fn remote_status(state: State<AppState>) -> RemoteStatus {
    remote_snapshot(&state)
}

/// Turn the remote server on or off. Enabling rotates the pairing PIN and starts
/// the listener; disabling signals graceful shutdown. Persisted across restarts.
#[tauri::command]
pub fn remote_set_enabled(state: State<AppState>, enabled: bool) -> AppResult<RemoteStatus> {
    settings::set(&state.pool, "remote_enabled", if enabled { "true" } else { "false" })?;
    state.remote.enabled.store(enabled, Ordering::SeqCst);
    if enabled {
        state.remote.rotate_pin();
        crate::remote::start(crate::remote::ApiState {
            pool: state.pool.clone(),
            tracking: state.shared.clone(),
            media_dir: std::sync::Arc::new(state.media_dir.clone()),
            remote: state.remote.clone(),
        });
    } else {
        crate::remote::stop(&state.remote);
    }
    Ok(remote_snapshot(&state))
}

/// Generate a fresh pairing PIN and invalidate any devices paired with the old one.
#[tauri::command]
pub fn remote_regen_pin(state: State<AppState>) -> RemoteStatus {
    state.remote.rotate_pin();
    remote_snapshot(&state)
}
