//! `gametracker.exe --notes-shell`: the floating Notes UI in a process of its own.
//!
//! A freeze or crash in the main app can't reach it, and it can't reach the main app.
//! Four kinds of thread:
//! - the orb thread (`orb`), which never waits for anything;
//! - this process's Tauri UI thread, which only hosts the panel;
//! - `control`, which turns what the orb reports into panel and database work;
//! - `feed`, which watches the database and the sync status and tells the orb.
//!
//! The database is the source of truth, so neither process needs the other. The main
//! app starts this one and restarts it (`hostproc::supervise_shell`).

use super::orb::motion::Rect;
use super::orb::place::Place;
use super::orb::{self, Config, FromOrb, Handle, Rim, ToOrb};
use super::{bus, panel, NotesCtx};
use crate::clipboard;
use crate::db::clipboard::{self as store, ClipInput};
use crate::db::{settings, DbPool};
use crate::hostproc;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

pub const DEFAULT_PANEL: (f32, f32) = (430.0, 660.0);
pub const MIN_PANEL: (f32, f32) = (320.0, 380.0);
/// The panel's WebView is released after this long closed.
const RELEASE_AFTER: Duration = Duration::from_secs(15 * 60);
/// A panel that hasn't reported in by now never will: WebView2 has wedged, and only a
/// fresh process gets out of that.
const OPEN_DEADLINE: Duration = Duration::from_secs(12);
const FEED_TICK: Duration = Duration::from_secs(2);
const PEEK_CHARS: usize = 120;

/// True while the panel is open: notes arriving then aren't unread.
static PANEL_OPEN: AtomicBool = AtomicBool::new(false);

pub struct Shell {
    pub orb: Handle,
}

fn panel_size(raw: Option<String>) -> (f32, f32) {
    let parsed = raw.and_then(|s| {
        let (w, h) = s.split_once(',')?;
        Some((w.trim().parse::<f32>().ok()?, h.trim().parse::<f32>().ok()?))
    });
    match parsed {
        Some((w, h)) if w.is_finite() && h.is_finite() => (w.clamp(MIN_PANEL.0, 1400.0), h.clamp(MIN_PANEL.1, 1600.0)),
        _ => DEFAULT_PANEL,
    }
}

pub fn load_config(pool: &DbPool) -> Config {
    Config {
        tuck: settings::get_bool(pool, "notes_orb_tuck").unwrap_or(true),
        spark: settings::get_bool(pool, "notes_orb_spark").unwrap_or(false),
        peek: settings::get_bool(pool, "notes_orb_peek").unwrap_or(true),
        private: settings::get_bool(pool, "notes_orb_private").unwrap_or(false),
        hotkey: settings::get(pool, "notes_hotkey").ok().flatten().unwrap_or_else(|| "Ctrl+Shift+Space".into()),
        panel: panel_size(settings::get(pool, "notes_panel_size").ok().flatten()),
    }
}

/// What to show on the rim for the main app's last status report. Written while sync
/// runs, so a stale file means the main app has stopped.
fn rim_for(status: Option<&serde_json::Value>, now_ms: i64) -> Rim {
    const STALE_MS: i64 = 20_000;
    let Some(s) = status else { return Rim::Off };
    if s.get("started").and_then(|v| v.as_str()) != Some("true") {
        return Rim::Off;
    }
    let fresh = s.get("updatedMs").and_then(|v| v.as_i64()).is_some_and(|at| now_ms - at < STALE_MS);
    if fresh && s.get("wsState").and_then(|v| v.as_str()) == Some("open") {
        Rim::Synced
    } else {
        Rim::Reconnecting
    }
}

fn read_status(data_dir: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(data_dir.join("notes-status.json")).ok()?).ok()
}

/// The note's first line that says anything.
fn peek_body(text: Option<&str>) -> String {
    let line = text.unwrap_or_default().lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    let mut body: String = line.chars().take(PEEK_CHARS).collect();
    if line.chars().count() > PEEK_CHARS {
        body.push('…');
    }
    body
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn Error>> {
    let handle = app.handle().clone();
    let data_dir = hostproc::data_dir();
    std::fs::create_dir_all(&data_dir)?;
    let pool = crate::db::init_pool(&data_dir.join("gametracker.db")).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let ctx = NotesCtx { pool: pool.clone(), media_dir: data_dir.join("media"), data_dir };
    // Already inside the app's scope, except for a test shell running on a copy.
    let _ = app.asset_protocol_scope().allow_directory(&ctx.media_dir, true);
    app.manage(ctx.clone());
    bus::start(handle.clone(), bus::Side::Shell);

    let place = settings::get(&pool, "notes_orb_place")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Place>(&raw).ok());
    let legacy = settings::get(&pool, "clipboard_overlay_pos").ok().flatten().filter(|s| !s.is_empty());
    let (tx, rx) = std::sync::mpsc::channel();
    let orb = orb::spawn(load_config(&pool), place, legacy, tx);
    app.manage(Shell { orb: orb.clone() });

    let (control_app, control_ctx, control_orb) = (handle.clone(), ctx.clone(), orb.clone());
    std::thread::Builder::new().name("notes-control".into()).spawn(move || control(control_app, control_ctx, control_orb, rx))?;
    let (feed_ctx, feed_orb) = (ctx, orb);
    std::thread::Builder::new().name("notes-feed".into()).spawn(move || feed(feed_ctx, feed_orb))?;
    hostproc::watch_shell_quit();
    crate::uistall::watch(handle, "notes-shell");
    hostproc::trace("notes shell started");
    Ok(())
}

fn control(app: tauri::AppHandle, ctx: NotesCtx, orb: Handle, rx: std::sync::mpsc::Receiver<FromOrb>) {
    let mut closed_at: Option<Instant> = None;
    let mut waiting_since: Option<Instant> = None;
    loop {
        let message = rx.recv_timeout(Duration::from_secs(1));
        match message {
            Ok(FromOrb::Prewarm(rect)) => {
                panel::prewarm(&app, &ctx, rect);
                // Warmed but never opened still has to be given back.
                if !PANEL_OPEN.load(Ordering::SeqCst) {
                    closed_at = Some(Instant::now());
                }
            }
            Ok(FromOrb::Open(rect)) => {
                PANEL_OPEN.store(true, Ordering::SeqCst);
                closed_at = None;
                if !panel::is_ready() {
                    waiting_since = Some(Instant::now());
                }
                panel::prepare(&app, &ctx, &orb, rect);
            }
            Ok(FromOrb::Reveal) => {
                waiting_since = None;
                let _ = app.emit_to(panel::LABEL, "notes://reveal", ());
            }
            Ok(FromOrb::Focus) => panel::focus(&app),
            Ok(FromOrb::Close) => {
                PANEL_OPEN.store(false, Ordering::SeqCst);
                waiting_since = None;
                let _ = app.emit_to(panel::LABEL, "notes://close", ());
            }
            Ok(FromOrb::Closed(kept)) => {
                closed_at = Some(Instant::now());
                if let Some(rect) = kept {
                    save_size(&ctx.pool, rect);
                }
                panel::suspend(&app);
            }
            Ok(FromOrb::Moved(place)) => {
                if let Ok(raw) = serde_json::to_string(&place) {
                    let _ = settings::set(&ctx.pool, "notes_orb_place", &raw);
                }
            }
            Ok(FromOrb::Dropped(files)) => {
                let ctx = ctx.clone();
                std::thread::spawn(move || add_dropped(&ctx, files));
            }
            Ok(FromOrb::HotkeyTaken(key)) => {
                hostproc::trace(&format!("notes: couldn't register hotkey {key}"));
                let _ = settings::set(&ctx.pool, "notes_hotkey_error", &key);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
        }
        if panel::is_ready() {
            waiting_since = None;
        }
        if waiting_since.is_some_and(|t| t.elapsed() > OPEN_DEADLINE) {
            hostproc::trace("notes panel never reported in; exiting for a fresh shell");
            std::process::exit(76);
        }
        if closed_at.is_some_and(|t| t.elapsed() > RELEASE_AFTER) {
            closed_at = None;
            panel::release(&app);
            orb.send(ToOrb::PanelGone);
        }
    }
}

fn save_size(pool: &DbPool, rect: Rect) {
    let scale = orb::place::monitors()
        .iter()
        .find(|m| rect.x >= m.bounds.x && rect.x < m.bounds.right())
        .map_or(1.0, |m| m.scale);
    let _ = settings::set(pool, "notes_panel_size", &format!("{},{}", (rect.w as f32 / scale).round(), (rect.h as f32 / scale).round()));
}

/// A file dropped on the orb: images become image notes, anything else a text note
/// holding its path.
fn add_dropped(ctx: &NotesCtx, files: Vec<PathBuf>) {
    const IMAGES: [&str; 6] = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];
    for file in files {
        let is_image = file.extension().and_then(|e| e.to_str()).is_some_and(|e| IMAGES.contains(&e.to_ascii_lowercase().as_str()));
        let added = if is_image {
            add_image(ctx, &file)
        } else {
            add_text(&ctx.pool, file.to_string_lossy().into_owned())
        };
        if let Err(e) = added {
            hostproc::trace(&format!("notes: drop of {} failed: {e}", file.display()));
        }
    }
}

fn base_input(pool: &DbPool, kind: &str) -> ClipInput {
    ClipInput {
        id: uuid::Uuid::new_v4().to_string(),
        kind: kind.into(),
        text: None,
        image_path: None,
        thumb_path: None,
        mime: None,
        size: 0,
        created_utc: store::wire_now(),
        device_id: clipboard::device_id(pool),
        device_name: Some(clipboard::device_name()),
        source: "manual".into(),
        pinned: false,
        folder: String::new(),
        tags: Vec::new(),
        content_hash: None,
        copies: Vec::new(),
        synced: false,
    }
}

fn add_text(pool: &DbPool, text: String) -> crate::error::AppResult<()> {
    let mut item = base_input(pool, "text");
    item.size = text.len() as i64;
    item.mime = Some("text/plain".into());
    item.text = Some(text);
    clipboard::add_local(pool, item).map(|_| ())
}

fn add_image(ctx: &NotesCtx, path: &Path) -> crate::error::AppResult<()> {
    let bytes = std::fs::read(path)?;
    let png = super::commands::to_png(bytes);
    let mut item = base_input(&ctx.pool, "image");
    let (image, thumb, size) = clipboard::save_image(&ctx.media_dir, &item.id, &png)?;
    item.image_path = Some(image);
    item.thumb_path = Some(thumb);
    item.size = size;
    item.mime = Some("image/png".into());
    item.content_hash = Some(store::content_hash("image", &png));
    clipboard::add_local(&ctx.pool, item).map(|_| ())
}

/// Watches for new notes and for changes in sync state and settings, and tells the
/// orb. Sleeps until something changes, with a slow tick for what doesn't signal.
fn feed(ctx: NotesCtx, orb: Handle) {
    let pool = &ctx.pool;
    let me = clipboard::device_id(pool);
    let mut rev = store::current_rev(pool).unwrap_or(0);
    let mut newest = store::list(pool, None, 1).ok().and_then(|l| l.into_iter().next()).map(|n| n.created_utc).unwrap_or_default();
    let mut unread = 0u32;
    let mut config = load_config(pool);
    let mut rim = None;
    loop {
        bus::wait(FEED_TICK);
        if PANEL_OPEN.load(Ordering::SeqCst) {
            unread = 0;
        }
        if let Ok(now) = store::current_rev(pool) {
            if now != rev {
                for note in store::changes_since(pool, rev, 50).unwrap_or_default() {
                    if note.deleted || note.created_utc <= newest || note.kind == "folder" {
                        continue;
                    }
                    newest = note.created_utc.clone();
                    let from = (note.device_id != me).then(|| note.device_name.clone().unwrap_or_else(|| "another device".into()));
                    if from.is_some() && !PANEL_OPEN.load(Ordering::SeqCst) {
                        unread += 1;
                        orb.send(ToOrb::Unread(unread));
                    }
                    let body = if note.kind == "image" { "Image".to_string() } else { peek_body(note.text.as_deref()) };
                    orb.send(ToOrb::Note { body, from });
                }
                rev = now;
            }
        }
        let next = rim_for(read_status(&ctx.data_dir).as_ref(), chrono::Utc::now().timestamp_millis());
        if rim != Some(next) {
            rim = Some(next);
            orb.send(ToOrb::Rim(next));
        }
        let fresh = load_config(pool);
        if fresh != config {
            config = fresh.clone();
            orb.send(ToOrb::Config(fresh));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn saved_panel_sizes_are_kept_in_bounds() {
        assert_eq!(panel_size(None), DEFAULT_PANEL);
        assert_eq!(panel_size(Some("junk".into())), DEFAULT_PANEL);
        assert_eq!(panel_size(Some("500, 700".into())), (500.0, 700.0));
        assert_eq!(panel_size(Some("10,10".into())), MIN_PANEL);
        assert_eq!(panel_size(Some("NaN,700".into())), DEFAULT_PANEL);
    }

    #[test]
    fn the_rim_follows_the_main_apps_report() {
        let now = 1_000_000;
        let report = |started: &str, ws: &str, age: i64| json!({ "started": started, "wsState": ws, "updatedMs": now - age });
        assert_eq!(rim_for(None, now), Rim::Off);
        assert_eq!(rim_for(Some(&report("false", "open", 0)), now), Rim::Off);
        assert_eq!(rim_for(Some(&report("true", "open", 1000)), now), Rim::Synced);
        assert_eq!(rim_for(Some(&report("true", "connecting", 1000)), now), Rim::Reconnecting);
        assert_eq!(rim_for(Some(&report("true", "open", 60_000)), now), Rim::Reconnecting, "a silent main app isn't synced");
    }

    #[test]
    fn a_peek_shows_the_first_line_with_something_on_it() {
        assert_eq!(peek_body(Some("\n\n  hello there \nmore")), "hello there");
        assert_eq!(peek_body(None), "");
        let long = "x".repeat(300);
        let body = peek_body(Some(&long));
        assert_eq!(body.chars().count(), PEEK_CHARS + 1);
        assert!(body.ends_with('…'));
    }
}
