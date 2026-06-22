//! Repair missing / stale online content for library entries and persist fixes.

use crate::db::games;
use crate::db::models::GameDto;
use crate::error::AppResult;
use crate::metadata;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairSummary {
    pub game_id: String,
    pub display_name: String,
    pub fixes: Vec<String>,
}

pub fn repair_one(pool: &crate::db::DbPool, media_dir: &Path, game: &GameDto) -> AppResult<RepairSummary> {
    let mut fixes = Vec::new();
    if game.kind == "app" {
        repair_app(pool, media_dir, game, &mut fixes)?;
    } else {
        repair_game(pool, media_dir, game, &mut fixes)?;
    }
    Ok(RepairSummary {
        game_id: game.id.clone(),
        display_name: game.display_name.clone(),
        fixes,
    })
}

fn repair_app(
    pool: &crate::db::DbPool,
    media_dir: &Path,
    game: &GameDto,
    fixes: &mut Vec<String>,
) -> AppResult<()> {
    let site = game
        .website
        .as_deref()
        .filter(|u| metadata::url_reachable(u))
        .map(str::to_string)
        .or_else(|| metadata::known_app_website(&game.display_name))
        .or_else(|| {
            metadata::fetch_app_info(&game.display_name, media_dir, &game.id, false)
                .ok()
                .flatten()
                .and_then(|i| i.website)
        });
    if let Some(url) = site {
        if game.website.as_deref() != Some(url.as_str()) {
            games::set_media(pool, &game.id, &[], None, Some(&url), None)?;
            fixes.push(format!("website → {url}"));
        }
    }
    Ok(())
}

fn repair_game(
    pool: &crate::db::DbPool,
    media_dir: &Path,
    game: &GameDto,
    fixes: &mut Vec<String>,
) -> AppResult<()> {
    let stored_id = game.steam_app_id.filter(|&id| id > 0).map(|id| id as u64);
    let appid = metadata::resolve_steam_appid_checked(&game.display_name, stored_id);

    if let Some(id) = appid {
        let steam_id_changed = game.steam_app_id != Some(id as i64);
        if steam_id_changed {
            games::set_steam_app_id(pool, &game.id, id as i64)?;
            fixes.push(format!("steam app id → {id}"));
        }
        let needs_cover = steam_id_changed
            || game.cover_path.is_none()
            || !cover_exists(media_dir, &game.cover_path);
        if needs_cover {
            if let Ok(Some(path)) = metadata::fetch_cover(&game.display_name, media_dir, &game.id) {
                games::set_cover_path(pool, &game.id, &path)?;
                fixes.push("cover downloaded".into());
            }
        }
        if let Some(details) = metadata::fetch_steam_details(id) {
            let mut website = details
                .website
                .clone()
                .filter(|s| !s.trim().is_empty() && metadata::url_reachable(s));
            if website.is_none() {
                website = metadata::fetch_game_info(&game.display_name, media_dir, &game.id, false)
                    .ok()
                    .flatten()
                    .and_then(|m| m.website.filter(|u| metadata::url_reachable(&u)));
            }
            let trailer = metadata::trailer_url(&details).and_then(|u| metadata::trailer_playable_url(&u));
            if let Some(site) = website.as_deref() {
                if game.website.as_deref() != Some(site) {
                    games::set_media(pool, &game.id, &[], None, Some(site), None)?;
                    fixes.push(format!("website → {site}"));
                }
            }
            if let Some(url) = trailer {
                let stored = game
                    .trailer_url
                    .as_deref()
                    .and_then(metadata::trailer_playable_url);
                if stored.as_deref() != Some(url.as_str()) {
                    games::set_media(pool, &game.id, &[], None, None, Some(&url))?;
                    fixes.push("trailer url fixed".into());
                }
            }
            if game.theme_youtube_id.is_none() && game.theme_audio_url.is_none() {
                let theme_name = details.name.as_deref().unwrap_or(&game.display_name);
                let (yt, audio) = metadata::resolve_theme(theme_name);
                if yt.is_some() || audio.is_some() {
                    games::set_theme(pool, &game.id, yt.as_deref(), audio.as_deref())?;
                    fixes.push("theme audio resolved".into());
                }
            }
        }
        if metadata::fetch_steam_reviews(id)
            .map(|r| !r.is_empty())
            .unwrap_or(false)
            && game.steam_app_id.is_none()
        {
            games::set_steam_app_id(pool, &game.id, id as i64)?;
        }
    } else {
        if stored_id.is_some() {
            games::clear_steam_app_id(pool, &game.id)?;
            fixes.push("cleared invalid steam app id".into());
        }
        if game.cover_path.is_none() {
            if let Ok(Some(meta)) = metadata::fetch_game_info(&game.display_name, media_dir, &game.id, true) {
                games::apply_metadata(
                    pool,
                    &game.id,
                    meta.developer.as_deref(),
                    meta.release_year,
                    meta.metacritic,
                    meta.short_description.as_deref(),
                    &meta.genres,
                    meta.cover_path.as_deref(),
                )?;
                games::set_media(
                    pool,
                    &game.id,
                    &meta.screenshots,
                    meta.background_url.as_deref(),
                    meta.website.as_deref(),
                    meta.trailer_url.as_deref(),
                )?;
                if let Some(a) = meta.steam_app_id {
                    games::set_steam_app_id(pool, &game.id, a as i64)?;
                }
                games::set_theme(
                    pool,
                    &game.id,
                    meta.theme_youtube_id.as_deref(),
                    meta.theme_audio_url.as_deref(),
                )?;
                fixes.push("metadata via RAWG/Steam fallback".into());
            }
        }
    }

    let stored_mc_bad = game
        .metacritic_slug
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .is_some_and(|s| !metadata::metacritic_slug_valid(s, &game.display_name));
    let slug = game
        .metacritic_slug
        .as_deref()
        .filter(|s| metadata::metacritic_slug_valid(s, &game.display_name))
        .map(str::to_string)
        .or_else(|| metadata::resolve_metacritic_slug(&game.display_name));
    if let Some(s) = slug {
        if game.metacritic_slug.as_deref() != Some(s.as_str()) {
            games::set_metacritic_slug(pool, &game.id, &s)?;
            fixes.push(format!("metacritic slug → {s}"));
        }
    } else if stored_mc_bad {
        games::set_metacritic_slug(pool, &game.id, "")?;
        fixes.push("cleared invalid metacritic slug".into());
    }

    if game.website.is_none() || !metadata::url_reachable(game.website.as_deref().unwrap_or("")) {
        if let Some(site) = metadata::known_app_website(&game.display_name) {
            games::set_media(pool, &game.id, &[], None, Some(&site), None)?;
            fixes.push(format!("website → {site}"));
        }
    }

    if let Some(raw) = game.trailer_url.as_deref().filter(|u| !u.is_empty()) {
        if let Some(fixed) = metadata::trailer_playable_url(raw).filter(|u| u != raw) {
            games::set_media(pool, &game.id, &[], None, None, Some(&fixed))?;
            fixes.push("trailer url fixed (480 fallback)".into());
        }
    }

    Ok(())
}

fn cover_exists(media_dir: &Path, cover: &Option<String>) -> bool {
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

pub fn repair_all(pool: &crate::db::DbPool, media_dir: &Path) -> AppResult<Vec<RepairSummary>> {
    let games = games::list(pool)?;
    let mut out = Vec::with_capacity(games.len());
    for g in &games {
        out.push(repair_one(pool, media_dir, g)?);
    }
    Ok(out)
}
