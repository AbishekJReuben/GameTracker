//! GameTracker Remote — the phone companion shell.
//!
//! This is a thin Tauri host for the `companion.html` web bundle. All the real
//! work (stats, live screen, input) happens in the webview talking to the desktop
//! app's remote server over Tailscale/LAN, so this crate stays deliberately tiny.
//! The one native command it exposes is the in-app updater (see `update.rs`),
//! since Tauri's updater plugin doesn't support Android.

mod clipboard;
mod decoder;
mod pip;
mod update;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            update::download_and_install_apk,
            update::save_apk_to_downloads,
            update::open_downloaded_apk,
            update::fetch_update_manifest,
            update::install_permission_status,
            update::open_install_settings,
            pip::set_pip_enabled,
            pip::set_rotation_hold_ms,
            decoder::decoder_probe,
            decoder::decoder_init,
            decoder::decoder_set_bounds,
            decoder::decoder_reset,
            decoder::decoder_teardown,
            decoder::decoder_get_stats,
            decoder::decoder_dump_diag,
            decoder::stream_active,
            clipboard::clipboard_service_start,
            clipboard::clipboard_overlay_status,
            clipboard::clipboard_request_overlay,
            clipboard::clipboard_battery_status,
            clipboard::clipboard_request_battery,
            clipboard::clipboard_notif_status,
            clipboard::clipboard_request_notif,
            clipboard::clipboard_read,
            clipboard::clipboard_read_image,
            clipboard::clipboard_write,
            clipboard::clipboard_service_snapshot,
            clipboard::speech_to_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GameTracker Remote");
}
