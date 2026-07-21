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
    pub synced: bool,
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
        deleted: r.get::<_, i64>("deleted")? != 0,
        synced: r.get::<_, i64>("synced")? != 0,
    })
}

const COLS: &str = "id, kind, text, image_path, thumb_path, mime, size, created_utc, \
                    device_id, device_name, source, pinned, folder, deleted, synced";

/// Insert (or replace, idempotent by id) an item. Used for both local captures
/// and applied remote items — `id` is the dedupe key so a re-delivered remote
/// item can't duplicate.
pub fn upsert(pool: &DbPool, i: &ClipInput) -> AppResult<()> {
    let conn = pool.get()?;
    // NOTE: created_utc is NOT updated on conflict — an edit (re-delivery with the
    // same id) keeps the item's original position in time. `deleted` resets to 0 so
    // a re-add revives a tombstone (matches the relay's behavior).
    conn.execute(
        "INSERT INTO clipboard_items
            (id, kind, text, image_path, thumb_path, mime, size, created_utc,
             device_id, device_name, source, pinned, folder, deleted, synced)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?14,0,?13)
         ON CONFLICT(id) DO UPDATE SET
            text=excluded.text, image_path=excluded.image_path,
            thumb_path=excluded.thumb_path, mime=excluded.mime, size=excluded.size,
            pinned=excluded.pinned, folder=excluded.folder, deleted=0,
            synced=excluded.synced",
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
        ],
    )?;
    Ok(())
}

/// Edit a text item in place (notes). Marks it unsynced so the JS sync engine
/// re-uploads it (same id → the relay upserts + rebroadcasts to other devices).
pub fn update_text(pool: &DbPool, id: &str, text: &str) -> AppResult<bool> {
    let conn = pool.get()?;
    let changed = conn.execute(
        "UPDATE clipboard_items SET text = ?2, size = ?3, synced = 0
         WHERE id = ?1 AND deleted = 0 AND kind = 'text'",
        rusqlite::params![id, text, text.len() as i64],
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

/// Distinct non-empty folder names across live items (for the filter chips),
/// alphabetical.
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
                 WHERE deleted = 0 AND created_utc < ?1
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
                 WHERE deleted = 0
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
         WHERE deleted = 0 AND pinned = 1
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
