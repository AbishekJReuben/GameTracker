pub mod clipboard;
pub mod foreground;
pub mod games;
pub mod media;
pub mod models;
pub mod music;
pub mod playlists;
pub mod remote_grants;
pub mod screenshots;
pub mod shares;
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
        // Backfill: re-classify existing SMTC media plays so old rows match the
        // current heuristic (YouTube/browser videos that were tagged 'music' get
        // corrected to 'video'). Honors the user's per-app type overrides.
        reclassify_smtc_plays(conn)?;
        conn.execute_batch("PRAGMA user_version = 21;")?;
        version = 21;
    }

    if version < 22 {
        // Re-run the backfill: v21 ran an earlier, weaker rule (Firefox-family
        // browsers like Zen — opaque hex AUMIDs — slipped through as 'music').
        // The classifier now catches them, so reclassify once more.
        reclassify_smtc_plays(conn)?;
        conn.execute_batch("PRAGMA user_version = 22;")?;
        version = 22;
    }

    if version < 23 {
        // Shared clipboard history (text + images), synced end-to-end across
        // devices and kept permanently until deleted. Images live as files under
        // media_dir/clipboard/ with a thumbnail; only metadata + text live here.
        // `synced` marks whether the item has been pushed to the relay yet (so the
        // JS sync client can find its backlog after a reconnect).
        conn.execute_batch(
            r#"
            CREATE TABLE clipboard_items (
                id          TEXT PRIMARY KEY,
                kind        TEXT NOT NULL DEFAULT 'text',
                text        TEXT,
                image_path  TEXT,
                thumb_path  TEXT,
                mime        TEXT,
                size        INTEGER NOT NULL DEFAULT 0,
                created_utc TEXT NOT NULL,
                device_id   TEXT NOT NULL DEFAULT '',
                device_name TEXT,
                source      TEXT NOT NULL DEFAULT 'desktop',
                pinned      INTEGER NOT NULL DEFAULT 0,
                deleted     INTEGER NOT NULL DEFAULT 0,
                synced      INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX idx_clip_created ON clipboard_items(created_utc);
            CREATE INDEX idx_clip_pinned ON clipboard_items(pinned);
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 23;")?;
        version = 23;
    }

    if version < 24 {
        // Notes rebrand: items can live in a named folder/list ('' = unfiled).
        conn.execute_batch(
            r#"
            ALTER TABLE clipboard_items ADD COLUMN folder TEXT NOT NULL DEFAULT '';
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 24;")?;
        version = 24;
    }

    if version < 25 {
        // Dedup-to-top + copy history:
        //  - `content_hash` is a stable fingerprint of the item's content (text
        //    bytes / image bytes), so a re-copy of the SAME content finds the
        //    existing row instead of inserting a duplicate.
        //  - `copies` is a JSON array of every UTC timestamp this content was
        //    copied/added, so the app screens can show all the dates.
        // Empty folders also sync now, stored as kind='folder' rows (text = the
        // folder name) that ride the same relay pipeline as clips but never show
        // in the item lists.
        conn.execute_batch(
            r#"
            ALTER TABLE clipboard_items ADD COLUMN content_hash TEXT;
            ALTER TABLE clipboard_items ADD COLUMN copies TEXT;
            CREATE INDEX IF NOT EXISTS idx_clip_hash ON clipboard_items(content_hash);
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 25;")?;
        version = 25;
    }

    if version < 26 {
        // Notes use many-to-many tags now. Preserve every existing folder as the
        // item's first tag so upgrading never loses organization.
        conn.execute_batch(
            r#"
            ALTER TABLE clipboard_items ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
            UPDATE clipboard_items
               SET tags = json_array(folder)
             WHERE kind != 'folder' AND folder IS NOT NULL AND folder != '';
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 26;")?;
        version = 26;
    }

    if version < 27 {
        // Direct shares are permanent local capabilities until revoked. The
        // source manifest stays on the sender; session rows are audit metadata
        // only and never contain file bytes or receiver IP addresses.
        conn.execute_batch(
            r#"
            CREATE TABLE file_shares (
                id                TEXT PRIMARY KEY,
                room              TEXT NOT NULL UNIQUE,
                title             TEXT NOT NULL,
                manifest_json     TEXT NOT NULL,
                created_utc       TEXT NOT NULL,
                updated_utc       TEXT NOT NULL,
                revoked           INTEGER NOT NULL DEFAULT 0,
                download_count    INTEGER NOT NULL DEFAULT 0,
                last_download_utc TEXT
            );
            CREATE INDEX idx_file_shares_updated ON file_shares(updated_utc DESC);
            CREATE TABLE file_share_sessions (
                id                 TEXT PRIMARY KEY,
                share_id           TEXT NOT NULL REFERENCES file_shares(id) ON DELETE CASCADE,
                started_utc        TEXT NOT NULL,
                ended_utc          TEXT,
                state              TEXT NOT NULL,
                peer_name          TEXT,
                route              TEXT,
                bytes_transferred  INTEGER NOT NULL DEFAULT 0,
                total_bytes        INTEGER NOT NULL DEFAULT 0,
                average_speed_bps  REAL NOT NULL DEFAULT 0,
                peak_speed_bps     REAL NOT NULL DEFAULT 0,
                rtt_ms             REAL,
                error              TEXT
            );
            CREATE INDEX idx_file_share_sessions_share ON file_share_sessions(share_id, started_utc DESC);
            "#,
        )?;
        conn.execute_batch("PRAGMA user_version = 27;")?;
        version = 27;
    }

    if version < 28 {
        // app_samples (created by system::ensure_app_table) was a rowid table with a
        // TEXT (ts, game_id) primary key, so every sample was stored twice: once in the
        // table and once in the key's autoindex (107 MB for 30 days on a real install,
        // 44% of the file). WITHOUT ROWID keeps rows in the key's own b-tree: 59 MB,
        // one b-tree write per sample, and the history read and prune search the same
        // key (~20% faster). Measured one-time cost: ~1.2 s for 600k rows.
        let old_layout: bool = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master
              WHERE type = 'table' AND name = 'app_samples' AND sql NOT LIKE '%WITHOUT ROWID%'",
            [],
            |r| r.get::<_, i64>(0),
        )? > 0;
        let tx = conn.unchecked_transaction()?;
        if old_layout {
            tx.execute_batch(
                r#"
                CREATE TABLE app_samples_new (
                    ts       TEXT NOT NULL,
                    game_id  TEXT NOT NULL,
                    cpu      REAL NOT NULL DEFAULT 0,
                    ram_mb   REAL NOT NULL DEFAULT 0,
                    gpu      REAL,
                    PRIMARY KEY (ts, game_id)
                ) WITHOUT ROWID;
                INSERT INTO app_samples_new SELECT ts, game_id, cpu, ram_mb, gpu FROM app_samples;
                DROP TABLE app_samples;
                ALTER TABLE app_samples_new RENAME TO app_samples;
                "#,
            )?;
        }
        tx.execute_batch("PRAGMA user_version = 28;")?;
        tx.commit()?;
        version = 28;
        if old_layout {
            // Hand the freed pages back to the disk (244 → 141 MB measured, ~1.1 s).
            // Best-effort: a full disk just leaves them on the freelist for reuse.
            let _ = conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
        }
    }

    if version < 29 {
        // Notes. `tags` and friends lived after `text`, so every metadata read walked
        // each note's text: 20 ms per tag scan on a real history with a 20 MB note,
        // 4.7 ms once `text` is out of the way. Same rows, `text` last, plus what the
        // list needs without ever touching it (`preview`, `text_len`) and a revision
        // both processes can follow (`rev`, bumped by triggers so no writer can
        // forget). `clipboard_outbox` holds changes the relay hasn't seen yet, so a
        // pin or delete made offline, or in the notes shell, survives until it is sent.
        let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
        let current: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if current < 29 {
            tx.execute_batch(
                r#"
                CREATE TABLE clipboard_items_new (
                    id           TEXT PRIMARY KEY,
                    kind         TEXT NOT NULL DEFAULT 'text',
                    image_path   TEXT,
                    thumb_path   TEXT,
                    mime         TEXT,
                    size         INTEGER NOT NULL DEFAULT 0,
                    created_utc  TEXT NOT NULL,
                    device_id    TEXT NOT NULL DEFAULT '',
                    device_name  TEXT,
                    source       TEXT NOT NULL DEFAULT 'desktop',
                    pinned       INTEGER NOT NULL DEFAULT 0,
                    deleted      INTEGER NOT NULL DEFAULT 0,
                    synced       INTEGER NOT NULL DEFAULT 0,
                    folder       TEXT NOT NULL DEFAULT '',
                    tags         TEXT NOT NULL DEFAULT '[]',
                    content_hash TEXT,
                    copies       TEXT,
                    rev          INTEGER NOT NULL DEFAULT 0,
                    text_len     INTEGER NOT NULL DEFAULT 0,
                    preview      TEXT,
                    text         TEXT
                );
                INSERT INTO clipboard_items_new
                    (id, kind, image_path, thumb_path, mime, size, created_utc, device_id,
                     device_name, source, pinned, deleted, synced, folder, tags, content_hash,
                     copies, rev, text_len, preview, text)
                SELECT id, kind, image_path, thumb_path, mime, size, created_utc, device_id,
                       device_name, source, pinned, deleted, synced, folder, tags, content_hash,
                       copies, rowid, coalesce(length(text), 0), substr(text, 1, 8192), text
                  FROM clipboard_items;
                DROP TABLE clipboard_items;
                ALTER TABLE clipboard_items_new RENAME TO clipboard_items;
                CREATE INDEX idx_clip_created ON clipboard_items(created_utc);
                CREATE INDEX idx_clip_pinned ON clipboard_items(pinned);
                CREATE INDEX idx_clip_hash ON clipboard_items(content_hash);
                CREATE INDEX idx_clip_rev ON clipboard_items(rev);

                CREATE TABLE clipboard_meta (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL);
                INSERT INTO clipboard_meta (id, rev)
                    SELECT 1, coalesce(max(rev), 0) FROM clipboard_items;

                CREATE TABLE clipboard_outbox (
                    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
                    op          TEXT NOT NULL,
                    item_id     TEXT NOT NULL,
                    payload     TEXT,
                    created_utc TEXT NOT NULL
                );

                CREATE TRIGGER clip_rev_insert AFTER INSERT ON clipboard_items BEGIN
                    UPDATE clipboard_meta SET rev = rev + 1 WHERE id = 1;
                    UPDATE clipboard_items
                       SET rev = (SELECT rev FROM clipboard_meta WHERE id = 1),
                           preview = substr(NEW.text, 1, 8192),
                           text_len = coalesce(length(NEW.text), 0)
                     WHERE id = NEW.id;
                END;
                CREATE TRIGGER clip_rev_update AFTER UPDATE ON clipboard_items
                WHEN NEW.rev = OLD.rev BEGIN
                    UPDATE clipboard_meta SET rev = rev + 1 WHERE id = 1;
                    UPDATE clipboard_items
                       SET rev = (SELECT rev FROM clipboard_meta WHERE id = 1)
                     WHERE id = NEW.id;
                END;
                CREATE TRIGGER clip_text_update AFTER UPDATE OF text ON clipboard_items BEGIN
                    UPDATE clipboard_items
                       SET preview = substr(NEW.text, 1, 8192),
                           text_len = coalesce(length(NEW.text), 0)
                     WHERE id = NEW.id;
                END;
                CREATE TRIGGER clip_rev_delete AFTER DELETE ON clipboard_items BEGIN
                    UPDATE clipboard_meta SET rev = rev + 1 WHERE id = 1;
                END;
                "#,
            )?;
            tx.execute_batch("PRAGMA user_version = 29;")?;
        }
        tx.commit()?;
        version = 29;
        // The rebuild doubled the WAL; give that back now. Best-effort.
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }

    let _ = version;
    Ok(())
}

/// Re-classify every SMTC media play in place using the current `classify` rule,
/// honoring the user's per-app type overrides. Used by backfill migrations.
fn reclassify_smtc_plays(conn: &rusqlite::Connection) -> AppResult<()> {
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
        // Historical rows have no stored playback-type; classify from metadata.
        let media_type = overrides.get(&app).cloned().unwrap_or_else(|| {
            classify(&app, artist.as_deref(), album.as_deref(), None).to_string()
        });
        conn.execute(
            "UPDATE media_plays SET media_type = ?1 WHERE id = ?2",
            rusqlite::params![media_type, id],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The notes table as it stood at version 28, column order included.
    fn notes_v28(conn: &rusqlite::Connection) {
        conn.execute_batch(
            "CREATE TABLE clipboard_items (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'text', text TEXT, image_path TEXT,
                thumb_path TEXT, mime TEXT, size INTEGER NOT NULL DEFAULT 0, created_utc TEXT NOT NULL,
                device_id TEXT NOT NULL DEFAULT '', device_name TEXT, source TEXT NOT NULL DEFAULT 'desktop',
                pinned INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
                synced INTEGER NOT NULL DEFAULT 0, folder TEXT NOT NULL DEFAULT '', content_hash TEXT,
                copies TEXT, tags TEXT NOT NULL DEFAULT '[]');
             CREATE INDEX idx_clip_created ON clipboard_items(created_utc);
             CREATE INDEX idx_clip_pinned ON clipboard_items(pinned);
             CREATE INDEX idx_clip_hash ON clipboard_items(content_hash);
             PRAGMA user_version = 28;",
        )
        .unwrap();
    }

    #[test]
    fn migration_29_keeps_every_note_and_moves_text_last() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        notes_v28(&conn);
        let huge = "x".repeat(2_000_000);
        conn.execute(
            "INSERT INTO clipboard_items (id, text, created_utc, tags, pinned, copies, folder)
             VALUES ('huge', ?1, '2026-08-25T01:18:16.000Z', '[\"logs\"]', 1, '[\"a\"]', 'logs')",
            [&huge],
        )
        .unwrap();
        conn.execute("INSERT INTO clipboard_items (id, kind, image_path, created_utc, deleted) VALUES ('img', 'image', 'a.png', '2026-08-26T00:00:00.000Z', 1)", []).unwrap();
        run_migrations(&conn).unwrap();

        let (text, preview, len, tags, pinned): (String, String, i64, String, i64) = conn
            .query_row("SELECT text, preview, text_len, tags, pinned FROM clipboard_items WHERE id = 'huge'", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap();
        assert_eq!(text.len(), 2_000_000, "full text survives");
        assert_eq!(preview.len(), 8192);
        assert_eq!(len, 2_000_000);
        assert_eq!((tags.as_str(), pinned), ("[\"logs\"]", 1));
        let deleted: i64 = conn.query_row("SELECT deleted FROM clipboard_items WHERE id = 'img'", [], |r| r.get(0)).unwrap();
        assert_eq!(deleted, 1, "tombstones survive");
        let columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('clipboard_items')")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|c| c.unwrap())
            .collect();
        assert_eq!(columns.last().map(String::as_str), Some("text"));
    }

    #[test]
    fn migration_29_triggers_follow_every_writer() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        notes_v28(&conn);
        run_migrations(&conn).unwrap();
        let rev = |c: &rusqlite::Connection| -> i64 { c.query_row("SELECT rev FROM clipboard_meta", [], |r| r.get(0)).unwrap() };
        let row = |c: &rusqlite::Connection| -> (i64, Option<String>, i64) {
            c.query_row("SELECT rev, preview, text_len FROM clipboard_items WHERE id = 'n'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap()
        };
        assert_eq!(rev(&conn), 0);
        conn.execute("INSERT INTO clipboard_items (id, text, created_utc) VALUES ('n', 'hello', 'x')", []).unwrap();
        let (r1, preview, len) = row(&conn);
        assert_eq!((preview.as_deref(), len), (Some("hello"), 5));
        assert_eq!(r1, rev(&conn), "a row carries the revision that created it");

        conn.execute("UPDATE clipboard_items SET pinned = 1 WHERE id = 'n'", []).unwrap();
        let (r2, _, _) = row(&conn);
        assert!(r2 > r1, "a metadata change is visible to other processes");

        conn.execute("UPDATE clipboard_items SET text = 'changed text' WHERE id = 'n'", []).unwrap();
        let (r3, preview, len) = row(&conn);
        assert!(r3 > r2);
        assert_eq!((preview.as_deref(), len), (Some("changed text"), 12));

        conn.execute("UPDATE clipboard_items SET text = NULL, deleted = 1 WHERE id = 'n'", []).unwrap();
        let (_, preview, len) = row(&conn);
        assert_eq!((preview, len), (None, 0), "a tombstone keeps no text anywhere");

        let before = rev(&conn);
        conn.execute("DELETE FROM clipboard_items", []).unwrap();
        assert!(rev(&conn) > before);
    }

    #[test]
    fn migration_29_stops_cleanly_if_the_rebuild_fails() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        notes_v28(&conn);
        // Something already in the way: the rebuild must roll back, not half-apply.
        conn.execute_batch("CREATE TABLE clipboard_meta (x);").unwrap();
        conn.execute("INSERT INTO clipboard_items (id, text, created_utc) VALUES ('n', 'kept', 'x')", []).unwrap();
        assert!(run_migrations(&conn).is_err());
        let text: String = conn.query_row("SELECT text FROM clipboard_items WHERE id = 'n'", [], |r| r.get(0)).unwrap();
        assert_eq!(text, "kept");
        assert_eq!(user_version(&conn).unwrap(), 28);
    }

    #[test]
    fn migration_28_moves_app_samples_to_without_rowid_and_keeps_every_row() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        // The pre-28 layout, as ensure_app_table used to create it.
        conn.execute_batch("DROP TABLE clipboard_items; DROP TABLE clipboard_meta; DROP TABLE clipboard_outbox;").unwrap();
        notes_v28(&conn);
        conn.execute_batch(
            "CREATE TABLE app_samples (
                ts TEXT NOT NULL, game_id TEXT NOT NULL,
                cpu REAL NOT NULL DEFAULT 0, ram_mb REAL NOT NULL DEFAULT 0, gpu REAL,
                PRIMARY KEY (ts, game_id));
             CREATE INDEX idx_app_samples_ts ON app_samples(ts);
             INSERT INTO app_samples VALUES ('2026-09-01T00:00:00Z', 'a', 1.5, 100, NULL);
             INSERT INTO app_samples VALUES ('2026-09-01T00:00:00Z', 'b', 2.5, 200, 7);
             INSERT INTO app_samples VALUES ('2026-09-02T00:00:00Z', 'a', 3.5, 300, NULL);
             PRAGMA user_version = 27;",
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        assert_eq!(user_version(&conn).unwrap(), 29);
        let sql: String = conn
            .query_row("SELECT sql FROM sqlite_master WHERE name = 'app_samples'", [], |r| r.get(0))
            .unwrap();
        assert!(sql.contains("WITHOUT ROWID"), "{sql}");
        let old_index: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_app_samples_ts'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(old_index, 0);
        let rows: Vec<(String, String, f64, f64, Option<f64>)> = conn
            .prepare("SELECT ts, game_id, cpu, ram_mb, gpu FROM app_samples ORDER BY ts, game_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1], ("2026-09-01T00:00:00Z".into(), "b".into(), 2.5, 200.0, Some(7.0)));
        // The tracker's upsert still works on the new layout.
        conn.execute(
            "INSERT OR REPLACE INTO app_samples(ts, game_id, cpu, ram_mb, gpu) VALUES('2026-09-02T00:00:00Z', 'a', 9, 9, NULL)",
            [],
        )
        .unwrap();
        let cpu: f64 = conn
            .query_row("SELECT cpu FROM app_samples WHERE ts = '2026-09-02T00:00:00Z' AND game_id = 'a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cpu, 9.0);

        // A second launch is a no-op.
        run_migrations(&conn).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 29);
    }

    #[test]
    fn migration_28_on_a_fresh_install_just_bumps_the_version() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 29);
        let tables: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'app_samples'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tables, 0, "created later, already WITHOUT ROWID, by ensure_app_table");
    }
}
