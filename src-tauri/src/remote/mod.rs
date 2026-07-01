//! Remote access server — a small embedded HTTP + WebSocket API that lets the
//! companion phone app (over Tailscale, or the same LAN) view live stats and,
//! in later phases, stream the screen and inject input.
//!
//! Design notes:
//! - The whole feature is gated behind the `remote_enabled` setting (default off),
//!   consistent with the app's "one toggle controls network features" convention.
//! - Reachability is expected to come from a mesh VPN (Tailscale): the server binds
//!   `0.0.0.0:<port>` and the phone connects to the PC's Tailscale IP. No relay/TURN
//!   infrastructure is needed.
//! - Pairing: a 6-digit PIN is shown on the desktop Remote screen. The phone POSTs it
//!   to `/pair` and receives a bearer token; every `/api/*` call must carry that token.
//! - DB reads reuse the exact same `db::*` functions the Tauri commands use, wrapped in
//!   `spawn_blocking` so rusqlite never blocks the async runtime.

pub(crate) mod capture;
pub(crate) mod focus;
pub(crate) mod input;

use crate::db::{games, media as mediadb, music, playlists, screenshots, sessions, settings, stats, DbPool};
use crate::db::models::{GameInput, SessionFilter};
use crate::db::playlists::PlaylistTrack;
use crate::error::AppResult;
use crate::tracking::TrackingShared;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, Request, State,
    },
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

/// Shared, mutable state for the remote server: config + pairing + live counters.
pub struct RemoteShared {
    pub enabled: AtomicBool,
    pub running: AtomicBool,
    pub cloud_enabled: AtomicBool,
    pub port: AtomicU16,
    pub clients: AtomicUsize,
    pub pin: Mutex<String>,
    pub code: Mutex<String>,
    pub tokens: Mutex<HashSet<String>>,
    shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl RemoteShared {
    pub fn new(port: u16) -> Self {
        Self {
            enabled: AtomicBool::new(false),
            running: AtomicBool::new(false),
            cloud_enabled: AtomicBool::new(false),
            port: AtomicU16::new(port),
            clients: AtomicUsize::new(0),
            pin: Mutex::new(gen_pin()),
            code: Mutex::new(gen_code()),
            tokens: Mutex::new(HashSet::new()),
            shutdown: Mutex::new(None),
        }
    }

    /// Rotate the pairing PIN and invalidate every previously issued token.
    pub fn rotate_pin(&self) -> String {
        let pin = gen_pin();
        *self.pin.lock() = pin.clone();
        self.tokens.lock().clear();
        pin
    }

    /// Rotate the cloud connection code (the WebRTC signaling room id / secret).
    pub fn rotate_code(&self) -> String {
        let code = gen_code();
        *self.code.lock() = code.clone();
        code
    }
}

/// The axum handler state: everything a request needs, all cheaply cloneable.
#[derive(Clone)]
pub struct ApiState {
    pub pool: DbPool,
    pub tracking: Arc<TrackingShared>,
    pub media_dir: Arc<PathBuf>,
    pub remote: Arc<RemoteShared>,
    pub sys: Arc<crate::system::SystemShared>,
}

/// A 6-digit numeric pairing PIN, derived from UUID randomness (no extra dep).
fn gen_pin() -> String {
    let n = (uuid::Uuid::new_v4().as_u128() % 1_000_000) as u32;
    format!("{n:06}")
}

/// An 8-char connection code for cloud mode — used as the signaling room id and
/// shared secret. ~41 bits from an unambiguous alphabet (no 0/O/1/I/L).
fn gen_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let mut n = uuid::Uuid::new_v4().as_u128();
    let mut out = String::with_capacity(8);
    for _ in 0..8 {
        out.push(ALPHABET[(n % ALPHABET.len() as u128) as usize] as char);
        n /= ALPHABET.len() as u128;
    }
    out
}

fn gen_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Start the server if it isn't already running. Binds on the async runtime and
/// serves until `stop` signals graceful shutdown. Bind failures are logged and
/// leave `running=false` so the UI can reflect the error state.
pub fn start(ctx: ApiState) {
    if ctx.remote.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let port = ctx.remote.port.load(Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        *ctx.remote.shutdown.lock() = Some(tx);

        let addr = SocketAddr::from(([0, 0, 0, 0], port));
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("remote: failed to bind {addr}: {e}");
                ctx.remote.running.store(false, Ordering::SeqCst);
                return;
            }
        };
        let app = build_router(ctx.clone());
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
        ctx.remote.running.store(false, Ordering::SeqCst);
        ctx.remote.clients.store(0, Ordering::SeqCst);
    });
}

/// Signal the running server to shut down and reset live counters.
pub fn stop(remote: &RemoteShared) {
    if let Some(tx) = remote.shutdown.lock().take() {
        let _ = tx.send(());
    }
    remote.clients.store(0, Ordering::SeqCst);
}

fn build_router(state: ApiState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Routes that require a valid bearer token.
    let protected = Router::new()
        .route("/api/tracking", get(tracking_now))
        .route("/api/tracking/pause", post(set_paused))
        .route("/api/dashboard", get(dashboard))
        .route("/api/apps", get(apps_overview))
        .route("/api/games", get(list_games))
        .route("/api/games/:id", get(get_game))
        .route("/api/games/:id/stats", get(get_game_stats))
        .route("/api/games/:id/screenshots", get(get_game_screenshots))
        .route("/api/games/:id/achievements/steam", get(get_steam_achievements))
        .route("/api/games/:id/achievements/gog", get(get_gog_achievements))
        .route("/api/games/achievements/steam/overview", get(get_steam_achievements_overview))
        .route("/api/games/:id/launch", post(launch_game))
        .route("/api/games/:id/status", post(set_game_status))
        .route("/api/games/:id/save", post(save_game))
        .route("/api/games/:id/delete", post(delete_game))
        .route("/api/screenshots/:id/delete", post(delete_screenshot))
        .route("/api/catalog", get(catalog_analytics))
        .route("/api/insights", get(insights))
        .route("/api/hourofday", get(hour_of_day))
        .route("/api/tags", get(list_tags))
        .route("/api/sessions", get(list_sessions))
        .route("/api/heatmap", get(heatmap))
        .route("/api/music/overview", get(music_overview))
        .route("/api/music/top", get(music_top))
        .route("/api/music/insights", get(music_insights))
        .route("/api/music/recent", get(music_recent))
        .route("/api/music/timeline", get(music_timeline))
        .route("/api/music/heatmap", get(media_heatmap))
        .route("/api/music/hourofday", get(media_hour_of_day))
        .route("/api/music/stop", post(stop_media_play))
        .route("/api/playlists", get(playlists_list))
        .route("/api/playlists/create", post(playlist_create))
        .route("/api/playlists/:id", get(playlist_get))
        .route("/api/playlists/:id/rename", post(playlist_rename))
        .route("/api/playlists/:id/delete", post(playlist_delete))
        .route("/api/playlists/:id/add_tracks", post(playlist_add_tracks))
        .route("/api/playlists/:id/remove_track", post(playlist_remove_track))
        .route("/api/playlists/:id/reorder", post(playlist_reorder))
        .route("/api/monitors", get(monitors_list))
        .route("/api/system/specs", get(system_specs))
        .route("/api/system/live", get(system_live))
        .route("/api/system/history", get(system_history))
        .route("/api/settings", get(get_settings))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    // Public routes: health check, pairing, live socket, media files, and the
    // screen + control WebSockets (all token-checked via a query param, since
    // browser WebSocket and <img> can't set an Authorization header).
    let public = Router::new()
        .route("/ping", get(ping))
        .route("/pair", post(pair))
        .route("/ws", get(ws_handler))
        .route("/screen", get(screen_ws))
        .route("/control", get(control_ws))
        .route("/media", get(media_file));

    public.merge(protected).layer(cors).with_state(state)
}

// ---------- auth ----------

async fn require_auth(
    State(s): State<ApiState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let ok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|tok| s.remote.tokens.lock().contains(tok))
        .unwrap_or(false);
    if ok {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

#[derive(Deserialize)]
struct PairReq {
    pin: String,
}

#[derive(Serialize)]
struct PairResp {
    token: String,
    name: String,
    version: String,
}

async fn pair(State(s): State<ApiState>, Json(body): Json<PairReq>) -> Response {
    let expected = s.remote.pin.lock().clone();
    if body.pin.trim() == expected {
        let token = gen_token();
        s.remote.tokens.lock().insert(token.clone());
        Json(PairResp {
            token,
            name: "GameTracker".into(),
            version: env!("CARGO_PKG_VERSION").into(),
        })
        .into_response()
    } else {
        (StatusCode::UNAUTHORIZED, "Wrong PIN").into_response()
    }
}

#[derive(Serialize)]
struct Ping {
    app: &'static str,
    version: &'static str,
}

async fn ping() -> Json<Ping> {
    Json(Ping {
        app: "gametracker",
        version: env!("CARGO_PKG_VERSION"),
    })
}

// ---------- error + blocking helpers ----------

/// Wraps an error into an HTTP response. Any `AppError` becomes a 500 with its message.
struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

impl From<crate::error::AppError> for ApiError {
    fn from(e: crate::error::AppError) -> Self {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

/// Run a blocking DB closure off the async runtime and map its result to JSON.
async fn blocking<T, F>(f: F) -> ApiResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Serialize + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(r) => r.map(Json).map_err(ApiError::from),
        Err(_) => Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "worker task failed".into(),
        )),
    }
}

// ---------- read endpoints (mirror the Tauri commands) ----------

async fn tracking_now(State(s): State<ApiState>) -> Json<crate::tracking::TrackingState> {
    Json(s.tracking.state.lock().clone())
}

async fn dashboard(State(s): State<ApiState>) -> ApiResult<stats::Dashboard> {
    let pool = s.pool.clone();
    blocking(move || stats::dashboard(&pool)).await
}

async fn apps_overview(State(s): State<ApiState>) -> ApiResult<stats::AppsOverview> {
    let pool = s.pool.clone();
    blocking(move || stats::apps_overview(&pool)).await
}

async fn list_games(State(s): State<ApiState>) -> ApiResult<Vec<crate::db::models::GameDto>> {
    let pool = s.pool.clone();
    blocking(move || games::list(&pool)).await
}

async fn get_game(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Option<crate::db::models::GameDto>> {
    let pool = s.pool.clone();
    blocking(move || games::get(&pool, &id)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedGameStatsResp {
    stats: Option<crate::metadata::GameStats>,
    fetched_utc: Option<String>,
}
async fn get_game_stats(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<CachedGameStatsResp> {
    let pool = s.pool.clone();
    blocking(move || {
        let (json, fetched_utc) = games::get_stats_cache(&pool, &id)?;
        let stats = json.and_then(|j| serde_json::from_str::<crate::metadata::GameStats>(&j).ok());
        Ok(CachedGameStatsResp { stats, fetched_utc })
    }).await
}

async fn get_game_screenshots(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Vec<crate::db::models::ScreenshotDto>> {
    let pool = s.pool.clone();
    blocking(move || screenshots::list(&pool, &id)).await
}

#[derive(Deserialize)]
struct AchievementsQuery {
    refresh: Option<bool>,
}

async fn get_steam_achievements(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(q): Query<AchievementsQuery>,
) -> ApiResult<Vec<crate::steam::SteamAchievement>> {
    let pool = s.pool.clone();
    let force = q.refresh.unwrap_or(false);
    blocking(move || {
        if !force {
            let cached = crate::steam::achievements_for_game(&pool, &id)?;
            if !cached.is_empty() {
                return Ok(cached);
            }
        }
        let game = games::get(&pool, &id)?.ok_or_else(|| crate::error::AppError::msg("Game not found."))?;
        let appid = game
            .steam_app_id
            .filter(|&a| a > 0)
            .ok_or_else(|| crate::error::AppError::msg("This game has no linked Steam app ID."))?;
        let api_key = crate::steam::steam_api_key()?;
        let steam_id = settings::get(&pool, "steam_id")?.unwrap_or_default();
        let install_folder = game.install_folder.clone();

        crate::steam::refresh_achievements_for_game(
            &pool,
            &id,
            &api_key,
            &steam_id,
            appid as u64,
            install_folder.as_deref(),
        )
    }).await
}

async fn get_gog_achievements(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(q): Query<AchievementsQuery>,
) -> ApiResult<Vec<crate::gog::GogAchievement>> {
    let pool = s.pool.clone();
    let refresh = q.refresh.unwrap_or(false);
    blocking(move || crate::gog::game_achievements(&pool, &id, refresh)).await
}

async fn get_steam_achievements_overview(
    State(s): State<ApiState>,
) -> ApiResult<crate::steam::SteamAchievementsOverview> {
    let pool = s.pool.clone();
    blocking(move || crate::steam::achievements_overview(&pool)).await
}

async fn catalog_analytics(State(s): State<ApiState>) -> ApiResult<stats::CatalogAnalytics> {
    let pool = s.pool.clone();
    blocking(move || stats::catalog_analytics(&pool)).await
}

#[derive(Deserialize)]
struct InsightsQuery {
    year: i64,
    kind: Option<String>,
}
async fn insights(
    State(s): State<ApiState>,
    Query(q): Query<InsightsQuery>,
) -> ApiResult<stats::Insights> {
    let pool = s.pool.clone();
    let kind = q.kind;
    blocking(move || stats::insights(&pool, q.year, kind.as_deref())).await
}

#[derive(Deserialize)]
struct HourOfDayQuery {
    kind: Option<String>,
}
async fn hour_of_day(
    State(s): State<ApiState>,
    Query(q): Query<HourOfDayQuery>,
) -> ApiResult<Vec<i64>> {
    let pool = s.pool.clone();
    let kind = q.kind;
    blocking(move || stats::hour_of_day(&pool, kind.as_deref())).await
}

async fn list_tags(State(s): State<ApiState>) -> ApiResult<Vec<String>> {
    let pool = s.pool.clone();
    blocking(move || stats::list_tags(&pool)).await
}

async fn tag_analytics(State(s): State<ApiState>) -> ApiResult<Vec<stats::TagStat>> {
    let pool = s.pool.clone();
    blocking(move || stats::tag_analytics(&pool)).await
}

#[derive(Deserialize)]
struct HeatmapQuery {
    days: Option<i64>,
    kind: Option<String>,
}

async fn heatmap(
    State(s): State<ApiState>,
    Query(q): Query<HeatmapQuery>,
) -> ApiResult<Vec<stats::DayValue>> {
    let pool = s.pool.clone();
    let days = q.days.unwrap_or(140).clamp(7, 400);
    blocking(move || stats::heatmap(&pool, days, q.kind.as_deref())).await
}

#[derive(Deserialize)]
struct SessionsQuery {
    kind: Option<String>,
    limit: Option<i64>,
}

async fn list_sessions(
    State(s): State<ApiState>,
    Query(q): Query<SessionsQuery>,
) -> ApiResult<Vec<crate::db::models::SessionDto>> {
    let pool = s.pool.clone();
    let filter = SessionFilter {
        game_id: None,
        from_utc: None,
        to_utc: None,
        min_seconds: None,
        exclude_idle_ended: None,
        limit: Some(q.limit.unwrap_or(500).clamp(1, 5000)),
        kind: q.kind,
    };
    blocking(move || sessions::list(&pool, &filter)).await
}

async fn music_overview(State(s): State<ApiState>) -> ApiResult<music::MusicOverview> {
    let pool = s.pool.clone();
    blocking(move || music::overview(&pool)).await
}

#[derive(Deserialize)]
struct LimitQuery {
    limit: Option<i64>,
}

async fn music_top(
    State(s): State<ApiState>,
    Query(q): Query<LimitQuery>,
) -> ApiResult<music::MusicTop> {
    let pool = s.pool.clone();
    let limit = q.limit.unwrap_or(12).clamp(1, 100);
    blocking(move || music::top(&pool, limit)).await
}

async fn music_insights(State(s): State<ApiState>) -> ApiResult<music::MusicInsights> {
    let pool = s.pool.clone();
    blocking(move || music::insights(&pool)).await
}

async fn music_recent(
    State(s): State<ApiState>,
    Query(q): Query<LimitQuery>,
) -> ApiResult<Vec<mediadb::MediaPlayDto>> {
    let pool = s.pool.clone();
    let limit = q.limit.unwrap_or(16).clamp(1, 100);
    blocking(move || mediadb::recent(&pool, limit)).await
}

#[derive(Deserialize)]
struct RangeQuery {
    from: Option<String>,
    to: Option<String>,
}

async fn music_timeline(
    State(s): State<ApiState>,
    Query(q): Query<RangeQuery>,
) -> ApiResult<Vec<mediadb::MediaPlayDto>> {
    let pool = s.pool.clone();
    blocking(move || mediadb::list_plays(&pool, q.from.as_deref(), q.to.as_deref())).await
}

#[derive(Deserialize)]
struct DaysQuery {
    days: Option<i64>,
}
async fn media_heatmap(
    State(s): State<ApiState>,
    Query(q): Query<DaysQuery>,
) -> ApiResult<Vec<stats::DayValue>> {
    let pool = s.pool.clone();
    let days = q.days.unwrap_or(140).clamp(7, 400);
    blocking(move || music::heatmap(&pool, days)).await
}

async fn media_hour_of_day(State(s): State<ApiState>) -> ApiResult<Vec<i64>> {
    let pool = s.pool.clone();
    blocking(move || music::hour_of_day(&pool)).await
}

async fn playlists_list(State(s): State<ApiState>) -> ApiResult<Vec<playlists::PlaylistDto>> {
    let pool = s.pool.clone();
    blocking(move || playlists::list(&pool)).await
}

async fn playlist_get(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Option<playlists::PlaylistDto>> {
    let pool = s.pool.clone();
    blocking(move || playlists::get(&pool, &id)).await
}

async fn monitors_list() -> Json<Vec<capture::MonitorInfo>> {
    Json(capture::list_monitors())
}

async fn system_specs(State(s): State<ApiState>) -> Json<crate::system::SystemSpecs> {
    Json(crate::system::specs(&s.sys))
}

async fn system_live(State(s): State<ApiState>) -> Json<crate::system::SystemLive> {
    Json(crate::system::live(&s.sys))
}

#[derive(Deserialize)]
struct MinutesQuery {
    minutes: Option<i64>,
}
async fn system_history(
    State(s): State<ApiState>,
    Query(q): Query<MinutesQuery>,
) -> ApiResult<crate::system::SystemHistory> {
    let pool = s.pool.clone();
    let sys = s.sys.clone();
    let min = q.minutes.unwrap_or(60).clamp(5, 1440);
    blocking(move || crate::system::history(&pool, &sys, min)).await
}

async fn get_settings(State(s): State<ApiState>) -> ApiResult<std::collections::HashMap<String, String>> {
    let pool = s.pool.clone();
    blocking(move || settings::all(&pool)).await
}

// ---------- write endpoints ----------

#[derive(Deserialize)]
struct SetPausedReq {
    paused: bool,
}
async fn set_paused(State(s): State<ApiState>, Json(body): Json<SetPausedReq>) -> ApiResult<()> {
    let pool = s.pool.clone();
    blocking(move || {
        settings::set(&pool, "tracking_paused", if body.paused { "true" } else { "false" })?;
        Ok(())
    }).await
}

async fn launch_game(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<()> {
    let pool = s.pool.clone();
    blocking(move || {
        let game = games::get(&pool, &id)?.ok_or_else(|| crate::error::AppError::msg("Game not found."))?;
        if game.kind != "game" {
            return Err(crate::error::AppError::msg("Only games can be launched."));
        }
        let exe = crate::util::first_existing_exe(&game.exe_paths)
            .ok_or_else(|| crate::error::AppError::msg("Executable not found. The file may have been moved or deleted."))?;

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x00000008;
            let work_dir = exe.parent().unwrap_or(Path::new("."));
            std::process::Command::new(&exe)
                .current_dir(work_dir)
                .creation_flags(DETACHED_PROCESS)
                .spawn()
                .map_err(|e| crate::error::AppError::msg(format!("Failed to launch: {e}")))?;
        }
        Ok(())
    }).await
}

#[derive(Deserialize)]
struct SetGameStatusReq {
    status: String,
}
async fn set_game_status(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetGameStatusReq>,
) -> ApiResult<()> {
    let pool = s.pool.clone();
    blocking(move || {
        games::set_status(&pool, &id, &body.status)?;
        Ok(())
    }).await
}

#[derive(Deserialize)]
struct SaveGameReq {
    game: GameInput,
}
async fn save_game(
    State(s): State<ApiState>,
    Json(body): Json<SaveGameReq>,
) -> ApiResult<crate::db::models::GameDto> {
    let pool = s.pool.clone();
    blocking(move || {
        let id = games::upsert(&pool, body.game)?;
        games::get(&pool, &id)?.ok_or_else(|| crate::error::AppError::msg("Save failed, game not found."))
    }).await
}

async fn delete_game(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<()> {
    let pool = s.pool.clone();
    blocking(move || {
        games::delete(&pool, &id)?;
        Ok(())
    }).await
}

async fn delete_screenshot(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<()> {
    let pool = s.pool.clone();
    blocking(move || {
        if let Some(path) = screenshots::delete(&pool, &id)? {
            let _ = std::fs::remove_file(&path);
        }
        Ok(())
    }).await
}

async fn stop_media_play(State(s): State<ApiState>) -> ApiResult<()> {
    let pool = s.pool.clone();
    blocking(move || {
        crate::db::media::close_open_for_source(&pool, "jukebox")?;
        Ok(())
    }).await
}

#[derive(Deserialize)]
struct PlaylistCreateReq {
    name: String,
}
async fn playlist_create(
    State(s): State<ApiState>,
    Json(body): Json<PlaylistCreateReq>,
) -> ApiResult<String> {
    let pool = s.pool.clone();
    blocking(move || playlists::create(&pool, &body.name)).await
}

#[derive(Deserialize)]
struct PlaylistRenameReq {
    name: String,
}
async fn playlist_rename(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<PlaylistRenameReq>,
) -> ApiResult<()> {
    let pool = s.pool.clone();
    blocking(move || playlists::rename(&pool, &id, &body.name)).await
}

async fn playlist_delete(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<()> {
    let pool = s.pool.clone();
    blocking(move || playlists::delete(&pool, &id)).await
}

#[derive(Deserialize)]
struct PlaylistAddTracksReq {
    tracks: Vec<PlaylistTrack>,
}
async fn playlist_add_tracks(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<PlaylistAddTracksReq>,
) -> ApiResult<()> {
    let pool = s.pool.clone();
    blocking(move || playlists::add_tracks(&pool, &id, &body.tracks)).await
}

#[derive(Deserialize)]
struct PlaylistRemoveTrackReq {
    vid: String,
}
async fn playlist_remove_track(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<PlaylistRemoveTrackReq>,
) -> ApiResult<()> {
    let pool = s.pool.clone();
    blocking(move || playlists::remove_track(&pool, &id, &body.vid)).await
}

#[derive(Deserialize)]
struct PlaylistReorderReq {
    vids: Vec<String>,
}
async fn playlist_reorder(
    State(s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<PlaylistReorderReq>,
) -> ApiResult<()> {
    let pool = s.pool.clone();
    blocking(move || playlists::reorder(&pool, &id, &body.vids)).await
}

// ---------- media files ----------

#[derive(Deserialize)]
struct MediaQuery {
    path: String,
}

/// Serve a media file (cover/icon/screenshot) by its absolute path so the phone
/// can show artwork — the DTOs carry absolute local paths. Path-safe: the
/// resolved file must live under `media_dir`, so nothing else on disk is exposed.
async fn media_file(State(s): State<ApiState>, Query(q): Query<MediaQuery>) -> Response {
    let base = match s.media_dir.canonicalize() {
        Ok(b) => b,
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    let safe = std::path::Path::new(&q.path)
        .canonicalize()
        .ok()
        .filter(|p| p.starts_with(&base));
    let Some(p) = safe else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    match tokio::fs::read(&p).await {
        Ok(bytes) => {
            let ct = content_type(&p);
            ([(header::CONTENT_TYPE, ct)], bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

fn content_type(p: &std::path::Path) -> &'static str {
    match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("mp4") => "video/mp4",
        _ => "application/octet-stream",
    }
}

// ---------- live WebSocket ----------

#[derive(Deserialize)]
struct WsQuery {
    token: Option<String>,
}

async fn ws_handler(
    State(s): State<ApiState>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !ws_authorized(&s, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    ws.on_upgrade(move |socket| live_socket(socket, s))
}

/// Push the live tracking snapshot to the client once a second until it drops.
async fn live_socket(mut socket: WebSocket, s: ApiState) {
    s.remote.clients.fetch_add(1, Ordering::SeqCst);
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        ticker.tick().await;
        let snapshot = { s.tracking.state.lock().clone() };
        let payload = match serde_json::to_string(&snapshot) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if socket.send(Message::Text(payload.into())).await.is_err() {
            break;
        }
    }
    s.remote.clients.fetch_sub(1, Ordering::SeqCst);
}

// ---------- screen streaming ----------

async fn screen_ws(State(s): State<ApiState>, Query(q): Query<WsQuery>, ws: WebSocketUpgrade) -> Response {
    if !ws_authorized(&s, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    ws.on_upgrade(screen_socket)
}

/// Runtime stream-quality config the phone can push over the screen socket to
/// trade sharpness (resolution + JPEG quality) against bandwidth and frame rate.
#[derive(Deserialize, Clone, Copy)]
struct QualityCfg {
    #[serde(rename = "maxW")]
    max_w: u32,
    quality: u8,
    fps: u32,
}

impl QualityCfg {
    fn clamped(self) -> Self {
        Self {
            max_w: self.max_w.clamp(320, 3840),
            quality: self.quality.clamp(20, 95),
            fps: self.fps.clamp(1, 60),
        }
    }
    fn frame_interval(&self) -> std::time::Duration {
        std::time::Duration::from_millis((1000 / self.fps.max(1)) as u64)
    }
}

impl Default for QualityCfg {
    fn default() -> Self {
        Self { max_w: 1280, quality: 60, fps: 12 }
    }
}

/// Stream the primary monitor as JPEG frames. The phone may send a `QualityCfg`
/// JSON text message at any time to re-tune resolution/quality/fps live. Capture +
/// encode run on a blocking worker so the async runtime is never stalled.
async fn screen_socket(mut socket: WebSocket) {
    let mut cfg = QualityCfg::default();
    let mut ticker = tokio::time::interval(cfg.frame_interval());
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Stateful delta encoder for this connection (only changed tiles are sent).
    let mut enc = capture::TileEncoder::new();
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let (w, q) = (cfg.max_w, cfg.quality);
                let mon = capture::selected_monitor();
                // The encoder holds the previous frame, so hand it into the blocking
                // task and take it back out (it's Send, but not borrowable across await).
                let mut taken = std::mem::replace(&mut enc, capture::TileEncoder::new());
                let (frame, back) = tokio::task::spawn_blocking(move || {
                    let f = taken.encode(mon, w, q, false);
                    (f, taken)
                })
                .await
                .unwrap_or_else(|_| (None, capture::TileEncoder::new()));
                enc = back;
                let Some(bytes) = frame else { continue }; // None = nothing changed
                if socket.send(Message::Binary(bytes.into())).await.is_err() {
                    break;
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(next) = serde_json::from_str::<QualityCfg>(&t) {
                            let next = next.clamped();
                            if next.fps != cfg.fps {
                                ticker = tokio::time::interval(next.frame_interval());
                                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                            }
                            cfg = next;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}

// ---------- input control ----------

async fn control_ws(State(s): State<ApiState>, Query(q): Query<WsQuery>, ws: WebSocketUpgrade) -> Response {
    if !ws_authorized(&s, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    ws.on_upgrade(control_socket)
}

/// Receive control events and forward them to the input-injection thread. The
/// `Enigo` backend lives on its own OS thread (it isn't `Send`), fed via a channel.
async fn control_socket(mut socket: WebSocket) {
    let tx = input::spawn_controller();
    if tx.is_none() {
        let _ = socket
            .send(Message::Text("{\"error\":\"input unavailable\"}".to_string().into()))
            .await;
    }
    while let Some(Ok(msg)) = socket.recv().await {
        if let Message::Text(t) = msg {
            if let (Ok(ev), Some(tx)) = (serde_json::from_str::<input::ControlEvent>(&t), tx.as_ref()) {
                let _ = tx.send(ev);
            }
        }
    }
}

fn ws_authorized(s: &ApiState, q: &WsQuery) -> bool {
    q.token
        .as_deref()
        .map(|t| s.remote.tokens.lock().contains(t))
        .unwrap_or(false)
}

// ---------- helpers for the UI ----------

/// Best-guess reachable host address for the phone: prefer a Tailscale CGNAT
/// address (100.64.0.0/10), then a private LAN IPv4, else loopback.
pub fn best_host_ip() -> Option<String> {
    let ifaces = local_ip_address::list_afinet_netifas().ok()?;
    let mut lan: Option<String> = None;
    for (_name, ip) in ifaces {
        if let IpAddr::V4(v4) = ip {
            if v4.is_loopback() {
                continue;
            }
            let o = v4.octets();
            let is_tailscale = o[0] == 100 && (64..128).contains(&o[1]);
            if is_tailscale {
                return Some(v4.to_string());
            }
            let is_private = o[0] == 10
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 172 && (16..32).contains(&o[1]));
            if is_private && lan.is_none() {
                lan = Some(v4.to_string());
            }
        }
    }
    lan
}
