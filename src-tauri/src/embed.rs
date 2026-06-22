//! In-window child webviews for embedded site panels (logical coords relative to main window).
use crate::error::{AppError, AppResult};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

fn main_window(app: &AppHandle) -> AppResult<tauri::WebviewWindow> {
    app.get_webview_window("main")
        .ok_or_else(|| AppError::msg("Main window not found."))
}

fn close_if_exists(app: &AppHandle, label: &str) {
    if let Some(wv) = app.get_webview(label) {
        let _ = wv.close();
    }
}

#[tauri::command]
pub async fn open_embed(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> AppResult<()> {
    let main_wv = main_window(&app)?;
    close_if_exists(&app, &label);

    let parsed = url
        .trim()
        .parse()
        .map_err(|_| AppError::msg("Invalid URL."))?;

    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed));
    let window = main_wv.as_ref().window();
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(w.max(80.0), h.max(80.0)),
        )
        .map_err(|e| AppError::msg(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn set_embed_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> AppResult<()> {
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| AppError::msg("Embed not found."))?;
    wv.set_position(LogicalPosition::new(x, y))
        .map_err(|e| AppError::msg(e.to_string()))?;
    wv.set_size(LogicalSize::new(w.max(80.0), h.max(80.0)))
        .map_err(|e| AppError::msg(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn set_embed_visible(app: AppHandle, label: String, visible: bool) -> AppResult<()> {
    if let Some(wv) = app.get_webview(&label) {
        if visible {
            let _ = wv.show();
        } else {
            let _ = wv.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn close_embed(app: AppHandle, label: String) -> AppResult<()> {
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.close();
    }
    Ok(())
}
