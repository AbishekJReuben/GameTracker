use crate::db::games::{self, MatchGame};
use crate::db::DbPool;
use crate::error::AppResult;
use crate::util;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub name: String,
    pub install_folder: Option<String>,
    pub exe_path: Option<String>,
    pub source: String,
    /// Steam appid when the candidate came from a Steam manifest — lets the
    /// auto-enrichment resolve covers/metadata exactly (no fuzzy name search).
    #[serde(default)]
    pub steam_app_id: Option<u64>,
}

fn env_path(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

fn steam_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let candidates = [
        env_path("ProgramFiles(x86)").map(|p| p.join("Steam")),
        env_path("ProgramFiles").map(|p| p.join("Steam")),
        Some(PathBuf::from("C:\\Steam")),
    ];
    for c in candidates.into_iter().flatten() {
        if c.join("steamapps").is_dir() {
            roots.push(c);
        }
    }
    roots
}

/// Read additional Steam library paths from libraryfolders.vdf.
fn steam_libraries() -> Vec<PathBuf> {
    let mut libs: Vec<PathBuf> = Vec::new();
    for root in steam_roots() {
        let steamapps = root.join("steamapps");
        libs.push(steamapps.clone());
        let vdf = steamapps.join("libraryfolders.vdf");
        if let Ok(text) = std::fs::read_to_string(&vdf) {
            for line in text.lines() {
                let line = line.trim();
                if line.starts_with("\"path\"") {
                    if let Some(path) = line.splitn(3, '"').nth(2).and_then(|rest| {
                        rest.trim().trim_start_matches('"').rsplit('"').nth(1)
                    }) {
                        let p = PathBuf::from(path.replace("\\\\", "\\")).join("steamapps");
                        if p.is_dir() {
                            libs.push(p);
                        }
                    }
                }
            }
        }
    }
    libs.sort();
    libs.dedup();
    libs
}

fn scan_steam() -> Vec<Candidate> {
    let mut out = Vec::new();
    for lib in steam_libraries() {
        let entries = match std::fs::read_dir(&lib) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_manifest = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("appmanifest_") && n.ends_with(".acf"))
                .unwrap_or(false);
            if !is_manifest {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&path) {
                let name = vdf_value(&text, "name");
                let installdir = vdf_value(&text, "installdir");
                let appid = vdf_value(&text, "appid").and_then(|a| a.parse::<u64>().ok());
                if let (Some(name), Some(installdir)) = (name, installdir) {
                    let folder = lib.join("common").join(&installdir);
                    if folder.is_dir() {
                        out.push(Candidate {
                            name,
                            install_folder: Some(folder.to_string_lossy().to_string()),
                            exe_path: None,
                            source: "Steam".to_string(),
                            steam_app_id: appid,
                        });
                    }
                }
            }
        }
    }
    out
}

fn vdf_value(text: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with(&needle) {
            // "key"   "value"
            let parts: Vec<&str> = line.split('"').collect();
            if parts.len() >= 4 {
                return Some(parts[3].to_string());
            }
        }
    }
    None
}

fn scan_subfolders(base: PathBuf, source: &str) -> Vec<Candidate> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    out.push(Candidate {
                        name: name.to_string(),
                        install_folder: Some(path.to_string_lossy().to_string()),
                        exe_path: None,
                        source: source.to_string(),
                        steam_app_id: None,
                    });
                }
            }
        }
    }
    out
}

/// Parse the Epic Games Launcher install manifests — the authoritative list of
/// installed Epic titles (real display names + exe), far better than guessing
/// from folder names. Each `*.item` under
/// `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests` is JSON with
/// `DisplayName`, `InstallLocation`, and `LaunchExecutable`.
fn scan_epic_manifests() -> Vec<Candidate> {
    let mut out = Vec::new();
    let manifests = match env_path("ProgramData") {
        Some(pd) => pd
            .join("Epic")
            .join("EpicGamesLauncher")
            .join("Data")
            .join("Manifests"),
        None => return out,
    };
    let entries = match std::fs::read_dir(&manifests) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("item") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some((name, install, launch)) = parse_epic_item(&text) else {
            continue;
        };
        let exe_path = launch.and_then(|launch| {
            let exe = Path::new(&install).join(launch.replace('/', "\\"));
            exe.is_file().then(|| exe.to_string_lossy().to_string())
        });
        out.push(Candidate {
            name,
            install_folder: Some(install),
            exe_path,
            source: "Epic".to_string(),
            steam_app_id: None,
        });
    }
    out
}

/// Pure parse of one Epic `.item` manifest → (display name, install location,
/// launch executable). Returns `None` for entries that aren't playable games
/// (missing fields, or the Unreal Engine entry). Kept separate to unit-test.
fn parse_epic_item(text: &str) -> Option<(String, String, Option<String>)> {
    let json: serde_json::Value = serde_json::from_str(text).ok()?;
    let name = json.get("DisplayName")?.as_str()?.trim().to_string();
    let install = json.get("InstallLocation")?.as_str()?.trim().to_string();
    if name.is_empty() || install.is_empty() || name.eq_ignore_ascii_case("Unreal Engine") {
        return None;
    }
    let launch = json
        .get("LaunchExecutable")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some((name, install, launch))
}

fn scan_launchers() -> Vec<Candidate> {
    let mut out = Vec::new();

    // Epic — manifest-driven (real titles + exe).
    out.extend(scan_epic_manifests());

    // GOG Galaxy + classic standalone installs.
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(pf) = env_path(var) {
            let gog = pf.join("GOG Galaxy").join("Games");
            if gog.is_dir() {
                out.extend(scan_subfolders(gog, "GOG"));
            }
        }
    }
    let gog_default = PathBuf::from("C:\\GOG Games");
    if gog_default.is_dir() {
        out.extend(scan_subfolders(gog_default, "GOG"));
    }

    // EA app / Origin.
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(pf) = env_path(var) {
            for sub in ["EA Games", "Origin Games"] {
                let dir = pf.join(sub);
                if dir.is_dir() {
                    out.extend(scan_subfolders(dir, "EA"));
                }
            }
        }
    }

    // Ubisoft Connect default games root.
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(pf) = env_path(var) {
            let ubi = pf
                .join("Ubisoft")
                .join("Ubisoft Game Launcher")
                .join("games");
            if ubi.is_dir() {
                out.extend(scan_subfolders(ubi, "Ubisoft"));
            }
        }
    }

    out
}

/// Path fragments that mark a running process as living under a game install
/// root (any storefront/launcher we know about). Used to surface running games.
const GAME_PATH_ROOTS: &[&str] = &[
    "steamapps\\common",
    "epic games",
    "gog galaxy\\games",
    "\\gog games\\",
    "\\games\\",
    "riot games",
    "\\battle.net\\",
    "\\rockstar games\\",
    "ubisoft\\ubisoft game launcher\\games",
    "\\origin games\\",
    "\\ea games\\",
    "\\ea\\",
    "\\xboxgames\\",
];

fn looks_like_game_path(path: &str) -> bool {
    let p = path.to_lowercase();
    GAME_PATH_ROOTS.iter().any(|root| p.contains(root))
}

fn scan_running() -> Vec<Candidate> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::everything());
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for proc_ in sys.processes().values() {
        if let Some(exe) = proc_.exe() {
            let path = exe.to_string_lossy().to_string();
            if !looks_like_game_path(&path) {
                continue;
            }
            let norm = util::normalize_path(&path);
            if !seen.insert(norm) {
                continue;
            }
            out.push(Candidate {
                name: util::name_from_exe(&path),
                install_folder: Path::new(&path)
                    .parent()
                    .map(|p| p.to_string_lossy().to_string()),
                exe_path: Some(path),
                source: "Running".to_string(),
                steam_app_id: None,
            });
        }
    }
    out
}

// ---------- Launcher / publisher registry detection ----------

/// Friendly title from an install-folder path (its last path component).
fn name_from_folder(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path.trim_end_matches(['\\', '/']).to_string())
}

/// Riot installs every title under `C:\Riot Games\<Game>` (alongside the shared
/// "Riot Client"). There's no per-game manifest like Steam's, so we enumerate
/// that root directly — and honor a relocated root recorded in
/// `%ProgramData%\Riot Games\RiotClientInstalls.json`.
fn scan_riot() -> Vec<Candidate> {
    let mut roots: Vec<PathBuf> = vec![PathBuf::from("C:\\Riot Games")];
    if let Some(pf) = env_path("ProgramFiles") {
        roots.push(pf.join("Riot Games"));
    }
    if let Some(pd) = env_path("ProgramData") {
        let manifest = pd.join("Riot Games").join("RiotClientInstalls.json");
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(obj) = json.get("associated_client").and_then(|v| v.as_object()) {
                    // Keys are game install dirs, e.g. "C:/Riot Games/VALORANT/".
                    for key in obj.keys() {
                        let p = PathBuf::from(key.replace('/', "\\"));
                        if let Some(parent) = p.parent() {
                            roots.push(parent.to_path_buf());
                        }
                    }
                }
            }
        }
    }
    roots.sort();
    roots.dedup();

    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for root in roots {
        let entries = match std::fs::read_dir(&root) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Some(folder) = dir.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if folder.eq_ignore_ascii_case("Riot Client") {
                continue;
            }
            let path = dir.to_string_lossy().to_string();
            if !seen.insert(util::normalize_path(&path)) {
                continue;
            }
            out.push(Candidate {
                name: riot_title(folder),
                install_folder: Some(path),
                exe_path: None,
                source: "Riot".to_string(),
                steam_app_id: None,
            });
        }
    }
    out
}

/// Map Riot install-folder names to their proper display titles.
fn riot_title(folder: &str) -> String {
    match folder.to_lowercase().as_str() {
        "valorant" => "VALORANT".to_string(),
        "league of legends" => "League of Legends".to_string(),
        "lor" | "legends of runeterra" => "Legends of Runeterra".to_string(),
        "2xko" => "2XKO".to_string(),
        _ => folder.to_string(),
    }
}

/// Ubisoft Connect records every installed title under
/// `…\Ubisoft\Launcher\Installs\<id>` with an `InstallDir` value — its
/// authoritative installed-games list.
#[cfg(windows)]
fn scan_ubisoft_registry() -> Vec<Candidate> {
    use crate::registry::{self, Hive};
    let mut out = Vec::new();
    for base in [
        "SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs",
        "SOFTWARE\\Ubisoft\\Launcher\\Installs",
    ] {
        for id in registry::subkeys(Hive::Lm, base) {
            let path = format!("{base}\\{id}");
            let Some(dir) = registry::read_string(Hive::Lm, &path, "InstallDir") else {
                continue;
            };
            let dir = dir.replace('/', "\\");
            if !Path::new(&dir).is_dir() {
                continue;
            }
            out.push(Candidate {
                name: name_from_folder(&dir),
                install_folder: Some(dir),
                exe_path: None,
                source: "Ubisoft".to_string(),
                steam_app_id: None,
            });
        }
    }
    out
}
#[cfg(not(windows))]
fn scan_ubisoft_registry() -> Vec<Candidate> {
    Vec::new()
}

/// Rockstar Games Launcher writes each title to `…\Rockstar Games\<Game>` with
/// an `InstallFolder` value.
#[cfg(windows)]
fn scan_rockstar_registry() -> Vec<Candidate> {
    use crate::registry::{self, Hive};
    let mut out = Vec::new();
    for base in ["SOFTWARE\\WOW6432Node\\Rockstar Games", "SOFTWARE\\Rockstar Games"] {
        for sub in registry::subkeys(Hive::Lm, base) {
            if sub.eq_ignore_ascii_case("Launcher")
                || sub.eq_ignore_ascii_case("Rockstar Games Social Club")
            {
                continue;
            }
            let path = format!("{base}\\{sub}");
            let dir = registry::read_string(Hive::Lm, &path, "InstallFolder")
                .or_else(|| registry::read_string(Hive::Lm, &path, "InstallLocation"));
            let Some(dir) = dir.filter(|d| Path::new(d).is_dir()) else {
                continue;
            };
            out.push(Candidate {
                name: sub,
                install_folder: Some(dir),
                exe_path: None,
                source: "Rockstar".to_string(),
                steam_app_id: None,
            });
        }
    }
    out
}
#[cfg(not(windows))]
fn scan_rockstar_registry() -> Vec<Candidate> {
    Vec::new()
}

/// Publisher substrings that mark an Uninstall entry as a game, mapped to a
/// friendly source label. Matched (lowercased) against the entry's `Publisher`.
const GAME_PUBLISHERS: &[(&str, &str)] = &[
    ("blizzard", "Battle.net"),
    ("activision", "Battle.net"),
    ("riot games", "Riot"),
    ("rockstar", "Rockstar"),
    ("electronic arts", "EA"),
    ("ubisoft", "Ubisoft"),
    ("bethesda", "Bethesda"),
    ("cd projekt", "GOG"),
    ("xbox game studios", "Xbox"),
    ("square enix", "Installed"),
    ("bandai namco", "Installed"),
    ("capcom", "Installed"),
    ("sega", "Installed"),
    ("2k ", "Installed"),
    ("take-two", "Installed"),
    ("devolver", "Installed"),
    ("fromsoftware", "Installed"),
    ("from software", "Installed"),
    ("hoyoverse", "Installed"),
    ("cognosphere", "Installed"),
    ("mihoyo", "Installed"),
    ("kurogame", "Installed"),
    ("krafton", "Installed"),
    ("nexon", "Installed"),
    ("paradox", "Installed"),
    ("warner bros", "Installed"),
    ("deep silver", "Installed"),
];

/// Names that pass the publisher filter but are tooling/redistributables.
const UNINSTALL_NAME_DENY: &[&str] = &[
    "redistributable",
    "redist",
    "runtime",
    "directx",
    "visual c++",
    "vcredist",
    ".net",
    "driver",
    "framework",
    "uninstall",
    "anticheat",
    "easyanticheat",
    "battleye",
    "sdk",
    "dedicated server",
];

/// Decide whether an Uninstall entry is a game, and under which source label.
fn classify_uninstall(publisher: &str, install: &str) -> Option<&'static str> {
    let pub_l = publisher.to_lowercase();
    for (needle, source) in GAME_PUBLISHERS {
        if pub_l.contains(needle) {
            return Some(source);
        }
    }
    // Otherwise only accept it if it sits under a known game install root.
    looks_like_game_path(install).then_some("Installed")
}

/// Generic Windows Uninstall-registry scan. Surfaces games whose publisher we
/// recognize (this is what catches Blizzard / Battle.net titles, which don't
/// expose a Steam-style manifest) or that install under a known game root.
/// Deliberately conservative to avoid listing ordinary applications.
#[cfg(windows)]
fn scan_uninstall_registry() -> Vec<Candidate> {
    use crate::registry::{self, Hive};
    let hives: [(Hive, &str); 3] = [
        (Hive::Lm, "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
        (Hive::Lm, "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
        (Hive::Cu, "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
    ];
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (hive, base) in hives {
        for sub in registry::subkeys(hive, base) {
            let path = format!("{base}\\{sub}");
            let Some(name) = registry::read_string(hive, &path, "DisplayName") else {
                continue;
            };
            let install = match registry::read_string(hive, &path, "InstallLocation") {
                Some(p) if Path::new(&p).is_dir() => p,
                _ => continue,
            };
            let name_l = name.to_lowercase();
            if UNINSTALL_NAME_DENY.iter().any(|d| name_l.contains(d)) {
                continue;
            }
            let publisher = registry::read_string(hive, &path, "Publisher").unwrap_or_default();
            let Some(source) = classify_uninstall(&publisher, &install) else {
                continue;
            };
            if !seen.insert(util::normalize_path(&install)) {
                continue;
            }
            out.push(Candidate {
                name,
                install_folder: Some(install),
                exe_path: None,
                source: source.to_string(),
                steam_app_id: None,
            });
        }
    }
    out
}
#[cfg(not(windows))]
fn scan_uninstall_registry() -> Vec<Candidate> {
    Vec::new()
}

// ---------- App / software detection ----------

/// Background services, system shell, and runtime noise we never offer as apps.
const APP_NOISE: &[&str] = &[
    "explorer.exe",
    "applicationframehost.exe",
    "systemsettings.exe",
    "searchhost.exe",
    "searchapp.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "textinputhost.exe",
    "lockapp.exe",
    "dwm.exe",
    "sihost.exe",
    "ctfmon.exe",
    "runtimebroker.exe",
    "smartscreen.exe",
    "wallpaperhost.exe",
    "widgets.exe",
    "widgetservice.exe",
    "gametracker.exe",
];

fn is_app_noise(path: &str) -> bool {
    let p = path.to_lowercase();
    // System binaries are infrastructure, not user apps.
    if p.contains("\\windows\\system32") || p.contains("\\windows\\systemapps") || p.contains("\\windows\\immersivecontrolpanel") {
        return true;
    }
    let file = Path::new(&p)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    APP_NOISE.iter().any(|n| *n == file)
}

/// Enumerate processes that own a visible top-level (alt-tab style) window and
/// look like real user applications — the candidates a user might want to track.
fn scan_running_apps() -> Vec<Candidate> {
    let self_exe = std::env::current_exe()
        .ok()
        .map(|p| util::normalize_path(&p.to_string_lossy()));

    let pids = visible_app_pids();
    if pids.is_empty() {
        return Vec::new();
    }

    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::everything());

    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for pid in pids {
        let proc_ = match sys.process(sysinfo::Pid::from_u32(pid)) {
            Some(p) => p,
            None => continue,
        };
        let exe = match proc_.exe() {
            Some(e) => e.to_string_lossy().to_string(),
            None => continue,
        };
        if is_app_noise(&exe) || looks_like_game_path(&exe) {
            continue;
        }
        let norm = util::normalize_path(&exe);
        if norm.is_empty() || Some(&norm) == self_exe.as_ref() {
            continue;
        }
        if !seen.insert(norm) {
            continue;
        }
        out.push(Candidate {
            name: util::name_from_exe(&exe),
            install_folder: Path::new(&exe)
                .parent()
                .map(|p| p.to_string_lossy().to_string()),
            exe_path: Some(exe),
            source: "Running app".to_string(),
            steam_app_id: None,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[cfg(windows)]
fn visible_app_pids() -> Vec<u32> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowThreadProcessId,
        IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let pids = &mut *(lparam.0 as *mut Vec<u32>);
        // Alt-tab heuristic: visible, titled, not a tool window, no owner.
        if IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 {
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            let owner = GetWindow(hwnd, GW_OWNER).unwrap_or_default();
            if ex & WS_EX_TOOLWINDOW.0 == 0 && owner.0.is_null() {
                let mut pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
                if pid != 0 && !pids.contains(&pid) {
                    pids.push(pid);
                }
            }
        }
        TRUE
    }

    let mut pids: Vec<u32> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut pids as *mut Vec<u32> as isize));
    }
    pids
}

#[cfg(not(windows))]
fn visible_app_pids() -> Vec<u32> {
    Vec::new()
}

/// Detect running user applications not yet registered (as games or apps).
pub fn detect_apps(pool: &DbPool) -> AppResult<Vec<Candidate>> {
    let existing = games::match_candidates(pool).unwrap_or_default();
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for c in scan_running_apps() {
        let key = c
            .exe_path
            .clone()
            .unwrap_or_else(|| c.name.to_lowercase());
        if !seen.insert(key.to_lowercase()) {
            continue;
        }
        if is_registered(&existing, &c) {
            continue;
        }
        out.push(c);
    }
    Ok(out)
}

fn is_registered(existing: &[MatchGame], cand: &Candidate) -> bool {
    if let Some(exe) = &cand.exe_path {
        if existing
            .iter()
            .any(|g| g.exe_paths.iter().any(|p| util::paths_equal(p, exe)))
        {
            return true;
        }
    }
    if let Some(folder) = &cand.install_folder {
        if existing.iter().any(|g| {
            g.install_folder
                .as_deref()
                .map(|f| util::paths_equal(f, folder))
                .unwrap_or(false)
        }) {
            return true;
        }
    }
    false
}

/// Scan Steam, launchers and running processes for game candidates not yet registered.
pub fn detect(pool: &DbPool) -> AppResult<Vec<Candidate>> {
    let existing = games::match_candidates(pool).unwrap_or_default();
    let mut all = Vec::new();
    all.extend(scan_steam());
    all.extend(scan_launchers());
    all.extend(scan_riot());
    all.extend(scan_ubisoft_registry());
    all.extend(scan_rockstar_registry());
    all.extend(scan_uninstall_registry());
    all.extend(scan_running());

    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for c in all {
        let key = format!(
            "{}|{}",
            c.name.to_lowercase(),
            c.install_folder.clone().unwrap_or_default().to_lowercase()
        );
        if !seen.insert(key) {
            continue;
        }
        if is_registered(&existing, &c) {
            continue;
        }
        out.push(c);
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Installed titles for a specific launcher (local discovery only).
pub fn local_launcher_candidates(platform: &str) -> Vec<Candidate> {
    match platform.to_lowercase().as_str() {
        "epic" => scan_epic_manifests(),
        "riot" => scan_riot(),
        "ubisoft" => scan_ubisoft_registry(),
        "rockstar" => scan_rockstar_registry(),
        "gog" => scan_local_gog_folders(),
        _ => Vec::new(),
    }
}

fn scan_local_gog_folders() -> Vec<Candidate> {
    let mut out = Vec::new();
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(pf) = env_path(var) {
            let gog = pf.join("GOG Galaxy").join("Games");
            if gog.is_dir() {
                out.extend(scan_subfolders(gog, "GOG"));
            }
        }
    }
    let gog_default = PathBuf::from("C:\\GOG Games");
    if gog_default.is_dir() {
        out.extend(scan_subfolders(gog_default, "GOG"));
    }
    out
}

/// Import one detected candidate as a tracked game. Returns the new or existing game id.
pub fn import_candidate(pool: &DbPool, c: &Candidate) -> AppResult<String> {
    use crate::db::models::GameInput;
    if let Some(id) = games::find_by_install_or_name(
        pool,
        c.install_folder.as_deref(),
        &c.name,
    )? {
        return Ok(id);
    }
    let input = GameInput {
        id: None,
        kind: "game".to_string(),
        display_name: c.name.clone(),
        install_folder: c.install_folder.clone(),
        exe_paths: c.exe_path.clone().into_iter().collect(),
        cover_path: None,
        status: "backlog".to_string(),
        rating: None,
        developer: None,
        release_year: None,
        started_year: None,
        started_month: None,
        started_day: None,
        completed_year: None,
        completed_month: None,
        completed_day: None,
        metacritic: None,
        notes: None,
        time_to_beat_minutes: None,
        manual_playtime_seconds: None,
        accent_color: None,
        tags: Vec::new(),
        count_background: None,
        steam_app_id: c.steam_app_id.map(|a| a as i64),
        gog_product_id: None,
    };
    games::upsert(pool, input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_epic_item_manifest() {
        let json = r#"{
            "DisplayName": "Rocket League",
            "InstallLocation": "D:\\Epic\\rocketleague",
            "LaunchExecutable": "Binaries/Win64/RocketLeague.exe",
            "AppName": "Sugar"
        }"#;
        let (name, install, launch) = parse_epic_item(json).expect("should parse");
        assert_eq!(name, "Rocket League");
        assert_eq!(install, "D:\\Epic\\rocketleague");
        assert_eq!(launch.as_deref(), Some("Binaries/Win64/RocketLeague.exe"));
    }

    #[test]
    fn skips_unreal_engine_and_incomplete_items() {
        let engine = r#"{"DisplayName":"Unreal Engine","InstallLocation":"C:\\UE"}"#;
        assert!(parse_epic_item(engine).is_none());
        let no_install = r#"{"DisplayName":"Some Game","InstallLocation":""}"#;
        assert!(parse_epic_item(no_install).is_none());
        let not_json = "not json";
        assert!(parse_epic_item(not_json).is_none());
    }

    #[test]
    fn riot_titles_are_prettified() {
        assert_eq!(riot_title("VALORANT"), "VALORANT");
        assert_eq!(riot_title("League of Legends"), "League of Legends");
        assert_eq!(riot_title("LoR"), "Legends of Runeterra");
        assert_eq!(riot_title("Some Game"), "Some Game");
    }

    #[test]
    fn name_from_folder_takes_last_component() {
        assert_eq!(name_from_folder("C:\\Games\\Far Cry 6"), "Far Cry 6");
        assert_eq!(name_from_folder("D:/Riot Games/VALORANT/"), "VALORANT");
    }

    #[test]
    fn classify_uninstall_recognizes_blizzard_and_path() {
        assert_eq!(classify_uninstall("Blizzard Entertainment", "C:\\X"), Some("Battle.net"));
        assert_eq!(classify_uninstall("Riot Games, Inc.", "C:\\X"), Some("Riot"));
        // Unknown publisher but a Steam install path still counts.
        assert_eq!(
            classify_uninstall("Some Studio", "D:\\SteamLibrary\\steamapps\\common\\Game"),
            Some("Installed")
        );
        // Unknown publisher + ordinary path → not a game.
        assert_eq!(classify_uninstall("Acme Software", "C:\\Program Files\\Acme"), None);
    }

    #[test]
    fn epic_item_without_launch_exe_is_folder_only() {
        let json = r#"{"DisplayName":"Folder Game","InstallLocation":"C:\\Games\\FG"}"#;
        let (_, _, launch) = parse_epic_item(json).expect("should parse");
        assert!(launch.is_none());
    }
}
