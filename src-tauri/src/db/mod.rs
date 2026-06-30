pub mod foreground;
pub mod games;
pub mod media;
pub mod models;
pub mod music;
pub mod playlists;
pub mod screenshots;
pub mod sessions;
pub mod settings;
pub mod stats;

use crate::error::AppResult;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::path::Path;

pub type DbPool = Pool<SqliteConnectionManager>;
pub type PooledConn = r2d2::PooledConnection<SqliteConnectionManager>;

/// Open (or create) the SQLite database and run migrations.
pub fn init_pool(db_path: &Path) -> AppResult<DbPool> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let manager = SqliteConnectionManager::file(db_path).with_init(|c| {
        c.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )
    });
    let pool = Pool::builder()
        .max_size(6)
        .build(manager)
        .map_err(|e| crate::error::AppError::msg(e.to_string()))?;

    {
        let conn = pool.get()?;
        run_migrations(&conn)?;
    }
    Ok(pool)
}

fn user_version(conn: &rusqlite::Connection) -> AppResult<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

fn run_migrations(conn: &rusqlite::Connection) -> AppResult<()> {
    let mut version = user_version(conn)?;

    if version < 1 {
        conn.execute_batch(
            r#"
            CREATE TABLE games (
                id                   TEXT PRIMARY KEY,
                display_name         TEXT NOT NULL,
                install_folder       TEXT,
                exe_paths            TEXT NOT NULL DEFAULT '[]',
                icon_path            TEXT,
                cover_path           TEXT,
                status               TEXT NOT NULL DEFAULT 'backlog',
                rating               INTEGER,
                developer            TEXT,
                release_year         INTEGER,
                completed_year       INTEGER,
                metacritic           INTEGER,
                notes                TEXT,
                time_to_beat_minutes INTEGER,
                accent_color         TEXT,
                is_enabled           INTEGER NOT NULL DEFAULT 1,
                created_at           TEXT NOT NULL
            );

            CREATE TABLE sessions (
                id              TEXT PRIMARY KEY,
                game_id         TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                start_utc       TEXT NOT NULL,
                end_utc         TEXT,
                last_seen_utc   TEXT NOT NULL,
                runtime_seconds INTEGER NOT NULL DEFAULT 0,
                active_seconds  INTEGER NOT NULL DEFAULT 0,
                was_idle_ended  INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX idx_sessions_game ON sessions(game_id);
            CREATE INDEX idx_sessions_start ON sessions(start_utc);

            CREATE TABLE tags (
                id   TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE game_tags (
                game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
                PRIMARY KEY (game_id, tag_id)
            );

            CREATE TABLE settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 1;")?;
        version = 1;
    }

    if version < 2 {
        conn.execute_batch(
            r#"
            ALTER TABLE games ADD COLUMN started_year INTEGER;
            ALTER TABLE games ADD COLUMN started_month INTEGER;
            ALTER TABLE games ADD COLUMN started_day INTEGER;
            ALTER TABLE games ADD COLUMN completed_month INTEGER;
            ALTER TABLE games ADD COLUMN completed_day INTEGER;
            ALTER TABLE games ADD COLUMN manual_playtime_seconds INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE games ADD COLUMN hltb_main_minutes INTEGER;
            ALTER TABLE games ADD COLUMN hltb_main_extra_minutes INTEGER;
            ALTER TABLE games ADD COLUMN hltb_completionist_minutes INTEGER;
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 2;")?;
        version = 2;
    }

    if version < 3 {
        // Apps/software become first-class entries alongside games via a `kind`
        // discriminator ('game' | 'app'). Everything else (sessions, tracking,
        // stats) is shared; the UI keeps the two cleanly separated.
        conn.execute_batch(
            r#"
            ALTER TABLE games ADD COLUMN kind TEXT NOT NULL DEFAULT 'game';
            CREATE INDEX IF NOT EXISTS idx_games_kind ON games(kind);
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 3;")?;
        version = 3;
    }

    if version < 4 {
        // Richer media: store screenshot/asset URLs (JSON array) and an optional
        // wide background/hero image + website for the detail pages.
        conn.execute_batch(
            r#"
            ALTER TABLE games ADD COLUMN screenshots TEXT NOT NULL DEFAULT '[]';
            ALTER TABLE games ADD COLUMN background_url TEXT;
            ALTER TABLE games ADD COLUMN website TEXT;
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 4;")?;
        version = 4;
    }

    if version < 5 {
        conn.execute_batch(
            r#"
            ALTER TABLE games ADD COLUMN count_background INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE games ADD COLUMN steam_app_id INTEGER;
            ALTER TABLE games ADD COLUMN metacritic_slug TEXT;
            ALTER TABLE games ADD COLUMN info_json TEXT;
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 5;")?;
        version = 5;
    }

    if version < 6 {
        conn.execute_batch(
            r#"
            ALTER TABLE sessions ADD COLUMN focus_spans_json TEXT NOT NULL DEFAULT '[]';
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 6;")?;
        version = 6;
    }

    if version < 7 {
        // Auto-captured in-game screenshots (taken every N minutes while a game is
        // focused) live in their own table so they stay distinct from the curated
        // Steam/Wikipedia `games.screenshots` media. Per-session window activity
        // (foreground title + browser URL) is stored alongside focus spans.
        conn.execute_batch(
            r#"
            CREATE TABLE screenshots (
                id           TEXT PRIMARY KEY,
                game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                session_id   TEXT,
                path         TEXT NOT NULL,
                captured_utc TEXT NOT NULL
            );
            CREATE INDEX idx_screenshots_game ON screenshots(game_id);
            ALTER TABLE sessions ADD COLUMN activity_json TEXT NOT NULL DEFAULT '[]';
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 7;")?;
        version = 7;
    }

    if version < 8 {
        // Apps now track in the background (runtime) like games, so existing
        // focus-only apps are flipped on. Users can still opt individual apps out.
        conn.execute_batch(
            r#"
            UPDATE games SET count_background = 1 WHERE kind = 'app';
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 8;")?;
        version = 8;
    }

    if version < 9 {
        // Store an optional game trailer (direct mp4 URL from Steam) for the
        // detail page video player. URL only — streamed from the CDN, not saved.
        conn.execute_batch(
            r#"
            ALTER TABLE games ADD COLUMN trailer_url TEXT;
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 9;")?;
        version = 9;
    }

    if version < 10 {
        // Per-game theme: a YouTube video id (full track, needs an API key) and/or
        // a keyless iTunes 30s preview URL for the detail-page theme player.
        conn.execute_batch(
            r#"
            ALTER TABLE games ADD COLUMN theme_youtube_id TEXT;
            ALTER TABLE games ADD COLUMN theme_audio_url TEXT;
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 10;")?;
        version = 10;
    }

    if version < 11 {
        // Tighten the auto-screenshot cadence to 1 minute. Forced onto existing
        // installs (overrides any previously stored value) per product decision.
        conn.execute_batch(
            r#"
            INSERT INTO settings(key, value) VALUES('screenshot_interval_minutes', '1')
            ON CONFLICT(key) DO UPDATE SET value = '1';
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 11;")?;
        version = 11;
    }

    if version < 12 {
        // Re-assert the 1-minute screenshot cadence for installs already past the
        // v11 migration (this update forces it again regardless of any custom value).
        conn.execute_batch(
            r#"
            INSERT INTO settings(key, value) VALUES('screenshot_interval_minutes', '1')
            ON CONFLICT(key) DO UPDATE SET value = '1';
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 12;")?;
        version = 12;
    }

    if version < 13 {
        conn.execute_batch(
            r#"
            ALTER TABLE games ADD COLUMN steam_achievements_unlocked INTEGER;
            ALTER TABLE games ADD COLUMN steam_achievements_total INTEGER;
            ALTER TABLE games ADD COLUMN steam_achievements_synced_utc TEXT;
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 13;")?;
        version = 13;
    }

    if version < 14 {
        conn.execute_batch(
            r#"
            ALTER TABLE games ADD COLUMN steam_achievements_json TEXT;
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 14;")?;
        version = 14;
    }

    if version < 15 {
        conn.execute_batch(
            r#"
            ALTER TABLE games ADD COLUMN gog_product_id INTEGER;
            ALTER TABLE games ADD COLUMN gog_achievements_unlocked INTEGER;
            ALTER TABLE games ADD COLUMN gog_achievements_total INTEGER;
            ALTER TABLE games ADD COLUMN gog_achievements_synced_utc TEXT;
            ALTER TABLE games ADD COLUMN gog_achievements_json TEXT;
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 15;")?;
        version = 15;
    }

    if version < 16 {
        // Cache live/estimated game stats with the game so GameDetail can render
        // them instantly (no blocking network on open) and refresh slowly.
        conn.execute_batch(
            r#"
            ALTER TABLE games ADD COLUMN stats_json TEXT;
            ALTER TABLE games ADD COLUMN stats_fetched_utc TEXT;
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 16;")?;
        version = 16;
    }

    if version < 17 {
        // Up to five YouTube OST tracks per game for the in-app jukebox mix.
        conn.execute_batch(
            r#"
            ALTER TABLE games ADD COLUMN theme_track_ids TEXT NOT NULL DEFAULT '[]';
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 17;")?;
        version = 17;
    }

    if version < 18 {
        // Source YouTube playlist id for a game's full OST (when one is found),
        // so the jukebox can deep-link / export it. theme_track_ids now holds the
        // full playlist (up to ~100), not just five.
        conn.execute_batch(
            r#"
            ALTER TABLE games ADD COLUMN theme_playlist_id TEXT;
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 18;")?;
        version = 18;
    }

    if version < 19 {
        // Human-readable YouTube titles keyed by video id for jukebox labels.
        conn.execute_batch(
            r#"
            ALTER TABLE games ADD COLUMN theme_track_titles TEXT NOT NULL DEFAULT '{}';
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 19;")?;
        version = 19;
    }

    if version < 20 {
        // Music/media listening tracking, a global foreground-app log (for the
        // "active app" timeline lane), and user-curated playlists.
        conn.execute_batch(
            r#"
            CREATE TABLE media_plays (
                id             TEXT PRIMARY KEY,
                source         TEXT NOT NULL,            -- 'smtc' | 'jukebox'
                source_app     TEXT,                     -- AUMID / exe (smtc) or 'gametracker'
                app_name       TEXT,                     -- friendly (Spotify, Chrome…)
                media_type     TEXT NOT NULL,            -- 'music' | 'video' | 'podcast' | 'other'
                title          TEXT,
                artist         TEXT,
                album          TEXT,
                thumb_path     TEXT,
                game_id        TEXT,
                vid            TEXT,
                start_utc      TEXT NOT NULL,
                end_utc        TEXT,
                last_seen_utc  TEXT NOT NULL,
                played_seconds INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX idx_media_start ON media_plays(start_utc);
            CREATE INDEX idx_media_artist ON media_plays(artist);

            CREATE TABLE foreground_spans (
                id            TEXT PRIMARY KEY,
                app_key       TEXT NOT NULL,
                name          TEXT NOT NULL,
                exe_path      TEXT,
                icon_path     TEXT,
                game_id       TEXT,
                start_utc     TEXT NOT NULL,
                end_utc       TEXT,
                last_seen_utc TEXT NOT NULL
            );
            CREATE INDEX idx_fg_start ON foreground_spans(start_utc);

            CREATE TABLE playlists (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE playlist_tracks (
                playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                position    INTEGER NOT NULL,
                vid         TEXT NOT NULL,
                game_id     TEXT,
                title       TEXT,
                artist      TEXT,
                cover_path  TEXT,
                icon_path   TEXT,
                PRIMARY KEY (playlist_id, vid)
            );
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 20;")?;
        version = 20;
    }

    if version < 21 {
        // Re-classify existing SMTC media plays with the improved heuristic: a
        // browser session counts as music only when it carries an album (real
        // music services), so plain YouTube videos — channel name in `artist`,
        // no album — are corrected from 'music' to 'video'. Honors the user's
        // per-app type overrides, mirroring the live tracker.
        use crate::tracking::media::classify;
        let overrides: std::collections::HashMap<String, String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'media_app_types'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|s| serde_json::from_str::<std::collections::HashMap<String, String>>(&s).ok())
            .unwrap_or_default();

        let rows: Vec<(String, Option<String>, Option<String>, Option<String>)> = {
            let mut stmt = conn.prepare(
                "SELECT id, source_app, artist, album FROM media_plays WHERE source = 'smtc'",
            )?;
            let mapped = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })?;
            mapped.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, source_app, artist, album) in rows {
            let app = source_app.unwrap_or_default();
            // Old rows predate the playback-type hint; classify from metadata only.
            let media_type = overrides.get(&app).cloned().unwrap_or_else(|| {
                classify(&app, artist.as_deref(), album.as_deref(), None).to_string()
            });
            conn.execute(
                "UPDATE media_plays SET media_type = ?1 WHERE id = ?2",
                rusqlite::params![media_type, id],
            )?;
        }

        conn.execute_batch("PRAGMA user_version = 21;")?;
        version = 21;
    }

    let _ = version;
    Ok(())
}
