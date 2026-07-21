//! Shared-clipboard local store.
//!
//! The desktop keeps a permanent local history of clipboard items (text + image
//! metadata). Image bytes + thumbnails live as files under `media_dir/clipboard/`
//! (written by `crate::clipboard`); this table stores only paths + metadata, so
//! listing/paging never loads blobs into memory. Rows are soft-deleted
//! (tombstoned) so a delete can propagate to other devices via the relay.

use crate::db::DbPool;
use crate::error::AppResult;
use rusqlite::Row;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    pub id: String,
    /// "text" | "image"
    pub kind: String,
    pub text: Option<String>,
    /// Absolute path to the full image file (webview reads via assetUrl).
    pub image_path: Option<String>,
    pub thumb_path: Option<String>,
    pub mime: Option<String>,
    pub size: i64,
    pub created_utc: String,
    pub device_id: String,
    pub device_name: Option<String>,
    /// "desktop" | "android" | "manual" | "share"
    pub source: String,
    pub pinned: bool,
    /// Folder/list label for the notes view ("" = unfiled).
    #[serde(default)]
    pub folder: String,
    /// Stable fingerprint of the content (text/image bytes) for dedup. Not shown.
    #[serde(default)]
    pub content_hash: Option<String>,
    /// Every UTC timestamp this exact content was copied/added (dedup history).
    /// The app screens show all of these; a single-entry list is the normal case.
    #[serde(default)]
    pub copies: Vec<String>,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub synced: bool,
}

/// Everything needed to insert an item. A local capture leaves `id`/`device_id`
/// unset (assigned by the caller); an applied remote item carries them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipInput {
    pub id: String,
    pub kind: String,
    pub text: Option<String>,
    pub image_path: Option<String>,
    pub thumb_path: Option<String>,
    pub mime: Option<String>,
    pub size: i64,
    pub created_utc: String,
    pub device_id: String,
    pub device_name: Option<String>,
    pub source: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub content_hash: Option<String>,
    #[serde(default)]
    pub copies: Vec<String>,
    #[serde(default)]
    pub synced: bool,
}

/// Stable content fingerprint (hex), namespaced by kind so a text item and an
/// image that hash-collide never dedupe each other. Callers pass the raw content
/// bytes (text bytes / image file bytes).
pub fn content_hash(kind: &str, bytes: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    kind.hash(&mut h);
    bytes.hash(&mut h);
    format!("{}:{:016x}", kind, h.finish())
}

/// Parse the stored `copies` JSON array; a NULL/blank/garbage column → empty vec.
fn parse_copies(raw: Option<String>) -> Vec<String> {
    raw.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

/// Serialize a copies list to the JSON stored in the column.
fn copies_json(copies: &[String]) -> String {
    serde_json::to_string(copies).unwrap_or_else(|_| "[]".into())
}

fn from_row(r: &Row) -> rusqlite::Result<ClipItem> {
    Ok(ClipItem {
        id: r.get("id")?,
        kind: r.get("kind")?,
        text: r.get("text")?,
        image_path: r.get("image_path")?,
        thumb_path: r.get("thumb_path")?,
        mime: r.get("mime")?,
        size: r.get("size")?,
        created_utc: r.get("created_utc")?,
        device_id: r.get("device_id")?,
        device_name: r.get("device_name")?,
        source: r.get("source")?,
        pinned: r.get::<_, i64>("pinned")? != 0,
        folder: r.get::<_, Option<String>>("folder")?.unwrap_or_default(),
        content_hash: r.get::<_, Option<String>>("content_hash")?,
        copies: parse_copies(r.get::<_, Option<String>>("copies")?),
        deleted: r.get::<_, i64>("deleted")? != 0,
        synced: r.get::<_, i64>("synced")? != 0,
    })
}

const COLS: &str = "id, kind, text, image_path, thumb_path, mime, size, created_utc, \
                    device_id, device_name, source, pinned, folder, content_hash, copies, \
                    deleted, synced";

/// Item lists never surface folder entities (kind='folder' rows are the synced
/// empty-folder registry, not notes).
const NOT_FOLDER: &str = "kind != 'folder'";

/// Insert (or replace, idempotent by id) an item. Used for both local captures
/// and applied remote items — `id` is the dedupe key so a re-delivered remote
/// item can't duplicate.
pub fn upsert(pool: &DbPool, i: &ClipInput) -> AppResult<()> {
    let conn = pool.get()?;
    // A single-entry copies list is the default when a caller doesn't track one
    // (e.g. an applied remote item that predates the feature) — seed it with the
    // item's created_utc so the app screens always have at least one date.
    let copies = if i.copies.is_empty() {
        vec![i.created_utc.clone()]
    } else {
        i.copies.clone()
    };
    // created_utc + copies ARE updated on conflict now: an edit or a dedup re-add
    // carries a fresh timestamp and must jump the item to the top on every device.
    // `deleted` resets to 0 so a re-add revives a tombstone (matches the relay).
    conn.execute(
        "INSERT INTO clipboard_items
            (id, kind, text, image_path, thumb_path, mime, size, created_utc,
             device_id, device_name, source, pinned, folder, content_hash, copies,
             deleted, synced)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?14,?15,?16,0,?13)
         ON CONFLICT(id) DO UPDATE SET
            text=excluded.text, image_path=excluded.image_path,
            thumb_path=excluded.thumb_path, mime=excluded.mime, size=excluded.size,
            pinned=excluded.pinned, folder=excluded.folder,
            content_hash=excluded.content_hash, copies=excluded.copies,
            created_utc=excluded.created_utc, deleted=0, synced=excluded.synced",
        rusqlite::params![
            i.id,
            i.kind,
            i.text,
            i.image_path,
            i.thumb_path,
            i.mime,
            i.size,
            i.created_utc,
            i.device_id,
            i.device_name,
            i.source,
            i.pinned as i64,
            i.synced as i64,
            i.folder,
            i.content_hash,
            copies_json(&copies),
        ],
    )?;
    Ok(())
}

/// Find a live (non-deleted) note whose content matches `hash`, newest first.
/// Used to dedupe a re-copy of identical content into the existing item instead
/// of a new row. Folder entities are excluded.
pub fn find_by_hash(pool: &DbPool, hash: &str) -> AppResult<Option<ClipItem>> {
    let conn = pool.get()?;
    let item = conn
        .query_row(
            &format!(
                "SELECT {COLS} FROM clipboard_items
                 WHERE deleted = 0 AND content_hash = ?1 AND {NOT_FOLDER}
                 ORDER BY created_utc DESC LIMIT 1"
            ),
            [hash],
            from_row,
        )
        .ok();
    Ok(item)
}

/// Bump an existing item to the top (new created_utc) and append `stamp` to its
/// copy history, marking it unsynced so the sync engine re-uploads it. Returns
/// the refreshed row for the caller to emit.
pub fn bump_to_top(pool: &DbPool, id: &str, stamp: &str) -> AppResult<Option<ClipItem>> {
    let Some(mut item) = get(pool, id)? else {
        return Ok(None);
    };
    item.copies.push(stamp.to_string());
    // Keep the history bounded + chronological; dedupe exact-equal stamps.
    item.copies.sort();
    item.copies.dedup();
    if item.copies.len() > 200 {
        let start = item.copies.len() - 200;
        item.copies.drain(0..start);
    }
    let conn = pool.get()?;
    conn.execute(
        "UPDATE clipboard_items
         SET created_utc = ?2, copies = ?3, synced = 0
         WHERE id = ?1",
        rusqlite::params![id, stamp, copies_json(&item.copies)],
    )?;
    get(pool, id)
}

/// Edit a text item in place (notes). Bumps it to the top (fresh `now`) and
/// refreshes its content hash so future dedup matches the new text. Marks it
/// unsynced so the JS sync engine re-uploads it (same id → the relay upserts +
/// rebroadcasts to other devices, jumping it to the top there too).
pub fn update_text(pool: &DbPool, id: &str, text: &str, now: &str) -> AppResult<bool> {
    let conn = pool.get()?;
    let hash = content_hash("text", text.as_bytes());
    let changed = conn.execute(
        "UPDATE clipboard_items
         SET text = ?2, size = ?3, created_utc = ?4, content_hash = ?5, synced = 0
         WHERE id = ?1 AND deleted = 0 AND kind = 'text'",
        rusqlite::params![id, text, text.len() as i64, now, hash],
    )?;
    Ok(changed > 0)
}

/// Move an item to a folder ('' = unfiled).
pub fn set_folder(pool: &DbPool, id: &str, folder: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE clipboard_items SET folder = ?2 WHERE id = ?1",
        rusqlite::params![id, folder],
    )?;
    Ok(())
}

/// Every folder name to show as a chip: the union of (a) folders that live items
/// are filed under and (b) folder entities (empty folders created + synced as
/// kind='folder' rows). Both carry the name in the `folder` column, so this is a
/// single DISTINCT. Alphabetical.
pub fn list_folders(pool: &DbPool) -> AppResult<Vec<String>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT DISTINCT folder FROM clipboard_items
         WHERE deleted = 0 AND folder IS NOT NULL AND folder != ''
         ORDER BY folder COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Create (or revive) a folder entity by name — a `kind='folder'` row carrying the
/// name in its `folder` column (the same plaintext carrier the wire uses).
/// Idempotent by name (case-insensitive) so two devices converge. The row is
/// unsynced so the sync engine uploads it as a `kind='folder'` item.
pub fn create_folder(
    pool: &DbPool,
    name: &str,
    device_id: &str,
    device_name: Option<&str>,
    now: &str,
) -> AppResult<ClipItem> {
    let name = name.trim();
    let existing: Option<String> = {
        let conn = pool.get()?;
        conn.query_row(
            "SELECT id FROM clipboard_items
             WHERE deleted = 0 AND kind = 'folder' AND folder = ?1 COLLATE NOCASE
             LIMIT 1",
            [name],
            |r| r.get(0),
        )
        .ok()
    };
    let id = existing.unwrap_or_else(|| format!("folder-{}", uuid::Uuid::new_v4()));
    let item = ClipInput {
        id: id.clone(),
        kind: "folder".into(),
        text: None,
        image_path: None,
        thumb_path: None,
        mime: None,
        size: 0,
        created_utc: now.to_string(),
        device_id: device_id.to_string(),
        device_name: device_name.map(|s| s.to_string()),
        source: "folder".into(),
        pinned: false,
        folder: name.to_string(),
        content_hash: None,
        copies: Vec::new(),
        synced: false,
    };
    upsert(pool, &item)?;
    get(pool, &id)?.ok_or_else(|| crate::error::AppError::msg("folder vanished after insert"))
}

/// Apply a remote folder entity (kind='folder' notice) into the local store,
/// keeping its id/timestamp so it converges. `deleted` tombstones it.
pub fn apply_folder_entity(
    pool: &DbPool,
    id: &str,
    name: &str,
    created_utc: &str,
    device_id: Option<&str>,
    device_name: Option<&str>,
    deleted: bool,
) -> AppResult<()> {
    if deleted {
        let conn = pool.get()?;
        conn.execute(
            "UPDATE clipboard_items SET deleted = 1 WHERE id = ?1",
            [id],
        )?;
        return Ok(());
    }
    let item = ClipInput {
        id: id.to_string(),
        kind: "folder".into(),
        text: None,
        image_path: None,
        thumb_path: None,
        mime: None,
        size: 0,
        created_utc: created_utc.to_string(),
        device_id: device_id.unwrap_or("").to_string(),
        device_name: device_name.map(|s| s.to_string()),
        source: "folder".into(),
        pinned: false,
        folder: name.to_string(),
        content_hash: None,
        copies: Vec::new(),
        synced: true, // already on the relay
    };
    upsert(pool, &item)
}

/// Live folder entities (for the sync engine's initial upload backlog).
pub fn list_folder_entities(pool: &DbPool) -> AppResult<Vec<ClipItem>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM clipboard_items
         WHERE deleted = 0 AND kind = 'folder'
         ORDER BY created_utc ASC"
    ))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Tombstone the folder entity for `name` (case-insensitive). Returns the entity
/// ids that were tombstoned so the caller can propagate the deletes. Member items
/// are NOT deleted here — the caller unfiles them separately.
pub fn tombstone_folder(pool: &DbPool, name: &str) -> AppResult<Vec<String>> {
    let conn = pool.get()?;
    let ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM clipboard_items
             WHERE deleted = 0 AND kind = 'folder' AND folder = ?1 COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([name], |r| r.get::<_, String>(0))?;
        rows.filter_map(Result::ok).collect()
    };
    conn.execute(
        "UPDATE clipboard_items SET deleted = 1
         WHERE kind = 'folder' AND folder = ?1 COLLATE NOCASE",
        [name],
    )?;
    Ok(ids)
}

/// Ids of live items filed under `folder` (case-insensitive) — so a folder delete
/// can unfile (and propagate) each member.
pub fn ids_in_folder(pool: &DbPool, folder: &str) -> AppResult<Vec<String>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id FROM clipboard_items
         WHERE deleted = 0 AND kind != 'folder' AND folder = ?1 COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([folder], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn get(pool: &DbPool, id: &str) -> AppResult<Option<ClipItem>> {
    let conn = pool.get()?;
    let item = conn
        .query_row(
            &format!("SELECT {COLS} FROM clipboard_items WHERE id = ?1"),
            [id],
            from_row,
        )
        .ok();
    Ok(item)
}

/// Keyset page of non-deleted items, newest first. `before_utc` is the exclusive
/// upper bound (the `created_utc` of the last row already shown) — pass `None`
/// for the first page. Never loads image blobs (paths only).
pub fn list(pool: &DbPool, before_utc: Option<&str>, limit: i64) -> AppResult<Vec<ClipItem>> {
    let conn = pool.get()?;
    let limit = limit.clamp(1, 500);
    let mut out = Vec::new();
    match before_utc {
        Some(before) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {COLS} FROM clipboard_items
                 WHERE deleted = 0 AND {NOT_FOLDER} AND created_utc < ?1
                 ORDER BY created_utc DESC LIMIT ?2"
            ))?;
            let rows = stmt.query_map(rusqlite::params![before, limit], from_row)?;
            for row in rows {
                out.push(row?);
            }
        }
        None => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {COLS} FROM clipboard_items
                 WHERE deleted = 0 AND {NOT_FOLDER}
                 ORDER BY created_utc DESC LIMIT ?1"
            ))?;
            let rows = stmt.query_map([limit], from_row)?;
            for row in rows {
                out.push(row?);
            }
        }
    }
    Ok(out)
}

/// All pinned items (usually few) so the UI can float them to the top regardless
/// of how far the main list has paged.
pub fn list_pinned(pool: &DbPool) -> AppResult<Vec<ClipItem>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM clipboard_items
         WHERE deleted = 0 AND pinned = 1 AND {NOT_FOLDER}
         ORDER BY created_utc DESC"
    ))?;
    let rows = stmt.query_map([], from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Items captured locally that the relay hasn't acknowledged yet, oldest first,
/// so the JS sync client can flush its backlog after a reconnect.
pub fn list_unsynced(pool: &DbPool, limit: i64) -> AppResult<Vec<ClipItem>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM clipboard_items
         WHERE synced = 0 AND deleted = 0
         ORDER BY created_utc ASC LIMIT ?1"
    ))?;
    let rows = stmt.query_map([limit.clamp(1, 500)], from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// One-time retroactive dedup: backfill `content_hash` for every live note and
/// merge pre-existing duplicates (same content) into a single item, unioning all
/// their copy timestamps and tombstoning the extras. Returns
/// `(survivors, loser_ids)` — survivors to re-emit so their merged history syncs,
/// loser ids to propagate as deletes. Idempotent: a second run finds nothing to
/// merge (hashes are already set and duplicates already collapsed).
pub fn dedupe_existing(pool: &DbPool) -> AppResult<(Vec<ClipItem>, Vec<String>)> {
    use std::collections::HashMap;
    // Snapshot every live note (folder entities excluded).
    let items: Vec<ClipItem> = {
        let conn = pool.get()?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLS} FROM clipboard_items
             WHERE deleted = 0 AND {NOT_FOLDER}
             ORDER BY created_utc ASC"
        ))?;
        let rows = stmt.query_map([], from_row)?;
        rows.filter_map(Result::ok).collect()
    };

    // Compute/backfill each item's content hash. Images that have lost their file
    // are left without a hash (never merged blindly).
    let mut hash_of: HashMap<String, String> = HashMap::new();
    for it in &items {
        let hash = match it.kind.as_str() {
            "text" => Some(content_hash("text", it.text.clone().unwrap_or_default().as_bytes())),
            "image" => it
                .image_path
                .as_ref()
                .and_then(|p| std::fs::read(p).ok())
                .map(|bytes| content_hash("image", &bytes)),
            _ => None,
        };
        if let Some(h) = hash {
            // Persist the backfilled hash so future captures dedup against it.
            if it.content_hash.as_deref() != Some(h.as_str()) {
                let conn = pool.get()?;
                let _ = conn.execute(
                    "UPDATE clipboard_items SET content_hash = ?2 WHERE id = ?1",
                    rusqlite::params![it.id, h],
                );
            }
            hash_of.insert(it.id.clone(), h);
        }
    }

    // Group by hash; a group of >1 is a set of duplicates to collapse.
    let mut groups: HashMap<String, Vec<&ClipItem>> = HashMap::new();
    for it in &items {
        if let Some(h) = hash_of.get(&it.id) {
            groups.entry(h.clone()).or_default().push(it);
        }
    }

    let mut survivors = Vec::new();
    let mut losers = Vec::new();
    for (_h, group) in groups {
        if group.len() < 2 {
            continue;
        }
        // Survivor = newest (last, since we ordered ASC). Union every member's
        // copy history + its own created_utc into the survivor's copies.
        let survivor = *group.last().unwrap();
        let mut copies: Vec<String> = Vec::new();
        for m in &group {
            copies.extend(m.copies.iter().cloned());
            copies.push(m.created_utc.clone());
        }
        copies.sort();
        copies.dedup();
        if copies.len() > 200 {
            let start = copies.len() - 200;
            copies.drain(0..start);
        }
        // Preserve a pin if any member was pinned.
        let pinned = group.iter().any(|m| m.pinned);
        {
            let conn = pool.get()?;
            conn.execute(
                "UPDATE clipboard_items SET copies = ?2, pinned = ?3, synced = 0 WHERE id = ?1",
                rusqlite::params![survivor.id, copies_json(&copies), pinned as i64],
            )?;
        }
        for m in &group {
            if m.id == survivor.id {
                continue;
            }
            let (img, thumb) = tombstone(pool, &m.id)?;
            crate::clipboard::remove_files([img, thumb]);
            losers.push(m.id.clone());
        }
        if let Some(row) = get(pool, &survivor.id)? {
            survivors.push(row);
        }
    }
    Ok((survivors, losers))
}

pub fn mark_synced(pool: &DbPool, id: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute("UPDATE clipboard_items SET synced = 1 WHERE id = ?1", [id])?;
    Ok(())
}

pub fn set_pinned(pool: &DbPool, id: &str, pinned: bool) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE clipboard_items SET pinned = ?2 WHERE id = ?1",
        rusqlite::params![id, pinned as i64],
    )?;
    Ok(())
}

/// Soft-delete (tombstone) so the delete can propagate. Returns the stored file
/// paths, if any, so the caller can remove the blobs from disk.
pub fn tombstone(pool: &DbPool, id: &str) -> AppResult<(Option<String>, Option<String>)> {
    let conn = pool.get()?;
    let paths: (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT image_path, thumb_path FROM clipboard_items WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((None, None));
    conn.execute(
        "UPDATE clipboard_items SET deleted = 1, image_path = NULL, thumb_path = NULL,
             text = NULL WHERE id = ?1",
        [id],
    )?;
    Ok(paths)
}

/// The most recent non-deleted item's text (for deduping consecutive identical
/// copies in the native watcher).
pub fn latest_text(pool: &DbPool) -> AppResult<Option<String>> {
    let conn = pool.get()?;
    let v: Option<String> = conn
        .query_row(
            "SELECT text FROM clipboard_items
             WHERE deleted = 0 AND kind = 'text'
             ORDER BY created_utc DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    Ok(v)
}

/// Delete every item permanently (clear-all). Returns the file paths to remove.
pub fn clear_all(pool: &DbPool) -> AppResult<Vec<String>> {
    let conn = pool.get()?;
    let mut files = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT image_path FROM clipboard_items WHERE image_path IS NOT NULL
             UNION ALL SELECT thumb_path FROM clipboard_items WHERE thumb_path IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for row in rows {
            if let Ok(p) = row {
                files.push(p);
            }
        }
    }
    conn.execute("DELETE FROM clipboard_items", [])?;
    Ok(files)
}

/// IDs of every live item, used to publish tombstones before a local clear-all.
/// This selects only the primary key and therefore remains cheap even with a
/// large image history.
pub fn live_ids(pool: &DbPool) -> AppResult<Vec<String>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT id FROM clipboard_items WHERE deleted = 0")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(Result::ok).collect())
}
