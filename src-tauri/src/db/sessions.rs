use crate::db::models::{ActivitySpan, FocusSpan, SessionDto, SessionFilter};
use crate::db::DbPool;
use crate::error::AppResult;
use crate::util;
use chrono::{DateTime, Duration, Utc};

/// Cap on stored activity spans per session, so heavy browsing doesn't bloat a row.
const MAX_ACTIVITY_SPANS: usize = 400;

fn parse_focus_spans(raw: &str) -> Vec<FocusSpan> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn parse_activity_spans(raw: &str) -> Vec<ActivitySpan> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn row_to_session(r: &rusqlite::Row<'_>) -> rusqlite::Result<SessionDto> {
    let focus_raw: String = r.get::<_, String>(12).unwrap_or_else(|_| "[]".to_string());
    let activity_raw: String = r.get::<_, String>(13).unwrap_or_else(|_| "[]".to_string());
    Ok(SessionDto {
        id: r.get(0)?,
        game_id: r.get(1)?,
        game_name: r.get(2)?,
        kind: r.get::<_, String>(3).unwrap_or_else(|_| "game".to_string()),
        icon_path: r.get(4)?,
        cover_path: r.get(14)?,
        accent_color: r.get(5)?,
        start_utc: r.get(6)?,
        end_utc: r.get(7)?,
        last_seen_utc: r.get(8)?,
        runtime_seconds: r.get(9)?,
        active_seconds: r.get(10)?,
        was_idle_ended: r.get::<_, i64>(11)? != 0,
        focus_spans: parse_focus_spans(&focus_raw),
        activity_spans: parse_activity_spans(&activity_raw),
    })
}

const SESSION_SELECT: &str = "SELECT s.id, s.game_id, g.display_name, g.kind, g.icon_path, g.accent_color,
                s.start_utc, COALESCE(s.end_utc, s.last_seen_utc), s.last_seen_utc,
                s.runtime_seconds, s.active_seconds, s.was_idle_ended, s.focus_spans_json,
                s.activity_json, g.cover_path";

pub fn list(pool: &DbPool, filter: &SessionFilter) -> AppResult<Vec<SessionDto>> {
    let conn = pool.get()?;
    // Include in-progress sessions (end_utc IS NULL) so live activity appears on
    // timelines immediately; their end is coalesced to last_seen so the bar grows
    // as the tracker accrues. Crash-orphaned open rows are closed at startup.
    let mut sql = format!(
        "{SESSION_SELECT}
         FROM sessions s JOIN games g ON g.id = s.game_id
         WHERE 1=1"
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(gid) = &filter.game_id {
        params.push(Box::new(gid.clone()));
        sql.push_str(&format!(" AND s.game_id = ?{}", params.len()));
    }
    if let Some(from) = &filter.from_utc {
        params.push(Box::new(from.clone()));
        sql.push_str(&format!(
            " AND datetime(COALESCE(s.end_utc, s.last_seen_utc)) > datetime(?{})",
            params.len()
        ));
    }
    if let Some(to) = &filter.to_utc {
        params.push(Box::new(to.clone()));
        sql.push_str(&format!(" AND s.start_utc <= ?{}", params.len()));
    }
    if let Some(min) = filter.min_seconds {
        params.push(Box::new(min));
        sql.push_str(&format!(" AND s.runtime_seconds >= ?{}", params.len()));
    }
    if let Some(kind) = &filter.kind {
        params.push(Box::new(kind.clone()));
        sql.push_str(&format!(" AND g.kind = ?{}", params.len()));
    }
    if filter.exclude_idle_ended.unwrap_or(false) {
        sql.push_str(" AND s.was_idle_ended = 0");
    }
    sql.push_str(" ORDER BY s.start_utc DESC");
    if let Some(limit) = filter.limit {
        params.push(Box::new(limit));
        sql.push_str(&format!(" LIMIT ?{}", params.len()));
    }

    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(refs.as_slice(), row_to_session)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Sum of runtime/active seconds for sessions that overlap "today" (local-naive via UTC day).
pub fn today_totals(pool: &DbPool) -> AppResult<(i64, i64)> {
    today_totals_kind(pool, "game")
}

pub fn today_totals_kind(pool: &DbPool, kind: &str) -> AppResult<(i64, i64)> {
    let conn = pool.get()?;
    let start_of_day = Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .to_rfc3339();
    let (rt, act): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(s.runtime_seconds),0), COALESCE(SUM(s.active_seconds),0)
         FROM sessions s JOIN games g ON g.id = s.game_id
         WHERE s.last_seen_utc >= ?1 AND g.kind = ?2",
        rusqlite::params![start_of_day, kind],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok((rt, act))
}

// ---- Tracker lifecycle helpers ----

/// Close any sessions left open from a previous run (crash / forced quit).
pub fn close_orphans(pool: &DbPool) -> AppResult<()> {
    let conn = pool.get()?;
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM sessions WHERE end_utc IS NULL")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in ids {
        let _ = finalize_focus_spans(pool, &id);
        let _ = finalize_activity_spans(pool, &id);
    }
    conn.execute(
        "UPDATE sessions SET end_utc = last_seen_utc, was_idle_ended = 0
         WHERE end_utc IS NULL",
        [],
    )?;
    Ok(())
}

/// Start a brand-new session, or resume a very recent one for the same game (merge window).
/// Returns the active session id.
pub fn start_or_resume(pool: &DbPool, game_id: &str, merge_window_secs: i64) -> AppResult<String> {
    let conn = pool.get()?;
    let now = Utc::now();
    let cutoff = (now - Duration::seconds(merge_window_secs)).to_rfc3339();

    let recent: Option<String> = conn
        .query_row(
            "SELECT id FROM sessions
             WHERE game_id = ?1 AND end_utc IS NOT NULL AND end_utc >= ?2
             ORDER BY end_utc DESC LIMIT 1",
            rusqlite::params![game_id, cutoff],
            |r| r.get(0),
        )
        .ok();

    if let Some(id) = recent {
        conn.execute(
            "UPDATE sessions SET end_utc = NULL, last_seen_utc = ?1, was_idle_ended = 0
             WHERE id = ?2",
            rusqlite::params![now.to_rfc3339(), id],
        )?;
        return Ok(id);
    }

    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO sessions(id, game_id, start_utc, end_utc, last_seen_utc,
            runtime_seconds, active_seconds, was_idle_ended, focus_spans_json)
         VALUES(?1, ?2, ?3, NULL, ?3, 0, 0, 0, '[]')",
        rusqlite::params![id, game_id, now.to_rfc3339()],
    )?;
    Ok(id)
}

/// Add elapsed seconds to an open session and bump last_seen.
pub fn accrue(
    pool: &DbPool,
    session_id: &str,
    add_runtime: i64,
    add_active: i64,
) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE sessions SET runtime_seconds = runtime_seconds + ?1,
            active_seconds = active_seconds + ?2, last_seen_utc = ?3
         WHERE id = ?4",
        rusqlite::params![add_runtime, add_active, Utc::now().to_rfc3339(), session_id],
    )?;
    Ok(())
}

pub fn end(pool: &DbPool, session_id: &str, idle_ended: bool) -> AppResult<()> {
    let _ = finalize_focus_spans(pool, session_id);
    let _ = finalize_activity_spans(pool, session_id);
    let conn = pool.get()?;
    conn.execute(
        "UPDATE sessions SET end_utc = last_seen_utc, was_idle_ended = ?1
         WHERE id = ?2 AND end_utc IS NULL",
        rusqlite::params![idle_ended as i64, session_id],
    )?;
    Ok(())
}

/// Record foreground vs background stretch for timeline opacity (merged when state unchanged).
pub fn record_focus_tick(pool: &DbPool, session_id: &str, focused: bool) -> AppResult<()> {
    let conn = pool.get()?;
    let now = Utc::now().to_rfc3339();
    let json: String = conn.query_row(
        "SELECT focus_spans_json FROM sessions WHERE id = ?1",
        [session_id],
        |r| r.get(0),
    )?;
    let mut spans: Vec<FocusSpan> = parse_focus_spans(&json);

    if let Some(last) = spans.last() {
        if last.end_utc.is_none() && last.focused == focused {
            return Ok(());
        }
    }

    if let Some(last) = spans.last_mut() {
        if last.end_utc.is_none() {
            last.end_utc = Some(now.clone());
        }
    }

    spans.push(FocusSpan {
        start_utc: now,
        end_utc: None,
        focused,
    });

    let json = serde_json::to_string(&spans)?;
    conn.execute(
        "UPDATE sessions SET focus_spans_json = ?1 WHERE id = ?2",
        rusqlite::params![json, session_id],
    )?;
    Ok(())
}

/// Record the current foreground activity (window title + optional browser URL)
/// for an open session. Consecutive identical stretches are merged; when the
/// title/url changes, the previous span is closed and a new one opened.
pub fn record_activity(
    pool: &DbPool,
    session_id: &str,
    title: Option<&str>,
    url: Option<&str>,
) -> AppResult<()> {
    let conn = pool.get()?;
    let now = Utc::now().to_rfc3339();
    let json: String = conn
        .query_row(
            "SELECT activity_json FROM sessions WHERE id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "[]".to_string());
    let mut spans: Vec<ActivitySpan> = parse_activity_spans(&json);

    let same = |s: &ActivitySpan| s.title.as_deref() == title && s.url.as_deref() == url;
    if let Some(last) = spans.last() {
        if last.end_utc.is_none() && same(last) {
            return Ok(());
        }
    }
    if let Some(last) = spans.last_mut() {
        if last.end_utc.is_none() {
            last.end_utc = Some(now.clone());
        }
    }
    spans.push(ActivitySpan {
        start_utc: now,
        end_utc: None,
        title: title.map(|s| s.to_string()),
        url: url.map(|s| s.to_string()),
    });
    if spans.len() > MAX_ACTIVITY_SPANS {
        let overflow = spans.len() - MAX_ACTIVITY_SPANS;
        spans.drain(0..overflow);
    }

    let json = serde_json::to_string(&spans)?;
    conn.execute(
        "UPDATE sessions SET activity_json = ?1 WHERE id = ?2",
        rusqlite::params![json, session_id],
    )?;
    Ok(())
}

pub fn finalize_activity_spans(pool: &DbPool, session_id: &str) -> AppResult<()> {
    let conn = pool.get()?;
    let now = Utc::now().to_rfc3339();
    let json: String = conn
        .query_row(
            "SELECT activity_json FROM sessions WHERE id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "[]".to_string());
    let mut spans: Vec<ActivitySpan> = parse_activity_spans(&json);
    if let Some(last) = spans.last_mut() {
        if last.end_utc.is_none() {
            last.end_utc = Some(now);
        }
    }
    let json = serde_json::to_string(&spans)?;
    conn.execute(
        "UPDATE sessions SET activity_json = ?1 WHERE id = ?2",
        rusqlite::params![json, session_id],
    )?;
    Ok(())
}

pub fn finalize_focus_spans(pool: &DbPool, session_id: &str) -> AppResult<()> {
    let conn = pool.get()?;
    let now = Utc::now().to_rfc3339();
    let json: String = conn
        .query_row(
            "SELECT focus_spans_json FROM sessions WHERE id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "[]".to_string());
    let mut spans: Vec<FocusSpan> = parse_focus_spans(&json);
    if let Some(last) = spans.last_mut() {
        if last.end_utc.is_none() {
            last.end_utc = Some(now);
        }
    }
    let json = serde_json::to_string(&spans)?;
    conn.execute(
        "UPDATE sessions SET focus_spans_json = ?1 WHERE id = ?2",
        rusqlite::params![json, session_id],
    )?;
    Ok(())
}

/// Current open-session counters (runtime, active) for live UI.
pub fn open_counters(pool: &DbPool, session_id: &str) -> AppResult<(i64, i64)> {
    let conn = pool.get()?;
    let res = conn
        .query_row(
            "SELECT runtime_seconds, active_seconds FROM sessions WHERE id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));
    Ok(res)
}

pub fn parse(s: &str) -> Option<DateTime<Utc>> {
    util::parse_utc(s)
}
