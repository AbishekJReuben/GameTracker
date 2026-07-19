//! GameTracker Remote — signaling (rendezvous) server.
//!
//! The one small piece of infrastructure that makes "connect from anywhere with
//! nothing to install" possible. It does NOT carry screen/control traffic — it
//! only brokers the WebRTC handshake: two peers (the PC "host" and the phone
//! "guest") join a **room** identified by a short connection code, and this
//! server relays their SDP offer/answer and ICE candidates to each other. Once
//! WebRTC establishes a direct peer-to-peer path, this server is idle.
//!
//! Protocol: connect to `wss://<host>/ws?room=<CODE>&role=<host|guest>`. Every
//! text/binary message you send is forwarded verbatim to the *other* members of
//! the same room. The server also emits small JSON control notices:
//!   {"type":"peer-joined","role":"..."}   — another peer entered your room
//!   {"type":"peer-left"}                   — a peer left your room
//!   {"type":"room-full"}                   — room already had 2 peers (rejected)
//!
//! Deploy it anywhere that runs a container or a binary (Fly.io, Railway, a VPS).
//! It listens on `$PORT` (default 8080). No state is persisted; rooms are ephemeral.

mod clip;

use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxumPath, Query, State,
    },
    http::{header, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
struct AppState {
    rooms: Arc<Mutex<HashMap<String, Vec<Peer>>>>,
    next_id: Arc<AtomicU64>,
    /// Persistent, E2E-encrypted shared-clipboard store (the /clip namespace).
    clip: Arc<clip::ClipState>,
}

struct Peer {
    id: u64,
    role: String,
    tx: mpsc::UnboundedSender<Message>,
    /// Set when this peer was kicked out by a newer same-role connection, so its
    /// own leave-cleanup skips the misleading "peer-left" notice to the room.
    evicted: Arc<AtomicBool>,
}

#[derive(Deserialize)]
struct JoinQuery {
    room: String,
    role: Option<String>,
}

#[tokio::main]
async fn main() {
    let state = AppState {
        rooms: Arc::new(Mutex::new(HashMap::new())),
        next_id: Arc::new(AtomicU64::new(1)),
        clip: clip::ClipState::new(&clip_data_dir()),
    };

    // Host both discovery clients from signaling/static:
    //   / and /companion → companion.html (phone browser)
    //   /quest           → quest.html     (Meta Quest headset)
    // Assets resolve via ServeDir; /ws and /health always win.
    let static_dir = quest_static_dir();
    let companion = PathBuf::from(format!("{static_dir}/companion.html"));
    let quest = PathBuf::from(format!("{static_dir}/quest.html"));
    let serve = ServeDir::new(&static_dir).fallback(ServeFile::new(companion.clone()));
    println!("serving discovery clients from {static_dir}");

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(ws_handler))
        // Shared-clipboard namespace: WS for metadata + a blob endpoint for images.
        .route("/clip/ws", get(clip_ws_handler))
        .route(
            "/clip/blob/:clip/:item",
            get(clip_blob_get).put(clip_blob_put),
        )
        .route("/quest", {
            let p = quest.clone();
            get(move || serve_html(p.clone()))
        })
        .route("/quest/", {
            let p = quest.clone();
            get(move || serve_html(p.clone()))
        })
        .route("/companion", {
            let p = companion.clone();
            get(move || serve_html(p.clone()))
        })
        .route("/companion/", {
            let p = companion.clone();
            get(move || serve_html(p.clone()))
        })
        .with_state(state)
        .fallback_service(serve);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    println!("signaling server listening on {addr}");
    axum::serve(listener, app).await.expect("serve");
}

async fn serve_html(path: PathBuf) -> Response {
    match tokio::fs::read_to_string(&path).await {
        Ok(body) => (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            Html(body),
        )
            .into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            "client not built — run npm run discovery:build",
        )
            .into_response(),
    }
}

/// Locate the built discovery clients (`signaling/static`). Order: `QUEST_STATIC_DIR`
/// env override, `<exe dir>/static` (deployed alongside the binary), then the
/// build machine's `signaling/static` (this server is self-hosted — built and run
/// on the same PC, so the compile-time manifest path is valid at runtime).
fn quest_static_dir() -> String {
    if let Ok(d) = std::env::var("QUEST_STATIC_DIR") {
        if Path::new(&d).exists() {
            return d;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("static");
            if p.exists() {
                return p.to_string_lossy().into_owned();
            }
        }
    }
    concat!(env!("CARGO_MANIFEST_DIR"), "/static").to_string()
}

/// Where the shared-clipboard store lives: `CLIP_DATA_DIR` env override,
/// `<exe dir>/clip-data`, else `./clip-data`.
fn clip_data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("CLIP_DATA_DIR") {
        return PathBuf::from(d);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            return dir.join("clip-data");
        }
    }
    PathBuf::from("clip-data")
}

#[derive(Deserialize)]
struct ClipJoin {
    clip: String,
}

async fn clip_ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<ClipJoin>,
    State(s): State<AppState>,
) -> impl IntoResponse {
    let clip_id = q.clip;
    ws.on_upgrade(move |socket| clip::handle(socket, clip_id, s.clip.clone()))
}

async fn clip_blob_get(
    AxumPath((clip_id, item)): AxumPath<(String, String)>,
    State(s): State<AppState>,
) -> Response {
    match s.clip.read_blob(&clip_id, &item) {
        Some(bytes) => {
            ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn clip_blob_put(
    AxumPath((clip_id, item)): AxumPath<(String, String)>,
    State(s): State<AppState>,
    body: Bytes,
) -> Response {
    if body.len() > clip::MAX_BLOB {
        return (StatusCode::PAYLOAD_TOO_LARGE, "too large").into_response();
    }
    match s.clip.write_blob(&clip_id, &item, &body) {
        Ok(_) => StatusCode::OK.into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "write failed").into_response(),
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<JoinQuery>,
    State(s): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle(socket, q, s))
}

async fn handle(socket: WebSocket, q: JoinQuery, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let role = q.role.unwrap_or_else(|| "guest".into());
    let room = q.room.clone();
    let evicted = Arc::new(AtomicBool::new(false));

    // Join the room (cap at 2 peers to keep it a 1:1 rendezvous). Notify BOTH
    // directions so the WebRTC "host" can initiate regardless of who connected
    // first: tell each existing peer the newcomer arrived, AND tell the newcomer
    // about each peer already present. (Previously only existing peers were told,
    // so if the guest joined before the host, the host never learned to send its
    // offer and the connection hung.)
    {
        let mut rooms = state.rooms.lock().await;
        let peers = rooms.entry(room.clone()).or_default();
        // Replace any existing peer with the SAME role: a reconnecting phone (new
        // "guest") almost always means its previous socket is a zombie the server
        // hasn't noticed dying yet (common when Android switches Wi‑Fi). Evicting it
        // — instead of rejecting the newcomer with room-full — is what lets the phone
        // reattach on its own without a force-stop + new code. The evicted peer is
        // flagged (so its cleanup won't emit a spurious peer-left) and sent a Close.
        for stale in peers.iter().filter(|p| p.role == role) {
            stale.evicted.store(true, Ordering::SeqCst);
            let _ = stale
                .tx
                .send(Message::Text("{\"type\":\"replaced\"}".to_string().into()));
            let _ = stale.tx.send(Message::Close(None));
        }
        peers.retain(|p| p.role != role);
        if peers.len() >= 2 {
            let _ = sink
                .send(Message::Text("{\"type\":\"room-full\"}".to_string().into()))
                .await;
            return;
        }
        for p in peers.iter() {
            // Tell the newcomer that an existing peer (with its role) is here...
            let _ = tx.send(Message::Text(
                format!("{{\"type\":\"peer-joined\",\"role\":\"{}\"}}", p.role).into(),
            ));
            // ...and tell that existing peer the newcomer joined.
            let _ = p.tx.send(Message::Text(
                format!("{{\"type\":\"peer-joined\",\"role\":\"{role}\"}}").into(),
            ));
        }
        peers.push(Peer {
            id,
            role: role.clone(),
            tx: tx.clone(),
            evicted: evicted.clone(),
        });
    }

    // Pump queued messages out to this socket.
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Relay everything this peer sends to the other room member(s).
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(_) | Message::Binary(_) => relay(&state, &room, id, msg).await,
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Leave the room and notify the remaining peer.
    {
        let mut rooms = state.rooms.lock().await;
        if let Some(peers) = rooms.get_mut(&room) {
            peers.retain(|p| p.id != id);
            if peers.is_empty() {
                rooms.remove(&room);
            }
        }
    }
    // If we were evicted by a newer same-role peer, stay quiet: a "peer-left" here
    // would tell the host the guest is gone right as its replacement is joining.
    if !evicted.load(Ordering::SeqCst) {
        relay(
            &state,
            &room,
            id,
            Message::Text("{\"type\":\"peer-left\"}".to_string().into()),
        )
        .await;
    }
    send_task.abort();
}

async fn relay(state: &AppState, room: &str, from: u64, msg: Message) {
    let rooms = state.rooms.lock().await;
    if let Some(peers) = rooms.get(room) {
        for p in peers {
            if p.id != from {
                let _ = p.tx.send(msg.clone());
            }
        }
    }
}
