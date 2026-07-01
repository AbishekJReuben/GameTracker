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

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

#[derive(Clone)]
struct AppState {
    rooms: Arc<Mutex<HashMap<String, Vec<Peer>>>>,
    next_id: Arc<AtomicU64>,
}

struct Peer {
    id: u64,
    role: String,
    tx: mpsc::UnboundedSender<Message>,
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
    };

    let app = Router::new()
        .route("/", get(|| async { "GameTracker signaling server" }))
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(ws_handler))
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    println!("signaling server listening on {addr}");
    axum::serve(listener, app).await.expect("serve");
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

    // Join the room (cap at 2 peers to keep it a 1:1 rendezvous). Notify BOTH
    // directions so the WebRTC "host" can initiate regardless of who connected
    // first: tell each existing peer the newcomer arrived, AND tell the newcomer
    // about each peer already present. (Previously only existing peers were told,
    // so if the guest joined before the host, the host never learned to send its
    // offer and the connection hung.)
    {
        let mut rooms = state.rooms.lock().await;
        let peers = rooms.entry(room.clone()).or_default();
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
    relay(
        &state,
        &room,
        id,
        Message::Text("{\"type\":\"peer-left\"}".to_string().into()),
    )
    .await;
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
