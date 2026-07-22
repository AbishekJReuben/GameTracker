//! Durable metadata and audit history for direct browser shares. File bytes are
//! never stored here: only the sender-local manifest, the permanent room id,
//! and small transfer telemetry records live in SQLite.

use crate::db::DbPool;
use crate::error::{AppError, AppResult};
use crate::file_share::{self, ShareManifest};
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedShare {
    pub id: String,
    pub room: String,
    pub title: String,
    pub manifest: ShareManifest,
    pub created_utc: String,
    pub updated_utc: String,
    pub revoked: bool,
    pub download_count: i64,
    pub last_download_utc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareDownloadSession {
    pub id: String,
    pub share_id: String,
    pub started_utc: String,
    pub ended_utc: Option<String>,
    pub state: String,
    pub peer_name: Option<String>,
    pub route: Option<String>,
    pub bytes_transferred: i64,
    pub total_bytes: i64,
    pub average_speed_bps: f64,
    pub peak_speed_bps: f64,
    pub rtt_ms: Option<f64>,
    pub error: Option<String>,
}

fn title_for(manifest: &ShareManifest) -> String {
    if manifest.items.len() == 1 { return manifest.items[0].path.clone(); }
    format!("{} files", manifest.items.len())
}

pub fn create(pool: &DbPool, room: String, paths: Vec<String>) -> AppResult<SavedShare> {
    let manifest = file_share::prepare(paths)?;
    let now = Utc::now().to_rfc3339();
    let saved = SavedShare {
        id: uuid::Uuid::new_v4().to_string(), room, title: title_for(&manifest),
        manifest, created_utc: now.clone(), updated_utc: now, revoked: false,
        download_count: 0, last_download_utc: None,
    };
    let conn = pool.get()?;
    conn.execute(
        "INSERT INTO file_shares (id, room, title, manifest_json, created_utc, updated_utc, revoked, download_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0)",
        params![saved.id, saved.room, saved.title, serde_json::to_string(&saved.manifest)?, saved.created_utc, saved.updated_utc],
    )?;
    Ok(saved)
}

fn read_share(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedShare> {
    let manifest: String = row.get(3)?;
    Ok(SavedShare {
        id: row.get(0)?, room: row.get(1)?, title: row.get(2)?,
        manifest: serde_json::from_str(&manifest).unwrap_or(ShareManifest { items: vec![], total_bytes: 0, skipped: vec!["Saved manifest could not be read.".into()] }),
        created_utc: row.get(4)?, updated_utc: row.get(5)?, revoked: row.get::<_, i64>(6)? != 0,
        download_count: row.get(7)?, last_download_utc: row.get(8)?,
    })
}

pub fn list(pool: &DbPool) -> AppResult<Vec<SavedShare>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT id, room, title, manifest_json, created_utc, updated_utc, revoked, download_count, last_download_utc FROM file_shares ORDER BY revoked ASC, updated_utc DESC")?;
    let rows = stmt.query_map([], read_share)?;
    let shares = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(shares)
}

pub fn revoke(pool: &DbPool, id: &str) -> AppResult<()> {
    let conn = pool.get()?;
    if conn.execute("UPDATE file_shares SET revoked = 1, updated_utc = ?2 WHERE id = ?1", params![id, Utc::now().to_rfc3339()])? == 0 {
        return Err(AppError::msg("Share not found."));
    }
    Ok(())
}

pub fn start_session(pool: &DbPool, share_id: &str, peer_name: Option<String>, total_bytes: u64) -> AppResult<ShareDownloadSession> {
    let now = Utc::now().to_rfc3339();
    let session = ShareDownloadSession {
        id: uuid::Uuid::new_v4().to_string(), share_id: share_id.to_string(), started_utc: now.clone(), ended_utc: None,
        state: "transferring".into(), peer_name, route: None, bytes_transferred: 0, total_bytes: total_bytes.min(i64::MAX as u64) as i64,
        average_speed_bps: 0.0, peak_speed_bps: 0.0, rtt_ms: None, error: None,
    };
    let conn = pool.get()?;
    conn.execute("INSERT INTO file_share_sessions (id, share_id, started_utc, state, peer_name, total_bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![session.id, session.share_id, session.started_utc, session.state, session.peer_name, session.total_bytes])?;
    Ok(session)
}

pub fn finish_session(pool: &DbPool, session: ShareDownloadSession) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute("UPDATE file_share_sessions SET ended_utc = ?2, state = ?3, route = ?4, bytes_transferred = ?5, average_speed_bps = ?6, peak_speed_bps = ?7, rtt_ms = ?8, error = ?9 WHERE id = ?1", params![session.id, session.ended_utc.unwrap_or_else(|| Utc::now().to_rfc3339()), session.state, session.route, session.bytes_transferred, session.average_speed_bps, session.peak_speed_bps, session.rtt_ms, session.error])?;
    if session.state == "complete" {
        let now = Utc::now().to_rfc3339();
        conn.execute("UPDATE file_shares SET download_count = download_count + 1, last_download_utc = ?2, updated_utc = ?2 WHERE id = ?1", params![session.share_id, now])?;
    }
    Ok(())
}

pub fn sessions(pool: &DbPool, share_id: &str) -> AppResult<Vec<ShareDownloadSession>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT id, share_id, started_utc, ended_utc, state, peer_name, route, bytes_transferred, total_bytes, average_speed_bps, peak_speed_bps, rtt_ms, error FROM file_share_sessions WHERE share_id = ?1 ORDER BY started_utc DESC")?;
    let rows = stmt.query_map([share_id], |row| Ok(ShareDownloadSession {
        id: row.get(0)?, share_id: row.get(1)?, started_utc: row.get(2)?, ended_utc: row.get(3)?, state: row.get(4)?, peer_name: row.get(5)?, route: row.get(6)?, bytes_transferred: row.get(7)?, total_bytes: row.get(8)?, average_speed_bps: row.get(9)?, peak_speed_bps: row.get(10)?, rtt_ms: row.get(11)?, error: row.get(12)?,
    }))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}
