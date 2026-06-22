use crate::db::models::ScreenshotDto;
use crate::db::DbPool;
use crate::error::AppResult;
use crate::util;

fn row_to_screenshot(r: &rusqlite::Row<'_>) -> rusqlite::Result<ScreenshotDto> {
    Ok(ScreenshotDto {
        id: r.get(0)?,
        game_id: r.get(1)?,
        session_id: r.get(2)?,
        path: r.get(3)?,
        captured_utc: r.get(4)?,
    })
}

/// Record a freshly captured screenshot. Returns the new row id.
pub fn insert(
    pool: &DbPool,
    game_id: &str,
    session_id: Option<&str>,
    path: &str,
) -> AppResult<String> {
    let conn = pool.get()?;
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO screenshots(id, game_id, session_id, path, captured_utc)
         VALUES(?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, game_id, session_id, path, util::now_utc_string()],
    )?;
    Ok(id)
}

/// All auto-captured screenshots for a game, newest first.
pub fn list(pool: &DbPool, game_id: &str) -> AppResult<Vec<ScreenshotDto>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, game_id, session_id, path, captured_utc
         FROM screenshots WHERE game_id = ?1
         ORDER BY captured_utc DESC",
    )?;
    let rows = stmt.query_map([game_id], row_to_screenshot)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Delete a screenshot row and return its file path so the caller can remove it.
pub fn delete(pool: &DbPool, id: &str) -> AppResult<Option<String>> {
    let conn = pool.get()?;
    let path: Option<String> = conn
        .query_row(
            "SELECT path FROM screenshots WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .ok();
    conn.execute("DELETE FROM screenshots WHERE id = ?1", [id])?;
    Ok(path)
}
