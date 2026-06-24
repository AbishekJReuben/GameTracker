//! Read Steam achievement progress from Goldberg / GSE emulator save files.
//!
//! Cracked or non-library installs do not appear in `GetPlayerAchievements`, but
//! Goldberg-family emulators write unlocks under `%APPDATA%\Goldberg SteamEmu Saves`
//! or `%APPDATA%\GSE Saves`.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Resolved app id + unlock map (`apiname` -> unix unlock time).
pub struct EmuAchievementData {
    pub app_id: u64,
    pub unlocks: HashMap<String, i64>,
}

/// Try to read emulator unlock progress for a game.
pub fn read_emu_unlocks(app_id: u64, install_folder: Option<&str>) -> Option<EmuAchievementData> {
    let app_id = resolve_app_id(app_id, install_folder)?;
    let mut unlocks = HashMap::new();

    for root in emu_save_roots() {
        let path = root.join(app_id.to_string()).join("achievements.json");
        if let Some(map) = parse_emu_save_file(&path) {
            unlocks.extend(map);
        }
    }

    if unlocks.is_empty() {
        if let Some(folder) = install_folder {
            let local = Path::new(folder).join("steam_settings").join("achievements.json");
            if let Some(map) = parse_emu_save_file(&local) {
                unlocks.extend(map);
            }
        }
    }

    if unlocks.is_empty() {
        return None;
    }

    Some(EmuAchievementData { app_id, unlocks })
}

fn resolve_app_id(steam_app_id: u64, install_folder: Option<&str>) -> Option<u64> {
    if steam_app_id > 0 {
        return Some(steam_app_id);
    }
    let folder = install_folder?;
    for candidate in [
        Path::new(folder).join("steam_settings").join("steam_appid.txt"),
        Path::new(folder).join("steam_appid.txt"),
    ] {
        if let Ok(text) = std::fs::read_to_string(&candidate) {
            if let Ok(id) = text.trim().parse::<u64>() {
                if id > 0 {
                    return Some(id);
                }
            }
        }
    }
    None
}

fn emu_save_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(roaming) = dirs::data_dir() {
        roots.push(roaming.join("Goldberg SteamEmu Saves"));
        roots.push(roaming.join("GSE Saves"));
    }
    roots
}

#[derive(Debug, Deserialize)]
struct EmuUnlockEntry {
    #[serde(default)]
    earned: bool,
    #[serde(default)]
    earned_time: i64,
}

/// Parse Goldberg/GSE `achievements.json` — object map of unlocks.
fn parse_emu_save_file(path: &Path) -> Option<HashMap<String, i64>> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let obj = value.as_object()?;
    let mut out = HashMap::new();
    for (name, entry) in obj {
        if let Ok(parsed) = serde_json::from_value::<EmuUnlockEntry>(entry.clone()) {
            if parsed.earned {
                out.insert(name.clone(), parsed.earned_time.max(0));
            }
            continue;
        }
        // Some emus use bare booleans or 0/1.
        if entry.as_bool() == Some(true) || entry.as_i64() == Some(1) {
            out.insert(name.clone(), 0);
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Local `steam_settings/achievements.json` definitions (array) for when schema API fails.
pub fn read_local_definitions(install_folder: Option<&str>) -> Vec<LocalAchievementDef> {
    let Some(folder) = install_folder else {
        return Vec::new();
    };
    let path = Path::new(folder).join("steam_settings").join("achievements.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(arr) = serde_json::from_str::<Vec<LocalAchievementDef>>(&text) else {
        return Vec::new();
    };
    arr
}

#[derive(Debug, Clone, Deserialize)]
pub struct LocalAchievementDef {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub icon_gray: String,
    #[serde(default)]
    pub hidden: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_goldberg_unlock_json() {
        let json = r#"{"ACH_TEST":{"earned":true,"earned_time":1700000000},"ACH_LOCKED":{"earned":false}}"#;
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        let map = parse_emu_save_file_from_value(&v);
        assert_eq!(map.get("ACH_TEST"), Some(&1700000000));
        assert!(!map.contains_key("ACH_LOCKED"));
    }

    fn parse_emu_save_file_from_value(value: &serde_json::Value) -> HashMap<String, i64> {
        let obj = value.as_object().unwrap();
        let mut out = HashMap::new();
        for (name, entry) in obj {
            if let Ok(parsed) = serde_json::from_value::<EmuUnlockEntry>(entry.clone()) {
                if parsed.earned {
                    out.insert(name.clone(), parsed.earned_time.max(0));
                }
            }
        }
        out
    }
}
