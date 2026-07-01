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
pub(crate) mod input;

use crate::db::{games, media as mediadb, music, sessions, stats, DbPool};
use crate::db::models::SessionFilter;
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
use std::path::PathBuf;
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
        .route("/api/dashboard", get(dashboard))
        .route("/api/apps", get(apps_overview))
        .route("/api/games", get(list_games))
        .route("/api/sessions", get(list_sessions))
        .route("/api/heatmap", get(heatmap))
        .route("/api/music/overview", get(music_overview))
        .route("/api/music/top", get(music_top))
        .route("/api/music/insights", get(music_insights))
        .route("/api/music/recent", get(music_recent))
        .route("/api/music/timeline", get(music_timeline))
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

/// Stream the primary monitor as JPEG frames (~12 fps). Capture + encode run on a
/// blocking worker so the async runtime is never stalled.
async fn screen_socket(mut socket: WebSocket) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_millis(80));
    loop {
        ticker.tick().await;
        let frame = tokio::task::spawn_blocking(|| capture::grab_primary_jpeg(1280, 60))
            .await
            .ok()
            .flatten();
        let Some(bytes) = frame else { continue };
        if socket.send(Message::Binary(bytes.into())).await.is_err() {
            break;
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
