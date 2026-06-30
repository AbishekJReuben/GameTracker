//! Listening analytics over `media_plays` (SMTC + in-app jukebox). Mirrors the
//! local-day/hour bucketing style of `db/stats.rs`.

use crate::db::stats::DayValue;
use crate::db::DbPool;
use crate::error::AppResult;
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, Timelike, Utc};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};

struct RawPlay {
    start: DateTime<Utc>,
    end: Option<DateTime<Utc>>,
    seconds: i64,
    artist: Option<String>,
    title: Option<String>,
    album: Option<String>,
    app_name: Option<String>,
    source_app: Option<String>,
    media_type: String,
    thumb: Option<String>,
}

fn norm(s: &Option<String>) -> Option<String> {
    s.as_ref().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn load(pool: &DbPool) -> AppResult<Vec<RawPlay>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT start_utc, end_utc, played_seconds, artist, title, album, app_name,
                source_app, media_type, thumb_path
         FROM media_plays WHERE played_seconds > 0",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, Option<String>>(9)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (start, end, secs, artist, title, album, app, src_app, mtype, thumb) = row?;
        if let Some(s) = crate::util::parse_utc(&start) {
            out.push(RawPlay {
                start: s,
                end: end.as_deref().and_then(crate::util::parse_utc),
                seconds: secs.max(0),
                artist: norm(&artist),
                title: norm(&title),
                album: norm(&album),
                app_name: norm(&app),
                source_app: norm(&src_app),
                media_type: mtype,
                thumb,
            });
        }
    }
    Ok(out)
}

fn local_day(dt: &DateTime<Utc>) -> NaiveDate {
    dt.with_timezone(&Local).date_naive()
}

fn streaks(days: &BTreeMap<NaiveDate, i64>) -> (i64, i64) {
    let active: Vec<NaiveDate> = days.iter().filter(|(_, &v)| v > 0).map(|(d, _)| *d).collect();
    if active.is_empty() {
        return (0, 0);
    }
    let set: HashSet<NaiveDate> = active.iter().copied().collect();
    let mut longest = 1i64;
    let mut run = 1i64;
    for w in active.windows(2) {
        if (w[1] - w[0]).num_days() == 1 {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 1;
        }
    }
    let today = Local::now().date_naive();
    let mut cursor = if set.contains(&today) { today } else { today - Duration::days(1) };
    let mut current = 0i64;
    while set.contains(&cursor) {
        current += 1;
        cursor -= Duration::days(1);
    }
    (current, longest)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSlice {
    pub media_type: String,
    pub seconds: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicOverview {
    pub total_seconds: i64,
    pub today_seconds: i64,
    pub week_seconds: i64,
    pub month_seconds: i64,
    pub play_count: i64,
    pub distinct_artists: i64,
    pub distinct_tracks: i64,
    pub distinct_albums: i64,
    pub distinct_apps: i64,
    pub active_days: i64,
    pub current_streak: i64,
    pub longest_streak: i64,
    pub avg_per_active_day: i64,
    pub by_type: Vec<TypeSlice>,
}

pub fn overview(pool: &DbPool) -> AppResult<MusicOverview> {
    let plays = load(pool)?;
    let today = Local::now().date_naive();
    let week_start = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let month_start = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);

    let mut total = 0i64;
    let mut today_s = 0i64;
    let mut week_s = 0i64;
    let mut month_s = 0i64;
    let mut artists = HashSet::new();
    let mut tracks = HashSet::new();
    let mut albums = HashSet::new();
    let mut apps = HashSet::new();
    let mut day_map: BTreeMap<NaiveDate, i64> = BTreeMap::new();
    let mut type_map: HashMap<String, (i64, i64)> = HashMap::new();

    for p in &plays {
        total += p.seconds;
        let d = local_day(&p.start);
        *day_map.entry(d).or_default() += p.seconds;
        if d == today {
            today_s += p.seconds;
        }
        if d >= week_start {
            week_s += p.seconds;
        }
        if d >= month_start {
            month_s += p.seconds;
        }
        if let Some(a) = &p.artist {
            artists.insert(a.to_lowercase());
        }
        if let Some(t) = &p.title {
            tracks.insert(format!("{}|{}", t.to_lowercase(), p.artist.clone().unwrap_or_default().to_lowercase()));
        }
        if let Some(al) = &p.album {
            albums.insert(al.to_lowercase());
        }
        if let Some(app) = p.app_name.clone().or_else(|| p.source_app.clone()) {
            apps.insert(app.to_lowercase());
        }
        let e = type_map.entry(p.media_type.clone()).or_insert((0, 0));
        e.0 += p.seconds;
        e.1 += 1;
    }

    let active_days = day_map.values().filter(|&&v| v > 0).count() as i64;
    let (current_streak, longest_streak) = streaks(&day_map);
    let avg_per_active_day = if active_days > 0 { total / active_days } else { 0 };

    let mut by_type: Vec<TypeSlice> = type_map
        .into_iter()
        .map(|(media_type, (seconds, count))| TypeSlice { media_type, seconds, count })
        .collect();
    by_type.sort_by(|a, b| b.seconds.cmp(&a.seconds));

    Ok(MusicOverview {
        total_seconds: total,
        today_seconds: today_s,
        week_seconds: week_s,
        month_seconds: month_s,
        play_count: plays.len() as i64,
        distinct_artists: artists.len() as i64,
        distinct_tracks: tracks.len() as i64,
        distinct_albums: albums.len() as i64,
        distinct_apps: apps.len() as i64,
        active_days,
        current_streak,
        longest_streak,
        avg_per_active_day,
        by_type,
    })
}

pub fn heatmap(pool: &DbPool, days: i64) -> AppResult<Vec<DayValue>> {
    let plays = load(pool)?;
    let mut map: BTreeMap<NaiveDate, i64> = BTreeMap::new();
    for p in &plays {
        *map.entry(local_day(&p.start)).or_default() += p.seconds;
    }
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

pub fn hour_of_day(pool: &DbPool) -> AppResult<Vec<i64>> {
    let plays = load(pool)?;
    let mut hours = vec![0i64; 24];
    for p in &plays {
        hours[p.start.with_timezone(&Local).hour() as usize] += p.seconds;
    }
    Ok(hours)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicEntry {
    pub key: String,
    pub label: String,
    pub secondary: Option<String>,
    pub seconds: i64,
    pub count: i64,
    pub art: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicTop {
    pub artists: Vec<MusicEntry>,
    pub tracks: Vec<MusicEntry>,
    pub albums: Vec<MusicEntry>,
    pub apps: Vec<MusicEntry>,
}

struct Agg {
    label: String,
    secondary: Option<String>,
    seconds: i64,
    count: i64,
    art: Option<String>,
}

fn top_from(map: HashMap<String, Agg>, limit: usize) -> Vec<MusicEntry> {
    let mut v: Vec<MusicEntry> = map
        .into_iter()
        .map(|(key, a)| MusicEntry {
            key,
            label: a.label,
            secondary: a.secondary,
            seconds: a.seconds,
            count: a.count,
            art: a.art,
        })
        .collect();
    v.sort_by(|a, b| b.seconds.cmp(&a.seconds).then(b.count.cmp(&a.count)));
    v.truncate(limit);
    v
}

pub fn top(pool: &DbPool, limit: i64) -> AppResult<MusicTop> {
    let plays = load(pool)?;
    let limit = limit.clamp(1, 100) as usize;
    let mut artists: HashMap<String, Agg> = HashMap::new();
    let mut tracks: HashMap<String, Agg> = HashMap::new();
    let mut albums: HashMap<String, Agg> = HashMap::new();
    let mut apps: HashMap<String, Agg> = HashMap::new();

    let bump = |m: &mut HashMap<String, Agg>, key: String, label: String, secondary: Option<String>, p: &RawPlay| {
        let e = m.entry(key).or_insert(Agg { label, secondary, seconds: 0, count: 0, art: None });
        e.seconds += p.seconds;
        e.count += 1;
        if e.art.is_none() {
            e.art = p.thumb.clone();
        }
    };

    for p in &plays {
        if let Some(a) = &p.artist {
            bump(&mut artists, a.to_lowercase(), a.clone(), None, p);
        }
        if let Some(t) = &p.title {
            let key = format!("{}|{}", t.to_lowercase(), p.artist.clone().unwrap_or_default().to_lowercase());
            bump(&mut tracks, key, t.clone(), p.artist.clone(), p);
        }
        if let Some(al) = &p.album {
            bump(&mut albums, al.to_lowercase(), al.clone(), p.artist.clone(), p);
        }
        if let Some(app) = p.app_name.clone().or_else(|| p.source_app.clone()) {
            bump(&mut apps, app.to_lowercase(), app.clone(), None, p);
        }
    }

    Ok(MusicTop {
        artists: top_from(artists, limit),
        tracks: top_from(tracks, limit),
        albums: top_from(albums, limit),
        apps: top_from(apps, limit),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicInsights {
    pub most_repeated: Option<MusicEntry>,
    pub longest_play_seconds: i64,
    pub longest_play_label: Option<String>,
    pub night_owl_seconds: i64,
    pub peak_hour: i64,
    pub new_artists_this_month: i64,
    pub gaming_with_music_pct: f64,
    pub busiest_day: Option<DayValue>,
    pub first_listen_utc: Option<String>,
}

/// Wall-clock overlap (seconds) between music plays and game sessions, as a
/// fraction of total game session wall-clock — "how often you game with music on".
fn gaming_with_music_pct(pool: &DbPool, plays: &[RawPlay]) -> AppResult<f64> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT s.start_utc, COALESCE(s.end_utc, s.last_seen_utc)
         FROM sessions s JOIN games g ON g.id = s.game_id
         WHERE g.kind = 'game' AND s.end_utc IS NOT NULL",
    )?;
    let sessions: Vec<(DateTime<Utc>, DateTime<Utc>)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(|x| x.ok())
        .filter_map(|(a, b)| Some((crate::util::parse_utc(&a)?, crate::util::parse_utc(&b)?)))
        .collect();
    if sessions.is_empty() {
        return Ok(0.0);
    }
    let music: Vec<(DateTime<Utc>, DateTime<Utc>)> = plays
        .iter()
        .filter(|p| p.media_type == "music")
        .map(|p| (p.start, p.end.unwrap_or(p.start + Duration::seconds(p.seconds))))
        .collect();

    let total: i64 = sessions.iter().map(|(a, b)| (*b - *a).num_seconds().max(0)).sum();
    if total <= 0 {
        return Ok(0.0);
    }
    let mut overlap = 0i64;
    for (gs, ge) in &sessions {
        for (ms, me) in &music {
            let lo = (*gs).max(*ms);
            let hi = (*ge).min(*me);
            if hi > lo {
                overlap += (hi - lo).num_seconds();
            }
        }
    }
    Ok(((overlap as f64 / total as f64) * 100.0).clamp(0.0, 100.0))
}

pub fn insights(pool: &DbPool) -> AppResult<MusicInsights> {
    let plays = load(pool)?;

    // most repeated track (by play count)
    let mut tracks: HashMap<String, Agg> = HashMap::new();
    let mut hours = vec![0i64; 24];
    let mut night = 0i64;
    let mut day_map: BTreeMap<NaiveDate, i64> = BTreeMap::new();
    let mut longest = 0i64;
    let mut longest_label: Option<String> = None;
    let mut first_listen: Option<DateTime<Utc>> = None;
    let mut artist_first: HashMap<String, NaiveDate> = HashMap::new();

    for p in &plays {
        let h = p.start.with_timezone(&Local).hour() as usize;
        hours[h] += p.seconds;
        if h < 5 {
            night += p.seconds;
        }
        let d = local_day(&p.start);
        *day_map.entry(d).or_default() += p.seconds;
        if p.seconds > longest {
            longest = p.seconds;
            longest_label = p.title.clone().or_else(|| p.app_name.clone());
        }
        first_listen = Some(match first_listen {
            Some(f) => f.min(p.start),
            None => p.start,
        });
        if let Some(t) = &p.title {
            let key = format!("{}|{}", t.to_lowercase(), p.artist.clone().unwrap_or_default().to_lowercase());
            let e = tracks.entry(key).or_insert(Agg {
                label: t.clone(),
                secondary: p.artist.clone(),
                seconds: 0,
                count: 0,
                art: None,
            });
            e.seconds += p.seconds;
            e.count += 1;
            if e.art.is_none() {
                e.art = p.thumb.clone();
            }
        }
        if let Some(a) = &p.artist {
            let key = a.to_lowercase();
            let d = local_day(&p.start);
            artist_first.entry(key).and_modify(|cur| { if d < *cur { *cur = d; } }).or_insert(d);
        }
    }

    let most_repeated = tracks
        .into_iter()
        .max_by(|a, b| a.1.count.cmp(&b.1.count).then(a.1.seconds.cmp(&b.1.seconds)))
        .map(|(key, a)| MusicEntry {
            key,
            label: a.label,
            secondary: a.secondary,
            seconds: a.seconds,
            count: a.count,
            art: a.art,
        });

    let peak_hour = hours
        .iter()
        .enumerate()
        .max_by_key(|(_, v)| **v)
        .map(|(i, _)| i as i64)
        .unwrap_or(0);

    let busiest_day = day_map
        .iter()
        .max_by_key(|(_, v)| **v)
        .map(|(d, v)| DayValue { date: d.format("%Y-%m-%d").to_string(), seconds: *v });

    let today = Local::now().date_naive();
    let month_start = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);
    let new_artists_this_month = artist_first.values().filter(|d| **d >= month_start).count() as i64;

    let gaming_with_music_pct = gaming_with_music_pct(pool, &plays)?;

    Ok(MusicInsights {
        most_repeated,
        longest_play_seconds: longest,
        longest_play_label: longest_label,
        night_owl_seconds: night,
        peak_hour,
        new_artists_this_month,
        gaming_with_music_pct,
        busiest_day,
        first_listen_utc: first_listen.map(|d| d.to_rfc3339()),
    })
}
