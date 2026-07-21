//! Shared-clipboard relay (the `/clip` namespace).
//!
//! A **dumb, end-to-end-encrypted store**: every device of one user shares a
//! `clipId` (a hash of their secret the client computes — the server never sees
//! the secret) and this server keeps their items forever until deleted. It only
//! ever holds **ciphertext** + small metadata; image blobs are files on disk,
//! served on demand. Text ciphertext is small so it rides inline in the metadata.
//!
//! Transport: one WebSocket per device at `/clip/ws?clip=<clipId>&device=<id>`.
//! On connect the client sends `{"t":"hello","since":<rev>}` and the server
//! streams every change with a higher `rev` (the monotonic cursor), then pushes
//! new changes live. Image ciphertext moves over HTTP (`/clip/blob/...`) so a big
//! paste never blocks the metadata channel, and old blobs are fetched only when
//! an item is actually opened.

use axum::extract::ws::{Message, WebSocket};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Max image-ciphertext blob accepted over PUT (~10 MB).
pub const MAX_BLOB: usize = 10 * 1024 * 1024;

pub struct ClipState {
    db: Mutex<rusqlite::Connection>,
    blob_dir: PathBuf,
    subs: Mutex<HashMap<String, HashMap<u64, mpsc::UnboundedSender<Message>>>>,
    next_peer: AtomicU64,
}

impl ClipState {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        let _ = std::fs::create_dir_all(data_dir);
        let db_path = data_dir.join("clip.sqlite");
        let conn = rusqlite::Connection::open(&db_path).expect("open clip.sqlite");
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS items (
                clip_id     TEXT NOT NULL,
                item_id     TEXT NOT NULL,
                rev         INTEGER NOT NULL,
                device_id   TEXT,
                device_name TEXT,
                kind        TEXT NOT NULL,
                mime        TEXT,
                size        INTEGER NOT NULL DEFAULT 0,
                created_utc TEXT,
                text_cipher TEXT,
                has_blob    INTEGER NOT NULL DEFAULT 0,
                deleted     INTEGER NOT NULL DEFAULT 0,
                pinned      INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (clip_id, item_id)
            );
            CREATE INDEX IF NOT EXISTS idx_items_rev ON items(clip_id, rev);
            "#,
        )
        .expect("init clip schema");
        // Additive migration: folder/list label for the notes rebrand. Ignore the
        // "duplicate column" error on an already-migrated store.
        let _ = conn.execute("ALTER TABLE items ADD COLUMN folder TEXT", []);
        Arc::new(Self {
            db: Mutex::new(conn),
            blob_dir: data_dir.join("clip-blobs"),
            subs: Mutex::new(HashMap::new()),
            next_peer: AtomicU64::new(1),
        })
    }

    /// Next monotonic revision (global across clips — it's just an opaque cursor).
    fn next_rev(conn: &rusqlite::Connection) -> i64 {
        conn.query_row("SELECT COALESCE(MAX(rev), 0) + 1 FROM items", [], |r| {
            r.get(0)
        })
        .unwrap_or(1)
    }

    /// Insert/replace an item; returns the JSON notice to broadcast.
    fn upsert(&self, clip_id: &str, item: &serde_json::Value) -> Option<serde_json::Value> {
        let item_id = item.get("itemId")?.as_str()?.to_string();
        let conn = self.db.lock().ok()?;
        let rev = Self::next_rev(&conn);
        let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("text");
        let mime = item.get("mime").and_then(|v| v.as_str());
        let size = item.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
        let created = item.get("createdUtc").and_then(|v| v.as_str());
        let device_id = item.get("deviceId").and_then(|v| v.as_str());
        let device_name = item.get("deviceName").and_then(|v| v.as_str());
        let text_cipher = item.get("textCipher").and_then(|v| v.as_str());
        let has_blob = item
            .get("hasBlob")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let pinned = item
            .get("pinned")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let folder = item.get("folder").and_then(|v| v.as_str());
        // NOTE: created_utc is NOT updated on conflict — an edit (re-add with the
        // same itemId) keeps the item's original position in time.
        conn.execute(
            "INSERT INTO items
                (clip_id, item_id, rev, device_id, device_name, kind, mime, size,
                 created_utc, text_cipher, has_blob, deleted, pinned, folder)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,?12,?13)
             ON CONFLICT(clip_id, item_id) DO UPDATE SET
                rev=excluded.rev, text_cipher=excluded.text_cipher,
                has_blob=excluded.has_blob, pinned=excluded.pinned, size=excluded.size,
                mime=excluded.mime, folder=excluded.folder, deleted=0",
            rusqlite::params![
                clip_id,
                item_id,
                rev,
                device_id,
                device_name,
                kind,
                mime,
                size,
                created,
                text_cipher,
                has_blob as i64,
                pinned as i64,
                folder
            ],
        )
        .ok()?;
        // Preserve the ORIGINAL created_utc in the broadcast (an edit's payload may
        // carry a slightly different one; the row is authoritative).
        let created_row: Option<String> = conn
            .query_row(
                "SELECT created_utc FROM items WHERE clip_id=?1 AND item_id=?2",
                rusqlite::params![clip_id, item_id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        Some(row_notice(
            rev,
            &item_id,
            device_id,
            device_name,
            kind,
            mime,
            size,
            created_row.as_deref().or(created),
            text_cipher,
            has_blob,
            false,
            pinned,
            folder,
        ))
    }

    fn set_deleted(&self, clip_id: &str, item_id: &str) -> Option<serde_json::Value> {
        let conn = self.db.lock().ok()?;
        let rev = Self::next_rev(&conn);
        let changed = conn
            .execute(
                "UPDATE items SET deleted=1, rev=?3, text_cipher=NULL, has_blob=0
                 WHERE clip_id=?1 AND item_id=?2",
                rusqlite::params![clip_id, item_id, rev],
            )
            .ok()?;
        // Best-effort blob removal.
        let _ = std::fs::remove_file(self.blob_path(clip_id, item_id));
        if changed == 0 {
            return None;
        }
        Some(json!({ "t":"item", "rev":rev, "itemId":item_id, "deleted":true }))
    }

    fn set_pinned(&self, clip_id: &str, item_id: &str, pinned: bool) -> Option<serde_json::Value> {
        let conn = self.db.lock().ok()?;
        let rev = Self::next_rev(&conn);
        let changed = conn
            .execute(
                "UPDATE items SET pinned=?3, rev=?4 WHERE clip_id=?1 AND item_id=?2",
                rusqlite::params![clip_id, item_id, pinned as i64, rev],
            )
            .ok()?;
        if changed == 0 {
            return None;
        }
        Some(json!({ "t":"item", "rev":rev, "itemId":item_id, "pinned":pinned }))
    }

    /// Move an item to a folder (or clear it with an empty string). Bare metadata
    /// update, like `set_pinned` — no content fields ride along.
    fn set_folder(&self, clip_id: &str, item_id: &str, folder: &str) -> Option<serde_json::Value> {
        let conn = self.db.lock().ok()?;
        let rev = Self::next_rev(&conn);
        let changed = conn
            .execute(
                "UPDATE items SET folder=?3, rev=?4 WHERE clip_id=?1 AND item_id=?2",
                rusqlite::params![clip_id, item_id, folder, rev],
            )
            .ok()?;
        if changed == 0 {
            return None;
        }
        Some(json!({ "t":"item", "rev":rev, "itemId":item_id, "folder":folder }))
    }

    /// Every change with `rev > since`, oldest first (the catch-up burst).
    fn items_since(&self, clip_id: &str, since: i64) -> Vec<serde_json::Value> {
        let Ok(conn) = self.db.lock() else {
            return Vec::new();
        };
        let Ok(mut stmt) = conn.prepare(
            "SELECT rev, item_id, device_id, device_name, kind, mime, size, created_utc,
                    text_cipher, has_blob, deleted, pinned, folder
             FROM items WHERE clip_id=?1 AND rev>?2 ORDER BY rev ASC",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(rusqlite::params![clip_id, since], |r| {
            Ok(row_notice(
                r.get(0)?,
                &r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?.as_deref(),
                r.get::<_, Option<String>>(3)?.as_deref(),
                &r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?.as_deref(),
                r.get(6)?,
                r.get::<_, Option<String>>(7)?.as_deref(),
                r.get::<_, Option<String>>(8)?.as_deref(),
                r.get::<_, i64>(9)? != 0,
                r.get::<_, i64>(10)? != 0,
                r.get::<_, i64>(11)? != 0,
                r.get::<_, Option<String>>(12)?.as_deref(),
            ))
        });
        match rows {
            Ok(mapped) => mapped.filter_map(|x| x.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn blob_path(&self, clip_id: &str, item_id: &str) -> PathBuf {
        // clip_id + item_id are client-controlled — keep them to safe path atoms.
        let safe = |s: &str| {
            s.chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect::<String>()
        };
        self.blob_dir
            .join(safe(clip_id))
            .join(format!("{}.bin", safe(item_id)))
    }

    pub fn write_blob(&self, clip_id: &str, item_id: &str, bytes: &[u8]) -> std::io::Result<()> {
        let path = self.blob_path(clip_id, item_id);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(path, bytes)?;
        // Mark the item as having a blob (if the metadata already arrived).
        if let Ok(conn) = self.db.lock() {
            let _ = conn.execute(
                "UPDATE items SET has_blob=1 WHERE clip_id=?1 AND item_id=?2",
                rusqlite::params![clip_id, item_id],
            );
        }
        Ok(())
    }

    pub fn read_blob(&self, clip_id: &str, item_id: &str) -> Option<Vec<u8>> {
        std::fs::read(self.blob_path(clip_id, item_id)).ok()
    }

    fn add_sub(&self, clip_id: &str, peer: u64, tx: mpsc::UnboundedSender<Message>) {
        self.subs
            .lock()
            .unwrap()
            .entry(clip_id.to_string())
            .or_default()
            .insert(peer, tx);
    }

    fn remove_sub(&self, clip_id: &str, peer: u64) {
        let mut subs = self.subs.lock().unwrap();
        if let Some(peers) = subs.get_mut(clip_id) {
            peers.remove(&peer);
            if peers.is_empty() {
                subs.remove(clip_id);
            }
        }
    }

    /// Push a notice to every device of a clip except the originator.
    fn broadcast(&self, clip_id: &str, from: u64, notice: &serde_json::Value) {
        let text = notice.to_string();
        let subs = self.subs.lock().unwrap();
        if let Some(peers) = subs.get(clip_id) {
            for (id, tx) in peers.iter() {
                if *id != from {
                    let _ = tx.send(Message::Text(text.clone()));
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn row_notice(
    rev: i64,
    item_id: &str,
    device_id: Option<&str>,
    device_name: Option<&str>,
    kind: &str,
    mime: Option<&str>,
    size: i64,
    created: Option<&str>,
    text_cipher: Option<&str>,
    has_blob: bool,
    deleted: bool,
    pinned: bool,
    folder: Option<&str>,
) -> serde_json::Value {
    json!({
        "t": "item",
        "rev": rev,
        "itemId": item_id,
        "deviceId": device_id,
        "deviceName": device_name,
        "kind": kind,
        "mime": mime,
        "size": size,
        "createdUtc": created,
        "textCipher": text_cipher,
        "hasBlob": has_blob,
        "deleted": deleted,
        "pinned": pinned,
        "folder": folder,
    })
}

/// Drive one `/clip` WebSocket connection.
pub async fn handle(socket: WebSocket, clip_id: String, state: Arc<ClipState>) {
    use futures_util::{SinkExt, StreamExt};
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let peer = state.next_peer.fetch_add(1, Ordering::SeqCst);
    state.add_sub(&clip_id, peer, tx.clone());

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
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
            continue;
        };
        match v.get("t").and_then(|t| t.as_str()) {
            Some("hello") => {
                let since = v.get("since").and_then(|s| s.as_i64()).unwrap_or(0);
                let items = state.items_since(&clip_id, since);
                let mut max_rev = since;
                for it in &items {
                    if let Some(r) = it.get("rev").and_then(|r| r.as_i64()) {
                        max_rev = max_rev.max(r);
                    }
                    let _ = tx.send(Message::Text(it.to_string()));
                }
                let _ = tx.send(Message::Text(
                    json!({ "t":"synced", "rev":max_rev }).to_string(),
                ));
            }
            Some("add") => {
                if let Some(item) = v.get("item") {
                    if let Some(notice) = state.upsert(&clip_id, item) {
                        state.broadcast(&clip_id, peer, &notice);
                    }
                }
            }
            Some("delete") => {
                if let Some(id) = v.get("itemId").and_then(|s| s.as_str()) {
                    if let Some(notice) = state.set_deleted(&clip_id, id) {
                        state.broadcast(&clip_id, peer, &notice);
                    }
                }
            }
            Some("pin") => {
                if let (Some(id), Some(p)) = (
                    v.get("itemId").and_then(|s| s.as_str()),
                    v.get("pinned").and_then(|s| s.as_bool()),
                ) {
                    if let Some(notice) = state.set_pinned(&clip_id, id, p) {
                        state.broadcast(&clip_id, peer, &notice);
                    }
                }
            }
            Some("folder") => {
                if let (Some(id), Some(f)) = (
                    v.get("itemId").and_then(|s| s.as_str()),
                    v.get("folder").and_then(|s| s.as_str()),
                ) {
                    if let Some(notice) = state.set_folder(&clip_id, id, f) {
                        state.broadcast(&clip_id, peer, &notice);
                    }
                }
            }
            _ => {} // ping / unknown → ignore
        }
    }

    state.remove_sub(&clip_id, peer);
    send_task.abort();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_state(tag: &str) -> Arc<ClipState> {
        let dir = std::env::temp_dir().join(format!(
            "gt-clip-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        ClipState::new(&dir)
    }

    fn text_item(id: &str, device: &str) -> serde_json::Value {
        json!({
            "itemId": id,
            "deviceId": device,
            "deviceName": "Test",
            "kind": "text",
            "mime": "text/plain",
            "size": 5,
            "createdUtc": "2026-07-20T00:00:00.000Z",
            "pinned": false,
            "textCipher": "AAAA",
            "hasBlob": false,
        })
    }

    #[test]
    fn upsert_assigns_monotonic_revs_and_replays_since() {
        let s = temp_state("upsert");
        let n1 = s.upsert("clip1", &text_item("a", "dev1")).unwrap();
        let n2 = s.upsert("clip1", &text_item("b", "dev2")).unwrap();
        let r1 = n1.get("rev").unwrap().as_i64().unwrap();
        let r2 = n2.get("rev").unwrap().as_i64().unwrap();
        assert!(r2 > r1, "revs must be monotonic");

        // hello since=0 replays both, oldest first.
        let all = s.items_since("clip1", 0);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].get("itemId").unwrap().as_str().unwrap(), "a");
        // since=r1 replays only the newer one.
        let newer = s.items_since("clip1", r1);
        assert_eq!(newer.len(), 1);
        assert_eq!(newer[0].get("itemId").unwrap().as_str().unwrap(), "b");
        // Other clip spaces see nothing.
        assert!(s.items_since("other", 0).is_empty());
    }

    #[test]
    fn re_upsert_same_item_bumps_rev_not_count() {
        let s = temp_state("reupsert");
        let n1 = s.upsert("c", &text_item("a", "d")).unwrap();
        let n2 = s.upsert("c", &text_item("a", "d")).unwrap();
        assert!(n2.get("rev").unwrap().as_i64() > n1.get("rev").unwrap().as_i64());
        assert_eq!(s.items_since("c", 0).len(), 1);
    }

    #[test]
    fn delete_marks_and_clears_cipher() {
        let s = temp_state("delete");
        s.upsert("c", &text_item("a", "d")).unwrap();
        let n = s.set_deleted("c", "a").unwrap();
        assert!(n.get("deleted").unwrap().as_bool().unwrap());
        let replay = s.items_since("c", 0);
        assert_eq!(replay.len(), 1);
        assert!(replay[0].get("deleted").unwrap().as_bool().unwrap());
        assert!(replay[0].get("textCipher").unwrap().is_null());
        // Deleting a nonexistent item is a no-op (no broadcast).
        assert!(s.set_deleted("c", "nope").is_none());
    }

    #[test]
    fn pin_roundtrip() {
        let s = temp_state("pin");
        s.upsert("c", &text_item("a", "d")).unwrap();
        let n = s.set_pinned("c", "a", true).unwrap();
        assert!(n.get("pinned").unwrap().as_bool().unwrap());
        let replay = s.items_since("c", 0);
        assert!(replay[0].get("pinned").unwrap().as_bool().unwrap());
        assert!(s.set_pinned("c", "nope", true).is_none());
    }

    #[test]
    fn folder_roundtrip_and_edit_keeps_created() {
        let s = temp_state("folder");
        s.upsert("c", &text_item("a", "d")).unwrap();
        // Bare folder move.
        let n = s.set_folder("c", "a", "work").unwrap();
        assert_eq!(n.get("folder").unwrap().as_str().unwrap(), "work");
        let replay = s.items_since("c", 0);
        assert_eq!(replay[0].get("folder").unwrap().as_str().unwrap(), "work");
        // An edit (re-add, same id, different createdUtc + folder in payload)
        // keeps the ORIGINAL created_utc but applies the new folder.
        let mut edited = text_item("a", "d");
        edited["textCipher"] = json!("BBBB");
        edited["createdUtc"] = json!("2030-01-01T00:00:00.000Z");
        edited["folder"] = json!("notes");
        let n2 = s.upsert("c", &edited).unwrap();
        assert_eq!(
            n2.get("createdUtc").unwrap().as_str().unwrap(),
            "2026-07-20T00:00:00.000Z"
        );
        assert_eq!(n2.get("folder").unwrap().as_str().unwrap(), "notes");
        assert_eq!(n2.get("textCipher").unwrap().as_str().unwrap(), "BBBB");
        assert!(s.set_folder("c", "nope", "x").is_none());
    }

    #[test]
    fn blob_write_read_and_path_sanitizing() {
        let s = temp_state("blob");
        s.write_blob("clipA", "item1", b"cipherbytes").unwrap();
        assert_eq!(s.read_blob("clipA", "item1").unwrap(), b"cipherbytes");
        assert!(s.read_blob("clipA", "missing").is_none());
        // Path traversal characters are stripped, not honored.
        s.write_blob("../evil", "..\\item", b"x").unwrap();
        assert!(s.read_blob("evil", "item").is_some());
    }
}
