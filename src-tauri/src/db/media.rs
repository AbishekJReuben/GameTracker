//! Persistence for media listening — both Windows SMTC sessions (Spotify,
//! browsers, podcast apps…) and the in-app jukebox. Mirrors the session
//! lifecycle pattern in `db/sessions.rs`: a row is opened on a new track,
//! accrued each tick while playing, and closed on track change / stop.

use crate::db::DbPool;
use crate::error::AppResult;
use chrono::Utc;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPlayDto {
    pub id: String,
    pub source: String,
    pub source_app: Option<String>,
    pub app_name: Option<String>,
    pub media_type: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub thumb_path: Option<String>,
    pub game_id: Option<String>,
    pub vid: Option<String>,
    pub start_utc: String,
    pub end_utc: Option<String>,
    pub last_seen_utc: String,
    pub played_seconds: i64,
}

/// Fields needed to open a new media play row.
#[derive(Debug, Clone, Default)]
pub struct NewMediaPlay {
    pub source: String,
    pub source_app: Option<String>,
    pub app_name: Option<String>,
    pub media_type: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub thumb_path: Option<String>,
    pub game_id: Option<String>,
    pub vid: Option<String>,
}

const SELECT: &str = "SELECT id, source, source_app, app_name, media_type, title, artist, album,
        thumb_path, game_id, vid, start_utc, end_utc, last_seen_utc, played_seconds
     FROM media_plays";

fn row_to_dto(r: &rusqlite::Row<'_>) -> rusqlite::Result<MediaPlayDto> {
    Ok(MediaPlayDto {
        id: r.get(0)?,
        source: r.get(1)?,
        source_app: r.get(2)?,
        app_name: r.get(3)?,
        media_type: r.get(4)?,
        title: r.get(5)?,
        artist: r.get(6)?,
        album: r.get(7)?,
        thumb_path: r.get(8)?,
        game_id: r.get(9)?,
        vid: r.get(10)?,
        start_utc: r.get(11)?,
        end_utc: r.get(12)?,
        last_seen_utc: r.get(13)?,
        played_seconds: r.get(14)?,
    })
}

/// Open a new media play. Returns its id.
pub fn start_play(pool: &DbPool, m: &NewMediaPlay) -> AppResult<String> {
    let conn = pool.get()?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO media_plays(id, source, source_app, app_name, media_type, title, artist,
            album, thumb_path, game_id, vid, start_utc, end_utc, last_seen_utc, played_seconds)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,NULL,?12,0)",
        rusqlite::params![
            id,
            m.source,
            m.source_app,
            m.app_name,
            m.media_type,
            m.title,
            m.artist,
            m.album,
            m.thumb_path,
            m.game_id,
            m.vid,
            now,
        ],
    )?;
    Ok(id)
}

/// Add played seconds to an open row and bump last_seen.
pub fn accrue(pool: &DbPool, id: &str, add_seconds: i64) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE media_plays SET played_seconds = played_seconds + ?1, last_seen_utc = ?2
         WHERE id = ?3",
        rusqlite::params![add_seconds, Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

/// Accrue time onto every open row for a source (used for the in-app jukebox,
/// which has no SMTC session of its own to drive per-track accrual).
pub fn accrue_open_for_source(pool: &DbPool, source: &str, add_seconds: i64) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE media_plays SET played_seconds = played_seconds + ?1, last_seen_utc = ?2
         WHERE source = ?3 AND end_utc IS NULL",
        rusqlite::params![add_seconds, Utc::now().to_rfc3339(), source],
    )?;
    Ok(())
}

/// Bump last_seen without accruing time (e.g. paused but still the current track).
pub fn touch(pool: &DbPool, id: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE media_plays SET last_seen_utc = ?1 WHERE id = ?2",
        rusqlite::params![Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

pub fn end(pool: &DbPool, id: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE media_plays SET end_utc = last_seen_utc WHERE id = ?1 AND end_utc IS NULL",
        [id],
    )?;
    Ok(())
}

/// Close any rows left open from a previous run (crash / forced quit).
pub fn close_orphans(pool: &DbPool) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE media_plays SET end_utc = last_seen_utc WHERE end_utc IS NULL",
        [],
    )?;
    Ok(())
}

/// Close the open row for a given source (e.g. "jukebox") before opening a new one.
pub fn close_open_for_source(pool: &DbPool, source: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE media_plays SET end_utc = last_seen_utc WHERE source = ?1 AND end_utc IS NULL",
        [source],
    )?;
    Ok(())
}

/// Plays overlapping [from, to]. Open rows are included (their end coalesces to last_seen).
pub fn list_plays(pool: &DbPool, from: Option<&str>, to: Option<&str>) -> AppResult<Vec<MediaPlayDto>> {
    let conn = pool.get()?;
    let mut sql = format!("{SELECT} WHERE 1=1");
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(f) = from {
        params.push(Box::new(f.to_string()));
        sql.push_str(&format!(
            " AND datetime(COALESCE(end_utc, last_seen_utc)) > datetime(?{})",
            params.len()
        ));
    }
    if let Some(t) = to {
        params.push(Box::new(t.to_string()));
        sql.push_str(&format!(" AND start_utc <= ?{}", params.len()));
    }
    sql.push_str(" ORDER BY start_utc DESC");
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(refs.as_slice(), row_to_dto)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Most recent plays (for the "recent" reel / now-listening fallback).
pub fn recent(pool: &DbPool, limit: i64) -> AppResult<Vec<MediaPlayDto>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY last_seen_utc DESC LIMIT ?1"))?;
    let rows = stmt.query_map([limit], row_to_dto)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Drop rows older than `days` to keep the table bounded.
pub fn prune(pool: &DbPool, days: i64) -> AppResult<()> {
    let conn = pool.get()?;
    let cutoff = (Utc::now() - chrono::Duration::days(days)).to_rfc3339();
    conn.execute("DELETE FROM media_plays WHERE last_seen_utc < ?1", [cutoff])?;
    Ok(())
}
