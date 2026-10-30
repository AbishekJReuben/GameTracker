//! The panel: a WebView window behind real desktop acrylic.
//!
//! It is built the first time the pointer nears the orb, stays warm after closing, and
//! is released after 15 idle minutes. The orb decides when it shows, so nothing here
//! shows it: this file only makes sure it exists, in the right place, with its page
//! ready. Everything runs on the control thread or a worker, never on the orb's thread.

use super::orb::motion::Rect;
use super::orb::{Handle, ToOrb};
use super::shell::{Shell, MIN_PANEL};
use super::NotesCtx;
use crate::commands::run_blocking;
use crate::db::settings;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "notes-panel";

static BUILDING: AtomicBool = AtomicBool::new(false);
static READY: AtomicBool = AtomicBool::new(false);

pub fn is_ready() -> bool {
    READY.load(Ordering::SeqCst)
}

fn hwnd(window: &WebviewWindow) -> isize {
    window.hwnd().map(|h| h.0 as isize).unwrap_or(0)
}

/// Build the window on a worker: `build` waits for the UI thread and for WebView2.
fn build(app: &AppHandle, ctx: &NotesCtx, orb: &Handle, rect: Rect) {
    if app.get_webview_window(LABEL).is_some() || BUILDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let (app, data, orb) = (app.clone(), ctx.data_dir.join("EBWebView-notes"), orb.clone());
    let _ = std::thread::Builder::new().name("notes-panel-build".into()).spawn(move || {
        let built = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("notes.html".into()))
            .title("Notes")
            .inner_size(rect.w as f64, rect.h as f64)
            .position(rect.x as f64, rect.y as f64)
            .min_inner_size(MIN_PANEL.0 as f64, MIN_PANEL.1 as f64)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(true)
            .shadow(true)
            .visible(false)
            .focused(false)
            .data_directory(data)
            .build();
        match built {
            Ok(window) => {
                set_physical(&window, rect);
                chrome(&window);
                crate::hostproc::reload_on_renderer_crash(&window);
                let dead = app.clone();
                crate::hostproc::on_browser_exit(&window, move || {
                    crate::hostproc::trace("notes panel: browser process exited");
                    release(&dead);
                    orb.send(ToOrb::PanelGone);
                });
            }
            Err(e) => crate::hostproc::trace(&format!("notes panel build failed: {e}")),
        }
        BUILDING.store(false, Ordering::SeqCst);
    });
}

fn set_physical(window: &WebviewWindow, rect: Rect) {
    let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
    let _ = window.set_size(PhysicalSize::new(rect.w as u32, rect.h as u32));
}

/// Real acrylic, native rounded corners and shadow, and no taskbar or Alt-Tab entry.
#[cfg(windows)]
fn chrome(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMWINDOWATTRIBUTE};
    use windows::Win32::UI::Controls::MARGINS;
    use windows::Win32::UI::WindowsAndMessaging::*;
    const TRANSITIONS_OFF: i32 = 3;
    const DARK: i32 = 20;
    const CORNERS: i32 = 33;
    const BACKDROP: i32 = 38;
    const ROUND: u32 = 2;
    const TRANSIENT: u32 = 3;
    let Ok(raw) = window.hwnd() else { return };
    let h = HWND(raw.0);
    unsafe {
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
        SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW.0 as isize);
        let style = GetWindowLongPtrW(h, GWL_STYLE);
        // Without this Windows paints caption buttons into the extended frame.
        SetWindowLongPtrW(h, GWL_STYLE, style & !((WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0) as isize));
        let _ = SetWindowPos(h, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);
        let _ = DwmExtendFrameIntoClientArea(h, &MARGINS { cxLeftWidth: -1, cxRightWidth: -1, cyTopHeight: -1, cyBottomHeight: -1 });
        for (attribute, value) in [(TRANSITIONS_OFF, 1u32), (DARK, 1), (CORNERS, ROUND), (BACKDROP, TRANSIENT)] {
            let _ = DwmSetWindowAttribute(h, DWMWINDOWATTRIBUTE(attribute), &value as *const u32 as *const _, 4);
        }
    }
}

/// The pointer is near the orb. Worth starting now: a cold start takes longer than
/// the gap between hover and click.
pub fn prewarm(app: &AppHandle, ctx: &NotesCtx, orb: &Handle, rect: Rect) {
    build(app, ctx, orb, rect);
}

/// An open is under way: the window must exist and sit where the shape is heading.
pub fn prepare(app: &AppHandle, ctx: &NotesCtx, orb: &Handle, rect: Rect) {
    match app.get_webview_window(LABEL) {
        Some(window) => {
            set_physical(&window, rect);
            let _ = window.as_ref().show();
            if is_ready() {
                orb.send(ToOrb::PanelReady(hwnd(&window)));
            }
        }
        None => build(app, ctx, orb, rect),
    }
}

/// The panel is closed: stop its page drawing, but keep it.
pub fn suspend(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.as_ref().hide();
    }
}

pub fn focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.as_ref().set_focus();
    }
}

/// Give the WebView's memory back.
pub fn release(app: &AppHandle) {
    READY.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}

// ---- commands the panel's page calls -------------------------------------------

/// The page has rendered and can be shown. Called again after a renderer reload.
#[tauri::command]
pub async fn notes_panel_ready(window: WebviewWindow, shell: State<'_, Shell>) -> AppResult<()> {
    READY.store(true, Ordering::SeqCst);
    shell.orb.send(ToOrb::PanelReady(hwnd(&window)));
    Ok(())
}

/// The page has drawn a frame since being shown.
#[tauri::command]
pub async fn notes_panel_painted(shell: State<'_, Shell>) -> AppResult<()> {
    shell.orb.send(ToOrb::PanelPainted);
    Ok(())
}

#[tauri::command]
pub async fn notes_panel_close(shell: State<'_, Shell>) -> AppResult<()> {
    shell.orb.send(ToOrb::Close);
    Ok(())
}

#[tauri::command]
pub async fn notes_panel_recording(shell: State<'_, Shell>, on: bool) -> AppResult<()> {
    shell.orb.send(ToOrb::Recording(on));
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelConfig {
    stt_enabled: bool,
    draft: String,
    hotkey: String,
}

#[tauri::command]
pub async fn notes_panel_config(ctx: State<'_, NotesCtx>) -> AppResult<PanelConfig> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        Ok(PanelConfig {
            stt_enabled: settings::get_bool(&pool, "clipboard_stt_enabled").unwrap_or(false),
            draft: settings::get(&pool, "notes_draft")?.unwrap_or_default(),
            hotkey: settings::get(&pool, "notes_hotkey")?.unwrap_or_default(),
        })
    })
    .await
}

#[tauri::command]
pub async fn notes_panel_set_draft(ctx: State<'_, NotesCtx>, text: String) -> AppResult<()> {
    const MAX_DRAFT: usize = 256 * 1024;
    if text.len() > MAX_DRAFT {
        return Err(AppError::msg("That draft is too long to keep."));
    }
    let pool = ctx.pool.clone();
    run_blocking(move || settings::set(&pool, "notes_draft", &text)).await
}

/// The main app's last word on sync, for the header pill.
#[tauri::command]
pub async fn notes_panel_status(ctx: State<'_, NotesCtx>) -> AppResult<Option<serde_json::Value>> {
    let path = ctx.data_dir.join("notes-status.json");
    run_blocking(move || Ok(std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()))).await
}
