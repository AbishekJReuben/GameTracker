//! Hybrid game suggestions for a single-user local library.
//!
//! Approach (research-backed, adapted for offline-first single user):
//! - **Content-based filtering**: build a taste vector from tags, developers, years,
//!   playtime length, ratings, and status (completed/playing vs dropped).
//! - **Implicit feedback**: log-scaled hours played weights engagement.
//! - **Explicit feedback**: personal score and Metacritic alignment.
//! - **Discovery**: query Steam's keyless store search API using top taste signals,
//!   score candidates, return ranked picks with human-readable reasons.
//!
//! Collaborative filtering across users isn't possible locally; we approximate
//! "people who liked X also liked Y" via tag/developer similarity.

use crate::db::games;
use crate::db::models::GameDto;
use crate::db::settings;
use crate::db::DbPool;
use crate::error::{AppError, AppResult};
use crate::metadata::{self, steam_cover_url, steam_header_url};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::thread;
use std::time::Duration;

const CACHE_KEY: &str = "suggestions_cache_json";
const CACHE_AT_KEY: &str = "suggestions_cache_at";
const EXCLUDED_TAGS_KEY: &str = "suggestions_excluded_tags";
const ROTATION_KEY: &str = "suggestions_rotation";
const PREV_IDS_KEY: &str = "suggestions_prev_ids";
const CACHE_TTL_SECS: i64 = 86_400; // 24h
const PREV_IDS_CAP: usize = 160;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasteTag {
    pub tag: String,
    pub weight: f64,
    pub loved_games: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasteDeveloper {
    pub name: String,
    pub weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasteProfile {
    pub loved_count: i64,
    pub disliked_count: i64,
    pub neutral_count: i64,
    pub top_tags: Vec<TasteTag>,
    pub top_developers: Vec<TasteDeveloper>,
    pub preferred_hours: Option<f64>,
    pub preferred_year: Option<i64>,
    pub avg_my_score: Option<f64>,
    pub avg_metacritic: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSuggestion {
    pub steam_app_id: u64,
    pub name: String,
    pub developer: Option<String>,
    pub release_year: Option<i64>,
    pub metacritic: Option<i64>,
    pub genres: Vec<String>,
    pub short_description: Option<String>,
    pub cover_url: String,
    pub header_image_url: String,
    pub match_score: f64,
    pub match_percent: i64,
    pub reasons: Vec<String>,
    pub estimated_hours: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionsResult {
    pub generated_at: String,
    pub cached: bool,
    pub taste: TasteProfile,
    pub suggestions: Vec<GameSuggestion>,
    #[serde(default)]
    pub excluded_tags: Vec<String>,
}

struct TasteState {
    tag_weights: HashMap<String, f64>,
    tag_loved: HashMap<String, i64>,
    dev_weights: HashMap<String, f64>,
    years: Vec<f64>,
    lengths_hours: Vec<f64>,
    my_scores: Vec<f64>,
    meta_scores: Vec<f64>,
    loved: i64,
    disliked: i64,
    neutral: i64,
}

fn normalize_name(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn game_signal(g: &GameDto) -> f64 {
    let hours = g.total_runtime_seconds as f64 / 3600.0;
    let engagement = (1.0 + (hours + 0.25).ln()).min(4.0);

    let mut signal = 0.0;

    if let Some(r) = g.rating {
        signal += (r as f64 - 70.0) / 12.0;
    }

    match g.status.as_str() {
        "dropped" => signal -= 2.2,
        "completed" => {
            signal += 0.65;
            if g.rating.is_none() {
                signal += 0.25;
            }
        }
        "playing" => {
            if hours >= 10.0 {
                signal += 1.0;
            } else if hours >= 2.0 {
                signal += 0.45;
            }
        }
        _ => {}
    }

    if hours >= 25.0 && g.status != "dropped" {
        signal += 0.75;
    } else if hours < 1.0 && g.status == "dropped" {
        signal -= 0.5;
    }

    if let (Some(my), Some(mc)) = (g.rating, g.metacritic) {
        let delta = my as f64 - mc as f64;
        if delta > 12.0 {
            signal += 0.35;
        } else if delta < -15.0 {
            signal -= 0.4;
        }
    }

    signal * engagement.sqrt().max(0.45)
}

fn length_hours(g: &GameDto) -> Option<f64> {
    if let Some(m) = g.hltb_main_extra_minutes.or(g.hltb_main_minutes) {
        return Some(m as f64 / 60.0);
    }
    if g.total_runtime_seconds > 0 {
        return Some(g.total_runtime_seconds as f64 / 3600.0);
    }
    g.time_to_beat_minutes.map(|m| m as f64 / 60.0)
}

fn build_taste(games: &[GameDto]) -> TasteState {
    let mut state = TasteState {
        tag_weights: HashMap::new(),
        tag_loved: HashMap::new(),
        dev_weights: HashMap::new(),
        years: Vec::new(),
        lengths_hours: Vec::new(),
        my_scores: Vec::new(),
        meta_scores: Vec::new(),
        loved: 0,
        disliked: 0,
        neutral: 0,
    };

    for g in games {
        let sig = game_signal(g);
        if sig > 1.0 {
            state.loved += 1;
        } else if sig < -1.0 {
            state.disliked += 1;
        } else {
            state.neutral += 1;
        }

        for tag in &g.tags {
            let key = tag.trim().to_string();
            if key.is_empty() {
                continue;
            }
            *state.tag_weights.entry(key.clone()).or_default() += sig;
            if sig > 0.8 {
                *state.tag_loved.entry(key).or_default() += 1;
            }
        }

        if let Some(dev) = &g.developer {
            let d = dev.trim().to_string();
            if !d.is_empty() {
                *state.dev_weights.entry(d).or_default() += sig;
            }
        }

        if let Some(y) = g.release_year.or(g.completed_year) {
            if sig > 0.0 {
                state.years.push(y as f64);
            }
        }

        if sig > 0.0 {
            if let Some(h) = length_hours(g) {
                state.lengths_hours.push(h);
            }
        }

        if let Some(r) = g.rating {
            state.my_scores.push(r as f64);
        }
        if let Some(m) = g.metacritic {
            state.meta_scores.push(m as f64);
        }
    }

    state
}

fn taste_profile(state: &TasteState) -> TasteProfile {
    let mut tags: Vec<TasteTag> = state
        .tag_weights
        .iter()
        .filter(|(_, w)| **w > 0.15)
        .map(|(tag, weight)| TasteTag {
            tag: tag.clone(),
            weight: (*weight * 10.0).round() / 10.0,
            loved_games: *state.tag_loved.get(tag).unwrap_or(&0),
        })
        .collect();
    tags.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));
    tags.truncate(10);

    let mut devs: Vec<TasteDeveloper> = state
        .dev_weights
        .iter()
        .filter(|(_, w)| **w > 0.2)
        .map(|(name, weight)| TasteDeveloper {
            name: name.clone(),
            weight: (*weight * 10.0).round() / 10.0,
        })
        .collect();
    devs.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));
    devs.truncate(6);

    let preferred_hours = if state.lengths_hours.is_empty() {
        None
    } else {
        let sum: f64 = state.lengths_hours.iter().sum();
        Some((sum / state.lengths_hours.len() as f64 * 10.0).round() / 10.0)
    };

    let preferred_year = if state.years.is_empty() {
        None
    } else {
        let sum: f64 = state.years.iter().sum();
        Some((sum / state.years.len() as f64).round() as i64)
    };

    let avg_my = if state.my_scores.is_empty() {
        None
    } else {
        Some(state.my_scores.iter().sum::<f64>() / state.my_scores.len() as f64)
    };
    let avg_meta = if state.meta_scores.is_empty() {
        None
    } else {
        Some(state.meta_scores.iter().sum::<f64>() / state.meta_scores.len() as f64)
    };

    TasteProfile {
        loved_count: state.loved,
        disliked_count: state.disliked,
        neutral_count: state.neutral,
        top_tags: tags,
        top_developers: devs,
        preferred_hours,
        preferred_year,
        avg_my_score: avg_my.map(|v| (v * 10.0).round() / 10.0),
        avg_metacritic: avg_meta.map(|v| (v * 10.0).round() / 10.0),
    }
}

struct RawCandidate {
    appid: u64,
    name: String,
}

fn discover_candidates(
    taste: &TasteState,
    owned: &HashSet<String>,
    exclude_ids: &HashSet<u64>,
    rotation: i64,
) -> Vec<RawCandidate> {
    let mut seen_ids: HashSet<u64> = HashSet::new();
    let mut out: Vec<RawCandidate> = Vec::new();

    // All on-taste seed tags, strongest first.
    let mut ranked: Vec<String> = taste
        .tag_weights
        .iter()
        .filter(|(_, w)| **w > 0.35)
        .map(|(t, _)| t.clone())
        .collect();
    ranked.sort_by(|a, b| {
        taste
            .tag_weights
            .get(b)
            .unwrap_or(&0.0)
            .partial_cmp(taste.tag_weights.get(a).unwrap_or(&0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Rotate the seed window on each refresh so we explore *different* genres
    // instead of returning the same top picks every time.
    if !ranked.is_empty() {
        let rot = (rotation.rem_euclid(ranked.len() as i64)) as usize;
        ranked.rotate_left(rot);
    }
    let mut queries: Vec<String> = ranked.into_iter().take(10).collect();

    // Rotate developer seeds too.
    let mut devs: Vec<String> = taste
        .dev_weights
        .iter()
        .filter(|(_, w)| **w > 0.5)
        .map(|(d, _)| d.clone())
        .collect();
    if !devs.is_empty() {
        let rot = (rotation.rem_euclid(devs.len() as i64)) as usize;
        devs.rotate_left(rot);
    }
    queries.extend(devs.into_iter().take(4));

    if queries.is_empty() {
        // Cold-start: rotate through broad genres so refresh still varies.
        let broad = [
            "indie", "action", "adventure", "rpg", "strategy", "roguelike",
            "story rich", "open world", "puzzle", "shooter",
        ];
        let start = (rotation.rem_euclid(broad.len() as i64)) as usize;
        for i in 0..4 {
            queries.push(broad[(start + i) % broad.len()].to_string());
        }
    }

    for term in queries {
        for (appid, name) in metadata::search_steam_games(&term, 14) {
            if seen_ids.contains(&appid) || exclude_ids.contains(&appid) {
                continue;
            }
            let norm = normalize_name(&name);
            if owned.contains(&norm) {
                continue;
            }
            seen_ids.insert(appid);
            out.push(RawCandidate { appid, name });
        }
        thread::sleep(Duration::from_millis(220));
        if out.len() >= 90 {
            break;
        }
    }

    out
}

fn year_fit(year: Option<i64>, preferred: Option<i64>) -> f64 {
    let Some(pref) = preferred else { return 0.0 };
    let Some(y) = year else { return -0.15 };
    let d = (y - pref).unsigned_abs() as f64;
    if d <= 2.0 {
        1.0
    } else if d <= 5.0 {
        0.6
    } else if d <= 8.0 {
        0.2
    } else {
        -0.25
    }
}

fn length_fit(hours: Option<f64>, preferred: Option<f64>) -> f64 {
    let Some(pref) = preferred else { return 0.0 };
    let Some(h) = hours else { return 0.0 };
    let ratio = h / pref.max(1.0);
    if (0.55..=1.8).contains(&ratio) {
        1.0
    } else if (0.35..=2.5).contains(&ratio) {
        0.45
    } else {
        -0.2
    }
}

fn score_candidate(
    appid: u64,
    name: &str,
    details: &metadata::AppDetailsData,
    taste: &TasteState,
    profile: &TasteProfile,
    excluded: &HashSet<String>,
) -> Option<GameSuggestion> {
    let genres = metadata::collect_tags(appid, details);

    // Hard filter: the user explicitly muted these tags.
    if !excluded.is_empty()
        && genres
            .iter()
            .any(|g| excluded.contains(&g.trim().to_lowercase()))
    {
        return None;
    }

    let developer = details
        .developers
        .as_ref()
        .and_then(|d| d.first())
        .cloned()
        .filter(|s| !s.trim().is_empty());

    let release_year = details
        .release_date
        .as_ref()
        .and_then(|r| r.date.as_deref())
        .and_then(|d| {
            d.split(|c: char| !c.is_ascii_digit())
                .find(|w| w.len() == 4)
                .and_then(|w| w.parse::<i64>().ok())
        });

    let metacritic = details.metacritic.as_ref().map(|m| m.score);

    let mut score = 0.0_f64;
    let mut reasons: Vec<String> = Vec::new();

    for tag in &genres {
        if let Some(w) = taste.tag_weights.get(tag) {
            if *w > 0.35 {
                score += w * 3.2;
                if reasons.len() < 4 {
                    let loved = taste.tag_loved.get(tag).copied().unwrap_or(0);
                    if loved > 0 {
                        reasons.push(format!(
                            "You rated {loved} {tag} game{} highly",
                            if loved == 1 { "" } else { "s" }
                        ));
                    } else {
                        reasons.push(format!("Matches your interest in {tag}"));
                    }
                }
            } else if *w < -0.35 {
                score += w * 2.5;
            }
        }
    }

    if let Some(dev) = &developer {
        if let Some(w) = taste.dev_weights.get(dev) {
            if *w > 0.4 {
                score += w * 2.8;
                if reasons.len() < 4 {
                    reasons.push(format!("From {dev}, a studio you've enjoyed"));
                }
            }
        }
    }

    score += year_fit(release_year, profile.preferred_year) * 1.2;
    if profile.preferred_year.is_some() && release_year.is_some() && reasons.len() < 4 {
        if year_fit(release_year, profile.preferred_year) > 0.5 {
            reasons.push(format!(
                "Release era fits your favorites (~{}))",
                profile.preferred_year.unwrap_or(0)
            ));
        }
    }

  // Metacritic sweet spot
    if let (Some(mc), Some(avg)) = (metacritic, profile.avg_metacritic) {
        let diff = (mc as f64 - avg).abs();
        if diff <= 8.0 {
            score += 1.1;
            if reasons.len() < 4 {
                reasons.push(format!("Metacritic {mc} — in your usual critic range"));
            }
        } else if let Some(my) = profile.avg_my_score {
            if (mc as f64) <= my + 5.0 && (mc as f64) >= my - 12.0 {
                score += 0.6;
            }
        }
    }

    let est_hours = None::<f64>; // filled later if we add HLTB pass (skip for speed)
    score += length_fit(est_hours, profile.preferred_hours) * 0.8;

    if score < 0.5 {
        return None;
    }

    let match_percent = ((score / 12.0) * 100.0).clamp(35.0, 99.0).round() as i64;

    if reasons.is_empty() {
        reasons.push("Strong overlap with your library taste".to_string());
    }

    Some(GameSuggestion {
        steam_app_id: appid,
        name: details
            .name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| name.to_string()),
        developer,
        release_year,
        metacritic,
        genres,
        short_description: details
            .short_description
            .clone()
            .filter(|s| !s.trim().is_empty()),
        cover_url: steam_cover_url(appid),
        header_image_url: steam_header_url(appid),
        match_score: (score * 100.0).round() / 100.0,
        match_percent,
        reasons: reasons.into_iter().take(3).collect(),
        estimated_hours: est_hours,
    })
}

fn owned_names(games: &[GameDto]) -> HashSet<String> {
    games
        .iter()
        .map(|g| normalize_name(&g.display_name))
        .filter(|s| !s.is_empty())
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSuggestionInput {
    pub name: String,
    pub developer: Option<String>,
    pub release_year: Option<i64>,
    pub metacritic: Option<i64>,
    pub genres: Vec<String>,
    pub steam_app_id: Option<u64>,
}

/// Tags the user has muted; they are dropped from taste, seeds, and results.
pub fn load_excluded_tags(pool: &DbPool) -> Vec<String> {
    settings::get(pool, EXCLUDED_TAGS_KEY)
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

fn excluded_set(pool: &DbPool) -> HashSet<String> {
    load_excluded_tags(pool)
        .into_iter()
        .map(|t| t.to_lowercase())
        .collect()
}

/// Replace the muted-tags list (case-insensitive, de-duplicated).
pub fn set_excluded_tags(pool: &DbPool, tags: &[String]) -> AppResult<()> {
    let mut seen = HashSet::new();
    let cleaned: Vec<String> = tags
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty() && seen.insert(t.to_lowercase()))
        .collect();
    let json = serde_json::to_string(&cleaned).map_err(|e| AppError::msg(e.to_string()))?;
    settings::set(pool, EXCLUDED_TAGS_KEY, &json)
}

fn load_prev_ids(pool: &DbPool) -> HashSet<u64> {
    settings::get(pool, PREV_IDS_KEY)
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str::<Vec<u64>>(&j).ok())
        .unwrap_or_default()
        .into_iter()
        .collect()
}

fn save_prev_ids(pool: &DbPool, ids: &[u64]) {
    let mut existing: Vec<u64> = {
        settings::get(pool, PREV_IDS_KEY)
            .ok()
            .flatten()
            .and_then(|j| serde_json::from_str::<Vec<u64>>(&j).ok())
            .unwrap_or_default()
    };
    for id in ids {
        if !existing.contains(id) {
            existing.push(*id);
        }
    }
    if existing.len() > PREV_IDS_CAP {
        let drop = existing.len() - PREV_IDS_CAP;
        existing.drain(0..drop);
    }
    if let Ok(j) = serde_json::to_string(&existing) {
        let _ = settings::set(pool, PREV_IDS_KEY, &j);
    }
}

fn bump_rotation(pool: &DbPool) -> i64 {
    let cur = settings::get(pool, ROTATION_KEY)
        .ok()
        .flatten()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let next = cur.wrapping_add(1);
    let _ = settings::set(pool, ROTATION_KEY, &next.to_string());
    next
}

pub fn generate(pool: &DbPool, refresh: bool) -> AppResult<SuggestionsResult> {
    if !settings::get_bool(pool, "online_metadata_enabled")? {
        return Err(AppError::msg(
            "Turn on “Online metadata” in Settings to discover suggested games.",
        ));
    }

    let excluded_display = load_excluded_tags(pool);
    let excluded = excluded_set(pool);

    let now = chrono::Utc::now().to_rfc3339();
    if !refresh {
        if let (Ok(Some(json)), Ok(Some(at))) = (
            settings::get(pool, CACHE_AT_KEY),
            settings::get(pool, CACHE_KEY),
        ) {
            if let Ok(ts) = chrono::DateTime::parse_from_rfc3339(&at) {
                let age = chrono::Utc::now().timestamp() - ts.with_timezone(&chrono::Utc).timestamp();
                if age < CACHE_TTL_SECS {
                    if let Ok(mut cached) = serde_json::from_str::<SuggestionsResult>(&json) {
                        cached.cached = true;
                        cached.excluded_tags = excluded_display.clone();
                        return Ok(cached);
                    }
                }
            }
        }
    }

    // Taste is learned from games only — apps never influence game suggestions.
    let library: Vec<GameDto> = games::list(pool)?
        .into_iter()
        .filter(|g| g.kind == "game")
        .collect();
    if library.len() < 3 {
        return Err(AppError::msg(
            "Add at least 3 games with tags, scores, or playtime so we can learn your taste.",
        ));
    }

    let mut taste_state = build_taste(&library);
    // Drop muted tags from the taste signal entirely.
    for tag in excluded.iter() {
        taste_state.tag_weights.retain(|k, _| k.to_lowercase() != *tag);
        taste_state.tag_loved.retain(|k, _| k.to_lowercase() != *tag);
    }
    let profile = taste_profile(&taste_state);
    let owned = owned_names(&library);

    let rotation = if refresh { bump_rotation(pool) } else {
        settings::get(pool, ROTATION_KEY)
            .ok()
            .flatten()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0)
    };
    // On an explicit refresh, avoid repeating games we recently surfaced.
    let exclude_ids = if refresh { load_prev_ids(pool) } else { HashSet::new() };

    let candidates = discover_candidates(&taste_state, &owned, &exclude_ids, rotation);

    let mut scored: Vec<GameSuggestion> = Vec::new();
    for (i, c) in candidates.iter().enumerate() {
        if let Some(details) = metadata::fetch_steam_details(c.appid) {
            if let Some(s) =
                score_candidate(c.appid, &c.name, &details, &taste_state, &profile, &excluded)
            {
                scored.push(s);
            }
        }
        if i % 5 == 4 {
            thread::sleep(Duration::from_millis(180));
        }
        if scored.len() >= 30 {
            break;
        }
    }

    scored.sort_by(|a, b| {
        b.match_score
            .partial_cmp(&a.match_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(20);

    // Remember what we showed so the next refresh can rotate to fresh picks.
    let shown_ids: Vec<u64> = scored.iter().map(|s| s.steam_app_id).collect();
    save_prev_ids(pool, &shown_ids);

    let result = SuggestionsResult {
        generated_at: now.clone(),
        cached: false,
        taste: profile,
        suggestions: scored,
        excluded_tags: excluded_display,
    };

    let json = serde_json::to_string(&result).map_err(|e| AppError::msg(e.to_string()))?;
    settings::set(pool, CACHE_KEY, &json)?;
    settings::set(pool, CACHE_AT_KEY, &now)?;

    Ok(result)
}
