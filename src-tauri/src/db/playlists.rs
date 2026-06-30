//! User-curated playlists of jukebox tracks (YouTube OST ids). Playback reuses
//! the existing jukebox engine on the frontend; this just persists the lists.

use crate::db::DbPool;
use crate::error::AppResult;
use chrono::Utc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTrack {
    pub vid: String,
    #[serde(default)]
    pub game_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub cover_path: Option<String>,
    #[serde(default)]
    pub icon_path: Option<String>,
    #[serde(default)]
    pub position: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistDto {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub track_count: i64,
    /// Up to 4 art paths for a cover collage (covers first, then icons).
    pub covers: Vec<String>,
    pub tracks: Vec<PlaylistTrack>,
}

fn tracks_for(pool: &DbPool, playlist_id: &str) -> AppResult<Vec<PlaylistTrack>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT vid, game_id, title, artist, cover_path, icon_path, position
         FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position ASC",
    )?;
    let rows = stmt.query_map([playlist_id], |r| {
        Ok(PlaylistTrack {
            vid: r.get(0)?,
            game_id: r.get(1)?,
            title: r.get(2)?,
            artist: r.get(3)?,
            cover_path: r.get(4)?,
            icon_path: r.get(5)?,
            position: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn covers_from(tracks: &[PlaylistTrack]) -> Vec<String> {
    let mut out = Vec::new();
    for t in tracks {
        if let Some(c) = t.cover_path.clone().or_else(|| t.icon_path.clone()) {
            if !out.contains(&c) {
                out.push(c);
            }
        }
        if out.len() >= 4 {
            break;
        }
    }
    out
}

pub fn list(pool: &DbPool) -> AppResult<Vec<PlaylistDto>> {
    // Release this connection before the per-playlist `tracks_for` calls below so
    // we never hold two pooled connections at once.
    let ids: Vec<(String, String, String, String)> = {
        let conn = pool.get()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, created_at, updated_at FROM playlists ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut out = Vec::new();
    for (id, name, created_at, updated_at) in ids {
        let tracks = tracks_for(pool, &id)?;
        out.push(PlaylistDto {
            track_count: tracks.len() as i64,
            covers: covers_from(&tracks),
            tracks: Vec::new(), // summary list omits full tracks
            id,
            name,
            created_at,
            updated_at,
        });
    }
    Ok(out)
}

pub fn get(pool: &DbPool, id: &str) -> AppResult<Option<PlaylistDto>> {
    // Scope the head-row connection so `tracks_for` can grab a fresh one.
    let head: Option<(String, String, String)> = {
        let conn = pool.get()?;
        conn.query_row(
            "SELECT name, created_at, updated_at FROM playlists WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok()
    };
    let Some((name, created_at, updated_at)) = head else {
        return Ok(None);
    };
    let tracks = tracks_for(pool, id)?;
    Ok(Some(PlaylistDto {
        id: id.to_string(),
        name,
        created_at,
        updated_at,
        track_count: tracks.len() as i64,
        covers: covers_from(&tracks),
        tracks,
    }))
}

pub fn create(pool: &DbPool, name: &str) -> AppResult<String> {
    let conn = pool.get()?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO playlists(id, name, created_at, updated_at) VALUES(?1,?2,?3,?3)",
        rusqlite::params![id, name.trim(), now],
    )?;
    Ok(id)
}

pub fn rename(pool: &DbPool, id: &str, name: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE playlists SET name = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![name.trim(), Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

pub fn delete(pool: &DbPool, id: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute("DELETE FROM playlists WHERE id = ?1", [id])?;
    Ok(())
}

fn touch(conn: &rusqlite::Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

pub fn add_tracks(pool: &DbPool, id: &str, tracks: &[PlaylistTrack]) -> AppResult<()> {
    let conn = pool.get()?;
    let mut next: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_tracks WHERE playlist_id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    for t in tracks {
        let changed = conn.execute(
            "INSERT INTO playlist_tracks(playlist_id, position, vid, game_id, title, artist, cover_path, icon_path)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(playlist_id, vid) DO NOTHING",
            rusqlite::params![
                id,
                next,
                t.vid,
                t.game_id,
                t.title,
                t.artist,
                t.cover_path,
                t.icon_path,
            ],
        )?;
        if changed > 0 {
            next += 1;
        }
    }
    touch(&conn, id)?;
    Ok(())
}

pub fn remove_track(pool: &DbPool, id: &str, vid: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND vid = ?2",
        rusqlite::params![id, vid],
    )?;
    touch(&conn, id)?;
    Ok(())
}

pub fn reorder(pool: &DbPool, id: &str, vids: &[String]) -> AppResult<()> {
    let mut conn = pool.get()?;
    let tx = conn.transaction()?;
    for (i, vid) in vids.iter().enumerate() {
        tx.execute(
            "UPDATE playlist_tracks SET position = ?1 WHERE playlist_id = ?2 AND vid = ?3",
            rusqlite::params![i as i64, id, vid],
        )?;
    }
    tx.execute(
        "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![Utc::now().to_rfc3339(), id],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use r2d2_sqlite::SqliteConnectionManager;

    fn pool() -> DbPool {
        let mgr = SqliteConnectionManager::memory();
        let pool = r2d2::Pool::builder().max_size(1).build(mgr).unwrap();
        crate::db::run_migrations(&pool.get().unwrap()).unwrap();
        pool
    }

    fn track(vid: &str) -> PlaylistTrack {
        PlaylistTrack {
            vid: vid.to_string(),
            game_id: None,
            title: Some(vid.to_string()),
            artist: None,
            cover_path: None,
            icon_path: None,
            position: 0,
        }
    }

    #[test]
    fn create_add_reorder_roundtrip() {
        let pool = pool();
        let id = create(&pool, "Mix").unwrap();
        add_tracks(&pool, &id, &[track("a"), track("b"), track("c")]).unwrap();
        // duplicate vid is ignored
        add_tracks(&pool, &id, &[track("a")]).unwrap();
        let pl = get(&pool, &id).unwrap().unwrap();
        assert_eq!(pl.track_count, 3);
        assert_eq!(pl.tracks.iter().map(|t| t.vid.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);

        reorder(&pool, &id, &["c".into(), "a".into(), "b".into()]).unwrap();
        let pl = get(&pool, &id).unwrap().unwrap();
        assert_eq!(pl.tracks.iter().map(|t| t.vid.as_str()).collect::<Vec<_>>(), ["c", "a", "b"]);

        remove_track(&pool, &id, "a").unwrap();
        let pl = get(&pool, &id).unwrap().unwrap();
        assert_eq!(pl.track_count, 2);
    }
}
