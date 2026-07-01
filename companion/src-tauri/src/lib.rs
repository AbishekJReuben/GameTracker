//! GameTracker Remote — the phone companion shell.
//!
//! This is a thin Tauri host for the `companion.html` web bundle. All the real
//! work (stats, live screen, input) happens in the webview talking to the desktop
//! app's remote server over Tailscale/LAN, so this crate stays deliberately tiny.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running GameTracker Remote");
}
