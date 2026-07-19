//! Shared-clipboard runtime (desktop).
//!
//! Responsibilities kept in Rust on the desktop side:
//!   - native clipboard capture (Win32 listener → [`watch`]),
//!   - the permanent local store (image files + thumbnails on disk; metadata in
//!     SQLite via [`crate::db::clipboard`]),
//!   - the always-on-top floating overlay window,
//!   - reading/writing the OS clipboard for "quick copy".
//!
//! The E2E sync itself runs in the always-alive main webview (`clipboardSync.ts`,
//! WebCrypto) — the desktop webview keeps running while hidden to the tray, so a
//! single crypto implementation is shared with the Android companion webview and
//! no TLS/WebSocket/AEAD crates are pulled into the desktop binary. Rust emits
//! `clipboard://item` for a locally-captured item (the JS encrypts + uploads it)
//! and exposes commands the JS calls to apply remote items.

#[cfg(windows)]
pub mod watch;

use crate::db::clipboard::{self as store, ClipInput, ClipItem};
use crate::error::AppResult;
use crate::state::AppState;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const OVERLAY_LABEL: &str = "clipboard-overlay";

/// A stable per-install id so items can be attributed to a device and de-duped
/// across the relay. Generated + persisted on first use.
pub fn device_id(pool: &crate::db::DbPool) -> String {
    if let Ok(Some(id)) = crate::db::settings::get(pool, "clipboard_device_id") {
        if !id.is_empty() {
            return id;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = crate::db::settings::set(pool, "clipboard_device_id", &id);
    id
}

/// Friendly device label shown on each item ("this PC").
pub fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "PC".to_string())
}

/// `media_dir/clipboard`, created on demand.
pub fn clip_dir(media_dir: &Path) -> PathBuf {
    let dir = media_dir.join("clipboard");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Persist an image (PNG bytes) plus a downscaled thumbnail. Returns
/// `(image_path, thumb_path, size)` as absolute path strings.
pub fn save_image(media_dir: &Path, id: &str, png: &[u8]) -> AppResult<(String, String, i64)> {
    let dir = clip_dir(media_dir);
    let full = dir.join(format!("{id}.png"));
    let thumb = dir.join(format!("{id}_thumb.png"));
    std::fs::write(&full, png)?;

    // Thumbnail (max 320px longest edge) so the history list never decodes full
    // images. Best-effort — a decode failure just skips the thumb.
    if let Ok(img) = image::load_from_memory(png) {
        let t = img.thumbnail(320, 320);
        let _ = t.save_with_format(&thumb, image::ImageFormat::Png);
    }
    let thumb_str = if thumb.is_file() {
        thumb.to_string_lossy().into_owned()
    } else {
        full.to_string_lossy().into_owned()
    };
    Ok((
        full.to_string_lossy().into_owned(),
        thumb_str,
        png.len() as i64,
    ))
}

/// Remove any of the given files (best-effort) — used after a delete/clear.
pub fn remove_files<I: IntoIterator<Item = Option<String>>>(paths: I) {
    for p in paths.into_iter().flatten() {
        let _ = std::fs::remove_file(p);
    }
}

/// Reconcile the native watcher + overlay window with the current settings.
/// Called on launch and after any clipboard setting changes.
pub fn apply_settings(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let pool = &state.pool;
    let enabled = crate::db::settings::get_bool(pool, "clipboard_enabled").unwrap_or(false);
    let auto = crate::db::settings::get_bool(pool, "clipboard_auto_capture").unwrap_or(true);
    let overlay = crate::db::settings::get_bool(pool, "clipboard_overlay_enabled").unwrap_or(false);

    // Native capture (Windows only).
    #[cfg(windows)]
    {
        if enabled && auto {
            let did = device_id(pool);
            watch::start(
                app.clone(),
                pool.clone(),
                state.media_dir.clone(),
                did,
                device_name(),
            );
        } else {
            watch::stop();
        }
    }
    #[cfg(not(windows))]
    let _ = auto;

    // Floating overlay window.
    if enabled && overlay {
        open_overlay(app);
    } else {
        close_overlay(app);
    }
}

/// Create the always-on-top floating overlay window (idempotent).
pub fn open_overlay(app: &AppHandle) {
    if app.get_webview_window(OVERLAY_LABEL).is_some() {
        return;
    }
    let (x, y) = overlay_pos(app);
    let mut builder = WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("index.html#/clip-overlay".into()),
    )
    .title("Clipboard")
    .inner_size(76.0, 76.0)
    .min_inner_size(60.0, 60.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .shadow(false)
    .visible(true);
    if let (Some(x), Some(y)) = (x, y) {
        builder = builder.position(x, y);
    }
    let _ = builder.build();
}

/// Close the overlay window if present.
pub fn close_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = w.close();
    }
}

fn overlay_pos(app: &AppHandle) -> (Option<f64>, Option<f64>) {
    let Some(state) = app.try_state::<AppState>() else {
        return (None, None);
    };
    let raw = crate::db::settings::get(&state.pool, "clipboard_overlay_pos")
        .ok()
        .flatten()
        .unwrap_or_default();
    let mut it = raw.split(',');
    match (
        it.next().and_then(|s| s.trim().parse::<f64>().ok()),
        it.next().and_then(|s| s.trim().parse::<f64>().ok()),
    ) {
        (Some(x), Some(y)) => (Some(x), Some(y)),
        _ => (None, None),
    }
}

/// Insert a locally-captured item and notify the webview to sync + display it.
/// Called by the native watcher and the manual-add command.
pub fn add_local(
    app: &AppHandle,
    pool: &crate::db::DbPool,
    item: ClipInput,
) -> AppResult<ClipItem> {
    store::upsert(pool, &item)?;
    let saved = store::get(pool, &item.id)?
        .ok_or_else(|| crate::error::AppError::msg("clip item vanished after insert"))?;
    // Sync signal (JS encrypts + uploads) + UI refresh.
    let _ = app.emit("clipboard://item", &saved);
    let _ = app.emit_to(OVERLAY_LABEL, "clipboard://item", &saved);
    Ok(saved)
}

/// Set the OS clipboard to a stored item's contents (quick copy). No-op capture
/// loop: the watcher ignores the update this triggers (see `watch::ignore_next`).
pub fn copy_to_os(_pool: &crate::db::DbPool, item: &ClipItem) -> AppResult<()> {
    #[cfg(windows)]
    {
        watch::ignore_next();
        if item.kind == "image" {
            if let Some(path) = &item.image_path {
                if let Ok(bytes) = std::fs::read(path) {
                    if let Ok(img) = image::load_from_memory(&bytes) {
                        watch::set_os_image(&img.to_rgba8());
                        return Ok(());
                    }
                }
            }
        }
        if let Some(text) = &item.text {
            watch::set_os_text(text);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = item;
    }
    Ok(())
}
