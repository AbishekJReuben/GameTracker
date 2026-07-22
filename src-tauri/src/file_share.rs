//! Local file-selection and bounded read helpers for the browser-to-browser
//! Share feature. Network transport stays in the WebRTC webview; this module
//! owns the privileged disk access so a receiver can only ever get bytes that
//! the desktop user deliberately added to a manifest.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const MAX_MANIFEST_ITEMS: usize = 100_000;
/// This limits privileged disk reads, not WebRTC packet size. The frontend
/// splits each read into <=60 KiB SCTP frames, avoiding a Tauri IPC round trip
/// for every network frame.
pub const MAX_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareItem {
    pub id: u32,
    /// Receiver-visible, relative name. Never an absolute local path.
    pub path: String,
    /// Sender-only local source. It is never transmitted by the transfer protocol.
    pub source_path: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareManifest {
    pub items: Vec<ShareItem>,
    pub total_bytes: u64,
    pub skipped: Vec<String>,
}

pub fn prepare(paths: Vec<String>) -> AppResult<ShareManifest> {
    if paths.is_empty() {
        return Err(AppError::msg("Choose at least one file or folder."));
    }
    let mut items = Vec::new();
    let mut skipped = Vec::new();
    for raw in paths {
        let root = PathBuf::from(raw);
        let meta = match fs::symlink_metadata(&root) {
            Ok(v) => v,
            Err(e) => {
                skipped.push(format!("{} ({e})", root.display()));
                continue;
            }
        };
        if meta.file_type().is_symlink() {
            skipped.push(format!("{} (links are not shared)", root.display()));
            continue;
        }
        let label = root
            .file_name()
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_else(|| "Shared files".to_string());
        if meta.is_file() {
            push_file(&mut items, &root, PathBuf::from(label), &mut skipped)?;
        } else if meta.is_dir() {
            walk_dir(&mut items, &root, Path::new(&label), &mut skipped)?;
        } else {
            skipped.push(format!("{} (not a regular file)", root.display()));
        }
    }
    if items.is_empty() {
        return Err(AppError::msg("No readable regular files were selected."));
    }
    for (id, item) in items.iter_mut().enumerate() {
        item.id = id as u32;
    }
    let total_bytes = items.iter().map(|v| v.size).sum();
    Ok(ShareManifest { items, total_bytes, skipped })
}

fn walk_dir(
    items: &mut Vec<ShareItem>, root: &Path, relative: &Path, skipped: &mut Vec<String>,
) -> AppResult<()> {
    for entry in fs::read_dir(root)? {
        let entry = match entry {
            Ok(v) => v,
            Err(e) => {
                skipped.push(format!("{} ({e})", root.display()));
                continue;
            }
        };
        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(v) => v,
            Err(e) => {
                skipped.push(format!("{} ({e})", path.display()));
                continue;
            }
        };
        if meta.file_type().is_symlink() {
            skipped.push(format!("{} (links are not shared)", path.display()));
            continue;
        }
        let next = relative.join(entry.file_name());
        if meta.is_file() {
            push_file(items, &path, next, skipped)?;
        } else if meta.is_dir() {
            walk_dir(items, &path, &next, skipped)?;
        }
    }
    Ok(())
}

fn push_file(items: &mut Vec<ShareItem>, source: &Path, relative: PathBuf, skipped: &mut Vec<String>) -> AppResult<()> {
    if items.len() >= MAX_MANIFEST_ITEMS {
        return Err(AppError::msg(format!("A share can contain at most {MAX_MANIFEST_ITEMS} files.")));
    }
    let meta = match fs::metadata(source) {
        Ok(v) if v.is_file() => v,
        Ok(_) => return Ok(()),
        Err(e) => {
            skipped.push(format!("{} ({e})", source.display()));
            return Ok(());
        }
    };
    let path = unique_path(items, relative.to_string_lossy().replace('\\', "/"));
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|v| v.as_millis().min(u64::MAX as u128) as u64);
    items.push(ShareItem {
        id: 0,
        path,
        source_path: source.to_string_lossy().to_string(),
        size: meta.len(),
        modified_ms,
    });
    Ok(())
}

fn unique_path(items: &[ShareItem], candidate: String) -> String {
    if !items.iter().any(|v| v.path.eq_ignore_ascii_case(&candidate)) {
        return candidate;
    }
    let p = Path::new(&candidate);
    let stem = p.file_stem().unwrap_or_default().to_string_lossy();
    let ext = p.extension().map(|v| format!(".{}", v.to_string_lossy())).unwrap_or_default();
    let parent = p.parent().filter(|v| !v.as_os_str().is_empty()).map(|v| format!("{}/", v.to_string_lossy().replace('\\', "/"))).unwrap_or_default();
    for n in 2.. {
        let next = format!("{parent}{stem} ({n}){ext}");
        if !items.iter().any(|v| v.path.eq_ignore_ascii_case(&next)) { return next; }
    }
    unreachable!()
}

pub fn read_chunk(source_path: String, offset: u64, length: u32) -> AppResult<Vec<u8>> {
    let wanted = (length as usize).clamp(1, MAX_CHUNK_BYTES);
    let mut file = File::open(&source_path)
        .map_err(|e| AppError::msg(format!("Could not read shared file: {e}")))?;
    let size = file.metadata()?.len();
    if offset > size {
        return Err(AppError::msg("Requested chunk is outside the shared file."));
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut out = vec![0; wanted.min((size - offset) as usize)];
    file.read_exact(&mut out)?;
    Ok(out)
}
