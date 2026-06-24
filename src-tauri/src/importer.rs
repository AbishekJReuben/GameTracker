use crate::db::games;
use crate::db::models::GameInput;
use crate::db::DbPool;
use crate::error::AppResult;
use crate::hltb;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub imported: i64,
    pub skipped_duplicates: i64,
    pub hltb_fetched: i64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgressEvent {
    pub job_id: String,
    pub done: i64,
    pub total: i64,
    pub detail: Option<String>,
}

fn header_index(headers: &csv::StringRecord, keys: &[&str]) -> Option<usize> {
    header_index_filtered(headers, keys, &[])
}

fn header_index_filtered(
    headers: &csv::StringRecord,
    keys: &[&str],
    exclude: &[&str],
) -> Option<usize> {
    let norm = |h: &str| h.trim().to_lowercase();

    for (i, h) in headers.iter().enumerate() {
        let hl = norm(h);
        if exclude.iter().any(|e| hl.contains(e)) {
            continue;
        }
        if keys.iter().any(|k| hl == *k) {
            return Some(i);
        }
    }
    for (i, h) in headers.iter().enumerate() {
        let hl = norm(h);
        if exclude.iter().any(|e| hl.contains(e)) {
            continue;
        }
        if keys.iter().any(|k| hl.contains(k)) {
            return Some(i);
        }
    }
    None
}

fn score_column_indices(headers: &csv::StringRecord) -> (Option<usize>, Option<usize>) {
    let idx_meta = header_index_filtered(headers, &["metacritic score", "metacritic", "mc"], &[]);
    let idx_my = header_index_filtered(
        headers,
        &["my score", "myscore", "user score", "personal score", "rating"],
        &["metacritic"],
    )
    .or_else(|| header_index_filtered(headers, &["score"], &["metacritic"]));
    (idx_meta, idx_my)
}

fn parse_year(v: &str, name: &str, warnings: &mut Vec<String>) -> Option<i64> {
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    match v.parse::<i64>() {
        Ok(y) if (1970..=2100).contains(&y) => Some(y),
        Ok(y) => {
            warnings.push(format!("{name}: suspicious year '{y}' — left blank for review."));
            None
        }
        Err(_) => {
            warnings.push(format!("{name}: could not parse year '{v}'."));
            None
        }
    }
}

fn parse_month(v: &str) -> Option<i64> {
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    let m = v.parse::<i64>().ok()?;
    if (1..=12).contains(&m) {
        Some(m)
    } else {
        None
    }
}

fn parse_day(v: &str) -> Option<i64> {
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    let d = v.parse::<i64>().ok()?;
    if (1..=31).contains(&d) {
        Some(d)
    } else {
        None
    }
}

/// Parse YYYY, YYYY-MM, or YYYY-MM-DD (also accepts slash separators).
fn parse_partial_date(v: &str) -> (Option<i64>, Option<i64>, Option<i64>) {
    let v = v.trim();
    if v.is_empty() {
        return (None, None, None);
    }
    let parts: Vec<&str> = v.split(|c: char| c == '-' || c == '/' || c == '.').collect();
    let year = parts.first().and_then(|p| parse_year(p, "", &mut Vec::new()));
    let month = parts.get(1).and_then(|p| parse_month(p));
    let day = parts.get(2).and_then(|p| parse_day(p));
    (year, month, day)
}

fn parse_score(v: &str, name: &str, label: &str, warnings: &mut Vec<String>) -> Option<i64> {
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    match v.parse::<i64>() {
        Ok(s) if (0..=100).contains(&s) => Some(s),
        Ok(s) => {
            warnings.push(format!("{name}: {label} '{s}' out of range — left blank."));
            None
        }
        Err(_) => {
            warnings.push(format!("{name}: could not parse {label} '{v}'."));
            None
        }
    }
}

/// Parse playtime hours from strings like "42", "42.5", "42h", "42 hours".
fn parse_hours(v: &str, name: &str, warnings: &mut Vec<String>) -> Option<f64> {
    let v = v.trim().to_lowercase();
    if v.is_empty() {
        return None;
    }
    let cleaned: String = v
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if cleaned.is_empty() {
        warnings.push(format!("{name}: could not parse playtime hours '{v}'."));
        return None;
    }
    match cleaned.parse::<f64>() {
        Ok(h) if h > 0.0 && h < 50_000.0 => Some(h),
        Ok(h) => {
            warnings.push(format!("{name}: playtime hours '{h}' out of range."));
            None
        }
        Err(_) => {
            warnings.push(format!("{name}: could not parse playtime hours '{v}'."));
            None
        }
    }
}

fn try_hltb(title: &str, summary: &mut ImportSummary) -> Option<hltb::HltbTimes> {
    match hltb::lookup(title) {
        Ok(Some(t)) => {
            summary.hltb_fetched += 1;
            Some(t)
        }
        Ok(None) => {
            summary
                .warnings
                .push(format!("HLTB: no match for \"{title}\""));
            None
        }
        Err(e) => {
            summary
                .warnings
                .push(format!("HLTB lookup failed for \"{title}\": {e}"));
            None
        }
    }
}

pub fn import_csv(
    pool: &DbPool,
    path: &Path,
    job_id: Option<&str>,
    on_progress: Option<&dyn Fn(TaskProgressEvent)>,
) -> AppResult<ImportSummary> {
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .has_headers(true)
        .from_path(path)?;

    let headers = rdr.headers()?.clone();
    let idx_title = header_index(&headers, &["game title", "title", "game", "name"]);
    let idx_dev = header_index(&headers, &["devstudio", "developer", "studio"]);
    let idx_release = header_index(&headers, &["releaseyear", "release year", "release"]);
    let idx_completed = header_index(&headers, &["completedyear", "completed year", "completed"]);
    let idx_completed_month = header_index(&headers, &["completed month", "completedmonth"]);
    let idx_completed_day = header_index(&headers, &["completed day", "completedday", "completed date"]);
    let idx_started = header_index(
        &headers,
        &["started", "start date", "startdate", "date started", "started date"],
    );
    let idx_started_year = header_index(&headers, &["startedyear", "started year", "start year"]);
    let idx_started_month = header_index(&headers, &["startedmonth", "started month"]);
    let idx_started_day = header_index(&headers, &["startedday", "started day"]);
    let idx_hours = header_index(
        &headers,
        &[
            "hours played",
            "hoursplayed",
            "playtime",
            "play time",
            "time played",
            "hours",
            "played hours",
        ],
    );
    let (idx_meta, idx_my) = score_column_indices(&headers);

    let title_col = match idx_title {
        Some(i) => i,
        None => {
            return Err(crate::error::AppError::msg(
                "Could not find a game title column in the CSV.",
            ))
        }
    };

    let has_hours_col = idx_hours.is_some();

    let mut summary = ImportSummary {
        imported: 0,
        skipped_duplicates: 0,
        hltb_fetched: 0,
        warnings: Vec::new(),
    };

    let mut existing: HashMap<String, ()> = games::list(pool)?
        .into_iter()
        .map(|g| (g.display_name.to_lowercase(), ()))
        .collect();

    let get = |rec: &csv::StringRecord, idx: Option<usize>| -> String {
        idx.and_then(|i| rec.get(i)).unwrap_or("").trim().to_string()
    };

    let emit = |done: i64, total: i64, detail: Option<&str>| {
        if let (Some(jid), Some(cb)) = (job_id, on_progress) {
            cb(TaskProgressEvent {
                job_id: jid.to_string(),
                done,
                total,
                detail: detail.map(str::to_string),
            });
        }
    };

    let mut rows: Vec<csv::StringRecord> = Vec::new();
    for result in rdr.records() {
        match result {
            Ok(r) => rows.push(r),
            Err(e) => summary.warnings.push(format!("Skipped a malformed row: {e}")),
        }
    }

    let total = rows.len() as i64;
    emit(0, total, Some("Starting import…"));

    for (row_idx, rec) in rows.iter().enumerate() {
        let title = rec.get(title_col).unwrap_or("").trim().to_string();
        if title.is_empty() {
            emit((row_idx + 1) as i64, total, None);
            continue;
        }

        let metacritic =
            parse_score(&get(&rec, idx_meta), &title, "Metacritic", &mut summary.warnings);
        let rating = parse_score(&get(&rec, idx_my), &title, "My Score", &mut summary.warnings);

        let hours = parse_hours(&get(&rec, idx_hours), &title, &mut summary.warnings);
        let manual_seconds = hours.map(|h| (h * 3600.0).round() as i64);

        let release_year = parse_year(&get(&rec, idx_release), &title, &mut summary.warnings);
        let mut completed_year =
            parse_year(&get(&rec, idx_completed), &title, &mut summary.warnings);
        let mut completed_month = parse_month(&get(&rec, idx_completed_month));
        let mut completed_day = parse_day(&get(&rec, idx_completed_day));

        if let Some(raw) = idx_completed_day {
            let raw = get(&rec, Some(raw));
            if raw.contains('-') || raw.contains('/') {
                let (y, m, d) = parse_partial_date(&raw);
                completed_year = completed_year.or(y);
                completed_month = completed_month.or(m);
                completed_day = completed_day.or(d);
            }
        }

        let (mut started_year, mut started_month, mut started_day) =
            if let Some(col) = idx_started {
                let raw = get(&rec, Some(col));
                if !raw.is_empty() {
                    parse_partial_date(&raw)
                } else {
                    (None, None, None)
                }
            } else {
                (None, None, None)
            };
        started_year = started_year.or(parse_year(
            &get(&rec, idx_started_year),
            &title,
            &mut summary.warnings,
        ));
        started_month = started_month.or(parse_month(&get(&rec, idx_started_month)));
        started_day = started_day.or(parse_day(&get(&rec, idx_started_day)));

        if existing.contains_key(&title.to_lowercase()) {
            summary.skipped_duplicates += 1;
            games::update_scores(pool, &title, rating, metacritic)?;
            if let Some(secs) = manual_seconds {
                games::update_manual_playtime_by_name(pool, &title, secs)?;
            } else if !has_hours_col {
                if let Some(times) = try_hltb(&title, &mut summary) {
                    if let Some(id) = games::id_by_name(pool, &title)? {
                        games::apply_hltb(pool, &id, &times, true)?;
                    }
                }
                thread::sleep(Duration::from_millis(400));
            }
            emit((row_idx + 1) as i64, total, Some(&title));
            continue;
        }

        let developer = {
            let d = get(&rec, idx_dev);
            if d.is_empty() {
                None
            } else {
                Some(d)
            }
        };

        let mut manual = manual_seconds.unwrap_or(0);
        let mut hltb_times: Option<hltb::HltbTimes> = None;

        if manual == 0 && !has_hours_col {
            if let Some(times) = try_hltb(&title, &mut summary) {
                if let Some(mins) = times.main_extra_minutes {
                    manual = mins * 60;
                }
                hltb_times = Some(times);
            }
            thread::sleep(Duration::from_millis(400));
        }

        let input = GameInput {
            id: None,
            kind: "game".to_string(),
            display_name: title.clone(),
            install_folder: None,
            exe_paths: Vec::new(),
            cover_path: None,
            status: "completed".to_string(),
            rating,
            developer,
            release_year,
            started_year,
            started_month,
            started_day,
            completed_year,
            completed_month,
            completed_day,
            metacritic,
            notes: None,
            time_to_beat_minutes: None,
            manual_playtime_seconds: Some(manual),
            accent_color: None,
            tags: Vec::new(),
            count_background: None,
            steam_app_id: None,
            gog_product_id: None,
        };
        let id = games::upsert(pool, input)?;
        if let Some(times) = hltb_times {
            games::apply_hltb(pool, &id, &times, false)?;
        }
        existing.insert(title.to_lowercase(), ());
        summary.imported += 1;
        emit((row_idx + 1) as i64, total, Some(&title));
    }

    emit(total, total, Some("Import complete"));

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(cols: &[&str]) -> csv::StringRecord {
        csv::StringRecord::from(cols)
    }

    #[test]
    fn score_columns_distinguish_metacritic_score_and_my_score() {
        let h = headers(&[
            "Game Title",
            "DevStudio",
            "ReleaseYear",
            "CompletedYear",
            "Metacritic Score",
            "My Score",
        ]);
        let (meta, my) = score_column_indices(&h);
        assert_eq!(meta, Some(4));
        assert_eq!(my, Some(5));
        assert_ne!(meta, my);
    }

    #[test]
    fn parse_partial_date_formats() {
        let (y, m, d) = parse_partial_date("2023-06-15");
        assert_eq!(y, Some(2023));
        assert_eq!(m, Some(6));
        assert_eq!(d, Some(15));
        let (y2, m2, d2) = parse_partial_date("2019");
        assert_eq!(y2, Some(2019));
        assert!(m2.is_none());
        assert!(d2.is_none());
    }

    #[test]
    fn parse_hours_variants() {
        let mut w = Vec::new();
        assert_eq!(parse_hours("42.5", "x", &mut w), Some(42.5));
        assert_eq!(parse_hours("12h", "x", &mut w), Some(12.0));
    }
}
