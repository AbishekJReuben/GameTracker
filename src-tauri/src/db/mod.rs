pub mod games;
pub mod models;
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

    let _ = version;
    Ok(())
}
