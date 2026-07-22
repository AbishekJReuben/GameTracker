use crate::content_audit;
use crate::content_repair;
use crate::db::models::{GameDto, GameInput, ScreenshotDto, SessionDto, SessionFilter};
use crate::db::stats::{AppsOverview, CatalogAnalytics, Dashboard, DayValue, Insights, TagStat};
use crate::db::{games, screenshots, sessions, settings, stats};
use crate::detect::{self, Candidate};
use crate::error::{AppError, AppResult};
use crate::file_share;
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

// ---------- direct file sharing ----------

/// Build a frozen, receiver-safe file manifest from explicit user-picked roots.
/// Directory walking and metadata reads are intentionally off the UI thread.
#[tauri::command]
pub async fn share_prepare(paths: Vec<String>) -> AppResult<file_share::ShareManifest> {
    run_blocking(move || file_share::prepare(paths)).await
}

/// Read one bounded slice for the WebRTC sender. The frontend never hands this
/// path to a receiver; only manifest metadata crosses the peer connection.
#[tauri::command]
pub async fn share_read_chunk(source_path: String, offset: u64, length: u32) -> AppResult<Vec<u8>> {
    run_blocking(move || file_share::read_chunk(source_path, offset, length)).await
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
                games::set_media(
                    &pool,
                    &id,
                    &info.screenshots,
                    None,
                    info.website.as_deref(),
                    None,
                )?;
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
pub fn heatmap(
    state: State<AppState>,
    days: i64,
    kind: Option<String>,
) -> AppResult<Vec<DayValue>> {
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
pub fn insights(
    state: State<AppState>,
    year: Option<i64>,
    kind: Option<String>,
) -> AppResult<Insights> {
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
pub fn suggest_games(
    state: State<AppState>,
    refresh: Option<bool>,
) -> AppResult<SuggestionsResult> {
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

fn try_download_steam_cover(
    appid: u64,
    media_dir: &std::path::Path,
    game_id: &str,
) -> Option<String> {
    let url = metadata::steam_cover_url(appid);
    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(12))
        .call()
        .ok()?;
    let mut buf = Vec::new();
    use std::io::Read;
    resp.into_reader()
        .take(12_000_000)
        .read_to_end(&mut buf)
        .ok()?;
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
    settings::set(
        &state.pool,
        "tracking_paused",
        if paused { "true" } else { "false" },
    )
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

#[tauri::command]
pub fn system_app_history(
    state: State<AppState>,
    minutes: i64,
) -> AppResult<system::AppUsageHistory> {
    system::app_history(&state.pool, &state.sys, minutes)
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
        } else if let Some(s) = game
            .metacritic_slug
            .as_ref()
            .filter(|s| !s.trim().is_empty())
        {
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
    let exe = util::first_existing_exe(&game.exe_paths).ok_or_else(|| {
        AppError::msg("Executable not found. The file may have been moved or deleted.")
    })?;

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
        match crate::steam::import_games(&pool, &app_ids, playtime, achievements, Some(&progress)) {
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
pub fn media_heatmap(
    state: State<AppState>,
    days: Option<i64>,
) -> AppResult<Vec<crate::db::stats::DayValue>> {
    crate::db::music::heatmap(&state.pool, days.unwrap_or(140).clamp(7, 800))
}

#[tauri::command]
pub fn media_hour_of_day(state: State<AppState>) -> AppResult<Vec<i64>> {
    crate::db::music::hour_of_day(&state.pool)
}

#[tauri::command]
pub fn media_top(
    state: State<AppState>,
    limit: Option<i64>,
) -> AppResult<crate::db::music::MusicTop> {
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
pub fn media_recent(
    state: State<AppState>,
    limit: Option<i64>,
) -> AppResult<Vec<crate::db::media::MediaPlayDto>> {
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
pub fn playlist_get(
    state: State<AppState>,
    id: String,
) -> AppResult<Option<crate::db::playlists::PlaylistDto>> {
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
                        &pool,
                        &game.id,
                        None,
                        None,
                        meta.metacritic,
                        None,
                        &[],
                        None,
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
    pub cloud_enabled: bool,
    pub signal_url: String,
    pub code: String,
    /// Secret "permanent key" (code 2), shown behind the eye toggle on the page.
    pub secret_code: String,
    /// AnyDesk-style UAC handling: when on (and remote enabled), the UAC secure
    /// desktop is disabled so admin-consent prompts are visible/controllable.
    pub show_uac: bool,
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
        cloud_enabled: r.cloud_enabled.load(Ordering::SeqCst),
        signal_url: settings::get(&state.pool, "remote_signal_url")
            .ok()
            .flatten()
            .unwrap_or_default(),
        code: r.code.lock().clone(),
        secret_code: r.secret.lock().clone(),
        show_uac: settings::get_bool(&state.pool, "remote_show_uac").unwrap_or(false),
    }
}

/// Current remote-server status for the Remote screen (poll for live client count).
#[tauri::command]
pub fn remote_status(state: State<AppState>) -> RemoteStatus {
    remote_snapshot(&state)
}

/// The single Remote master switch. Turns on BOTH the local LAN server and cloud
/// (from-anywhere) mode together — the companion always uses the cloud/WebRTC path,
/// so the page shows one toggle. Enabling rotates the pairing PIN and starts the
/// listener; disabling shuts down and turns cloud off. Persisted across restarts.
#[tauri::command]
pub fn remote_set_enabled(state: State<AppState>, enabled: bool) -> AppResult<RemoteStatus> {
    settings::set(
        &state.pool,
        "remote_enabled",
        if enabled { "true" } else { "false" },
    )?;
    settings::set(
        &state.pool,
        "remote_cloud_enabled",
        if enabled { "true" } else { "false" },
    )?;
    state.remote.enabled.store(enabled, Ordering::SeqCst);
    // Cloud host runs in the desktop webview (RemoteHostManager) gated on this flag.
    state.remote.cloud_enabled.store(enabled, Ordering::SeqCst);
    if enabled {
        state.remote.rotate_pin();
        crate::remote::start(crate::remote::ApiState {
            pool: state.pool.clone(),
            tracking: state.shared.clone(),
            media_dir: std::sync::Arc::new(state.media_dir.clone()),
            remote: state.remote.clone(),
            sys: state.sys.clone(),
        });
        // Re-apply the opt-in UAC handling for this session.
        if settings::get_bool(&state.pool, "remote_show_uac").unwrap_or(false) {
            let _ = crate::remote::uac::set_visible(true);
        }
    } else {
        crate::remote::stop(&state.remote);
        // Always restore the UAC secure desktop when remote is turned off.
        let _ = crate::remote::uac::set_visible(false);
    }
    Ok(remote_snapshot(&state))
}

/// Toggle AnyDesk-style UAC handling. When enabled (and remote is on), the UAC
/// secure desktop is disabled so admin-consent prompts render on the capturable
/// desktop and can be answered from the phone. Lowers local security, so it's
/// opt-in; the secure desktop is restored when remote is disabled or on exit.
#[tauri::command]
pub fn remote_set_show_uac(state: State<AppState>, enabled: bool) -> AppResult<RemoteStatus> {
    settings::set(
        &state.pool,
        "remote_show_uac",
        if enabled { "true" } else { "false" },
    )?;
    // Only actually touch the registry while remote is on; otherwise just persist
    // the preference (it's applied when remote is enabled / on next launch).
    let remote_on = state.remote.enabled.load(Ordering::SeqCst);
    if let Err(e) = crate::remote::uac::set_visible(enabled && remote_on) {
        return Err(crate::error::AppError::msg(format!(
            "Couldn't change UAC handling: {e}"
        )));
    }
    Ok(remote_snapshot(&state))
}

/// Generate a fresh pairing PIN and invalidate any devices paired with the old one.
#[tauri::command]
pub fn remote_regen_pin(state: State<AppState>) -> RemoteStatus {
    state.remote.rotate_pin();
    remote_snapshot(&state)
}

/// Enable/disable cloud (WebRTC-from-anywhere) mode and set the signaling server
/// URL. Enabling rotates the connection code. Persisted across restarts.
#[tauri::command]
pub fn remote_set_cloud(
    state: State<AppState>,
    enabled: bool,
    signal_url: String,
) -> AppResult<RemoteStatus> {
    settings::set(
        &state.pool,
        "remote_cloud_enabled",
        if enabled { "true" } else { "false" },
    )?;
    settings::set(&state.pool, "remote_signal_url", signal_url.trim())?;
    state.remote.cloud_enabled.store(enabled, Ordering::SeqCst);
    // Deliberately do NOT rotate the code here — it must stay stable so the phone
    // keeps auto-connecting. Toggling cloud off/on reuses the same code; the user
    // rotates it explicitly via "New code" (remote_regen_code) only when they want to.
    Ok(remote_snapshot(&state))
}

/// Generate a fresh cloud connection code (invalidates the old one).
#[tauri::command]
pub fn remote_regen_code(state: State<AppState>) -> RemoteStatus {
    let code = state.remote.rotate_code();
    let _ = settings::set(&state.pool, "remote_code", &code);
    remote_snapshot(&state)
}

/// Generate a fresh secret permanent key (code 2). Devices already trusted stay
/// trusted; only the auto-grant secret changes.
#[tauri::command]
pub fn remote_regen_secret(state: State<AppState>) -> RemoteStatus {
    let secret = state.remote.rotate_secret();
    let _ = settings::set(&state.pool, "remote_secret_code", &secret);
    remote_snapshot(&state)
}

// ---- per-device access grants (permanent trust + temporary timed grants) ----

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrustedDevice {
    pub id: String,
    pub name: String,
    pub added_utc: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TempGrant {
    pub id: String,
    pub name: String,
    pub expires_utc: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGrants {
    pub trusted: Vec<TrustedDevice>,
    pub temporary: Vec<TempGrant>,
}

fn read_trusted(pool: &crate::db::DbPool) -> Vec<TrustedDevice> {
    settings::get(pool, "remote_trusted_devices")
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}

/// Read the temp grants, dropping any that have expired (and persist the pruned
/// list so it doesn't grow unbounded).
fn read_temp_pruned(pool: &crate::db::DbPool) -> Vec<TempGrant> {
    let now = chrono::Utc::now();
    let all: Vec<TempGrant> = settings::get(pool, "remote_temp_grants")
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default();
    let live: Vec<TempGrant> = all
        .into_iter()
        .filter(|g| {
            chrono::DateTime::parse_from_rfc3339(&g.expires_utc)
                .map(|t| t.with_timezone(&chrono::Utc) > now)
                .unwrap_or(false)
        })
        .collect();
    let _ = settings::set(
        pool,
        "remote_temp_grants",
        &serde_json::to_string(&live).unwrap_or_else(|_| "[]".into()),
    );
    live
}

/// List trusted (permanent) devices and active temporary grants (expired pruned).
#[tauri::command]
pub fn remote_list_grants(state: State<AppState>) -> RemoteGrants {
    RemoteGrants {
        trusted: read_trusted(&state.pool),
        temporary: read_temp_pruned(&state.pool),
    }
}

/// Grant a device permanent trust or a temporary (timed) grant.
#[tauri::command]
pub fn remote_grant(
    state: State<AppState>,
    device_id: String,
    name: String,
    kind: String,
    duration_secs: Option<i64>,
) -> AppResult<RemoteGrants> {
    let now = chrono::Utc::now();
    if kind == "permanent" {
        let mut trusted = read_trusted(&state.pool);
        trusted.retain(|d| d.id != device_id);
        trusted.push(TrustedDevice {
            id: device_id.clone(),
            name: name.clone(),
            added_utc: now.to_rfc3339(),
        });
        settings::set(
            &state.pool,
            "remote_trusted_devices",
            &serde_json::to_string(&trusted).unwrap_or_else(|_| "[]".into()),
        )?;
        // A permanent grant supersedes any temp grant for the same device.
        let mut temp = read_temp_pruned(&state.pool);
        temp.retain(|g| g.id != device_id);
        settings::set(
            &state.pool,
            "remote_temp_grants",
            &serde_json::to_string(&temp).unwrap_or_else(|_| "[]".into()),
        )?;
    } else {
        let secs = duration_secs.unwrap_or(3600).clamp(60, 60 * 60 * 24 * 30);
        let expires = now + chrono::Duration::seconds(secs);
        let mut temp = read_temp_pruned(&state.pool);
        temp.retain(|g| g.id != device_id);
        temp.push(TempGrant {
            id: device_id.clone(),
            name,
            expires_utc: expires.to_rfc3339(),
        });
        settings::set(
            &state.pool,
            "remote_temp_grants",
            &serde_json::to_string(&temp).unwrap_or_else(|_| "[]".into()),
        )?;
    }
    Ok(RemoteGrants {
        trusted: read_trusted(&state.pool),
        temporary: read_temp_pruned(&state.pool),
    })
}

/// Revoke a device — removes it from both the trusted and temporary lists.
#[tauri::command]
pub fn remote_revoke(state: State<AppState>, device_id: String) -> AppResult<RemoteGrants> {
    let mut trusted = read_trusted(&state.pool);
    trusted.retain(|d| d.id != device_id);
    settings::set(
        &state.pool,
        "remote_trusted_devices",
        &serde_json::to_string(&trusted).unwrap_or_else(|_| "[]".into()),
    )?;
    let mut temp = read_temp_pruned(&state.pool);
    temp.retain(|g| g.id != device_id);
    settings::set(
        &state.pool,
        "remote_temp_grants",
        &serde_json::to_string(&temp).unwrap_or_else(|_| "[]".into()),
    )?;
    Ok(RemoteGrants {
        trusted: read_trusted(&state.pool),
        temporary: read_temp_pruned(&state.pool),
    })
}

/// Decide a connecting device's access level, used by the host handshake:
/// `"secret"`  — supplied the correct secret key (auto-persisted as permanent),
/// `"permanent"` / `"temporary"` — already granted,
/// `"none"`    — needs the desktop approval prompt.
#[tauri::command]
pub fn remote_check_auth(
    state: State<AppState>,
    device_id: String,
    name: Option<String>,
    secret: Option<String>,
) -> String {
    let expected = state.remote.secret.lock().clone();
    if let Some(s) = secret {
        if !s.trim().is_empty() && s.trim().eq_ignore_ascii_case(expected.trim()) {
            // Correct secret → remember this device permanently.
            let now = chrono::Utc::now();
            let mut trusted = read_trusted(&state.pool);
            if !trusted.iter().any(|d| d.id == device_id) {
                trusted.push(TrustedDevice {
                    id: device_id.clone(),
                    name: name.unwrap_or_else(|| "Phone".into()),
                    added_utc: now.to_rfc3339(),
                });
                let _ = settings::set(
                    &state.pool,
                    "remote_trusted_devices",
                    &serde_json::to_string(&trusted).unwrap_or_else(|_| "[]".into()),
                );
            }
            return "secret".into();
        }
    }
    if read_trusted(&state.pool).iter().any(|d| d.id == device_id) {
        return "permanent".into();
    }
    if read_temp_pruned(&state.pool)
        .iter()
        .any(|g| g.id == device_id)
    {
        return "temporary".into();
    }
    "none".into()
}

// ---- USB install (adb) ----

/// Serial numbers of phones connected via USB debugging (state `device`).
#[tauri::command]
pub async fn remote_adb_devices() -> AppResult<Vec<String>> {
    run_blocking(crate::remote::adb::devices).await
}

/// Download the latest companion APK and `adb install -r` it to the USB phone.
#[tauri::command]
pub async fn remote_adb_install() -> AppResult<String> {
    run_blocking(|| {
        let url = "https://github.com/AbishekJReuben/GameTracker/releases/latest/download/GameTrackerRemote.apk";
        let resp = ureq::get(url)
            .timeout(std::time::Duration::from_secs(60))
            .call()
            .map_err(|e| AppError::msg(format!("Couldn't download the APK: {e}")))?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut resp.into_reader(), &mut buf)
            .map_err(|e| AppError::msg(format!("Download failed: {e}")))?;
        let tmp = std::env::temp_dir().join("GameTrackerRemote.apk");
        std::fs::write(&tmp, &buf).map_err(|e| AppError::msg(format!("Couldn't save the APK: {e}")))?;
        crate::remote::adb::install(&tmp)
    })
    .await
}

// ---- WebRTC path (screen/input driven over a peer-to-peer data channel) ----
// The WebRTC peer itself lives in the webview (browser-native RTCPeerConnection);
// Rust only supplies the pixels and performs the input injection.

use base64::Engine as _;

/// Capture the primary monitor as a JPEG and return it base64-encoded, for
/// sending over a WebRTC data channel. Runs off the main thread.
#[tauri::command]
pub async fn remote_grab_frame(max_w: Option<u32>, quality: Option<u8>) -> Option<String> {
    let w = max_w.unwrap_or(1280).clamp(320, 3840);
    let q = quality.unwrap_or(60).clamp(20, 95);
    run_blocking(move || {
        Ok(crate::remote::capture::grab_primary_jpeg(w, q)
            .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)))
    })
    .await
    .unwrap_or(None)
}

/// Inject one remote input event (mouse/keyboard) received over the data channel.
#[tauri::command]
pub fn remote_inject(event: crate::remote::input::ControlEvent) {
    crate::remote::input::inject(event);
}

/// Inject on a specific monitor (multi-monitor pop-out tabs).
#[tauri::command]
pub fn remote_inject_on(monitor: usize, event: crate::remote::input::ControlEvent) {
    crate::remote::input::inject_on_monitor(monitor, event);
}

/// Whether a virtual gamepad can be created on this PC (the ViGEmBus driver is
/// installed). The phone probes this before offering controller mode so it can
/// prompt the user to install the driver when it's missing.
#[tauri::command]
pub fn remote_gamepad_available() -> bool {
    crate::remote::gamepad::available()
}

/// Process-wide delta encoder for the cloud (WebRTC) screen path. There is at most
/// one cloud viewer, so a single shared encoder is enough.
static CLOUD_ENC: once_cell::sync::Lazy<parking_lot::Mutex<crate::remote::capture::TileEncoder>> =
    once_cell::sync::Lazy::new(|| {
        parking_lot::Mutex::new(crate::remote::capture::TileEncoder::new())
    });

/// Capture the selected monitor as a **delta** frame (only changed tiles, plus a
/// periodic keyframe) and return it base64-encoded for the WebRTC screen channel.
/// Returns `None` when nothing changed, so the host can skip sending. Pass
/// `key=true` to force a full keyframe (e.g. right after a viewer connects).
#[tauri::command]
pub async fn remote_grab_delta(
    max_w: Option<u32>,
    quality: Option<u8>,
    key: Option<bool>,
) -> Option<String> {
    let w = max_w.unwrap_or(1280).clamp(320, 3840);
    let q = quality.unwrap_or(60).clamp(20, 95);
    let force = key.unwrap_or(false);
    run_blocking(move || {
        let mon = crate::remote::capture::selected_monitor();
        let mut enc = CLOUD_ENC.lock();
        Ok(enc
            .encode(mon, w, q, force)
            .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)))
    })
    .await
    .unwrap_or(None)
}

/// Start the streaming screen capture for the cloud (WebRTC video-track) path.
/// A dedicated thread pushes full-frame JPEGs to the webview over a binary
/// channel; the host draws them to a canvas and feeds `captureStream()` into a
/// real WebRTC video track (hardware H.264/VP9). Frames arrive as raw bytes
/// (`InvokeResponseBody::Raw`), i.e. `ArrayBuffer` on the JS side — no base64.
#[tauri::command]
pub fn remote_start_capture(
    on_frame: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    max_w: Option<u32>,
    fps: Option<u32>,
    quality: Option<u32>,
) {
    let w = max_w.unwrap_or(1600);
    let f = fps.unwrap_or(30);
    let q = quality.unwrap_or(70);
    crate::remote::capture::start_capture(w, f, q, move |jpg| {
        let _ = on_frame.send(tauri::ipc::InvokeResponseBody::Raw(jpg));
    });
}

/// Live-retune the streaming capture (resolution / fps / JPEG quality, and the
/// optional content-optimization mode: 0 auto / 1 text / 2 video).
///
/// `bitrate_kbps` targets the **native** H.264 encoder (0/omitted = derive it from
/// resolution × fps × quality); it has no effect on the JPEG fallback, where `quality`
/// is the only lever.
#[tauri::command]
pub fn remote_set_capture_quality(
    max_w: u32,
    fps: u32,
    quality: u32,
    content: Option<u32>,
    bitrate_kbps: Option<u32>,
) {
    crate::remote::capture::set_capture_quality(max_w, fps, quality);
    if let Some(c) = content {
        crate::remote::capture::set_capture_content(c);
    }
    crate::remote::capture::set_capture_bitrate(bitrate_kbps.unwrap_or(0));
}

/// Ask the native encoder to emit a keyframe on the next frame.
///
/// The native path runs an infinite GOP, so a guest that just built a decoder (fresh
/// session, `vkf`, `vreset`, decode stall) has nothing decodable until one arrives.
/// A no-op on the JPEG fallback, where every frame is self-contained.
#[tauri::command]
pub fn remote_request_keyframe() {
    crate::remote::capture::request_keyframe();
}

/// Backpressure gate for the native H.264 path. While set, captures are skipped
/// BEFORE NVENC (keyframes still encode), so the reference chain stays intact —
/// dropping already-encoded P-frames is what corrupted the picture until the
/// next recovery IDR. Driven by the host webview from the video channel's
/// `bufferedAmount`.
#[tauri::command]
pub fn remote_set_encode_paused(paused: bool) {
    crate::remote::capture::set_encode_paused(paused);
}

/// Allow (or forbid) native H.264 frames from the capture pipeline.
///
/// Only the DIRECT guest can consume pre-encoded H.264 — the WebRTC track path needs
/// pixels for its canvas. The host enables this when the guest opts into DIRECT and
/// disables it on every fallback to RTC.
///
/// Returns whether this machine actually *has* a native encoder, so the host knows
/// whether to expect native frames (and whether a missing WebCodecs encoder is fatal).
#[tauri::command]
pub fn remote_set_capture_native(on: bool) -> bool {
    crate::remote::capture::set_capture_native(on);
    #[cfg(windows)]
    {
        crate::remote::nvenc::available()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Stop the streaming screen capture (on disconnect / teardown).
#[tauri::command]
pub fn remote_stop_capture() {
    crate::remote::capture::stop_capture();
}

/// Start a lightweight aux capture pipeline for a fixed monitor (pop-out tab).
#[tauri::command]
pub fn remote_start_aux_capture(
    monitor: usize,
    on_frame: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    max_w: Option<u32>,
    fps: Option<u32>,
    quality: Option<u32>,
) {
    let w = max_w.unwrap_or(1600);
    let f = fps.unwrap_or(30);
    let q = quality.unwrap_or(70);
    crate::remote::capture::start_aux_capture(monitor, w, f, q, move |jpg| {
        let _ = on_frame.send(tauri::ipc::InvokeResponseBody::Raw(jpg));
    });
}

/// Stop one aux capture pipeline, or all of them when `monitor` is omitted.
#[tauri::command]
pub fn remote_stop_aux_capture(monitor: Option<usize>) {
    crate::remote::capture::stop_aux_capture(monitor);
}

/// Start desktop-audio (WASAPI loopback) capture for the WebRTC audio track. PCM
/// float32 frames arrive as raw ArrayBuffers over the channel; returns the mix
/// format (sample rate / channels) the webview must decode with, or null if audio
/// capture is unavailable.
#[tauri::command]
pub fn remote_start_audio(
    on_pcm: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Option<crate::remote::audio::AudioFormat> {
    crate::remote::audio::start_audio(move |pcm| {
        let _ = on_pcm.send(tauri::ipc::InvokeResponseBody::Raw(pcm));
    })
}

/// Stop desktop-audio capture (on disconnect / teardown).
#[tauri::command]
pub fn remote_stop_audio() {
    crate::remote::audio::stop_audio();
}

/// True when the foreground app has a text field focused (blinking caret), so the
/// phone can auto-open its keyboard the moment you click into a PC input.
#[tauri::command]
pub fn remote_textfield_active() -> bool {
    crate::remote::focus::foreground_text_field_active()
}

/// The current desktop cursor shape (arrow/hand/text/resize/busy…), so the phone
/// can mirror it on its on-screen remote cursor.
#[tauri::command]
pub fn remote_cursor_kind() -> String {
    crate::remote::focus::foreground_cursor_kind().to_string()
}

#[tauri::command]
pub fn remote_cursor_position() -> Option<[f32; 2]> {
    crate::remote::focus::foreground_cursor_position()
}

/// Latest host capture-pipeline telemetry (capture/scale/encode ms, produced fps,
/// frame size, resolution), so the phone's debug HUD can pinpoint the bottleneck.
#[tauri::command]
pub fn remote_capture_stats() -> crate::remote::capture::CaptureStats {
    crate::remote::capture::capture_stats()
}

/// List the PC's monitors so the phone can offer a display switcher.
#[tauri::command]
pub fn remote_list_monitors() -> Vec<crate::remote::capture::MonitorInfo> {
    crate::remote::capture::list_monitors()
}

/// Read a media file (cover/icon/screenshot) as a base64 data URL, for the cloud
/// path where artwork can't be served over HTTP. Path-checked: the file must live
/// under `media_dir`, and oversized files are refused, so nothing else leaks.
#[tauri::command]
pub async fn remote_read_media(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<String>, ()> {
    let media_dir = state.media_dir.clone();
    let out = run_blocking(move || {
        let base = match media_dir.canonicalize() {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        let safe = std::path::Path::new(&path)
            .canonicalize()
            .ok()
            .filter(|p| p.starts_with(&base));
        let Some(p) = safe else { return Ok(None) };
        let meta = match std::fs::metadata(&p) {
            Ok(m) => m,
            Err(_) => return Ok(None),
        };
        if meta.len() > 32 * 1024 * 1024 {
            return Ok(None); // guard against pathological files before decode
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        // Cover art / screenshots: decode + downscale to a small JPEG so the
        // cloud data channel only ever carries a few KB per tile. Falls through
        // to the raw-bytes path if the image can't be decoded.
        let is_image = matches!(
            ext.as_deref(),
            Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "avif")
        );
        if is_image {
            if let Some(url) = crate::remote::capture::thumbnail_data_url(&p, 480) {
                return Ok(Some(url));
            }
        }
        // Non-image (or undecodable) fallback: ship raw bytes, size-capped.
        if meta.len() > 8 * 1024 * 1024 {
            return Ok(None);
        }
        let bytes = match std::fs::read(&p) {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        let mime = match ext.as_deref() {
            Some("png") => "image/png",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("webp") => "image/webp",
            Some("gif") => "image/gif",
            _ => "application/octet-stream",
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(Some(format!("data:{mime};base64,{b64}")))
    })
    .await
    .unwrap_or(None);
    Ok(out)
}

// ============================ shared clipboard ==============================

use crate::db::clipboard::{self as clip_store, ClipInput, ClipItem};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipDeviceInfo {
    pub device_id: String,
    pub device_name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAddInput {
    pub kind: String,
    pub text: Option<String>,
    /// Base64 (raw or data-URL) image bytes for `kind == "image"`.
    pub image_base64: Option<String>,
    pub mime: Option<String>,
    pub source: Option<String>,
    // These are present only when APPLYING a remote item (so it keeps its identity
    // and isn't re-uploaded). Absent → a fresh local capture.
    pub id: Option<String>,
    pub created_utc: Option<String>,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub pinned: Option<bool>,
    /// Folder/list label for the notes view ("" = unfiled).
    pub folder: Option<String>,
    /// Current multi-tag labels. Missing means a legacy client; its folder is
    /// promoted to one tag.
    pub tags: Option<Vec<String>>,
    /// Copy-history timestamps (present when applying a remote item that carries
    /// a merged dedup history).
    pub copies: Option<Vec<String>>,
}

fn decode_b64(s: &str) -> AppResult<Vec<u8>> {
    let s = s.rsplit_once(',').map(|(_, b)| b).unwrap_or(s);
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| AppError::msg(e.to_string()))
}

/// Normalize arbitrary image bytes to PNG (best-effort; falls back to raw bytes).
fn to_png(raw: &[u8]) -> Vec<u8> {
    match image::load_from_memory(raw) {
        Ok(img) => {
            let mut png = Vec::new();
            if img
                .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                .is_ok()
            {
                return png;
            }
            raw.to_vec()
        }
        Err(_) => raw.to_vec(),
    }
}

#[tauri::command]
pub fn clipboard_device_info(state: State<AppState>) -> AppResult<ClipDeviceInfo> {
    Ok(ClipDeviceInfo {
        device_id: crate::clipboard::device_id(&state.pool),
        device_name: crate::clipboard::device_name(),
    })
}

#[tauri::command]
pub fn clipboard_list(
    state: State<AppState>,
    before_utc: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<ClipItem>> {
    clip_store::list(&state.pool, before_utc.as_deref(), limit.unwrap_or(50))
}

#[tauri::command]
pub fn clipboard_pinned(state: State<AppState>) -> AppResult<Vec<ClipItem>> {
    clip_store::list_pinned(&state.pool)
}

#[tauri::command]
pub fn clipboard_unsynced(state: State<AppState>, limit: Option<i64>) -> AppResult<Vec<ClipItem>> {
    clip_store::list_unsynced(&state.pool, limit.unwrap_or(100))
}

#[tauri::command]
pub fn clipboard_mark_synced(state: State<AppState>, id: String) -> AppResult<()> {
    clip_store::mark_synced(&state.pool, &id)
}

/// Add an item. When `remote` is true the input carries an existing identity and
/// is applied WITHOUT re-emitting the sync signal (it already lives on the relay).
#[tauri::command]
pub fn clipboard_add(
    state: State<AppState>,
    app: tauri::AppHandle,
    input: ClipAddInput,
    remote: Option<bool>,
) -> AppResult<ClipItem> {
    let remote = remote.unwrap_or(false);
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // Millisecond-precision UTC with a literal Z — the ONE timestamp shape every
    // client (JS toISOString, Android SimpleDateFormat) emits and parses. A bare
    // to_rfc3339() ends in "+00:00" with nanosecond precision, which the Android
    // dock's parser rejected — those items fell back to "now" and sorted wrong.
    let created_utc = input
        .created_utc
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
    let device_id = input
        .device_id
        .unwrap_or_else(|| crate::clipboard::device_id(&state.pool));
    let device_name = input
        .device_name
        .or_else(|| Some(crate::clipboard::device_name()));
    let source = input.source.unwrap_or_else(|| {
        if remote {
            "android".into()
        } else {
            "manual".into()
        }
    });

    let (image_path, thumb_path, mime, size, content_hash) = if input.kind == "image" {
        let raw = decode_b64(input.image_base64.as_deref().unwrap_or_default())?;
        let png = to_png(&raw);
        let hash = clip_store::content_hash("image", &png);
        let (ip, tp, sz) = crate::clipboard::save_image(&state.media_dir, &id, &png)?;
        (
            Some(ip),
            Some(tp),
            Some("image/png".to_string()),
            sz,
            Some(hash),
        )
    } else {
        let size = input.text.as_ref().map(|t| t.len() as i64).unwrap_or(0);
        let hash = clip_store::content_hash("text", input.text.as_deref().unwrap_or_default().as_bytes());
        (
            None,
            None,
            input.mime.clone().or(Some("text/plain".into())),
            size,
            Some(hash),
        )
    };

    let legacy_folder = input.folder.unwrap_or_default();
    let tags = input.tags.unwrap_or_else(|| {
        if legacy_folder.trim().is_empty() { Vec::new() } else { vec![legacy_folder.clone()] }
    });
    let item = ClipInput {
        id,
        kind: input.kind,
        text: input.text,
        image_path,
        thumb_path,
        mime,
        size,
        created_utc,
        device_id,
        device_name,
        source,
        pinned: input.pinned.unwrap_or(false),
        folder: legacy_folder,
        tags,
        content_hash,
        copies: input.copies.unwrap_or_default(),
        synced: remote, // remote items are already on the relay
    };

    if remote {
        clip_store::upsert(&state.pool, &item)?;
        let saved = clip_store::get(&state.pool, &item.id)?
            .ok_or_else(|| AppError::msg("clip item vanished after insert"))?;
        let _ = app.emit("clipboard://changed", ());
        let _ = app.emit_to(crate::clipboard::OVERLAY_LABEL, "clipboard://changed", ());
        Ok(saved)
    } else {
        crate::clipboard::add_local(&app, &state.pool, item)
    }
}

#[tauri::command]
pub fn clipboard_delete(
    state: State<AppState>,
    app: tauri::AppHandle,
    id: String,
    propagate: Option<bool>,
) -> AppResult<()> {
    let (img, thumb) = clip_store::tombstone(&state.pool, &id)?;
    crate::clipboard::remove_files([img, thumb]);
    if propagate.unwrap_or(true) {
        let _ = app.emit("clipboard://delete", &id);
    }
    let _ = app.emit("clipboard://changed", ());
    let _ = app.emit_to(crate::clipboard::OVERLAY_LABEL, "clipboard://changed", ());
    Ok(())
}

#[tauri::command]
pub fn clipboard_set_pinned(
    state: State<AppState>,
    app: tauri::AppHandle,
    id: String,
    pinned: bool,
) -> AppResult<()> {
    clip_store::set_pinned(&state.pool, &id, pinned)?;
    let _ = app.emit("clipboard://changed", ());
    let _ = app.emit_to(crate::clipboard::OVERLAY_LABEL, "clipboard://changed", ());
    Ok(())
}

/// Edit a text item's content in place (notes). Emits `clipboard://item` so the
/// JS sync engine re-uploads it under the SAME id — the relay upserts and every
/// other device replaces its copy while keeping the original timestamp/position.
#[tauri::command]
pub fn clipboard_update_text(
    state: State<AppState>,
    app: tauri::AppHandle,
    id: String,
    text: String,
) -> AppResult<ClipItem> {
    // Bump the edited note to the top (fresh timestamp), the same wire shape every
    // client emits/parses (millis + literal Z).
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    if !clip_store::update_text(&state.pool, &id, &text, &now)? {
        return Err(AppError::msg("item not found or not editable"));
    }
    let saved = clip_store::get(&state.pool, &id)?
        .ok_or_else(|| AppError::msg("clip item vanished after edit"))?;
    let _ = app.emit("clipboard://item", &saved);
    let _ = app.emit_to(crate::clipboard::OVERLAY_LABEL, "clipboard://item", &saved);
    let _ = app.emit("clipboard://changed", ());
    let _ = app.emit_to(crate::clipboard::OVERLAY_LABEL, "clipboard://changed", ());
    Ok(saved)
}

/// Move an item to a folder ('' = unfiled). `propagate` sends the bare folder
/// notice over the relay (false when applying a remote move).
#[tauri::command]
pub fn clipboard_set_folder(
    state: State<AppState>,
    app: tauri::AppHandle,
    id: String,
    folder: String,
    propagate: Option<bool>,
) -> AppResult<()> {
    clip_store::set_folder(&state.pool, &id, &folder)?;
    if propagate.unwrap_or(true) {
        let _ = app.emit("clipboard://folder", &(id, folder));
    }
    let _ = app.emit("clipboard://changed", ());
    let _ = app.emit_to(crate::clipboard::OVERLAY_LABEL, "clipboard://changed", ());
    Ok(())
}

/// Distinct folder names across live items (for the filter chips).
#[tauri::command]
pub fn clipboard_folders(state: State<AppState>) -> AppResult<Vec<String>> {
    clip_store::list_folders(&state.pool)
}

#[tauri::command]
pub fn clipboard_tags(state: State<AppState>) -> AppResult<Vec<String>> {
    clip_store::list_tags(&state.pool)
}

#[tauri::command]
pub fn clipboard_set_tags(
    state: State<AppState>,
    app: tauri::AppHandle,
    id: String,
    tags: Vec<String>,
    propagate: Option<bool>,
) -> AppResult<Vec<String>> {
    let tags = clip_store::set_tags(&state.pool, &id, tags)?;
    if propagate.unwrap_or(true) {
        let _ = app.emit("clipboard://tags", &(id.clone(), tags.clone()));
    }
    let _ = app.emit("clipboard://changed", ());
    let _ = app.emit_to(crate::clipboard::OVERLAY_LABEL, "clipboard://changed", ());
    Ok(tags)
}

/// Create an (empty) folder that syncs to every device. Stored as a kind='folder'
/// entity; emits `clipboard://item` so the sync engine uploads it to the relay.
#[tauri::command]
pub fn clipboard_create_folder(
    state: State<AppState>,
    app: tauri::AppHandle,
    name: String,
) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(());
    }
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let device_id = crate::clipboard::device_id(&state.pool);
    let device_name = crate::clipboard::device_name();
    let folder = clip_store::create_folder(&state.pool, name, &device_id, Some(&device_name), &now)?;
    let _ = app.emit("clipboard://item", &folder);
    let _ = app.emit("clipboard://changed", ());
    let _ = app.emit_to(crate::clipboard::OVERLAY_LABEL, "clipboard://changed", ());
    Ok(())
}

/// Delete a folder everywhere: tombstone the folder entity AND unfile its notes
/// (they move to "unfiled", not deleted). Both the entity deletes and the folder
/// moves propagate over the relay.
#[tauri::command]
pub fn clipboard_delete_folder(
    state: State<AppState>,
    app: tauri::AppHandle,
    name: String,
) -> AppResult<()> {
    // Unfile members first (propagate each move).
    for id in clip_store::ids_in_folder(&state.pool, &name)? {
        clip_store::set_folder(&state.pool, &id, "")?;
        let _ = app.emit("clipboard://folder", &(id, String::new()));
    }
    // Tombstone the entity rows + propagate their deletes.
    for id in clip_store::tombstone_folder(&state.pool, &name)? {
        let _ = app.emit("clipboard://delete", &id);
    }
    let _ = app.emit("clipboard://changed", ());
    let _ = app.emit_to(crate::clipboard::OVERLAY_LABEL, "clipboard://changed", ());
    Ok(())
}

/// One-time retroactive dedup: merge pre-existing duplicate notes (same content)
/// into one, unioning their copy timestamps + tombstoning the extras. Survivors
/// are left unsynced so the JS backlog flush re-uploads their merged history;
/// returns the tombstoned loser ids so the caller can propagate the deletes.
#[tauri::command]
pub fn clipboard_dedupe(state: State<AppState>, app: tauri::AppHandle) -> AppResult<Vec<String>> {
    let (survivors, losers) = clip_store::dedupe_existing(&state.pool)?;
    if !survivors.is_empty() || !losers.is_empty() {
        let _ = app.emit("clipboard://changed", ());
        let _ = app.emit_to(crate::clipboard::OVERLAY_LABEL, "clipboard://changed", ());
    }
    Ok(losers)
}

/// Apply a remote folder entity (kind='folder' notice) into the local store.
/// Called by the JS sync engine; never re-emits a sync signal.
#[tauri::command]
pub fn clipboard_apply_folder(
    state: State<AppState>,
    app: tauri::AppHandle,
    id: String,
    name: String,
    created_utc: Option<String>,
    device_id: Option<String>,
    device_name: Option<String>,
    deleted: Option<bool>,
) -> AppResult<()> {
    let created = created_utc.unwrap_or_else(|| {
        chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string()
    });
    clip_store::apply_folder_entity(
        &state.pool,
        &id,
        &name,
        &created,
        device_id.as_deref(),
        device_name.as_deref(),
        deleted.unwrap_or(false),
    )?;
    let _ = app.emit("clipboard://changed", ());
    let _ = app.emit_to(crate::clipboard::OVERLAY_LABEL, "clipboard://changed", ());
    Ok(())
}

#[tauri::command]
pub fn clipboard_copy(state: State<AppState>, id: String) -> AppResult<()> {
    if let Some(item) = clip_store::get(&state.pool, &id)? {
        crate::clipboard::copy_to_os(&state.pool, &item)?;
    }
    Ok(())
}

/// Base64 of a stored image's bytes, for the JS sync client to encrypt + upload.
#[tauri::command]
pub fn clipboard_image_b64(state: State<AppState>, id: String) -> AppResult<Option<String>> {
    let Some(item) = clip_store::get(&state.pool, &id)? else {
        return Ok(None);
    };
    let Some(path) = item.image_path else {
        return Ok(None);
    };
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(
            base64::engine::general_purpose::STANDARD.encode(bytes),
        )),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn clipboard_clear_all(state: State<AppState>, app: tauri::AppHandle) -> AppResult<()> {
    // Publish one tombstone per live item before removing the local rows. The
    // relay is a permanent store, so skipping this would make cleared history
    // reappear on the next catch-up.
    let ids = clip_store::live_ids(&state.pool)?;
    for id in &ids {
        let _ = app.emit("clipboard://delete", id);
    }
    let files = clip_store::clear_all(&state.pool)?;
    crate::clipboard::remove_files(files.into_iter().map(Some));
    let _ = app.emit("clipboard://changed", ());
    let _ = app.emit_to(crate::clipboard::OVERLAY_LABEL, "clipboard://changed", ());
    Ok(())
}

/// Write the three clipboard toggles and reconcile the watcher + overlay window.
///
/// ASYNC + DEFERRED on purpose. Building the floating overlay window
/// (`WebviewWindowBuilder::build()`) must run on the Tauri main thread because
/// WebView2 controller init pumps the Win32 message loop — but it CANNOT run
/// inside a synchronous command, because that command is itself occupying the
/// main thread, so `build()` would deadlock waiting for a pump it is blocking
/// (the classic Tauri v2 Windows hang, see wry#583). The settings writes are
/// fast SQLite and stay inline; the window/watcher reconciliation is queued onto
/// the main thread via `apply_settings_deferred`, which returns immediately and
/// runs after this command yields. Errors from the deferred path are written to
/// the diagnostics log (and surfaced via `clipboard_diagnostics`).
#[tauri::command]
pub async fn clipboard_configure(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    enabled: bool,
    overlay: bool,
    auto_capture: bool,
) -> AppResult<()> {
    // Settings writes — synchronous, sub-millisecond SQLite. Cloned out of State
    // (not 'static) and run inline so a failure rejects the invoke before we
    // touch the window.
    let pool = state.pool.clone();
    settings::set(
        &pool,
        "clipboard_enabled",
        if enabled { "true" } else { "false" },
    )?;
    settings::set(
        &pool,
        "clipboard_overlay_enabled",
        if overlay { "true" } else { "false" },
    )?;
    settings::set(
        &pool,
        "clipboard_auto_capture",
        if auto_capture { "true" } else { "false" },
    )?;
    crate::clipboard::log(format!(
        "clipboard_configure: toggles written (enabled={enabled}, overlay={overlay}, auto={auto_capture}); deferring apply_settings to main thread"
    ));
    // Reconcile watcher + overlay on the main thread, AFTER this command returns
    // so the message pump is free to build the WebView2 child window.
    crate::clipboard::apply_settings_deferred(app);
    Ok(())
}

/// Snapshot of the desktop clipboard runtime log (watcher / overlay / sync
/// handoff) for the Settings panel's "Copy logs" diagnostics button.
#[tauri::command]
pub fn clipboard_diagnostics(_state: State<AppState>) -> AppResult<Vec<String>> {
    Ok(crate::clipboard::diagnostics())
}

#[tauri::command]
pub fn clipboard_overlay_set_pos(state: State<AppState>, x: f64, y: f64) -> AppResult<()> {
    settings::set(
        &state.pool,
        "clipboard_overlay_pos",
        &format!("{},{}", x.round(), y.round()),
    )
}

/// Resolve the Sarvam key: a user-supplied one in settings wins (so voice-to-text
/// works on installs that shipped without a baked key, and can be rotated without a
/// rebuild), falling back to the `.env`/compile-time key.
fn sarvam_key(state: &State<AppState>) -> Option<String> {
    settings::get(&state.pool, "clipboard_sarvam_key")
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("SARVAM_API_KEY").ok())
        .or_else(|| option_env!("SARVAM_API_KEY").map(str::to_string))
        .filter(|s| !s.trim().is_empty())
}

/// Transcribe short (≤30s) audio via Sarvam's speech-to-text REST API. The key comes
/// from settings (`clipboard_sarvam_key`) if set, else the `.env`/baked key.
#[tauri::command]
pub async fn speech_to_text(
    state: State<'_, AppState>,
    audio_base64: String,
    mime: Option<String>,
    language: Option<String>,
) -> AppResult<String> {
    let key = sarvam_key(&state).ok_or_else(|| AppError::msg("Sarvam API key not configured"))?;
    let language = language.or_else(|| {
        settings::get(&state.pool, "clipboard_stt_language")
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())
    });
    run_blocking(move || {
        let bytes = decode_b64(&audio_base64)?;
        let mime = mime.unwrap_or_else(|| "audio/wav".into());
        let boundary = format!("----gtclip{}", uuid::Uuid::new_v4().simple());

        let mut body: Vec<u8> = Vec::new();
        let mut field = |name: &str, value: &str, body: &mut Vec<u8>| {
            body.extend_from_slice(
                format!(
                    "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
                )
                .as_bytes(),
            );
        };
        field("model", "saaras:v3", &mut body);
        field("mode", "transcribe", &mut body);
        if let Some(lang) = language.as_deref() {
            field("language_code", lang, &mut body);
        }
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio\"\r\nContent-Type: {mime}\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(&bytes);
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

        // Sarvam intermittently 5xxs / stalls; a bounded timeout + one retry turns
        // "mic silently does nothing" into a reliable transcribe (or a real error).
        let send = || {
            ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .post("https://api.sarvam.ai/speech-to-text")
                .set("api-subscription-key", &key)
                .set(
                    "Content-Type",
                    &format!("multipart/form-data; boundary={boundary}"),
                )
                .send_bytes(&body)
        };
        let resp = match send() {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) if (500..600).contains(&code) => {
                std::thread::sleep(std::time::Duration::from_millis(600));
                send().map_err(|e| AppError::msg(format!("Sarvam request failed: {e}")))
                    .or_else(|first| {
                        // Surface the original server body if the retry also failed.
                        let body = r.into_string().unwrap_or_default();
                        Err(AppError::msg(format!(
                            "{first} (server said: {})",
                            body.chars().take(200).collect::<String>()
                        )))
                    })?
            }
            Err(ureq::Error::Transport(_)) => {
                std::thread::sleep(std::time::Duration::from_millis(600));
                send().map_err(|e| AppError::msg(format!("Sarvam request failed: {e}")))?
            }
            Err(e) => return Err(AppError::msg(format!("Sarvam request failed: {e}"))),
        };
        let json: serde_json::Value = resp
            .into_json()
            .map_err(|e| AppError::msg(e.to_string()))?;
        let text = json
            .get("transcript")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Ok(text)
    })
    .await
}
