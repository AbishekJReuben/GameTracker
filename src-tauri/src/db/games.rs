use crate::db::models::{GameDto, GameInput};
use crate::db::{settings, DbPool, PooledConn};
use crate::error::{AppError, AppResult};
use crate::util;
use rusqlite::Row;
use std::collections::HashMap;

/// Lightweight game record used by the tracking matcher.
#[derive(Debug, Clone)]
pub struct MatchGame {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub count_background: bool,
    pub exe_paths: Vec<String>,
    pub install_folder: Option<String>,
    pub icon_path: Option<String>,
    pub cover_path: Option<String>,
    pub accent_color: Option<String>,
}

fn parse_exe_paths(json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(json).unwrap_or_default()
}

fn min_session_seconds(pool: &DbPool) -> i64 {
    settings::get_i64(pool, "min_session_seconds", 30).unwrap_or(30)
}

struct GameRow {
    id: String,
    kind: String,
    display_name: String,
    install_folder: Option<String>,
    exe_paths: Vec<String>,
    icon_path: Option<String>,
    cover_path: Option<String>,
    status: String,
    rating: Option<i64>,
    developer: Option<String>,
    release_year: Option<i64>,
    started_year: Option<i64>,
    started_month: Option<i64>,
    started_day: Option<i64>,
    completed_year: Option<i64>,
    completed_month: Option<i64>,
    completed_day: Option<i64>,
    metacritic: Option<i64>,
    notes: Option<String>,
    time_to_beat_minutes: Option<i64>,
    manual_playtime_seconds: i64,
    hltb_main_minutes: Option<i64>,
    hltb_main_extra_minutes: Option<i64>,
    hltb_completionist_minutes: Option<i64>,
    accent_color: Option<String>,
    is_enabled: bool,
    created_at: String,
    screenshots: Vec<String>,
    background_url: Option<String>,
    website: Option<String>,
    count_background: bool,
    steam_app_id: Option<i64>,
    metacritic_slug: Option<String>,
    info_json: Option<String>,
    trailer_url: Option<String>,
    theme_youtube_id: Option<String>,
    theme_audio_url: Option<String>,
    steam_achievements_unlocked: Option<i64>,
    steam_achievements_total: Option<i64>,
    steam_achievements_synced_utc: Option<String>,
    gog_product_id: Option<i64>,
    gog_achievements_unlocked: Option<i64>,
    gog_achievements_total: Option<i64>,
    gog_achievements_synced_utc: Option<String>,
}

fn map_row(r: &Row) -> rusqlite::Result<GameRow> {
    let exe_json: String = r.get("exe_paths")?;
    Ok(GameRow {
        id: r.get("id")?,
        kind: r.get::<_, String>("kind").unwrap_or_else(|_| "game".to_string()),
        display_name: r.get("display_name")?,
        install_folder: r.get("install_folder")?,
        exe_paths: parse_exe_paths(&exe_json),
        icon_path: r.get("icon_path")?,
        cover_path: r.get("cover_path")?,
        status: r.get("status")?,
        rating: r.get("rating")?,
        developer: r.get("developer")?,
        release_year: r.get("release_year")?,
        started_year: r.get("started_year")?,
        started_month: r.get("started_month")?,
        started_day: r.get("started_day")?,
        completed_year: r.get("completed_year")?,
        completed_month: r.get("completed_month")?,
        completed_day: r.get("completed_day")?,
        metacritic: r.get("metacritic")?,
        notes: r.get("notes")?,
        time_to_beat_minutes: r.get("time_to_beat_minutes")?,
        manual_playtime_seconds: r.get::<_, i64>("manual_playtime_seconds").unwrap_or(0),
        hltb_main_minutes: r.get("hltb_main_minutes")?,
        hltb_main_extra_minutes: r.get("hltb_main_extra_minutes")?,
        hltb_completionist_minutes: r.get("hltb_completionist_minutes")?,
        accent_color: r.get("accent_color")?,
        is_enabled: r.get::<_, i64>("is_enabled")? != 0,
        created_at: r.get("created_at")?,
        screenshots: r
            .get::<_, String>("screenshots")
            .ok()
            .map(|j| parse_exe_paths(&j))
            .unwrap_or_default(),
        background_url: r.get::<_, Option<String>>("background_url").ok().flatten(),
        website: r.get::<_, Option<String>>("website").ok().flatten(),
        count_background: r.get::<_, i64>("count_background").unwrap_or(1) != 0,
        steam_app_id: r.get::<_, Option<i64>>("steam_app_id").ok().flatten(),
        metacritic_slug: r.get::<_, Option<String>>("metacritic_slug").ok().flatten(),
        info_json: r.get::<_, Option<String>>("info_json").ok().flatten(),
        trailer_url: r.get::<_, Option<String>>("trailer_url").ok().flatten(),
        theme_youtube_id: r.get::<_, Option<String>>("theme_youtube_id").ok().flatten(),
        theme_audio_url: r.get::<_, Option<String>>("theme_audio_url").ok().flatten(),
        steam_achievements_unlocked: r
            .get::<_, Option<i64>>("steam_achievements_unlocked")
            .ok()
            .flatten(),
        steam_achievements_total: r
            .get::<_, Option<i64>>("steam_achievements_total")
            .ok()
            .flatten(),
        steam_achievements_synced_utc: r
            .get::<_, Option<String>>("steam_achievements_synced_utc")
            .ok()
            .flatten(),
        gog_product_id: r.get::<_, Option<i64>>("gog_product_id").ok().flatten(),
        gog_achievements_unlocked: r
            .get::<_, Option<i64>>("gog_achievements_unlocked")
            .ok()
            .flatten(),
        gog_achievements_total: r
            .get::<_, Option<i64>>("gog_achievements_total")
            .ok()
            .flatten(),
        gog_achievements_synced_utc: r
            .get::<_, Option<String>>("gog_achievements_synced_utc")
            .ok()
            .flatten(),
    })
}

#[derive(Default, Clone)]
struct Stat {
    runtime: i64,
    active: i64,
    count: i64,
    last: Option<String>,
    first: Option<String>,
}

fn stats_map(conn: &PooledConn, min_seconds: i64) -> AppResult<HashMap<String, Stat>> {
    let mut stmt = conn.prepare(
        "SELECT game_id,
                COALESCE(SUM(runtime_seconds),0) AS rt,
                COALESCE(SUM(active_seconds),0)  AS act,
                COUNT(*) AS cnt,
                MAX(COALESCE(end_utc, last_seen_utc)) AS last,
                MIN(start_utc) AS first
         FROM sessions
         WHERE end_utc IS NOT NULL AND runtime_seconds >= ?1
         GROUP BY game_id",
    )?;
    let rows = stmt.query_map([min_seconds], |r| {
        Ok((
            r.get::<_, String>(0)?,
            Stat {
                runtime: r.get(1)?,
                active: r.get(2)?,
                count: r.get(3)?,
                last: r.get(4)?,
                first: r.get(5)?,
            },
        ))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (id, s) = row?;
        map.insert(id, s);
    }
    Ok(map)
}

fn tags_map(conn: &PooledConn) -> AppResult<HashMap<String, Vec<String>>> {
    let mut stmt = conn.prepare(
        "SELECT gt.game_id, t.name FROM game_tags gt
         JOIN tags t ON t.id = gt.tag_id ORDER BY t.name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let (gid, name) = row?;
        map.entry(gid).or_default().push(name);
    }
    Ok(map)
}

fn to_dto(g: GameRow, stat: &Stat, tags: Vec<String>) -> GameDto {
    let manual = g.manual_playtime_seconds.max(0);
    GameDto {
        is_tracked: !g.exe_paths.is_empty() || g.install_folder.is_some(),
        tracked_runtime_seconds: stat.runtime,
        tracked_active_seconds: stat.active,
        total_runtime_seconds: stat.runtime + manual,
        total_active_seconds: stat.active + manual,
        session_count: stat.count,
        last_played_utc: stat.last.clone(),
        first_played_utc: stat.first.clone(),
        manual_playtime_seconds: manual,
        id: g.id,
        kind: g.kind,
        display_name: g.display_name,
        install_folder: g.install_folder,
        exe_paths: g.exe_paths,
        icon_path: g.icon_path,
        cover_path: g.cover_path,
        status: g.status,
        rating: g.rating,
        developer: g.developer,
        release_year: g.release_year,
        started_year: g.started_year,
        started_month: g.started_month,
        started_day: g.started_day,
        completed_year: g.completed_year,
        completed_month: g.completed_month,
        completed_day: g.completed_day,
        metacritic: g.metacritic,
        notes: g.notes,
        time_to_beat_minutes: g.time_to_beat_minutes,
        hltb_main_minutes: g.hltb_main_minutes,
        hltb_main_extra_minutes: g.hltb_main_extra_minutes,
        hltb_completionist_minutes: g.hltb_completionist_minutes,
        accent_color: g.accent_color,
        is_enabled: g.is_enabled,
        created_at: g.created_at,
        tags,
        screenshots: g.screenshots,
        background_url: g.background_url,
        website: g.website,
        count_background: g.count_background,
        steam_app_id: g.steam_app_id,
        metacritic_slug: g.metacritic_slug,
        info_json: g.info_json,
        trailer_url: g.trailer_url,
        theme_youtube_id: g.theme_youtube_id,
        theme_audio_url: g.theme_audio_url,
        steam_achievements_unlocked: g.steam_achievements_unlocked,
        steam_achievements_total: g.steam_achievements_total,
        steam_achievements_synced_utc: g.steam_achievements_synced_utc,
        gog_product_id: g.gog_product_id,
        gog_achievements_unlocked: g.gog_achievements_unlocked,
        gog_achievements_total: g.gog_achievements_total,
        gog_achievements_synced_utc: g.gog_achievements_synced_utc,
    }
}

pub fn list(pool: &DbPool) -> AppResult<Vec<GameDto>> {
    let min_seconds = min_session_seconds(pool);
    let conn = pool.get()?;
    let stats = stats_map(&conn, min_seconds)?;
    let mut tags = tags_map(&conn)?;
    let mut stmt = conn.prepare("SELECT * FROM games ORDER BY display_name COLLATE NOCASE")?;
    let rows = stmt.query_map([], map_row)?;
    let mut out = Vec::new();
    for row in rows {
        let g = row?;
        let stat = stats.get(&g.id).cloned().unwrap_or_default();
        let t = tags.remove(&g.id).unwrap_or_default();
        out.push(to_dto(g, &stat, t));
    }
    Ok(out)
}

pub fn get(pool: &DbPool, id: &str) -> AppResult<Option<GameDto>> {
    let min_seconds = min_session_seconds(pool);
    let conn = pool.get()?;
    let stats = stats_map(&conn, min_seconds)?;
    let mut tags = tags_map(&conn)?;
    let mut stmt = conn.prepare("SELECT * FROM games WHERE id = ?1")?;
    let mut rows = stmt.query_map([id], map_row)?;
    if let Some(row) = rows.next() {
        let g = row?;
        let stat = stats.get(&g.id).cloned().unwrap_or_default();
        let t = tags.remove(&g.id).unwrap_or_default();
        return Ok(Some(to_dto(g, &stat, t)));
    }
    Ok(None)
}

/// Insert or update. Returns the game id.
pub fn upsert(pool: &DbPool, input: GameInput) -> AppResult<String> {
    let name = input.display_name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::msg("Game name is required."));
    }
    let exe_paths: Vec<String> = input
        .exe_paths
        .iter()
        .map(|p| util::normalize_path(p))
        .filter(|p| !p.is_empty())
        .collect();
    let exe_json = serde_json::to_string(&exe_paths)?;
    let install = input
        .install_folder
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(util::normalize_path);

    let manual = input.manual_playtime_seconds.unwrap_or(0).max(0);
    let kind = if input.kind == "app" { "app" } else { "game" };
    // Apps track in the background like games by default; users can opt an
    // individual app out via the "Also count background time" toggle.
    let count_bg = match input.count_background {
        Some(v) => if v { 1i64 } else { 0 },
        None => 1,
    };

    let mut conn = pool.get()?;
    let tx = conn.transaction()?;

    let id = match input.id {
        Some(existing) => {
            tx.execute(
                "UPDATE games SET display_name=?1, install_folder=?2, exe_paths=?3,
                    status=?4, rating=?5, developer=?6, release_year=?7,
                    started_year=?8, started_month=?9, started_day=?10,
                    completed_year=?11, completed_month=?12, completed_day=?13,
                    metacritic=?14, notes=?15, time_to_beat_minutes=?16,
                    manual_playtime_seconds=?17, accent_color=?18,
                    cover_path=COALESCE(?19, cover_path),
                    count_background=COALESCE(?21, count_background)
                 WHERE id=?20",
                rusqlite::params![
                    name,
                    install,
                    exe_json,
                    input.status,
                    input.rating,
                    input.developer,
                    input.release_year,
                    input.started_year,
                    input.started_month,
                    input.started_day,
                    input.completed_year,
                    input.completed_month,
                    input.completed_day,
                    input.metacritic,
                    input.notes,
                    input.time_to_beat_minutes,
                    manual,
                    input.accent_color,
                    input.cover_path,
                    existing,
                    input.count_background.map(|v| if v { 1i64 } else { 0 }),
                ],
            )?;
            existing
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO games(id, kind, display_name, install_folder, exe_paths, cover_path,
                    status, rating, developer, release_year,
                    started_year, started_month, started_day,
                    completed_year, completed_month, completed_day,
                    metacritic, notes, time_to_beat_minutes, manual_playtime_seconds,
                    accent_color, is_enabled, created_at, count_background)
                 VALUES(?1,?22,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,1,?21,?23)",
                rusqlite::params![
                    id,
                    name,
                    install,
                    exe_json,
                    input.cover_path,
                    input.status,
                    input.rating,
                    input.developer,
                    input.release_year,
                    input.started_year,
                    input.started_month,
                    input.started_day,
                    input.completed_year,
                    input.completed_month,
                    input.completed_day,
                    input.metacritic,
                    input.notes,
                    input.time_to_beat_minutes,
                    manual,
                    input.accent_color,
                    util::now_utc_string(),
                    kind,
                    count_bg,
                ],
            )?;
            id
        }
    };

    set_tags_tx(&tx, &id, &input.tags)?;
    tx.commit()?;
    Ok(id)
}

fn set_tags_tx(tx: &rusqlite::Transaction, game_id: &str, tags: &[String]) -> AppResult<()> {
    tx.execute("DELETE FROM game_tags WHERE game_id = ?1", [game_id])?;
    for raw in tags {
        let name = raw.trim();
        if name.is_empty() {
            continue;
        }
        let tag_id: String = match tx.query_row(
            "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
            [name],
            |r| r.get(0),
        ) {
            Ok(id) => id,
            Err(_) => {
                let id = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO tags(id, name) VALUES(?1, ?2)",
                    rusqlite::params![id, name],
                )?;
                id
            }
        };
        tx.execute(
            "INSERT OR IGNORE INTO game_tags(game_id, tag_id) VALUES(?1, ?2)",
            rusqlite::params![game_id, tag_id],
        )?;
    }
    Ok(())
}

pub fn set_status(pool: &DbPool, id: &str, status: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET status = ?1 WHERE id = ?2",
        rusqlite::params![status, id],
    )?;
    Ok(())
}

pub fn set_icon_path(pool: &DbPool, id: &str, icon_path: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET icon_path = ?1 WHERE id = ?2",
        rusqlite::params![icon_path, id],
    )?;
    Ok(())
}

pub fn set_cover_path(pool: &DbPool, id: &str, cover_path: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET cover_path = ?1 WHERE id = ?2",
        rusqlite::params![cover_path, id],
    )?;
    Ok(())
}

/// Store screenshot/asset URLs (replaces existing) plus optional background + website.
/// Empty inputs are ignored so a second source can't wipe a first.
pub fn set_media(
    pool: &DbPool,
    id: &str,
    screenshots: &[String],
    background_url: Option<&str>,
    website: Option<&str>,
    trailer_url: Option<&str>,
) -> AppResult<()> {
    let conn = pool.get()?;
    if !screenshots.is_empty() {
        let json = serde_json::to_string(screenshots)?;
        conn.execute(
            "UPDATE games SET screenshots = ?1 WHERE id = ?2",
            rusqlite::params![json, id],
        )?;
    }
    if let Some(bg) = background_url.filter(|s| !s.trim().is_empty()) {
        conn.execute(
            "UPDATE games SET background_url = ?1 WHERE id = ?2",
            rusqlite::params![bg, id],
        )?;
    }
    if let Some(site) = website.filter(|s| !s.trim().is_empty()) {
        conn.execute(
            "UPDATE games SET website = ?1 WHERE id = ?2",
            rusqlite::params![site, id],
        )?;
    }
    if let Some(trailer) = trailer_url.filter(|s| !s.trim().is_empty()) {
        conn.execute(
            "UPDATE games SET trailer_url = ?1 WHERE id = ?2",
            rusqlite::params![trailer, id],
        )?;
    }
    Ok(())
}

/// Persist the resolved per-game theme (YouTube video id and/or iTunes preview).
pub fn set_theme(
    pool: &DbPool,
    id: &str,
    youtube_id: Option<&str>,
    audio_url: Option<&str>,
) -> AppResult<()> {
    let conn = pool.get()?;
    if let Some(yt) = youtube_id.filter(|s| !s.trim().is_empty()) {
        conn.execute(
            "UPDATE games SET theme_youtube_id = ?1 WHERE id = ?2",
            rusqlite::params![yt, id],
        )?;
    }
    if let Some(audio) = audio_url.filter(|s| !s.trim().is_empty()) {
        conn.execute(
            "UPDATE games SET theme_audio_url = ?1 WHERE id = ?2",
            rusqlite::params![audio, id],
        )?;
    }
    Ok(())
}

/// Refresh personal and critic scores from a CSV re-import (matched by display name).
pub fn update_scores(
    pool: &DbPool,
    display_name: &str,
    rating: Option<i64>,
    metacritic: Option<i64>,
) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET rating = ?1, metacritic = ?2 WHERE display_name = ?3 COLLATE NOCASE",
        rusqlite::params![rating, metacritic, display_name],
    )?;
    Ok(())
}

/// Apply online metadata — fills empty text fields, merges genre tags, optional cover.
pub fn apply_metadata(
    pool: &DbPool,
    id: &str,
    developer: Option<&str>,
    release_year: Option<i64>,
    metacritic: Option<i64>,
    notes: Option<&str>,
    genre_tags: &[String],
    cover_path: Option<&str>,
) -> AppResult<()> {
    let mut conn = pool.get()?;
    let tx = conn.transaction()?;

    let (cur_dev, cur_year, cur_meta, cur_notes, cur_cover): (
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<String>,
    ) = tx.query_row(
        "SELECT developer, release_year, metacritic, notes, cover_path FROM games WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;

    let developer = developer
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .or(cur_dev);
    let release_year = release_year.or(cur_year);
    let metacritic = metacritic.or(cur_meta);
    let notes = notes
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .or(cur_notes);
    let cover = cover_path
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .or(cur_cover);

    tx.execute(
        "UPDATE games SET developer=?1, release_year=?2, metacritic=?3, notes=?4, cover_path=?5 WHERE id=?6",
        rusqlite::params![developer, release_year, metacritic, notes, cover, id],
    )?;

    if !genre_tags.is_empty() {
        let existing: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT t.name FROM game_tags gt JOIN tags t ON t.id = gt.tag_id WHERE gt.game_id = ?1",
            )?;
            let rows = stmt.query_map([id], |r| r.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let mut merged = existing;
        for g in genre_tags {
            let g = g.trim();
            if g.is_empty() {
                continue;
            }
            if !merged.iter().any(|t| t.eq_ignore_ascii_case(g)) {
                merged.push(g.to_string());
            }
        }
        set_tags_tx(&tx, id, &merged)?;
    }

    tx.commit()?;
    Ok(())
}

/// Store HLTB estimates and optionally seed manual playtime from Main+Extra.
pub fn apply_hltb(
    pool: &DbPool,
    id: &str,
    times: &crate::hltb::HltbTimes,
    apply_main_extra_as_manual: bool,
) -> AppResult<()> {
    let conn = pool.get()?;
    let manual_add = if apply_main_extra_as_manual {
        times
            .main_extra_minutes
            .map(|m| m * 60)
            .unwrap_or(0)
    } else {
        0
    };
    if apply_main_extra_as_manual && manual_add > 0 {
        conn.execute(
            "UPDATE games SET hltb_main_minutes=?1, hltb_main_extra_minutes=?2, hltb_completionist_minutes=?3,
             manual_playtime_seconds = CASE WHEN manual_playtime_seconds > 0 THEN manual_playtime_seconds ELSE ?4 END
             WHERE id=?5",
            rusqlite::params![
                times.main_minutes,
                times.main_extra_minutes,
                times.completionist_minutes,
                manual_add,
                id,
            ],
        )?;
    } else {
        conn.execute(
            "UPDATE games SET hltb_main_minutes=?1, hltb_main_extra_minutes=?2, hltb_completionist_minutes=?3 WHERE id=?4",
            rusqlite::params![
                times.main_minutes,
                times.main_extra_minutes,
                times.completionist_minutes,
                id,
            ],
        )?;
    }
    Ok(())
}

pub fn set_manual_playtime(pool: &DbPool, id: &str, seconds: i64) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET manual_playtime_seconds = ?1 WHERE id = ?2",
        rusqlite::params![seconds.max(0), id],
    )?;
    Ok(())
}

pub fn update_manual_playtime_by_name(
    pool: &DbPool,
    display_name: &str,
    seconds: i64,
) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET manual_playtime_seconds = ?1
         WHERE display_name = ?2 COLLATE NOCASE",
        rusqlite::params![seconds.max(0), display_name],
    )?;
    Ok(())
}

pub fn id_by_name(pool: &DbPool, name: &str) -> AppResult<Option<String>> {
    let conn = pool.get()?;
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM games WHERE display_name = ?1 COLLATE NOCASE",
            [name],
            |r| r.get(0),
        )
        .ok();
    Ok(id)
}

pub fn delete(pool: &DbPool, id: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute("DELETE FROM games WHERE id = ?1", [id])?;
    Ok(())
}

pub fn exists_by_name(pool: &DbPool, name: &str) -> AppResult<bool> {
    let conn = pool.get()?;
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM games WHERE display_name = ?1 COLLATE NOCASE",
        [name],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub fn set_steam_app_id(pool: &DbPool, id: &str, app_id: i64) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET steam_app_id = ?1 WHERE id = ?2",
        rusqlite::params![app_id, id],
    )?;
    Ok(())
}

/// Read the cached live-stats blob and when it was fetched (RFC3339 UTC), if any.
pub fn get_stats_cache(pool: &DbPool, id: &str) -> AppResult<(Option<String>, Option<String>)> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT stats_json, stats_fetched_utc FROM games WHERE id = ?1")?;
    let mut rows = stmt.query(rusqlite::params![id])?;
    if let Some(r) = rows.next()? {
        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?))
    } else {
        Ok((None, None))
    }
}

/// Persist a fetched live-stats blob and its fetch timestamp on the game row.
pub fn set_stats_cache(pool: &DbPool, id: &str, stats_json: &str, fetched_utc: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET stats_json = ?1, stats_fetched_utc = ?2 WHERE id = ?3",
        rusqlite::params![stats_json, fetched_utc, id],
    )?;
    Ok(())
}

pub fn clear_steam_app_id(pool: &DbPool, id: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET steam_app_id = NULL WHERE id = ?1",
        rusqlite::params![id],
    )?;
    Ok(())
}

pub fn id_by_steam_app_id(pool: &DbPool, app_id: i64) -> AppResult<Option<String>> {
    let conn = pool.get()?;
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM games WHERE steam_app_id = ?1 AND kind = 'game' LIMIT 1",
            [app_id],
            |r| r.get(0),
        )
        .ok();
    Ok(id)
}

/// Fuzzy name match against existing games (for Steam library import).
pub fn id_by_fuzzy_name(pool: &DbPool, name: &str) -> AppResult<Option<String>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, display_name FROM games WHERE kind = 'game' ORDER BY display_name",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, existing) = row?;
        if crate::metadata::names_match(name, &existing) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

pub fn set_gog_product_id(pool: &DbPool, id: &str, product_id: i64) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET gog_product_id = ?1 WHERE id = ?2",
        rusqlite::params![product_id, id],
    )?;
    Ok(())
}

pub fn id_by_gog_product_id(pool: &DbPool, product_id: i64) -> AppResult<Option<String>> {
    let conn = pool.get()?;
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM games WHERE gog_product_id = ?1 AND kind = 'game' LIMIT 1",
            [product_id],
            |r| r.get(0),
        )
        .ok();
    Ok(id)
}

pub fn find_by_name(pool: &DbPool, name: &str) -> AppResult<Option<String>> {
    let conn = pool.get()?;
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM games WHERE display_name = ?1 COLLATE NOCASE AND kind = 'game' LIMIT 1",
            [name],
            |r| r.get(0),
        )
        .ok();
    Ok(id)
}

pub fn find_by_install_or_name(
    pool: &DbPool,
    install_folder: Option<&str>,
    name: &str,
) -> AppResult<Option<String>> {
    if let Some(folder) = install_folder.filter(|s| !s.trim().is_empty()) {
        let norm = util::normalize_path(folder);
        let conn = pool.get()?;
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM games WHERE install_folder = ?1 AND kind = 'game' LIMIT 1",
                [norm],
                |r| r.get(0),
            )
            .ok();
        if id.is_some() {
            return Ok(id);
        }
    }
    find_by_name(pool, name)
}

pub fn set_install_folder(pool: &DbPool, id: &str, folder: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET install_folder = ?1 WHERE id = ?2",
        rusqlite::params![util::normalize_path(folder), id],
    )?;
    Ok(())
}

pub fn add_exe_path(pool: &DbPool, id: &str, exe: &str) -> AppResult<()> {
    let game = get(pool, id)?;
    let Some(mut g) = game else {
        return Ok(());
    };
    let norm = util::normalize_path(exe);
    if g.exe_paths.iter().any(|p| util::paths_equal(p, &norm)) {
        return Ok(());
    }
    g.exe_paths.push(norm);
    let json = serde_json::to_string(&g.exe_paths)?;
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET exe_paths = ?1 WHERE id = ?2",
        rusqlite::params![json, id],
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct GogLinkedGame {
    pub id: String,
    pub display_name: String,
    pub gog_product_id: Option<i64>,
}

pub fn list_with_gog_product_id(pool: &DbPool) -> AppResult<Vec<GogLinkedGame>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, display_name, gog_product_id FROM games
         WHERE kind = 'game' AND gog_product_id IS NOT NULL AND gog_product_id > 0",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(GogLinkedGame {
            id: r.get(0)?,
            display_name: r.get(1)?,
            gog_product_id: r.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn set_gog_achievements(
    pool: &DbPool,
    id: &str,
    unlocked: i64,
    total: i64,
    achievements_json: Option<&str>,
) -> AppResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET gog_achievements_unlocked = ?1,
                          gog_achievements_total = ?2,
                          gog_achievements_synced_utc = ?3,
                          gog_achievements_json = ?4
         WHERE id = ?5",
        rusqlite::params![unlocked, total, now, achievements_json, id],
    )?;
    Ok(())
}

pub fn gog_achievements_json(pool: &DbPool, id: &str) -> AppResult<Option<String>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT gog_achievements_json FROM games WHERE id = ?1")?;
    let mut rows = stmt.query([id])?;
    if let Some(row) = rows.next()? {
        return Ok(row.get(0)?);
    }
    Ok(None)
}

/// Bump manual playtime so tracked+manual meets Steam's official total. Never decreases.
/// Returns true when manual playtime was increased.
pub fn apply_steam_playtime(pool: &DbPool, id: &str, steam_seconds: i64) -> AppResult<bool> {
    if steam_seconds <= 0 {
        return Ok(false);
    }
    let min_seconds = min_session_seconds(pool);
    let conn = pool.get()?;
    let (manual, tracked): (i64, i64) = conn.query_row(
        "SELECT g.manual_playtime_seconds,
                COALESCE((
                    SELECT SUM(s.runtime_seconds) FROM sessions s
                    WHERE s.game_id = g.id AND s.end_utc IS NOT NULL AND s.runtime_seconds >= ?2
                ), 0)
         FROM games g WHERE g.id = ?1",
        rusqlite::params![id, min_seconds],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let current_total = manual.max(0) + tracked.max(0);
    if steam_seconds <= current_total {
        return Ok(false);
    }
    let new_manual = steam_seconds - tracked.max(0);
    conn.execute(
        "UPDATE games SET manual_playtime_seconds = ?1 WHERE id = ?2",
        rusqlite::params![new_manual.max(0), id],
    )?;
    Ok(true)
}

pub fn set_steam_achievements(
    pool: &DbPool,
    id: &str,
    unlocked: i64,
    total: i64,
    achievements_json: Option<&str>,
) -> AppResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET steam_achievements_unlocked = ?1,
                          steam_achievements_total = ?2,
                          steam_achievements_synced_utc = ?3,
                          steam_achievements_json = ?4
         WHERE id = ?5",
        rusqlite::params![unlocked, total, now, achievements_json, id],
    )?;
    Ok(())
}

pub fn steam_achievements_json(pool: &DbPool, id: &str) -> AppResult<Option<String>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT steam_achievements_json FROM games WHERE id = ?1")?;
    let mut rows = stmt.query(rusqlite::params![id])?;
    if let Some(row) = rows.next()? {
        let json: Option<String> = row.get(0)?;
        Ok(json.filter(|s| !s.trim().is_empty()))
    } else {
        Ok(None)
    }
}

/// All games with stored per-achievement JSON (for library-wide stats).
pub fn list_steam_achievement_rows(pool: &DbPool) -> AppResult<Vec<(String, String, String)>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, display_name, steam_achievements_json
         FROM games
         WHERE kind = 'game'
           AND steam_achievements_json IS NOT NULL
           AND TRIM(steam_achievements_json) != ''",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let name: String = row.get(1)?;
        let json: String = row.get(2)?;
        out.push((id, name, json));
    }
    Ok(out)
}

pub fn set_metacritic_slug(pool: &DbPool, id: &str, slug: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET metacritic_slug = ?1 WHERE id = ?2",
        rusqlite::params![slug, id],
    )?;
    Ok(())
}

pub fn set_info_json(pool: &DbPool, id: &str, json: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE games SET info_json = ?1 WHERE id = ?2",
        rusqlite::params![json, id],
    )?;
    Ok(())
}

/// Games eligible for live matching (enabled, with exe paths or an install folder).
pub fn match_candidates(pool: &DbPool) -> AppResult<Vec<MatchGame>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, display_name, kind, count_background, exe_paths, install_folder, icon_path, accent_color, cover_path
         FROM games WHERE is_enabled = 1",
    )?;
    let rows = stmt.query_map([], |r| {
        let exe_json: String = r.get(4)?;
        Ok(MatchGame {
            id: r.get(0)?,
            display_name: r.get(1)?,
            kind: r.get::<_, String>(2).unwrap_or_else(|_| "game".to_string()),
            count_background: r.get::<_, i64>(3).unwrap_or(1) != 0,
            exe_paths: parse_exe_paths(&exe_json),
            install_folder: r.get(5)?,
            icon_path: r.get(6)?,
            accent_color: r.get(7)?,
            cover_path: r.get(8)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        let g = row?;
        if !g.exe_paths.is_empty() || g.install_folder.is_some() {
            out.push(g);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn test_pool() -> DbPool {
        let path = std::env::temp_dir().join(format!("gt_steam_playtime_{}.db", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_file(&path);
        db::init_pool(&path).expect("pool")
    }

    #[test]
    fn apply_steam_playtime_only_increases() {
        let pool = test_pool();
        let id = upsert(
            &pool,
            GameInput {
                id: None,
                kind: "game".into(),
                display_name: "Test Game".into(),
                install_folder: None,
                exe_paths: vec![],
                cover_path: None,
                status: "backlog".into(),
                rating: None,
                developer: None,
                release_year: None,
                started_year: None,
                started_month: None,
                started_day: None,
                completed_year: None,
                completed_month: None,
                completed_day: None,
                metacritic: None,
                notes: None,
                time_to_beat_minutes: None,
                manual_playtime_seconds: Some(1800),
                accent_color: None,
                tags: vec![],
                count_background: None,
                steam_app_id: Some(123),
                gog_product_id: None,
            },
        )
        .unwrap();
        assert!(!apply_steam_playtime(&pool, &id, 1800).unwrap());
        assert!(apply_steam_playtime(&pool, &id, 7200).unwrap());
        let g = get(&pool, &id).unwrap().unwrap();
        assert_eq!(g.manual_playtime_seconds, 7200);
        assert!(!apply_steam_playtime(&pool, &id, 3600).unwrap());
    }
}
