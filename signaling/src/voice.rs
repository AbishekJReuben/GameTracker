//! Voice relay (the `/voice` namespace): Claude Code narration from the PC to
//! the phone.
//!
//! Like `/clip`, a dumb end-to-end-encrypted store keyed by a space id the
//! clients derive from their secret: the server only ever holds ciphertext.
//! Unlike `/clip`, audio arrives over the socket and is forwarded to live
//! listeners in the same message, so the phone never has to fetch what it's
//! about to play. It's also written to disk so a phone that was offline can
//! fetch it later (`GET /voice/blob/<space>/<item>_<part>`).
//!
//! Messages (JSON text frames):
//!   pc    → `{"t":"hello","role":"pc","since":-1}`     ← current `head` if any
//!   phone → `{"t":"hello","role":"phone","since":rev}` ← items with rev > since
//!                                                        (newest 1500), `synced`, `head`
//!   pc    → `{"t":"add","item":{itemId,order,createdUtc,skip,parts,cipher}}`
//!   pc    → `{"t":"audio","itemId","part","durMs","data"}`  (data: base64 ciphertext)
//!   phone → `{"t":"head","order"}`   the last item it finished (forwarded to the pc)
//!   phone → `{"t":"want","itemId"}`  speak this one (a replay of something never voiced)
//!
//! History is kept for `KEEP_DAYS`.

use axum::extract::ws::{Message, WebSocket};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// One spoken part is at most ~20 s of 32 kb/s MP3; this leaves ample room.
pub const MAX_AUDIO_B64: usize = 4 * 1024 * 1024;
const KEEP_DAYS: i64 = 30;
/// Catch-up replays at most this many items (the phone shows recent history).
const REPLAY_MAX: i64 = 1500;

pub struct VoiceState {
    db: Mutex<rusqlite::Connection>,
    blob_dir: PathBuf,
    subs: Mutex<HashMap<String, HashMap<u64, (String, mpsc::UnboundedSender<Message>)>>>,
    next_peer: AtomicU64,
}

fn safe(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(120).collect()
}

impl VoiceState {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        let _ = std::fs::create_dir_all(data_dir);
        let conn = rusqlite::Connection::open(data_dir.join("voice.sqlite")).expect("open voice.sqlite");
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS items (
                space       TEXT NOT NULL,
                item_id     TEXT NOT NULL,
                rev         INTEGER NOT NULL,
                ord         INTEGER NOT NULL,
                created_utc TEXT NOT NULL,
                skip        INTEGER NOT NULL DEFAULT 0,
                parts       INTEGER NOT NULL DEFAULT 1,
                audio       TEXT NOT NULL DEFAULT '[]',
                cipher      TEXT,
                PRIMARY KEY (space, item_id)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS idx_voice_rev ON items(space, rev);
            CREATE TABLE IF NOT EXISTS heads (
                space TEXT PRIMARY KEY,
                ord   INTEGER NOT NULL
            );
            "#,
        )
        .expect("init voice schema");
        let state = Arc::new(Self {
            db: Mutex::new(conn),
            blob_dir: data_dir.join("voice-blobs"),
            subs: Mutex::new(HashMap::new()),
            next_peer: AtomicU64::new(1),
        });
        state.prune();
        state
    }

    fn next_rev(conn: &rusqlite::Connection) -> i64 {
        conn.query_row("SELECT COALESCE(MAX(rev), 0) + 1 FROM items", [], |r| r.get(0)).unwrap_or(1)
    }

    /// Drop history older than KEEP_DAYS (rows and their audio files).
    pub fn prune(&self) {
        let Ok(conn) = self.db.lock() else { return };
        let old: Vec<(String, String, i64)> = conn
            .prepare("SELECT space, item_id, parts FROM items WHERE created_utc < strftime('%Y-%m-%dT%H:%M:%fZ','now',?1)")
            .and_then(|mut st| {
                st.query_map([format!("-{KEEP_DAYS} days")], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect()
            })
            .unwrap_or_default();
        for (space, item, parts) in &old {
            for p in 0..*parts {
                let _ = std::fs::remove_file(self.blob_path(space, item, p as usize));
            }
        }
        let _ = conn.execute(
            "DELETE FROM items WHERE created_utc < strftime('%Y-%m-%dT%H:%M:%fZ','now',?1)",
            [format!("-{KEEP_DAYS} days")],
        );
    }

    fn blob_path(&self, space: &str, item: &str, part: usize) -> PathBuf {
        self.blob_dir.join(safe(space)).join(format!("{}_{part}.bin", safe(item)))
    }

    pub fn read_blob(&self, space: &str, name: &str) -> Option<Vec<u8>> {
        // name = "<item>_<part>"
        let (item, part) = name.rsplit_once('_')?;
        let part: usize = part.parse().ok()?;
        std::fs::read(self.blob_path(space, item, part)).ok()
    }

    fn row_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
        let audio: String = r.get(6)?;
        Ok(json!({
            "t": "item",
            "itemId": r.get::<_, String>(0)?,
            "rev": r.get::<_, i64>(1)?,
            "order": r.get::<_, i64>(2)?,
            "createdUtc": r.get::<_, String>(3)?,
            "skip": r.get::<_, i64>(4)? != 0,
            "parts": r.get::<_, i64>(5)?,
            "audio": serde_json::from_str::<Value>(&audio).unwrap_or(json!([])),
            "cipher": r.get::<_, Option<String>>(7)?,
        }))
    }

    fn select_item(conn: &rusqlite::Connection, space: &str, item: &str) -> Option<Value> {
        conn.query_row(
            "SELECT item_id, rev, ord, created_utc, skip, parts, audio, cipher FROM items WHERE space=?1 AND item_id=?2",
            rusqlite::params![space, item],
            Self::row_json,
        )
        .ok()
    }

    /// Insert or update item metadata (audio already recorded is kept).
    fn upsert(&self, space: &str, item: &Value) -> Option<Value> {
        let id = safe(item.get("itemId")?.as_str()?);
        if id.is_empty() {
            return None;
        }
        let conn = self.db.lock().ok()?;
        let rev = Self::next_rev(&conn);
        let parts = item.get("parts").and_then(Value::as_i64).unwrap_or(1).clamp(0, 500);
        conn.execute(
            "INSERT INTO items (space, item_id, rev, ord, created_utc, skip, parts, audio, cipher)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', ?8)
             ON CONFLICT(space, item_id) DO UPDATE SET
                rev=excluded.rev, ord=excluded.ord, skip=excluded.skip,
                parts=excluded.parts, cipher=excluded.cipher",
            rusqlite::params![
                space,
                id,
                rev,
                item.get("order").and_then(Value::as_i64).unwrap_or(0),
                item.get("createdUtc").and_then(Value::as_str).unwrap_or(""),
                item.get("skip").and_then(Value::as_bool).unwrap_or(false) as i64,
                parts,
                item.get("cipher").and_then(Value::as_str),
            ],
        )
        .ok()?;
        Self::select_item(&conn, space, &id)
    }

    /// Store one part's audio and note its duration on the item.
    fn add_audio(&self, space: &str, item: &str, part: usize, dur_ms: i64, data_b64: &str) -> Option<i64> {
        let item = safe(item);
        let bytes = b64_decode(data_b64)?;
        let path = self.blob_path(space, &item, part);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok()?;
        }
        std::fs::write(&path, &bytes).ok()?;
        let conn = self.db.lock().ok()?;
        let audio: String = conn
            .query_row(
                "SELECT audio FROM items WHERE space=?1 AND item_id=?2",
                rusqlite::params![space, item],
                |r| r.get(0),
            )
            .ok()?;
        let mut list: Vec<i64> = serde_json::from_str(&audio).unwrap_or_default();
        if list.len() <= part {
            list.resize(part + 1, 0);
        }
        list[part] = dur_ms.max(1);
        let rev = Self::next_rev(&conn);
        conn.execute(
            "UPDATE items SET audio=?3, rev=?4 WHERE space=?1 AND item_id=?2",
            rusqlite::params![space, item, serde_json::to_string(&list).ok()?, rev],
        )
        .ok()?;
        Some(rev)
    }

    fn items_since(&self, space: &str, since: i64) -> Vec<Value> {
        let Ok(conn) = self.db.lock() else { return Vec::new() };
        let mut rows: Vec<Value> = conn
            .prepare(
                "SELECT item_id, rev, ord, created_utc, skip, parts, audio, cipher FROM items
                 WHERE space=?1 AND rev>?2 ORDER BY rev DESC LIMIT ?3",
            )
            .and_then(|mut st| {
                st.query_map(rusqlite::params![space, since, REPLAY_MAX], Self::row_json)?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap_or_default();
        rows.reverse();
        rows
    }

    fn head(&self, space: &str) -> Option<i64> {
        let conn = self.db.lock().ok()?;
        conn.query_row("SELECT ord FROM heads WHERE space=?1", [space], |r| r.get(0)).ok()
    }

    fn set_head(&self, space: &str, ord: i64) {
        if let Ok(conn) = self.db.lock() {
            let _ = conn.execute(
                "INSERT INTO heads (space, ord) VALUES (?1, ?2) ON CONFLICT(space) DO UPDATE SET ord=excluded.ord",
                rusqlite::params![space, ord],
            );
        }
    }

    fn add_sub(&self, space: &str, peer: u64, role: &str, tx: mpsc::UnboundedSender<Message>) {
        self.subs.lock().unwrap().entry(space.to_string()).or_default().insert(peer, (role.to_string(), tx));
    }

    fn remove_sub(&self, space: &str, peer: u64) {
        let mut subs = self.subs.lock().unwrap();
        if let Some(peers) = subs.get_mut(space) {
            peers.remove(&peer);
            if peers.is_empty() {
                subs.remove(space);
            }
        }
    }

    /// Send to every other device of the space, optionally only to one role.
    fn broadcast(&self, space: &str, from: u64, role: Option<&str>, text: &str) {
        let subs = self.subs.lock().unwrap();
        if let Some(peers) = subs.get(space) {
            for (id, (r, tx)) in peers.iter() {
                if *id != from && role.map_or(true, |want| want == r) {
                    let _ = tx.send(Message::Text(text.to_string()));
                }
            }
        }
    }
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    // Small standard-alphabet decoder: keeps the relay free of extra crates.
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' => continue,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Drive one `/voice` WebSocket.
pub async fn handle(socket: WebSocket, space: String, role: String, state: Arc<VoiceState>) {
    use futures_util::{SinkExt, StreamExt};
    let space = safe(&space);
    let role = if role == "pc" { "pc".to_string() } else { "phone".to_string() };
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let peer = state.next_peer.fetch_add(1, Ordering::SeqCst);
    state.add_sub(&space, peer, &role, tx.clone());

    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        let Message::Text(txt) = msg else {
            if matches!(msg, Message::Close(_)) {
                break;
            }
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&txt) else { continue };
        match v.get("t").and_then(Value::as_str) {
            Some("hello") => {
                let since = v.get("since").and_then(Value::as_i64).unwrap_or(0);
                if since >= 0 {
                    let items = state.items_since(&space, since);
                    let max_rev = items.iter().filter_map(|i| i.get("rev").and_then(Value::as_i64)).max().unwrap_or(since);
                    for it in items {
                        let _ = tx.send(Message::Text(it.to_string()));
                    }
                    let _ = tx.send(Message::Text(json!({ "t": "synced", "rev": max_rev }).to_string()));
                }
                if let Some(h) = state.head(&space) {
                    let _ = tx.send(Message::Text(json!({ "t": "head", "order": h }).to_string()));
                }
            }
            Some("add") if role == "pc" => {
                if let Some(item) = v.get("item") {
                    if let Some(notice) = state.upsert(&space, item) {
                        state.broadcast(&space, peer, Some("phone"), &notice.to_string());
                    }
                }
            }
            Some("audio") if role == "pc" => {
                let item = v.get("itemId").and_then(Value::as_str).unwrap_or("");
                let part = v.get("part").and_then(Value::as_u64).unwrap_or(0) as usize;
                let dur = v.get("durMs").and_then(Value::as_i64).unwrap_or(0);
                let data = v.get("data").and_then(Value::as_str).unwrap_or("");
                if data.len() <= MAX_AUDIO_B64 {
                    if let Some(rev) = state.add_audio(&space, item, part, dur, data) {
                        let notice = json!({
                            "t": "audio", "itemId": safe(item), "part": part,
                            "durMs": dur, "rev": rev, "data": data,
                        });
                        state.broadcast(&space, peer, Some("phone"), &notice.to_string());
                    }
                }
            }
            Some("head") if role == "phone" => {
                if let Some(o) = v.get("order").and_then(Value::as_i64) {
                    state.set_head(&space, o);
                    state.broadcast(&space, peer, Some("pc"), &json!({ "t": "head", "order": o }).to_string());
                }
            }
            Some("want") if role == "phone" => {
                if let Some(id) = v.get("itemId").and_then(Value::as_str) {
                    state.broadcast(&space, peer, Some("pc"), &json!({ "t": "want", "itemId": safe(id) }).to_string());
                }
            }
            _ => {}
        }
    }

    state.remove_sub(&space, peer);
    send_task.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> Arc<VoiceState> {
        let dir = std::env::temp_dir().join(format!("gt-voice-relay-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        VoiceState::new(&dir)
    }

    #[test]
    fn item_then_audio_then_catch_up() {
        let s = temp("a");
        let it = json!({"itemId":"u1_0","order":40,"createdUtc":"2099-01-01T00:00:00.000Z","skip":false,"parts":2,"cipher":"Y2lwaGVy"});
        let n = s.upsert("sp", &it).unwrap();
        assert_eq!(n["audio"], json!([]));
        let rev = s.add_audio("sp", "u1_0", 1, 1234, "AAEC").unwrap();
        assert!(rev > n["rev"].as_i64().unwrap());
        assert_eq!(s.read_blob("sp", "u1_0_1").unwrap(), vec![0, 1, 2]);
        // Re-publishing metadata (e.g. condensed) keeps the recorded audio.
        let mut again = it.clone();
        again["skip"] = json!(true);
        let n2 = s.upsert("sp", &again).unwrap();
        assert_eq!(n2["audio"], json!([0, 1234]));
        assert_eq!(n2["skip"], json!(true));
        let replay = s.items_since("sp", 0);
        assert_eq!(replay.len(), 1);
        assert!(s.items_since("sp", n2["rev"].as_i64().unwrap()).is_empty());
        assert!(s.items_since("other", 0).is_empty());
    }

    #[test]
    fn head_is_remembered_and_old_history_pruned() {
        let s = temp("b");
        s.set_head("sp", 99);
        assert_eq!(s.head("sp"), Some(99));
        s.upsert("sp", &json!({"itemId":"old","order":1,"createdUtc":"2000-01-01T00:00:00.000Z","parts":1,"cipher":"x"}));
        s.add_audio("sp", "old", 0, 10, "AAAA");
        s.upsert("sp", &json!({"itemId":"new","order":2,"createdUtc":"2099-01-01T00:00:00.000Z","parts":1,"cipher":"x"}));
        s.prune();
        let ids: Vec<String> = s.items_since("sp", 0).iter().map(|v| v["itemId"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["new"]);
        assert!(s.read_blob("sp", "old_0").is_none());
    }

    #[test]
    fn paths_and_base64_are_safe() {
        assert_eq!(safe("../../etc"), "etc");
        assert_eq!(b64_decode("aGVsbG8=").unwrap(), b"hello");
        assert!(b64_decode("not*b64").is_none());
    }
}
