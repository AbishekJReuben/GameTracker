//! HowLongToBeat lookup — user-triggered (CSV import / explicit fetch).
//! Uses HLTB's internal `/api/bleed` endpoints (no official public API).
use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use serde::Deserialize;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const BASE: &str = "https://howlongtobeat.com";
const INIT_URL: &str = "https://howlongtobeat.com/api/bleed/init";
const SEARCH_URL: &str = "https://howlongtobeat.com/api/bleed";
const TIMEOUT: Duration = Duration::from_secs(20);
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Default)]
pub struct HltbTimes {
    pub main_minutes: Option<i64>,
    pub main_extra_minutes: Option<i64>,
    pub completionist_minutes: Option<i64>,
    pub hltb_game_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct InitResp {
    token: Option<String>,
    #[serde(rename = "hpKey")]
    hp_key: Option<String>,
    #[serde(rename = "hpVal")]
    hp_val: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SearchResp {
    data: Option<Vec<RawGame>>,
}

#[derive(Debug, Deserialize)]
struct RawGame {
    game_id: Option<i64>,
    game_name: Option<String>,
    comp_main: Option<i64>,
    comp_plus: Option<i64>,
    comp_100: Option<i64>,
}

struct Token {
    token: String,
    hp_key: String,
    hp_val: String,
    expiry: Instant,
}

static TOKEN: OnceLock<Mutex<Option<Token>>> = OnceLock::new();

fn token_store() -> &'static Mutex<Option<Token>> {
    TOKEN.get_or_init(|| Mutex::new(None))
}

fn normalize_name(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn names_match(query: &str, candidate: &str) -> bool {
    let q = normalize_name(query);
    let c = normalize_name(candidate);
    if q.is_empty() || c.is_empty() {
        return false;
    }
    q == c || c.contains(&q) || q.contains(&c)
}

fn secs_to_minutes(secs: i64) -> Option<i64> {
    if secs > 0 {
        Some((secs + 59) / 60)
    } else {
        None
    }
}

fn fetch_token() -> AppResult<(String, String, String)> {
    {
        let guard = token_store().lock();
        if let Some(t) = guard.as_ref() {
            if Instant::now() < t.expiry {
                return Ok((t.token.clone(), t.hp_key.clone(), t.hp_val.clone()));
            }
        }
    }

    let url = format!("{INIT_URL}?t={}", chrono::Utc::now().timestamp_millis());
    let resp = ureq::get(&url)
        .set("User-Agent", UA)
        .set("Referer", &format!("{BASE}/"))
        .set("Origin", BASE)
        .timeout(TIMEOUT)
        .call()
        .map_err(|e| AppError::msg(format!("HLTB init failed: {e}")))?;

    let init: InitResp = resp
        .into_json()
        .map_err(|e| AppError::msg(format!("HLTB init parse failed: {e}")))?;

    let token = init
        .token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::msg("HLTB returned no auth token"))?;
    let hp_key = init
        .hp_key
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::msg("HLTB returned no hpKey"))?;
    let hp_val = init
        .hp_val
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::msg("HLTB returned no hpVal"))?;

    *token_store().lock() = Some(Token {
        token: token.clone(),
        hp_key: hp_key.clone(),
        hp_val: hp_val.clone(),
        expiry: Instant::now() + Duration::from_secs(3600),
    });

    Ok((token, hp_key, hp_val))
}

fn build_payload(query: &str, hp_key: &str, hp_val: &str) -> serde_json::Value {
    let terms: Vec<&str> = query.trim().split_whitespace().collect();
    let mut obj = serde_json::json!({
        "searchType": "games",
        "searchTerms": terms,
        "searchPage": 1,
        "size": 5,
        "searchOptions": {
            "games": {
                "userId": 0,
                "platform": "",
                "sortCategory": "popular",
                "rangeCategory": "main",
                "rangeTime": { "min": null, "max": null },
                "gameplay": { "perspective": "", "flow": "", "genre": "", "difficulty": "" },
                "rangeYear": { "min": "", "max": "" },
                "modifier": ""
            },
            "users": { "sortCategory": "postcount" },
            "lists": { "sortCategory": "follows" },
            "filter": "",
            "sort": 0,
            "randomizer": 0
        },
        "useCache": true
    });
    if let Some(map) = obj.as_object_mut() {
        map.insert(hp_key.to_string(), serde_json::Value::String(hp_val.to_string()));
    }
    obj
}

fn pick_best(query: &str, games: Vec<RawGame>) -> Option<RawGame> {
    let mut best: Option<(i32, RawGame)> = None;
    for g in games {
        let name = g.game_name.as_deref().unwrap_or("");
        let score = if names_match(query, name) {
            100
        } else if normalize_name(name).starts_with(&normalize_name(query)) {
            80
        } else {
            40
        };
        if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
            best = Some((score, g));
        }
    }
    best.map(|(_, g)| g)
}

/// Search HLTB for a game and return completion-time estimates.
pub fn lookup(name: &str) -> AppResult<Option<HltbTimes>> {
    let query = name.trim();
    if query.is_empty() {
        return Ok(None);
    }

    let (token, hp_key, hp_val) = fetch_token()?;
    let body = build_payload(query, &hp_key, &hp_val);

    let resp = ureq::post(SEARCH_URL)
        .set("User-Agent", UA)
        .set("Referer", &format!("{BASE}/"))
        .set("Origin", BASE)
        .set("Content-Type", "application/json")
        .set("Accept", "*/*")
        .set("x-auth-token", &token)
        .set("x-hp-key", &hp_key)
        .set("x-hp-val", &hp_val)
        .timeout(TIMEOUT)
        .send_json(body)
        .map_err(|e| AppError::msg(format!("HLTB search failed: {e}")))?;

    let parsed: SearchResp = resp
        .into_json()
        .map_err(|e| AppError::msg(format!("HLTB search parse failed: {e}")))?;

    let games = parsed.data.unwrap_or_default();
    let game = match pick_best(query, games) {
        Some(g) => g,
        None => return Ok(None),
    };

    Ok(Some(HltbTimes {
        main_minutes: game.comp_main.and_then(secs_to_minutes),
        main_extra_minutes: game.comp_plus.and_then(secs_to_minutes),
        completionist_minutes: game.comp_100.and_then(secs_to_minutes),
        hltb_game_id: game.game_id,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_handles_substrings() {
        assert!(names_match("Elden Ring", "Elden Ring"));
        assert!(names_match("witcher", "The Witcher 3: Wild Hunt"));
    }
}
