use crate::db::models::SessionDto;
use crate::db::{sessions, DbPool};
use crate::error::AppResult;
use chrono::{Datelike, Duration, Local, NaiveDate, Timelike, Utc};
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopGame {
    pub id: String,
    pub name: String,
    pub icon_path: Option<String>,
    pub cover_path: Option<String>,
    pub accent_color: Option<String>,
    pub runtime_seconds: i64,
    pub active_seconds: i64,
    pub session_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayValue {
    pub date: String, // YYYY-MM-DD (local)
    pub seconds: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHighlight {
    pub seconds: i64,
    pub game_id: String,
    pub game_name: String,
    pub start_utc: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub today_runtime: i64,
    pub today_active: i64,
    pub week_runtime: i64,
    pub week_active: i64,
    pub month_runtime: i64,
    pub month_active: i64,
    pub total_runtime: i64,
    pub total_active: i64,
    pub session_count: i64,
    pub games_total: i64,
    pub games_tracked: i64,
    pub games_completed: i64,
    pub games_backlog: i64,
    pub games_playing: i64,
    pub games_dropped: i64,
    pub current_streak: i64,
    pub longest_streak: i64,
    pub unique_games_played: i64,
    pub avg_session_runtime: f64,
    pub avg_session_active: f64,
    pub focus_ratio: f64,
    pub top_games: Vec<TopGame>,
    pub recent_sessions: Vec<SessionDto>,
    pub last14: Vec<DayValue>,
    pub week_active_prev: i64,
    pub week_runtime_prev: i64,
    pub longest_session: Option<SessionHighlight>,
}

struct RawSession {
    start: chrono::DateTime<Utc>,
    runtime: i64,
    active: i64,
}

fn raw_sessions(pool: &DbPool, min_seconds: i64, kind: &str) -> AppResult<Vec<RawSession>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT s.start_utc, s.runtime_seconds, s.active_seconds FROM sessions s
         JOIN games g ON g.id = s.game_id
         WHERE s.end_utc IS NOT NULL AND s.runtime_seconds >= ?1 AND g.kind = ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![min_seconds, kind], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (s, rt, act) = row?;
        if let Some(start) = sessions::parse(&s) {
            out.push(RawSession {
                start,
                runtime: rt,
                active: act,
            });
        }
    }
    Ok(out)
}

fn local_day(dt: &chrono::DateTime<Utc>) -> NaiveDate {
    dt.with_timezone(&Local).date_naive()
}

/// Per-local-day active seconds map.
fn day_active(raws: &[RawSession]) -> BTreeMap<NaiveDate, i64> {
    let mut map: BTreeMap<NaiveDate, i64> = BTreeMap::new();
    for r in raws {
        // Heatmap/streaks reflect engaged time; fall back to runtime when no focus was recorded.
        let value = if r.active > 0 { r.active } else { r.runtime };
        *map.entry(local_day(&r.start)).or_default() += value.max(0);
    }
    map
}

/// Per-day total running time (background included) — for app streaks/sparkline.
fn day_runtime(raws: &[RawSession]) -> BTreeMap<NaiveDate, i64> {
    let mut map: BTreeMap<NaiveDate, i64> = BTreeMap::new();
    for r in raws {
        let value = r.runtime.max(r.active).max(0);
        *map.entry(local_day(&r.start)).or_default() += value;
    }
    map
}

/// Manual / catalog playtime row for stats attribution.
struct ManualPlayRow {
    game_id: String,
    display_name: String,
    icon_path: Option<String>,
    cover_path: Option<String>,
    accent_color: Option<String>,
    manual_seconds: i64,
    completed_year: Option<i64>,
    completed_month: Option<i64>,
    completed_day: Option<i64>,
    started_year: Option<i64>,
    started_month: Option<i64>,
    started_day: Option<i64>,
}

fn date_from_parts(y: Option<i64>, m: Option<i64>, d: Option<i64>) -> Option<NaiveDate> {
    let y = y?;
    if !(1970..=2100).contains(&y) {
        return None;
    }
    let month = m.unwrap_or(1).clamp(1, 12) as u32;
    let mut day = d.unwrap_or(1).clamp(1, 31) as u32;
    while NaiveDate::from_ymd_opt(y as i32, month, day).is_none() && day > 1 {
        day -= 1;
    }
    NaiveDate::from_ymd_opt(y as i32, month, day)
}

fn manual_anchor_date(row: &ManualPlayRow) -> Option<NaiveDate> {
    date_from_parts(
        row.completed_year,
        row.completed_month,
        row.completed_day,
    )
    .or_else(|| {
        date_from_parts(
            row.started_year,
            row.started_month,
            row.started_day,
        )
    })
}

fn load_manual_play(pool: &DbPool) -> AppResult<Vec<ManualPlayRow>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, display_name, icon_path, accent_color, manual_playtime_seconds,
                completed_year, completed_month, completed_day,
                started_year, started_month, started_day, cover_path
         FROM games WHERE manual_playtime_seconds > 0 AND kind = 'game'",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ManualPlayRow {
            game_id: r.get(0)?,
            display_name: r.get(1)?,
            icon_path: r.get(2)?,
            cover_path: r.get(11)?,
            accent_color: r.get(3)?,
            manual_seconds: r.get::<_, i64>(4)?,
            completed_year: r.get(5)?,
            completed_month: r.get(6)?,
            completed_day: r.get(7)?,
            started_year: r.get(8)?,
            started_month: r.get(9)?,
            started_day: r.get(10)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn apply_manual_to_day_map(map: &mut BTreeMap<NaiveDate, i64>, manual: &[ManualPlayRow]) {
    for row in manual {
        if let Some(d) = manual_anchor_date(row) {
            *map.entry(d).or_default() += row.manual_seconds;
        }
    }
}

fn add_manual_to_period(
    manual: &[ManualPlayRow],
    today: NaiveDate,
    week_start: NaiveDate,
    prev_week_start: NaiveDate,
    month_start: NaiveDate,
) -> (i64, i64, i64, i64, i64, i64, i64, i64) {
    let mut today_rt = 0i64;
    let mut today_act = 0i64;
    let mut week_rt = 0i64;
    let mut week_act = 0i64;
    let mut week_prev_rt = 0i64;
    let mut week_prev_act = 0i64;
    let mut month_rt = 0i64;
    let mut month_act = 0i64;

    for row in manual {
        let Some(d) = manual_anchor_date(row) else { continue };
        let secs = row.manual_seconds;
        if d == today {
            today_rt += secs;
            today_act += secs;
        }
        if d >= week_start {
            week_rt += secs;
            week_act += secs;
        } else if d >= prev_week_start && d < week_start {
            week_prev_rt += secs;
            week_prev_act += secs;
        }
        if d >= month_start {
            month_rt += secs;
            month_act += secs;
        }
    }
    (
        today_rt,
        today_act,
        week_rt,
        week_act,
        week_prev_rt,
        week_prev_act,
        month_rt,
        month_act,
    )
}

fn manual_total_seconds(manual: &[ManualPlayRow]) -> i64 {
    manual.iter().map(|r| r.manual_seconds).sum()
}

fn merge_manual_top_games(
    mut games: Vec<TopGame>,
    manual: &[ManualPlayRow],
    year: Option<i64>,
    limit: usize,
) -> Vec<TopGame> {
    for row in manual {
        let Some(d) = manual_anchor_date(row) else { continue };
        if let Some(y) = year {
            if d.year() as i64 != y {
                continue;
            }
        }
        if let Some(g) = games.iter_mut().find(|g| g.id == row.game_id) {
            g.runtime_seconds += row.manual_seconds;
            g.active_seconds += row.manual_seconds;
        } else if row.manual_seconds > 0 {
            games.push(TopGame {
                id: row.game_id.clone(),
                name: row.display_name.clone(),
                icon_path: row.icon_path.clone(),
                cover_path: row.cover_path.clone(),
                accent_color: row.accent_color.clone(),
                runtime_seconds: row.manual_seconds,
                active_seconds: row.manual_seconds,
                session_count: 0,
            });
        }
    }
    games.sort_by(|a, b| b.active_seconds.cmp(&a.active_seconds).then(b.runtime_seconds.cmp(&a.runtime_seconds)));
    games.truncate(limit);
    games
}

fn apply_manual_to_insights(
    manual: &[ManualPlayRow],
    year: i64,
    year_start: NaiveDate,
    year_end: NaiveDate,
    active_seconds: &mut i64,
    runtime_seconds: &mut i64,
    game_ids: &mut std::collections::HashSet<String>,
    month_map: &mut BTreeMap<(i32, u32), i64>,
    day_map: &mut BTreeMap<NaiveDate, i64>,
) {
    for row in manual {
        let Some(d) = manual_anchor_date(row) else { continue };
        if d < year_start || d > year_end || d.year() as i64 != year {
            continue;
        }
        *active_seconds += row.manual_seconds;
        *runtime_seconds += row.manual_seconds;
        game_ids.insert(row.game_id.clone());
        day_map
            .entry(d)
            .and_modify(|v| *v += row.manual_seconds)
            .or_insert(row.manual_seconds);
        let key = (d.year(), d.month());
        *month_map.entry(key).or_default() += row.manual_seconds;
    }
}

fn streaks(days: &BTreeMap<NaiveDate, i64>) -> (i64, i64) {
    let active_days: Vec<NaiveDate> = days
        .iter()
        .filter(|(_, &v)| v > 0)
        .map(|(d, _)| *d)
        .collect();
    if active_days.is_empty() {
        return (0, 0);
    }
    let set: std::collections::HashSet<NaiveDate> = active_days.iter().copied().collect();

    // longest
    let mut longest = 1i64;
    let mut run = 1i64;
    for w in active_days.windows(2) {
        if (w[1] - w[0]).num_days() == 1 {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 1;
        }
    }

    // current — counting back from today (or yesterday if today empty)
    let today = Local::now().date_naive();
    let mut cursor = if set.contains(&today) {
        today
    } else {
        today - Duration::days(1)
    };
    let mut current = 0i64;
    while set.contains(&cursor) {
        current += 1;
        cursor -= Duration::days(1);
    }
    (current, longest)
}

pub fn dashboard(pool: &DbPool) -> AppResult<Dashboard> {
    let min_seconds = crate::db::settings::get_i64(pool, "min_session_seconds", 30)?;
    let raws = raw_sessions(pool, min_seconds, "game")?;
    let manual = load_manual_play(pool)?;

    let today = Local::now().date_naive();
    let week_start = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let prev_week_start = week_start - Duration::days(7);
    let month_start = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);

    let mut today_runtime = 0;
    let mut today_active = 0;
    let mut week_runtime = 0;
    let mut week_active = 0;
    let mut week_active_prev = 0;
    let mut week_runtime_prev = 0;
    let mut month_runtime = 0;
    let mut month_active = 0;
    let mut total_runtime = 0;
    let mut total_active = 0;
    for r in &raws {
        let d = local_day(&r.start);
        total_runtime += r.runtime;
        total_active += r.active;
        if d == today {
            today_runtime += r.runtime;
            today_active += r.active;
        }
        if d >= week_start {
            week_runtime += r.runtime;
            week_active += r.active;
        } else if d >= prev_week_start && d < week_start {
            week_active_prev += r.active;
            week_runtime_prev += r.runtime;
        }
        if d >= month_start {
            month_runtime += r.runtime;
            month_active += r.active;
        }
    }

    let (
        m_today_rt,
        m_today_act,
        m_week_rt,
        m_week_act,
        m_week_prev_rt,
        m_week_prev_act,
        m_month_rt,
        m_month_act,
    ) = add_manual_to_period(&manual, today, week_start, prev_week_start, month_start);
    today_runtime += m_today_rt;
    today_active += m_today_act;
    week_runtime += m_week_rt;
    week_active += m_week_act;
    week_runtime_prev += m_week_prev_rt;
    week_active_prev += m_week_prev_act;
    month_runtime += m_month_rt;
    month_active += m_month_act;
    let manual_all = manual_total_seconds(&manual);
    total_runtime += manual_all;
    total_active += manual_all;

    let mut day_map = day_active(&raws);
    apply_manual_to_day_map(&mut day_map, &manual);
    let (current_streak, longest_streak) = streaks(&day_map);

    // last 14 days sparkline
    let mut last14 = Vec::new();
    for i in (0..14).rev() {
        let d = today - Duration::days(i);
        last14.push(DayValue {
            date: d.format("%Y-%m-%d").to_string(),
            seconds: *day_map.get(&d).unwrap_or(&0),
        });
    }

    let conn = pool.get()?;
    let games_total: i64 =
        conn.query_row("SELECT COUNT(*) FROM games WHERE kind='game'", [], |r| r.get(0))?;
    let games_completed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM games WHERE kind='game' AND status='completed'",
        [],
        |r| r.get(0),
    )?;
    let games_backlog: i64 = conn.query_row(
        "SELECT COUNT(*) FROM games WHERE kind='game' AND status='backlog'",
        [],
        |r| r.get(0),
    )?;
    let games_playing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM games WHERE kind='game' AND status='playing'",
        [],
        |r| r.get(0),
    )?;
    let games_dropped: i64 = conn.query_row(
        "SELECT COUNT(*) FROM games WHERE kind='game' AND status='dropped'",
        [],
        |r| r.get(0),
    )?;
    let games_tracked: i64 = conn.query_row(
        "SELECT COUNT(*) FROM games WHERE kind='game' AND (exe_paths != '[]' OR install_folder IS NOT NULL)",
        [],
        |r| r.get(0),
    )?;
    let session_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sessions s JOIN games g ON g.id = s.game_id
         WHERE s.end_utc IS NOT NULL AND g.kind = 'game'",
        [],
        |r| r.get(0),
    )?;
    let unique_games_played: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT g.id) FROM games g
         LEFT JOIN sessions s ON s.game_id = g.id AND s.end_utc IS NOT NULL AND s.runtime_seconds >= ?1
         WHERE g.kind = 'game' AND (s.id IS NOT NULL OR g.manual_playtime_seconds > 0)",
        [min_seconds],
        |r| r.get(0),
    )?;
    let avg_session_runtime = if session_count > 0 {
        total_runtime as f64 / session_count as f64
    } else {
        0.0
    };
    let avg_session_active = if session_count > 0 {
        total_active as f64 / session_count as f64
    } else {
        0.0
    };
    let focus_ratio = if total_runtime > 0 {
        (total_active as f64 / total_runtime as f64) * 100.0
    } else {
        0.0
    };

    let longest_session: Option<SessionHighlight> = conn
        .query_row(
            "SELECT s.runtime_seconds, s.game_id, g.display_name, s.start_utc
             FROM sessions s JOIN games g ON g.id = s.game_id
             WHERE s.end_utc IS NOT NULL AND s.runtime_seconds >= ?1 AND g.kind = 'game'
             ORDER BY s.runtime_seconds DESC LIMIT 1",
            [min_seconds],
            |r| {
                Ok(SessionHighlight {
                    seconds: r.get(0)?,
                    game_id: r.get(1)?,
                    game_name: r.get(2)?,
                    start_utc: r.get(3)?,
                })
            },
        )
        .ok();

    let mut stmt = conn.prepare(
        "SELECT g.id, g.display_name, g.icon_path, g.accent_color,
                COALESCE(SUM(s.runtime_seconds),0) + g.manual_playtime_seconds,
                COALESCE(SUM(s.active_seconds),0) + g.manual_playtime_seconds,
                COUNT(s.id), g.cover_path
         FROM games g
         LEFT JOIN sessions s ON s.game_id = g.id AND s.end_utc IS NOT NULL AND s.runtime_seconds >= ?1
         WHERE g.kind = 'game'
         GROUP BY g.id
         HAVING COALESCE(SUM(s.runtime_seconds),0) + g.manual_playtime_seconds > 0
         ORDER BY 5 DESC LIMIT 6",
    )?;
    let top_games = stmt
        .query_map([min_seconds], |r| {
            Ok(TopGame {
                id: r.get(0)?,
                name: r.get(1)?,
                icon_path: r.get(2)?,
                cover_path: r.get(7)?,
                accent_color: r.get(3)?,
                runtime_seconds: r.get(4)?,
                active_seconds: r.get(5)?,
                session_count: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let recent_sessions = sessions::list(
        pool,
        &crate::db::models::SessionFilter {
            limit: Some(6),
            kind: Some("game".to_string()),
            ..Default::default()
        },
    )?;

    Ok(Dashboard {
        today_runtime,
        today_active,
        week_runtime,
        week_active,
        month_runtime,
        month_active,
        total_runtime,
        total_active,
        session_count,
        games_total,
        games_tracked,
        games_completed,
        games_backlog,
        games_playing,
        games_dropped,
        current_streak,
        longest_streak,
        unique_games_played,
        avg_session_runtime,
        avg_session_active,
        focus_ratio,
        top_games,
        recent_sessions,
        last14,
        week_active_prev,
        week_runtime_prev,
        longest_session,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppsOverview {
    pub today_active: i64,
    pub week_active: i64,
    pub month_active: i64,
    pub total_active: i64,
    // Total running time (includes background, like game runtime).
    pub today_runtime: i64,
    pub week_runtime: i64,
    pub month_runtime: i64,
    pub total_runtime: i64,
    pub session_count: i64,
    pub apps_total: i64,
    pub apps_tracked: i64,
    pub current_streak: i64,
    pub longest_streak: i64,
    pub top_apps: Vec<TopGame>,
    pub recent_sessions: Vec<SessionDto>,
    pub last14: Vec<DayValue>,
}

pub fn apps_overview(pool: &DbPool) -> AppResult<AppsOverview> {
    let min_seconds = crate::db::settings::get_i64(pool, "min_session_seconds", 30)?;
    let raws = raw_sessions(pool, min_seconds, "app")?;

    let today = Local::now().date_naive();
    let week_start = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let month_start = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);

    let mut today_active = 0i64;
    let mut week_active = 0i64;
    let mut month_active = 0i64;
    let mut total_active = 0i64;
    let mut today_runtime = 0i64;
    let mut week_runtime = 0i64;
    let mut month_runtime = 0i64;
    let mut total_runtime = 0i64;
    for r in &raws {
        let d = local_day(&r.start);
        let act = r.active.max(0);
        let run = r.runtime.max(act); // runtime is total running time, >= focused
        total_active += act;
        total_runtime += run;
        if d == today {
            today_active += act;
            today_runtime += run;
        }
        if d >= week_start {
            week_active += act;
            week_runtime += run;
        }
        if d >= month_start {
            month_active += act;
            month_runtime += run;
        }
    }

    // Streaks / sparkline reflect days the app ran (runtime), so background use counts.
    let day_map = day_runtime(&raws);
    let (current_streak, longest_streak) = streaks(&day_map);

    let mut last14 = Vec::new();
    for i in (0..14).rev() {
        let d = today - Duration::days(i);
        last14.push(DayValue {
            date: d.format("%Y-%m-%d").to_string(),
            seconds: *day_map.get(&d).unwrap_or(&0),
        });
    }

    let conn = pool.get()?;
    let apps_total: i64 =
        conn.query_row("SELECT COUNT(*) FROM games WHERE kind='app'", [], |r| r.get(0))?;
    let apps_tracked: i64 = conn.query_row(
        "SELECT COUNT(*) FROM games WHERE kind='app' AND (exe_paths != '[]' OR install_folder IS NOT NULL)",
        [],
        |r| r.get(0),
    )?;
    let session_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sessions s JOIN games g ON g.id = s.game_id
         WHERE s.end_utc IS NOT NULL AND g.kind = 'app'",
        [],
        |r| r.get(0),
    )?;

    let mut stmt = conn.prepare(
        "SELECT g.id, g.display_name, g.icon_path, g.accent_color,
                COALESCE(SUM(s.runtime_seconds),0),
                COALESCE(SUM(s.active_seconds),0),
                COUNT(s.id), g.cover_path
         FROM games g
         LEFT JOIN sessions s ON s.game_id = g.id AND s.end_utc IS NOT NULL AND s.runtime_seconds >= ?1
         WHERE g.kind = 'app'
         GROUP BY g.id
         HAVING COALESCE(SUM(s.runtime_seconds),0) > 0
         ORDER BY 5 DESC LIMIT 6",
    )?;
    let top_apps = stmt
        .query_map([min_seconds], |r| {
            Ok(TopGame {
                id: r.get(0)?,
                name: r.get(1)?,
                icon_path: r.get(2)?,
                cover_path: r.get(7)?,
                accent_color: r.get(3)?,
                runtime_seconds: r.get(4)?,
                active_seconds: r.get(5)?,
                session_count: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let recent_sessions = sessions::list(
        pool,
        &crate::db::models::SessionFilter {
            limit: Some(6),
            kind: Some("app".to_string()),
            ..Default::default()
        },
    )?;

    Ok(AppsOverview {
        today_active,
        week_active,
        month_active,
        total_active,
        today_runtime,
        week_runtime,
        month_runtime,
        total_runtime,
        session_count,
        apps_total,
        apps_tracked,
        current_streak,
        longest_streak,
        top_apps,
        recent_sessions,
        last14,
    })
}

pub fn heatmap(pool: &DbPool, days: i64, kind: Option<&str>) -> AppResult<Vec<DayValue>> {
    let kind = kind.unwrap_or("game");
    let min_seconds = crate::db::settings::get_i64(pool, "min_session_seconds", 30)?;
    let raws = raw_sessions(pool, min_seconds, kind)?;
    let manual = if kind == "game" {
        load_manual_play(pool)?
    } else {
        Vec::new()
    };
    let mut map = day_active(&raws);
    apply_manual_to_day_map(&mut map, &manual);
    let today = Local::now().date_naive();
    let start = today - Duration::days(days - 1);
    let mut out = Vec::new();
    let mut d = start;
    while d <= today {
        out.push(DayValue {
            date: d.format("%Y-%m-%d").to_string(),
            seconds: *map.get(&d).unwrap_or(&0),
        });
        d += Duration::days(1);
    }
    Ok(out)
}

/// Active seconds attributed to the local start-hour of each session.
pub fn hour_of_day(pool: &DbPool, kind: Option<&str>) -> AppResult<Vec<i64>> {
    let kind = kind.unwrap_or("game");
    let min_seconds = crate::db::settings::get_i64(pool, "min_session_seconds", 30)?;
    let raws = raw_sessions(pool, min_seconds, kind)?;
    let mut hours = vec![0i64; 24];
    for r in &raws {
        let h = r.start.with_timezone(&Local).hour() as usize;
        hours[h] += r.active.max(0);
    }
    Ok(hours)
}

// ---------- Catalog analytics ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearStat {
    pub year: i64,
    pub count: i64,
    pub avg_score: f64,
    pub avg_metacritic: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioStat {
    pub studio: String,
    pub count: i64,
    pub avg_score: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScorePoint {
    pub name: String,
    pub my: i64,
    pub metacritic: i64,
    pub year: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAnalytics {
    pub total_completed: i64,
    pub avg_my_score: f64,
    pub avg_metacritic: f64,
    pub total_playtime_seconds: i64,
    pub avg_time_to_beat_minutes: f64,
    pub perfect_scores: i64,
    pub scored_count: i64,
    pub backlog_count: i64,
    pub dropped_count: i64,
    pub per_year: Vec<YearStat>,
    pub top_studios: Vec<StudioStat>,
    pub score_points: Vec<ScorePoint>,
    pub status_counts: Vec<(String, i64)>,
}

pub fn catalog_analytics(pool: &DbPool) -> AppResult<CatalogAnalytics> {
    let conn = pool.get()?;

    struct Row {
        name: String,
        developer: Option<String>,
        completed_year: Option<i64>,
        rating: Option<i64>,
        metacritic: Option<i64>,
    }
    let mut stmt = conn.prepare(
        "SELECT display_name, developer, completed_year, rating, metacritic
         FROM games WHERE kind = 'game' AND status = 'completed'",
    )?;
    let rows: Vec<Row> = stmt
        .query_map([], |r| {
            Ok(Row {
                name: r.get(0)?,
                developer: r.get(1)?,
                completed_year: r.get(2)?,
                rating: r.get(3)?,
                metacritic: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let total_completed = rows.len() as i64;

    let my_scores: Vec<i64> = rows.iter().filter_map(|r| r.rating).collect();
    let meta_scores: Vec<i64> = rows.iter().filter_map(|r| r.metacritic).collect();
    let avg = |v: &[i64]| -> f64 {
        if v.is_empty() {
            0.0
        } else {
            v.iter().sum::<i64>() as f64 / v.len() as f64
        }
    };

    // per year
    let mut year_map: BTreeMap<i64, (i64, i64, i64, i64, i64)> = BTreeMap::new(); // year -> (count, sum_my, n_my, sum_meta, n_meta)
    for r in &rows {
        if let Some(y) = r.completed_year {
            let e = year_map.entry(y).or_insert((0, 0, 0, 0, 0));
            e.0 += 1;
            if let Some(s) = r.rating {
                e.1 += s;
                e.2 += 1;
            }
            if let Some(m) = r.metacritic {
                e.3 += m;
                e.4 += 1;
            }
        }
    }
    let per_year = year_map
        .into_iter()
        .map(|(year, (count, sm, nm, smeta, nmeta))| YearStat {
            year,
            count,
            avg_score: if nm > 0 { sm as f64 / nm as f64 } else { 0.0 },
            avg_metacritic: if nmeta > 0 {
                smeta as f64 / nmeta as f64
            } else {
                0.0
            },
        })
        .collect();

    // studios
    let mut studio_map: HashMap<String, (i64, i64, i64)> = HashMap::new();
    for r in &rows {
        if let Some(dev) = r.developer.as_ref().filter(|d| !d.trim().is_empty()) {
            let e = studio_map.entry(dev.clone()).or_insert((0, 0, 0));
            e.0 += 1;
            if let Some(s) = r.rating {
                e.1 += s;
                e.2 += 1;
            }
        }
    }
    let mut top_studios: Vec<StudioStat> = studio_map
        .into_iter()
        .map(|(studio, (count, sm, nm))| StudioStat {
            studio,
            count,
            avg_score: if nm > 0 { sm as f64 / nm as f64 } else { 0.0 },
        })
        .collect();
    top_studios.sort_by(|a, b| b.count.cmp(&a.count).then(a.studio.cmp(&b.studio)));
    top_studios.truncate(12);

    // score points (both present)
    let mut score_points: Vec<ScorePoint> = rows
        .iter()
        .filter_map(|r| match (r.rating, r.metacritic) {
            (Some(my), Some(m)) => Some(ScorePoint {
                name: r.name.clone(),
                my,
                metacritic: m,
                year: r.completed_year,
            }),
            _ => None,
        })
        .collect();
    score_points.sort_by(|a, b| b.year.cmp(&a.year));

    let mut status_counts = Vec::new();
    let mut backlog_count = 0i64;
    let mut dropped_count = 0i64;
    for st in ["playing", "completed", "backlog", "dropped"] {
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM games WHERE kind = 'game' AND status = ?1",
            [st],
            |r| r.get(0),
        )?;
        if st == "backlog" {
            backlog_count = n;
        }
        if st == "dropped" {
            dropped_count = n;
        }
        status_counts.push((st.to_string(), n));
    }

    let session_playtime: i64 = conn.query_row(
        "SELECT COALESCE(SUM(s.active_seconds), 0) FROM sessions s
         JOIN games g ON g.id = s.game_id
         WHERE g.status = 'completed' AND s.end_utc IS NOT NULL",
        [],
        |r| r.get(0),
    )?;
    let manual_playtime: i64 = conn.query_row(
        "SELECT COALESCE(SUM(manual_playtime_seconds), 0) FROM games WHERE status = 'completed'",
        [],
        |r| r.get(0),
    )?;
    let total_playtime_seconds = session_playtime + manual_playtime;

    let ttb_row: (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(time_to_beat_minutes), 0), COUNT(*) FROM games
         WHERE status = 'completed' AND time_to_beat_minutes IS NOT NULL AND time_to_beat_minutes > 0",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let avg_time_to_beat_minutes = if ttb_row.1 > 0 {
        ttb_row.0 as f64 / ttb_row.1 as f64
    } else {
        0.0
    };

    let perfect_scores: i64 = conn.query_row(
        "SELECT COUNT(*) FROM games WHERE status = 'completed' AND rating IS NOT NULL AND rating >= 95",
        [],
        |r| r.get(0),
    )?;
    let scored_count = my_scores.len() as i64;

    Ok(CatalogAnalytics {
        total_completed,
        avg_my_score: avg(&my_scores),
        avg_metacritic: avg(&meta_scores),
        total_playtime_seconds,
        avg_time_to_beat_minutes,
        perfect_scores,
        scored_count,
        backlog_count,
        dropped_count,
        per_year,
        top_studios,
        score_points,
        status_counts,
    })
}

// ---------- Year insights / wrap ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthValue {
    pub month: String,
    pub label: String,
    pub seconds: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Insights {
    pub year: i64,
    pub active_seconds: i64,
    pub runtime_seconds: i64,
    pub session_count: i64,
    pub unique_games: i64,
    pub completions: i64,
    pub best_month: String,
    pub best_month_seconds: i64,
    pub peak_streak: i64,
    pub top_games: Vec<TopGame>,
    pub monthly: Vec<MonthValue>,
}

pub fn insights(pool: &DbPool, year: i64, kind: Option<&str>) -> AppResult<Insights> {
    let kind = kind.unwrap_or("game");
    let min_seconds = crate::db::settings::get_i64(pool, "min_session_seconds", 30)?;
    let raws = raw_sessions(pool, min_seconds, kind)?;
    let manual = if kind == "game" {
        load_manual_play(pool)?
    } else {
        Vec::new()
    };

    let year_start = NaiveDate::from_ymd_opt(year as i32, 1, 1).unwrap();
    let year_end = NaiveDate::from_ymd_opt(year as i32, 12, 31).unwrap();

    let mut active_seconds = 0i64;
    let mut runtime_seconds = 0i64;
    let mut session_count = 0i64;
    let mut game_ids = std::collections::HashSet::new();
    let mut month_map: BTreeMap<(i32, u32), i64> = BTreeMap::new();
    let mut day_map: BTreeMap<NaiveDate, i64> = BTreeMap::new();

    for r in &raws {
        let d = local_day(&r.start);
        if d < year_start || d > year_end {
            continue;
        }
        session_count += 1;
        runtime_seconds += r.runtime;
        let act = if r.active > 0 { r.active } else { r.runtime };
        active_seconds += act;
        day_map.entry(d).and_modify(|v| *v += act).or_insert(act);
        let key = (d.year(), d.month());
        *month_map.entry(key).or_default() += act;
    }

    apply_manual_to_insights(
        &manual,
        year,
        year_start,
        year_end,
        &mut active_seconds,
        &mut runtime_seconds,
        &mut game_ids,
        &mut month_map,
        &mut day_map,
    );

    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT DISTINCT s.game_id FROM sessions s
         JOIN games g ON g.id = s.game_id
         WHERE s.end_utc IS NOT NULL AND s.runtime_seconds >= ?1
         AND g.kind = ?2 AND strftime('%Y', s.start_utc) = ?3",
    )?;
    let year_str = year.to_string();
    let ids = stmt.query_map(rusqlite::params![min_seconds, kind, year_str], |r| {
        r.get::<_, String>(0)
    })?;
    for id in ids {
        if let Ok(gid) = id {
            game_ids.insert(gid);
        }
    }
    let unique_games = game_ids.len() as i64;

    let completions: i64 = if kind == "game" {
        conn.query_row(
            "SELECT COUNT(*) FROM games WHERE status = 'completed' AND completed_year = ?1 AND kind = 'game'",
            [year],
            |r| r.get(0),
        )?
    } else {
        0
    };

    let (best_month, best_month_seconds) = month_map
        .iter()
        .max_by_key(|(_, v)| *v)
        .map(|((y, m), v)| {
            let label = chrono::NaiveDate::from_ymd_opt(*y, *m, 1)
                .map(|d| d.format("%b").to_string())
                .unwrap_or_else(|| format!("{m:02}"));
            (label, *v)
        })
        .unwrap_or_else(|| ("—".to_string(), 0));

    // Peak streak within the year
    let mut peak_streak = 0i64;
    let mut run = 0i64;
    let mut d = year_start;
    while d <= year_end {
        if *day_map.get(&d).unwrap_or(&0) > 0 {
            run += 1;
            peak_streak = peak_streak.max(run);
        } else {
            run = 0;
        }
        d += Duration::days(1);
    }

    let mut stmt = conn.prepare(
        "SELECT g.id, g.display_name, g.icon_path, g.accent_color,
                COALESCE(SUM(s.runtime_seconds),0), COALESCE(SUM(s.active_seconds),0), COUNT(s.id), g.cover_path
         FROM games g JOIN sessions s ON s.game_id = g.id
         WHERE s.end_utc IS NOT NULL AND s.runtime_seconds >= ?1 AND g.kind = ?2
         AND strftime('%Y', s.start_utc) = ?3
         GROUP BY g.id ORDER BY SUM(s.active_seconds) DESC LIMIT 5",
    )?;
    let top_games = if kind == "game" {
        merge_manual_top_games(
            stmt.query_map(rusqlite::params![min_seconds, kind, year_str], |r| {
                Ok(TopGame {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    icon_path: r.get(2)?,
                    cover_path: r.get(7)?,
                    accent_color: r.get(3)?,
                    runtime_seconds: r.get(4)?,
                    active_seconds: r.get(5)?,
                    session_count: r.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?,
            &manual,
            Some(year),
            5,
        )
    } else {
        stmt.query_map(rusqlite::params![min_seconds, kind, year_str], |r| {
            Ok(TopGame {
                id: r.get(0)?,
                name: r.get(1)?,
                icon_path: r.get(2)?,
                cover_path: r.get(7)?,
                accent_color: r.get(3)?,
                runtime_seconds: r.get(4)?,
                active_seconds: r.get(5)?,
                session_count: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    };

    let monthly: Vec<MonthValue> = (1..=12u32)
        .filter_map(|m| {
            let secs = month_map.get(&(year as i32, m)).copied().unwrap_or(0);
            let label = chrono::NaiveDate::from_ymd_opt(year as i32, m, 1)?
                .format("%b")
                .to_string();
            Some(MonthValue {
                month: format!("{year}-{m:02}"),
                label,
                seconds: secs,
            })
        })
        .collect();

    Ok(Insights {
        year,
        active_seconds,
        runtime_seconds,
        session_count,
        unique_games,
        completions,
        best_month,
        best_month_seconds,
        peak_streak,
        top_games,
        monthly,
    })
}

// ---------- Tag analytics ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagStat {
    pub tag: String,
    pub game_count: i64,
    pub completed_count: i64,
    pub active_seconds: i64,
    pub avg_rating: f64,
}

pub fn tag_analytics(pool: &DbPool) -> AppResult<Vec<TagStat>> {
    let min_seconds = crate::db::settings::get_i64(pool, "min_session_seconds", 30)?;
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT t.name, g.id, g.status, g.rating,
                COALESCE(SUM(s.active_seconds), 0) + g.manual_playtime_seconds AS active
         FROM tags t
         JOIN game_tags gt ON gt.tag_id = t.id
         JOIN games g ON g.id = gt.game_id
         LEFT JOIN sessions s ON s.game_id = g.id AND s.end_utc IS NOT NULL AND s.runtime_seconds >= ?1
         GROUP BY t.name, g.id",
    )?;
    let rows = stmt.query_map([min_seconds], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<i64>>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;

    let mut map: HashMap<String, (i64, i64, i64, i64, i64)> = HashMap::new();
    // tag -> (game_count, completed, active_secs, rating_sum, rating_n)
    for row in rows {
        let (tag, _gid, status, rating, active) = row?;
        let e = map.entry(tag).or_insert((0, 0, 0, 0, 0));
        e.0 += 1;
        if status == "completed" {
            e.1 += 1;
        }
        e.2 += active;
        if let Some(r) = rating {
            e.3 += r;
            e.4 += 1;
        }
    }

    let mut out: Vec<TagStat> = map
        .into_iter()
        .map(|(tag, (gc, cc, act, rs, rn))| TagStat {
            tag,
            game_count: gc,
            completed_count: cc,
            active_seconds: act,
            avg_rating: if rn > 0 { rs as f64 / rn as f64 } else { 0.0 },
        })
        .collect();
    out.sort_by(|a, b| b.active_seconds.cmp(&a.active_seconds).then(a.tag.cmp(&b.tag)));
    Ok(out)
}

pub fn list_tags(pool: &DbPool) -> AppResult<Vec<String>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT name FROM tags ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
