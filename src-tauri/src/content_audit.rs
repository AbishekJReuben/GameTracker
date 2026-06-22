//! Probe which online content sources are available per library entry (read-only).

use crate::db::models::GameDto;
use crate::error::{AppError, AppResult};
use crate::hltb;
use crate::metadata;
use serde::Serialize;
use std::path::Path;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentProbe {
    pub key: String,
    pub label: String,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentAuditRow {
    pub game_id: String,
    pub display_name: String,
    pub kind: String,
    pub probes: Vec<ContentProbe>,
}

fn probe(key: &str, label: &str, status: &str, detail: Option<String>) -> ContentProbe {
    ContentProbe {
        key: key.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        detail,
    }
}

fn local_cover_exists(media_dir: &Path, cover: &Option<String>) -> bool {
    cover
        .as_ref()
        .filter(|p| !p.trim().is_empty())
        .map(|p| {
            let path = Path::new(p);
            if path.is_absolute() {
                path.exists()
            } else {
                media_dir.join(path).exists()
            }
        })
        .unwrap_or(false)
}

fn probe_hltb_online(name: &str) -> (&'static str, Option<String>) {
    let (tx, rx) = mpsc::channel();
    let name = name.to_string();
    thread::spawn(move || {
        let ok = hltb::lookup(&name)
            .ok()
            .flatten()
            .map(|t| t.main_minutes.is_some() || t.main_extra_minutes.is_some())
            .unwrap_or(false);
        let _ = tx.send(ok);
    });
    match rx.recv_timeout(Duration::from_secs(8)) {
        Ok(true) => ("available", None),
        Ok(false) => ("missing", None),
        Err(_) => ("error", Some("Timed out".into())),
    }
}

fn resolved_steam_id(game: &GameDto) -> Option<u64> {
    metadata::resolve_steam_appid_checked(
        &game.display_name,
        game.steam_app_id.filter(|&id| id > 0).map(|id| id as u64),
    )
}

fn resolved_mc_slug(game: &GameDto) -> Option<String> {
    game.metacritic_slug
        .as_deref()
        .filter(|s| metadata::metacritic_slug_valid(s, &game.display_name))
        .map(str::to_string)
        .or_else(|| metadata::resolve_metacritic_slug(&game.display_name))
}

pub fn audit_games(games: &[GameDto], media_dir: &Path) -> AppResult<Vec<ContentAuditRow>> {
    let mut out = Vec::with_capacity(games.len());
    for (i, game) in games.iter().enumerate() {
        if i > 0 {
            thread::sleep(Duration::from_millis(40));
        }
        out.push(audit_one(game, media_dir));
    }
    Ok(out)
}

pub fn audit_one(game: &GameDto, media_dir: &Path) -> ContentAuditRow {
    let is_game = game.kind == "game";
    let mut probes = Vec::new();
    let steam_id = if is_game {
        resolved_steam_id(game)
    } else {
        None
    };

    if local_cover_exists(media_dir, &game.cover_path) {
        probes.push(probe("cover", "Cover art", "stored", Some("Saved locally".into())));
    } else if is_game {
        match steam_id {
            Some(id) => {
                let ok = metadata::steam_cover_available(id);
                probes.push(probe(
                    "cover",
                    "Cover art",
                    if ok { "available" } else { "missing" },
                    Some(format!("Steam app {id}")),
                ));
            }
            None => probes.push(probe("cover", "Cover art", "missing", None)),
        }
    } else if game.icon_path.is_some() {
        probes.push(probe("cover", "Cover art", "stored", Some("App icon".into())));
    } else {
        probes.push(probe("cover", "Cover art", "n/a", Some("Apps use icons".into())));
    }

    if is_game {
        match steam_id {
            Some(id) => {
                let ok = metadata::fetch_steam_details(id).is_some();
                probes.push(probe(
                    "steam",
                    "Steam store",
                    if ok { "available" } else { "missing" },
                    Some(id.to_string()),
                ));
            }
            None => probes.push(probe("steam", "Steam store", "missing", None)),
        }
    } else {
        probes.push(probe("steam", "Steam store", "n/a", None));
    }

    if is_game {
        match resolved_mc_slug(game) {
            Some(s) => {
                let ok = metadata::fetch_metacritic_reviews(&s)
                    .map(|r| !r.is_empty())
                    .unwrap_or(false);
                probes.push(probe(
                    "metacritic",
                    "Metacritic",
                    if ok { "available" } else { "missing" },
                    Some(s),
                ));
            }
            None => probes.push(probe("metacritic", "Metacritic", "missing", None)),
        }
    } else {
        probes.push(probe("metacritic", "Metacritic", "n/a", None));
    }

    if is_game {
        if game.hltb_main_extra_minutes.is_some() || game.hltb_main_minutes.is_some() {
            probes.push(probe(
                "hltb",
                "HowLongToBeat",
                "stored",
                game.hltb_main_extra_minutes
                    .or(game.hltb_main_minutes)
                    .map(format_minutes_hm),
            ));
        } else {
            let (status, detail) = probe_hltb_online(&game.display_name);
            probes.push(probe("hltb", "HowLongToBeat", status, detail));
        }
    } else {
        probes.push(probe("hltb", "HowLongToBeat", "n/a", None));
    }

    if is_game {
        let playable = game
            .trailer_url
            .as_deref()
            .and_then(metadata::trailer_playable_url)
            .or_else(|| {
                steam_id
                    .and_then(metadata::fetch_steam_details)
                    .and_then(|d| metadata::trailer_url(&d))
                    .and_then(|u| metadata::trailer_playable_url(&u))
            });
        probes.push(probe(
            "trailer",
            "Trailer",
            if playable.is_some() {
                "available"
            } else {
                "missing"
            },
            playable,
        ));
    } else {
        probes.push(probe("trailer", "Trailer", "n/a", None));
    }

    if is_game {
        if game.theme_youtube_id.is_some() || game.theme_audio_url.is_some() {
            probes.push(probe(
                "theme",
                "Theme audio",
                "stored",
                game.theme_youtube_id
                    .clone()
                    .or(game.theme_audio_url.clone()),
            ));
        } else {
            let (yt, itunes) = metadata::resolve_theme(&game.display_name);
            let status = if yt.is_some() || itunes.is_some() {
                "available"
            } else {
                "missing"
            };
            let detail = yt
                .map(|id| format!("YouTube {id}"))
                .or(itunes.map(|u| u.chars().take(60).collect()));
            probes.push(probe("theme", "Theme audio", status, detail));
        }
    } else {
        probes.push(probe("theme", "Theme audio", "n/a", None));
    }

    let website = game
        .website
        .clone()
        .filter(|u| metadata::url_reachable(u))
        .or_else(|| metadata::known_app_website(&game.display_name))
        .or_else(|| {
            steam_id
                .and_then(metadata::fetch_steam_details)
                .and_then(|d| d.website)
                .filter(|u| metadata::url_reachable(u))
        });
    probes.push(probe(
        "website",
        "Website",
        if website.is_some() { "available" } else { "missing" },
        website,
    ));

    if is_game {
        if let Some(id) = steam_id {
            let ok = metadata::fetch_steam_reviews(id)
                .map(|r| !r.is_empty())
                .unwrap_or(false);
            probes.push(probe(
                "steamReviews",
                "Steam reviews",
                if ok { "available" } else { "missing" },
                Some(id.to_string()),
            ));
        } else {
            probes.push(probe("steamReviews", "Steam reviews", "missing", None));
        }
    } else {
        probes.push(probe("steamReviews", "Steam reviews", "n/a", None));
    }

    ContentAuditRow {
        game_id: game.id.clone(),
        display_name: game.display_name.clone(),
        kind: game.kind.clone(),
        probes,
    }
}

fn format_minutes_hm(minutes: i64) -> String {
    let h = minutes / 60;
    let m = minutes % 60;
    if h > 0 {
        format!("{h}h {m}m")
    } else {
        format!("{m}m")
    }
}

pub fn audit_all(pool: &crate::db::DbPool, media_dir: &Path) -> AppResult<Vec<ContentAuditRow>> {
    if !crate::db::settings::get_bool(pool, "online_metadata_enabled")? {
        return Err(AppError::msg(
            "Turn on Online metadata in Settings before running the content audit.",
        ));
    }
    let games = crate::db::games::list(pool)?;
    audit_games(&games, media_dir)
}
