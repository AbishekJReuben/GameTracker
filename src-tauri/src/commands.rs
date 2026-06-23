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
pub fn fetch_cover(state: State<AppState>, id: String, name: String) -> AppResult<Option<GameDto>> {
    if !settings::get_bool(&state.pool, "online_metadata_enabled")? {
        return Err(AppError::msg(
            "Turn on Online metadata in Settings to fetch covers from Steam.",
        ));
    }
    match metadata::fetch_cover(&name, &state.media_dir, &id)? {
        Some(cover) => {
            games::set_cover_path(&state.pool, &id, &cover)?;
            games::get(&state.pool, &id)
        }
        None => Ok(None),
    }
}

/// Fetch developer, release year, metacritic, genres, and blurb from Steam (keyless).
/// Fills empty fields and merges genre tags. Optionally downloads cover too.
#[tauri::command]
pub fn fetch_game_info(
    state: State<AppState>,
    id: String,
    name: String,
    with_cover: Option<bool>,
) -> AppResult<Option<GameDto>> {
    if !settings::get_bool(&state.pool, "online_metadata_enabled")? {
        return Err(AppError::msg(
            "Turn on Online metadata in Settings to fetch game info from Steam.",
        ));
    }
    let with_cover = with_cover.unwrap_or(false);
    match metadata::fetch_game_info(&name, &state.media_dir, &id, with_cover)? {
        Some(meta) => {
            apply_game_metadata(&state.pool, &id, &meta)?;
            games::get(&state.pool, &id)
        }
        None => Ok(None),
    }
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
    )?;
    Ok(())
}

/// Fire-and-forget online enrichment for a freshly added game. Runs on a worker
/// thread (network must not block the sync command) and emits `game://enriched`
/// with `{ id }` when done so the UI can refetch. No-op when online metadata is
/// off. `steam_app_id`, when known from detection/autosuggest, makes the lookup
/// exact instead of a name search.
fn enrich_game_async(
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
            if apply_game_metadata(&pool, &id, &meta).is_ok() {
                let _ = app.emit("game://enriched", serde_json::json!({ "id": id }));
            }
        }
    });
}

/// Live + estimated stats (players now, peak, owners, revenue est., reviews) for
/// a game. Resolves a Steam appid from the stored id or the name; non-Steam games
/// (no appid) return `None`. Gated by the online-metadata opt-in.
#[tauri::command]
pub fn fetch_game_stats(
    state: State<AppState>,
    game_id: String,
) -> AppResult<Option<metadata::GameStats>> {
    if !settings::get_bool(&state.pool, "online_metadata_enabled")? {
        return Err(AppError::msg(
            "Turn on Online metadata in Settings to fetch live game stats.",
        ));
    }
    let game = games::get(&state.pool, &game_id)?.ok_or_else(|| AppError::msg("Game not found."))?;
    let appid = match game.steam_app_id {
        Some(a) if a > 0 => Some(a as u64),
        _ => metadata::resolve_steam_appid(&game.display_name),
    };
    let Some(appid) = appid else {
        return Ok(None);
    };
    // Cache the resolved appid so subsequent loads (and covers) are exact.
    if game.steam_app_id.is_none() {
        let _ = games::set_steam_app_id(&state.pool, &game_id, appid as i64);
    }
    Ok(Some(metadata::fetch_game_stats(appid)))
}

/// Fetch HowLongToBeat estimates (main, main+extra, completionist).
#[tauri::command]
pub fn fetch_hltb(
    state: State<AppState>,
    id: String,
    name: String,
    apply_as_manual: Option<bool>,
) -> AppResult<Option<GameDto>> {
    let apply = apply_as_manual.unwrap_or(true);
    match hltb::lookup(&name)? {
        Some(times) => {
            games::apply_hltb(&state.pool, &id, &times, apply)?;
            games::get(&state.pool, &id)?
                .ok_or_else(|| AppError::msg("Game not found"))
                .map(Some)
        }
        None => Ok(None),
    }
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
    };
    save_game(app, state, input)
}

/// Fetch a one-line description + logo for an app from Wikipedia (keyless).
/// Requires the online-metadata opt-in, like the game equivalents.
#[tauri::command]
pub fn fetch_app_info(
    state: State<AppState>,
    id: String,
    name: String,
    with_image: Option<bool>,
) -> AppResult<Option<GameDto>> {
    if !settings::get_bool(&state.pool, "online_metadata_enabled")? {
        return Err(AppError::msg(
            "Turn on Online metadata in Settings to fetch app info.",
        ));
    }
    let with_image = with_image.unwrap_or(true);
    match metadata::fetch_app_info(&name, &state.media_dir, &id, with_image)? {
        Some(info) => {
            games::apply_metadata(
                &state.pool,
                &id,
                info.developer.as_deref(),
                info.release_year,
                None,
                info.description.as_deref(),
                &info.genre_tags,
                info.cover_path.as_deref(),
            )?;
            games::set_media(&state.pool, &id, &info.screenshots, None, info.website.as_deref(), None)?;
            if let Some(json) = info.info_json.as_deref() {
                games::set_info_json(&state.pool, &id, json)?;
            }
            games::get(&state.pool, &id)
        }
        None => Ok(None),
    }
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
pub fn fetch_steam_reviews(app_id: i64) -> AppResult<Vec<metadata::SteamReview>> {
    if app_id <= 0 {
        return Ok(Vec::new());
    }
    metadata::fetch_steam_reviews(app_id as u64)
}

#[tauri::command]
pub fn fetch_metacritic_reviews(
    state: State<AppState>,
    game_id: String,
    slug: Option<String>,
) -> AppResult<Vec<metadata::MetacriticReview>> {
    if !settings::get_bool(&state.pool, "online_metadata_enabled")? {
        return Err(AppError::msg(
            "Turn on Online metadata in Settings to fetch Metacritic reviews.",
        ));
    }
    let game = games::get(&state.pool, &game_id)?.ok_or_else(|| AppError::msg("Game not found."))?;
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
        let _ = games::set_metacritic_slug(&state.pool, &game_id, &resolved);
    }
    metadata::fetch_metacritic_reviews(&resolved)
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
