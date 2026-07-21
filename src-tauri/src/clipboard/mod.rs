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
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const OVERLAY_LABEL: &str = "clipboard-overlay";

/// A small ring buffer of the most recent clipboard-runtime events/errors so the
/// Settings panel's "Copy logs" button can hand the user a self-contained report
/// instead of "it doesn't work." Cheap (Mutex<Vec<String>>, capped at 200 lines).
pub const LOG_MAX: usize = 200;
static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Append one line to the clipboard diagnostics log. Best-effort — a poisoned
/// lock is silently dropped (logging must never itself crash the feature).
pub fn log(line: impl Into<String>) {
    if let Ok(mut buf) = LOG.lock() {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string();
        buf.push(format!("[{stamp}] {}", line.into()));
        while (buf.len()) > LOG_MAX {
            buf.remove(0);
        }
    }
}

/// Snapshot of the diagnostics log (oldest first), for the Settings panel.
pub fn diagnostics() -> Vec<String> {
    LOG.lock().map(|b| b.clone()).unwrap_or_default()
}

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
/// Called on launch and after any clipboard setting changes. Returns the first
/// error encountered so callers (notably `clipboard_configure`) can surface it
/// instead of hanging the UI on "Turning on…". Every step is logged so the
/// diagnostics report explains what happened.
pub fn apply_settings(app: &AppHandle) -> AppResult<()> {
    let Some(state) = app.try_state::<AppState>() else {
        log("apply_settings: AppState unavailable");
        return Ok(());
    };
    let pool = &state.pool;
    let enabled = crate::db::settings::get_bool(pool, "clipboard_enabled").unwrap_or(false);
    let auto = crate::db::settings::get_bool(pool, "clipboard_auto_capture").unwrap_or(true);
    let overlay = crate::db::settings::get_bool(pool, "clipboard_overlay_enabled").unwrap_or(false);
    log(format!(
        "apply_settings: enabled={enabled} overlay={overlay} auto={auto} (windows={})",
        cfg!(windows)
    ));

    // Native capture (Windows only).
    #[cfg(windows)]
    {
        if enabled && auto {
            let did = device_id(pool);
            log(format!("watch::start (device={})", did));
            // watch::start spawns its own thread and returns fast; it cannot block us.
            if let Err(e) = watch::start(
                app.clone(),
                pool.clone(),
                state.media_dir.clone(),
                did,
                device_name(),
            ) {
                log(format!("watch::start FAILED: {e}"));
                return Err(e);
            }
            log("watch::start ok");
        } else {
            watch::stop();
            log("watch::stop");
        }
    }
    #[cfg(not(windows))]
    let _ = auto;

    // Floating overlay window. IMPORTANT: building a WebView window must happen
    // on the Tauri main thread (it pumps the Win32 message loop for WebView2
    // controller init). If `apply_settings` is ever called from a sync command,
    // `build()` deadlocks the main thread — see `clipboard_configure` which now
    // defers this via `run_on_main_thread`.
    if enabled && overlay {
        match open_overlay(app) {
            Ok(()) => log("open_overlay ok"),
            Err(e) => {
                log(format!("open_overlay FAILED: {e}"));
                return Err(e);
            }
        }
        #[cfg(windows)]
        spawn_fullscreen_guard(app.clone());
    } else {
        close_overlay(app);
        log("close_overlay");
    }
    Ok(())
}

/// While the overlay is on, hide it whenever the foreground app is fullscreen
/// (games, video players) so the bubble never floats over a movie or a match —
/// and bring it back the moment the fullscreen app goes away. Cheap 2s poll on a
/// dedicated thread; only ever toggles visibility on a state CHANGE.
#[cfg(windows)]
fn spawn_fullscreen_guard(app: AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return; // one guard for the process lifetime
    }
    std::thread::spawn(move || {
        let mut hidden_for_fs = false;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
                // Overlay closed (feature toggled off) — idle cheaply until it's back.
                hidden_for_fs = false;
                continue;
            };
            let fs = foreground_is_fullscreen();
            if fs && !hidden_for_fs {
                if win.hide().is_ok() {
                    hidden_for_fs = true;
                    log("overlay hidden (fullscreen app in front)");
                }
            } else if !fs && hidden_for_fs {
                if win.show().is_ok() {
                    hidden_for_fs = false;
                    log("overlay restored (fullscreen app gone)");
                }
            }
        }
    });
}

/// True when the current foreground window covers its whole monitor (borderless/
/// exclusive fullscreen). The desktop shell (Progman/WorkerW) and our own windows
/// never count.
#[cfg(windows)]
fn foreground_is_fullscreen() -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
    };
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        // Never react to our own process (the overlay itself, the main window).
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
        if pid == std::process::id() {
            return false;
        }
        // The desktop shell reports monitor-sized rects; skip it.
        let mut class = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut class);
        if n > 0 {
            let name = String::from_utf16_lossy(&class[..n as usize]);
            if name == "Progman" || name == "WorkerW" {
                return false;
            }
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(mon, &mut info).as_bool() {
            return false;
        }
        let m = info.rcMonitor;
        rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom
    }
}

/// Create the always-on-top floating overlay window (idempotent). MUST run on the
/// Tauri main thread (WebView2 controller init needs the message pump).
pub fn open_overlay(app: &AppHandle) -> AppResult<()> {
    if app.get_webview_window(OVERLAY_LABEL).is_some() {
        return Ok(());
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
    builder
        .build()
        .map(|_| ())
        .map_err(|e| crate::error::AppError::msg(format!("overlay window build failed: {e}")))
}

/// Close the overlay window if present.
pub fn close_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = w.close();
    }
}

/// Schedule `apply_settings` to run on the Tauri main thread WITHOUT blocking the
/// caller. Used by `clipboard_configure` (an async command) so the Win32/WebView2
/// message pump stays free while the window is built — calling `apply_settings`
/// inline from a sync command deadlocks `WebviewWindowBuilder::build()` on Windows.
pub fn apply_settings_deferred(app: AppHandle) {
    // `run_on_main_thread` borrows `app` to schedule the closure, so the closure
    // needs its own (cloned) handle to call `apply_settings` with once it runs.
    // A failure to *schedule* (rare: app shutting down) is logged but not fatal.
    let app2 = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        if let Err(e) = apply_settings(&app2) {
            log(format!("deferred apply_settings failed: {e}"));
        }
    }) {
        log(format!("run_on_main_thread schedule failed: {e}"));
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
///
/// Dedup-to-top: if a live note with the SAME content already exists, this bumps
/// that existing item to the top (appending this capture's timestamp to its copy
/// history) instead of inserting a duplicate — and drops the just-saved image
/// file, if any. `item.content_hash` must be set by the caller (text or image);
/// for text we compute it here as a fallback.
pub fn add_local(
    app: &AppHandle,
    pool: &crate::db::DbPool,
    mut item: ClipInput,
) -> AppResult<ClipItem> {
    if item.content_hash.is_none() && item.kind == "text" {
        item.content_hash = Some(store::content_hash(
            "text",
            item.text.clone().unwrap_or_default().as_bytes(),
        ));
    }

    // Dedup against an existing live note with identical content.
    if let Some(hash) = item.content_hash.clone() {
        if let Some(existing) = store::find_by_hash(pool, &hash)? {
            if existing.id != item.id {
                // This capture's blob is redundant — remove it from disk.
                remove_files([item.image_path.clone(), item.thumb_path.clone()]);
                if let Some(saved) = store::bump_to_top(pool, &existing.id, &item.created_utc)? {
                    let _ = app.emit("clipboard://item", &saved);
                    let _ = app.emit_to(OVERLAY_LABEL, "clipboard://item", &saved);
                    let _ = app.emit("clipboard://changed", ());
                    let _ = app.emit_to(OVERLAY_LABEL, "clipboard://changed", ());
                    return Ok(saved);
                }
            }
        }
    }

    store::upsert(pool, &item)?;
    let saved = store::get(pool, &item.id)?
        .ok_or_else(|| crate::error::AppError::msg("clip item vanished after insert"))?;
    // Sync signal (JS encrypts + uploads) + UI refresh.
    let _ = app.emit("clipboard://item", &saved);
    let _ = app.emit_to(OVERLAY_LABEL, "clipboard://item", &saved);
    let _ = app.emit("clipboard://changed", ());
    let _ = app.emit_to(OVERLAY_LABEL, "clipboard://changed", ());
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
