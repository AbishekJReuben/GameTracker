use chrono::{DateTime, Utc};
use std::path::PathBuf;

/// Normalize a Windows path for comparison: trim, backslashes, lowercase, drop trailing slash.
pub fn normalize_path(p: &str) -> String {
    let mut s = p.trim().replace('/', "\\").to_lowercase();
    while s.ends_with('\\') {
        s.pop();
    }
    s
}

pub fn paths_equal(a: &str, b: &str) -> bool {
    normalize_path(a) == normalize_path(b)
}

/// True if `path` lives inside `folder` (or equals a file directly under it).
pub fn is_under_folder(path: &str, folder: &str) -> bool {
    let folder = normalize_path(folder);
    if folder.is_empty() {
        return false;
    }
    let path = normalize_path(path);
    path.starts_with(&format!("{folder}\\"))
}

pub fn now_utc_string() -> String {
    Utc::now().to_rfc3339()
}

pub fn parse_utc(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// First exe path that exists on disk (normalized compare optional).
pub fn first_existing_exe(exe_paths: &[String]) -> Option<PathBuf> {
    exe_paths
        .iter()
        .map(|p| PathBuf::from(p.trim()))
        .find(|p| p.is_file())
}

/// Extract a clean game-ish name from an exe path (filename without extension, title-cased-ish).
pub fn name_from_exe(path: &str) -> String {
    let file = path
        .replace('/', "\\")
        .rsplit('\\')
        .next()
        .unwrap_or(path)
        .to_string();
    let stem = file.trim_end_matches(|c| c == ' ').to_string();
    let stem = stem
        .strip_suffix(".exe")
        .or_else(|| stem.strip_suffix(".EXE"))
        .unwrap_or(&stem)
        .to_string();
    if stem.is_empty() {
        "Unknown".to_string()
    } else {
        stem
    }
}
