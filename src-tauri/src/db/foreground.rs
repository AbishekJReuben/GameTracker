//! Global foreground-app log. Unlike per-session `activity_json`, this records
//! whichever app is in the foreground over time — including untracked apps — so
//! the timeline can show a single "Active app" lane (the multitasking picture).

use crate::db::DbPool;
use crate::error::AppResult;
use chrono::Utc;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundSpanDto {
    pub id: String,
    pub app_key: String,
    pub name: String,
    pub exe_path: Option<String>,
    pub icon_path: Option<String>,
    pub game_id: Option<String>,
    pub start_utc: String,
    pub end_utc: Option<String>,
    pub last_seen_utc: String,
}

pub fn start(
    pool: &DbPool,
    app_key: &str,
    name: &str,
    exe_path: Option<&str>,
    icon_path: Option<&str>,
    game_id: Option<&str>,
) -> AppResult<String> {
    let conn = pool.get()?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO foreground_spans(id, app_key, name, exe_path, icon_path, game_id,
            start_utc, end_utc, last_seen_utc)
         VALUES(?1,?2,?3,?4,?5,?6,?7,NULL,?7)",
        rusqlite::params![id, app_key, name, exe_path, icon_path, game_id, now],
    )?;
    Ok(id)
}

pub fn touch(pool: &DbPool, id: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE foreground_spans SET last_seen_utc = ?1 WHERE id = ?2",
        rusqlite::params![Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

pub fn end(pool: &DbPool, id: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE foreground_spans SET end_utc = last_seen_utc WHERE id = ?1 AND end_utc IS NULL",
        [id],
    )?;
    Ok(())
}

pub fn close_orphans(pool: &DbPool) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE foreground_spans SET end_utc = last_seen_utc WHERE end_utc IS NULL",
        [],
    )?;
    Ok(())
}

/// Spans overlapping [from, to]. Open spans coalesce their end to last_seen.
pub fn list(pool: &DbPool, from: Option<&str>, to: Option<&str>) -> AppResult<Vec<ForegroundSpanDto>> {
    let conn = pool.get()?;
    let mut sql = String::from(
        "SELECT id, app_key, name, exe_path, icon_path, game_id, start_utc, end_utc, last_seen_utc
         FROM foreground_spans WHERE 1=1",
    );
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
    sql.push_str(" ORDER BY start_utc ASC");
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(refs.as_slice(), |r| {
        Ok(ForegroundSpanDto {
            id: r.get(0)?,
            app_key: r.get(1)?,
            name: r.get(2)?,
            exe_path: r.get(3)?,
            icon_path: r.get(4)?,
            game_id: r.get(5)?,
            start_utc: r.get(6)?,
            end_utc: r.get(7)?,
            last_seen_utc: r.get(8)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn prune(pool: &DbPool, days: i64) -> AppResult<()> {
    let conn = pool.get()?;
    let cutoff = (Utc::now() - chrono::Duration::days(days)).to_rfc3339();
    conn.execute("DELETE FROM foreground_spans WHERE last_seen_utc < ?1", [cutoff])?;
    Ok(())
}
