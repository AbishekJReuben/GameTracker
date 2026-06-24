//! Launcher platform capabilities and local install discovery.
//!
//! Online sync is only available where a documented/authenticated API exists (Steam, GOG).
//! Epic, Riot, Ubisoft, and Rockstar are exposed as **local install** sources — titles
//! detected from manifests/registry on this PC, not full cloud libraries.

use crate::detect::{self, Candidate};
use crate::db::{games, DbPool};
use crate::error::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherCapability {
    pub id: String,
    pub name: String,
    /// `online` | `local` | `none`
    pub library: String,
    pub playtime: String,
    pub achievements: String,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLauncherGame {
    pub name: String,
    pub install_folder: Option<String>,
    pub exe_path: Option<String>,
    pub source: String,
    pub imported: bool,
    pub tracker_game_id: Option<String>,
}

pub fn capabilities() -> Vec<LauncherCapability> {
    vec![
        LauncherCapability {
            id: "steam".into(),
            name: "Steam".into(),
            library: "online".into(),
            playtime: "online".into(),
            achievements: "online".into(),
            notes: "Sign in with Steam OpenID. Full library, playtime, and achievements.".into(),
        },
        LauncherCapability {
            id: "gog".into(),
            name: "GOG".into(),
            library: "online".into(),
            playtime: "online".into(),
            achievements: "online".into(),
            notes: "Sign in with GOG Galaxy OAuth. Full owned library, playtime, and GOG achievements.".into(),
        },
        LauncherCapability {
            id: "epic".into(),
            name: "Epic Games".into(),
            library: "local".into(),
            playtime: "none".into(),
            achievements: "none".into(),
            notes: "Imports installed titles from Epic launcher manifests on this PC. Epic has no public user API for cloud library or playtime without their launcher OAuth.".into(),
        },
        LauncherCapability {
            id: "riot".into(),
            name: "Riot Games".into(),
            library: "local".into(),
            playtime: "none".into(),
            achievements: "none".into(),
            notes: "Detects VALORANT, League of Legends, etc. from Riot install folders. Riot's official API is match-history only (per-title), not a game library.".into(),
        },
        LauncherCapability {
            id: "ubisoft".into(),
            name: "Ubisoft Connect".into(),
            library: "local".into(),
            playtime: "none".into(),
            achievements: "none".into(),
            notes: "Imports installed Ubisoft titles from registry. No official public API for library or achievements.".into(),
        },
        LauncherCapability {
            id: "rockstar".into(),
            name: "Rockstar Games".into(),
            library: "local".into(),
            playtime: "none".into(),
            achievements: "none".into(),
            notes: "Imports installed Rockstar titles from registry. Social Club has no supported public API.".into(),
        },
    ]
}

pub fn local_library(pool: &DbPool, platform: &str) -> AppResult<Vec<LocalLauncherGame>> {
    let candidates = detect::local_launcher_candidates(platform);
    let mut out = Vec::new();
    for c in candidates {
        let tracker_game_id = games::find_by_install_or_name(pool, c.install_folder.as_deref(), &c.name)?;
        out.push(LocalLauncherGame {
            name: c.name,
            install_folder: c.install_folder,
            exe_path: c.exe_path,
            source: c.source,
            imported: tracker_game_id.is_some(),
            tracker_game_id,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub fn import_local(
    pool: &DbPool,
    platform: &str,
    names: &[String],
    enrich: impl Fn(&str) + Send + Sync,
) -> AppResult<(i64, i64)> {
    let candidates = detect::local_launcher_candidates(platform);
    let selected: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| names.iter().any(|n| n.eq_ignore_ascii_case(&c.name)))
        .collect();

    let mut added = 0i64;
    let mut updated = 0i64;
    for c in selected {
        let existing = games::find_by_install_or_name(
            pool,
            c.install_folder.as_deref(),
            &c.name,
        )?;
        if let Some(id) = existing {
            if let Some(ref folder) = c.install_folder {
                let _ = games::set_install_folder(pool, &id, folder);
            }
            if let Some(ref exe) = c.exe_path {
                let _ = games::add_exe_path(pool, &id, exe);
            }
            updated += 1;
            continue;
        }

        let id = detect::import_candidate(pool, c)?;
        added += 1;
        enrich(&id);
    }
    Ok((added, updated))
}
