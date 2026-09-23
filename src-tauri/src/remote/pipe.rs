//! Loopback **media pipe** between Rust and the host WebView.
//!
//! ## Why
//! Every encoded frame, every 10 ms audio packet and every phone input event used to
//! cross Tauri's IPC. For a payload ≥ 1 KB a Tauri 2 `Channel` message is delivered
//! as `webview.eval(...)` followed by an `ipc://` fetch, and on Windows both hops are
//! serviced on the app's **main UI thread** (WebView2 `ExecuteScript` and
//! `WebResourceRequested`). Input went the other way through `invoke`, which also
//! lands on that thread — and Tauri does not order separate invokes, which is why
//! chords needed `ControlEvent::Seq`. So stream smoothness and input latency both
//! depended on whatever else the UI thread was doing, and audio/video/input competed
//! with each other for it.
//!
//! This pipe is a plain WebSocket on `127.0.0.1`: bytes go capture thread → tokio →
//! loopback TCP → the WebView's network stack → the page, never touching the UI
//! thread, and input arrives in order on one socket and is injected straight from a
//! tokio task.
//!
//! ## Contract
//! * `ensure_started()` binds `127.0.0.1:0` once and returns `(port, token)`. Every
//!   connection must present the random per-process token (`?token=`), so only this
//!   app's own page can use it.
//! * Each socket gets an id, announced as the first text message `{"hello":<id>}`.
//!   A capture/audio pipeline started with that id sends ONLY there for its whole
//!   generation — it never mixes pipe and `Channel` delivery, so frames cannot be
//!   reordered across two transports. If the socket drops, its frames are dropped
//!   and the page restarts capture on the `Channel` path (a new generation + IDR).
//! * Page → Rust text messages: `{"t":"in","e":<ControlEvent>}` (primary input),
//!   `{"t":"inm","m":<monitor>,"e":<ControlEvent>}` (pop-out input) and
//!   `{"t":"ack","g":<generation>,"s":<sequence>}` (fast-delivery credit).
//! * A consumer that stops reading is disconnected once `MAX_QUEUED_BYTES` pile up,
//!   instead of growing memory without bound.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::mpsc;

/// Disconnect a client whose unsent backlog exceeds this (a stalled page).
pub const MAX_QUEUED_BYTES: usize = 48 * 1024 * 1024;

/// Port + token the page needs to connect.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipeInfo {
    pub port: u16,
    pub token: String,
}

struct Client {
    tx: mpsc::UnboundedSender<Message>,
    queued: Arc<AtomicUsize>,
}

struct Pipe {
    info: PipeInfo,
    clients: Mutex<HashMap<u64, Client>>,
    next_id: AtomicU64,
}

static PIPE: OnceLock<Option<Arc<Pipe>>> = OnceLock::new();

fn random_token() -> String {
    let mut s = String::with_capacity(64);
    for _ in 0..2 {
        s.push_str(&uuid::Uuid::new_v4().simple().to_string());
    }
    s
}

/// Start the loopback server (once) and return how to reach it. `None` if the
/// socket could not be bound — callers then keep the Tauri channel path.
pub fn ensure_started() -> Option<PipeInfo> {
    PIPE.get_or_init(|| {
        let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
        std_listener.set_nonblocking(true).ok()?;
        let port = std_listener.local_addr().ok()?.port();
        let pipe = Arc::new(Pipe {
            info: PipeInfo { port, token: random_token() },
            clients: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        });
        let state = pipe.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(listener) = tokio::net::TcpListener::from_std(std_listener) else {
                eprintln!("[pipe] could not adopt the loopback listener");
                return;
            };
            let app = Router::new().route("/pipe", get(upgrade)).with_state(state);
            // Loopback latency matters more than segment efficiency: never let
            // Nagle hold a small audio packet or P-frame waiting for an ACK.
            if let Err(e) = axum::serve(listener, app).tcp_nodelay(true).await {
                eprintln!("[pipe] server stopped: {e}");
            }
        });
        Some(pipe)
    })
    .as_ref()
    .map(|p| p.info.clone())
}

fn pipe() -> Option<&'static Arc<Pipe>> {
    PIPE.get().and_then(|p| p.as_ref())
}

/// True while client `id` is connected.
pub fn is_connected(id: u64) -> bool {
    pipe().is_some_and(|p| p.clients.lock().contains_key(&id))
}

/// Queue one binary message for client `id`. False if that client is gone (or was
/// just dropped for not reading) — the caller's frames are then lost until the page
/// restarts the pipeline, by design (see the module docs).
pub fn send_binary(id: u64, bytes: Vec<u8>) -> bool {
    let Some(p) = pipe() else { return false };
    let mut clients = p.clients.lock();
    let Some(c) = clients.get(&id) else { return false };
    let len = bytes.len();
    if c.queued.load(Ordering::Relaxed) + len > MAX_QUEUED_BYTES {
        eprintln!("[pipe] client {id} stopped reading ({} MB queued) — disconnecting", MAX_QUEUED_BYTES >> 20);
        clients.remove(&id); // dropping the sender closes the socket
        return false;
    }
    c.queued.fetch_add(len, Ordering::Relaxed);
    if c.tx.send(Message::Binary(bytes)).is_err() {
        clients.remove(&id);
        return false;
    }
    true
}

#[derive(Deserialize)]
struct Connect {
    token: String,
}

async fn upgrade(State(p): State<Arc<Pipe>>, Query(q): Query<Connect>, ws: WebSocketUpgrade) -> Response {
    if !constant_time_eq(q.token.as_bytes(), p.info.token.as_bytes()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(1 << 20).on_upgrade(move |socket| serve_client(p, socket))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn serve_client(p: Arc<Pipe>, socket: WebSocket) {
    use futures_util::{SinkExt, StreamExt};
    let id = p.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let queued = Arc::new(AtomicUsize::new(0));
    let (mut sink, mut stream) = socket.split();
    if sink.send(Message::Text(format!("{{\"hello\":{id}}}"))).await.is_err() {
        return;
    }
    p.clients.lock().insert(id, Client { tx, queued: queued.clone() });

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let len = match &msg {
                Message::Binary(b) => b.len(),
                _ => 0,
            };
            let ok = sink.send(msg).await.is_ok();
            queued.fetch_sub(len.min(queued.load(Ordering::Relaxed)), Ordering::Relaxed);
            if !ok {
                break;
            }
        }
        let _ = sink.close().await;
    });

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => handle_text(&t),
            Message::Close(_) => break,
            _ => {}
        }
    }
    p.clients.lock().remove(&id);
    writer.abort();
}

/// Page → Rust control messages (see the module docs).
#[derive(Deserialize)]
#[serde(tag = "t")]
enum PipeMsg {
    #[serde(rename = "in")]
    Inject { e: super::input::ControlEvent },
    #[serde(rename = "inm")]
    InjectOn { m: usize, e: super::input::ControlEvent },
    #[serde(rename = "ack")]
    Ack { g: u32, s: u32 },
}

fn handle_text(text: &str) {
    match serde_json::from_str::<PipeMsg>(text) {
        Ok(PipeMsg::Inject { e }) => super::input::inject(e),
        Ok(PipeMsg::InjectOn { m, e }) => super::input::inject_on_monitor(m, e),
        Ok(PipeMsg::Ack { g, s }) => super::delivery::DELIVERY.ack(g, s),
        Err(_) => {} // malformed / unknown — ignore, like the invoke path did
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()
    }

    #[test]
    fn parses_every_page_message_shape() {
        assert!(matches!(
            serde_json::from_str::<PipeMsg>(r#"{"t":"in","e":{"type":"move","x":0.5,"y":0.25}}"#),
            Ok(PipeMsg::Inject { .. })
        ));
        assert!(matches!(
            serde_json::from_str::<PipeMsg>(r#"{"t":"inm","m":1,"e":{"type":"click","x":0.1,"y":0.2,"button":"left"}}"#),
            Ok(PipeMsg::InjectOn { m: 1, .. })
        ));
        assert!(matches!(
            serde_json::from_str::<PipeMsg>(r#"{"t":"ack","g":3,"s":9}"#),
            Ok(PipeMsg::Ack { g: 3, s: 9 })
        ));
        assert!(serde_json::from_str::<PipeMsg>(r#"{"t":"nope"}"#).is_err());
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }

    /// End to end over real loopback sockets: a bad token is refused; a good one
    /// gets a hello id, receives binary frames byte-exact and in order, and the
    /// id stops being deliverable once the socket closes.
    #[test]
    fn delivers_ordered_binary_frames_only_to_authorized_clients() {
        let info = ensure_started().expect("loopback bind");
        let rt = runtime();
        rt.block_on(async move {
            // Give the spawned server a moment to adopt the listener.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let bad = format!("ws://127.0.0.1:{}/pipe?token=wrong", info.port);
            assert!(tokio_tungstenite::connect_async(bad).await.is_err(), "bad token must be refused");

            let url = format!("ws://127.0.0.1:{}/pipe?token={}", info.port, info.token);
            let (mut ws, _) = tokio_tungstenite::connect_async(url).await.expect("connect");
            let hello = ws.next().await.unwrap().unwrap();
            let id: u64 = match hello {
                WsMessage::Text(t) => serde_json::from_str::<serde_json::Value>(&t).unwrap()["hello"].as_u64().unwrap(),
                other => panic!("expected hello, got {other:?}"),
            };
            assert!(is_connected(id));
            // A 200 KB "keyframe" followed by small "P-frames": order + bytes intact.
            let frames: Vec<Vec<u8>> = (0..50u32)
                .map(|i| {
                    let n = if i == 0 { 200_000 } else { 1_000 + i as usize * 37 };
                    (0..n).map(|b| ((b as u32 * 31 + i) & 0xff) as u8).collect()
                })
                .collect();
            let send = frames.clone();
            std::thread::spawn(move || {
                for f in send {
                    assert!(send_binary(id, f));
                }
            })
            .join()
            .unwrap();
            for expect in &frames {
                match ws.next().await.unwrap().unwrap() {
                    WsMessage::Binary(got) => assert_eq!(&got, expect),
                    other => panic!("unexpected {other:?}"),
                }
            }
            // An unknown text message must be ignored, not kill the socket.
            ws.send(WsMessage::Text("{\"t\":\"nope\"}".into())).await.unwrap();
            ws.close(None).await.unwrap();
            for _ in 0..50 {
                if !is_connected(id) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(!is_connected(id), "closed socket must be unregistered");
            assert!(!send_binary(id, vec![1, 2, 3]), "frames for a gone client are refused");
        });
    }
}
