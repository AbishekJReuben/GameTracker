mod autostart;
mod clipboard;
mod commands;
mod content_audit;
mod content_repair;
mod db;
mod detect;
mod embed;
mod error;
mod gog;
mod gog_auth;
mod hltb;
mod icons;
mod importer;
mod launcher_catalog;
mod metadata;
#[cfg(windows)]
mod registry;
mod remote;
mod state;
mod steam;
mod steam_emu;
mod steam_openid;
mod suggestions;
mod system;
mod tracking;
mod tray;
mod util;

#[cfg(test)]
mod audit_regression;

use state::AppState;
use std::sync::Arc;
use system::SystemShared;
use tauri::{Listener, Manager};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_updater::UpdaterExt;
use tracking::TrackingShared;

/// How often to re-check GitHub Releases for a newer build while running.
const UPDATE_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Poll GitHub Releases for a newer signed build and install it silently — once
/// on launch, then every 30 minutes. Any failure (offline, no update, unsigned)
/// is ignored; the loop keeps the app current even across long uptime in the tray.
/// A background OS thread drives the timer (no async-runtime time feature needed)
/// and blocks on each async check in turn.
fn spawn_update_check(handle: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        check_for_update_once(&handle);
        std::thread::sleep(UPDATE_CHECK_INTERVAL);
    });
}

fn check_for_update_once(handle: &tauri::AppHandle) {
    let handle = handle.clone();
    tauri::async_runtime::block_on(async move {
        let updater = match handle.updater() {
            Ok(u) => u,
            Err(_) => return,
        };
        if let Ok(Some(update)) = updater.check().await {
            if update
                .download_and_install(|_chunk, _total| {}, || {})
                .await
                .is_ok()
            {
                handle.restart();
            }
        }
    });
}

/// Apply the setup type ("Full tracker" vs "Remote only") chosen in the Windows
/// installer, which writes it to `install-mode.txt` beside the exe.
///
/// Every run of the installer rewrites the marker, so adopting it only when it
/// differs from the last value we saw keeps the two ways of setting the mode from
/// fighting: a deliberate re-pick in the installer takes effect, while an update
/// that leaves the radio alone never clobbers a later change made in Settings.
/// Absent marker (dev build, portable copy, pre-3.9.26 install) → leave as is.
fn seed_install_mode(pool: &db::DbPool) {
    let marker = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("install-mode.txt")))
        .and_then(|path| std::fs::read_to_string(path).ok());
    if let Some(raw) = marker {
        apply_install_mode(pool, &raw);
    }
}

/// The decision half of [`seed_install_mode`], split out so it can be tested
/// without an installed exe to sit next to.
fn apply_install_mode(pool: &db::DbPool, raw: &str) {
    let mode = raw.trim().to_ascii_lowercase();
    if mode != "remote" && mode != "full" {
        return;
    }
    let seen = db::settings::get(pool, "install_mode_seen").ok().flatten();
    if seen.as_deref() == Some(mode.as_str()) {
        return;
    }
    let remote_only = if mode == "remote" { "true" } else { "false" };
    let _ = db::settings::set(pool, "remote_only", remote_only);
    let _ = db::settings::set(pool, "install_mode_seen", &mode);
}

#[cfg(test)]
mod install_mode_tests {
    use super::*;

    fn pool() -> db::DbPool {
        let path = std::env::temp_dir().join(format!(
            "gt-install-mode-{}-{:?}.db",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        db::init_pool(&path).expect("test pool")
    }

    fn remote_only(pool: &db::DbPool) -> bool {
        db::settings::get_bool(pool, "remote_only").unwrap()
    }

    #[test]
    fn seeds_the_mode_the_installer_wrote() {
        let p = pool();
        assert!(!remote_only(&p), "defaults to the full app");

        apply_install_mode(&p, "remote");
        assert!(remote_only(&p));

        apply_install_mode(&p, "full");
        assert!(!remote_only(&p));
    }

    #[test]
    fn tolerates_a_trailing_newline_and_odd_casing() {
        let p = pool();
        apply_install_mode(&p, "Remote\r\n");
        assert!(remote_only(&p));
    }

    #[test]
    fn ignores_a_corrupt_marker() {
        let p = pool();
        apply_install_mode(&p, "remote");
        apply_install_mode(&p, "wat");
        assert!(remote_only(&p), "garbage must not silently flip the mode");
    }

    /// The installer rewrites the marker on every run, including updates that just
    /// keep the pre-selected default. Re-applying an already-seen mode must not
    /// undo a change the user made in Settings afterwards.
    #[test]
    fn an_unchanged_marker_does_not_override_the_settings_toggle() {
        let p = pool();
        apply_install_mode(&p, "remote");
        assert!(remote_only(&p));

        // User switches the full app back on from Settings.
        db::settings::set(&p, "remote_only", "false").unwrap();

        apply_install_mode(&p, "remote");
        assert!(!remote_only(&p), "the update must leave their choice alone");

        // ...but deliberately re-picking the other type in the installer applies.
        apply_install_mode(&p, "full");
        apply_install_mode(&p, "remote");
        assert!(remote_only(&p));
    }
}

/// If a backup restore was staged, swap it into place before the pool opens.
fn apply_pending_restore(data_dir: &std::path::Path, db_path: &std::path::Path) {
    let pending = data_dir.join("pending_restore.db");
    if pending.is_file() {
        for suffix in ["", "-wal", "-shm"] {
            let p = std::path::PathBuf::from(format!("{}{}", db_path.to_string_lossy(), suffix));
            let _ = std::fs::remove_file(p);
        }
        let _ = std::fs::rename(&pending, db_path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle();
            let data_dir = handle.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("gametracker.db");
            let media_dir = data_dir.join("media");

            apply_pending_restore(&data_dir, &db_path);

            let pool = db::init_pool(&db_path).map_err(|e| {
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                ))
            })?;
            seed_install_mode(&pool);

            let shared = Arc::new(TrackingShared::new());
            let sys_shared = Arc::new(SystemShared::new());

            let remote_port = db::settings::get_i64(&pool, "remote_port", 47800)
                .unwrap_or(47800)
                .clamp(1024, 65535) as u16;
            let remote_shared = Arc::new(remote::RemoteShared::new(remote_port));
            if db::settings::get_bool(&pool, "remote_cloud_enabled").unwrap_or(false) {
                remote_shared
                    .cloud_enabled
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
            // Restore the persisted connection code so it stays STABLE across restarts
            // and crashes — otherwise the phone's remembered code would break every
            // launch. Generate + persist one on first run.
            match db::settings::get(&pool, "remote_code").ok().flatten() {
                Some(code) if !code.is_empty() => *remote_shared.code.lock() = code,
                _ => {
                    let code = remote_shared.code.lock().clone();
                    let _ = db::settings::set(&pool, "remote_code", &code);
                }
            }
            // Same for the secret permanent key (code 2) — stable across restarts.
            match db::settings::get(&pool, "remote_secret_code")
                .ok()
                .flatten()
            {
                Some(secret) if !secret.is_empty() => *remote_shared.secret.lock() = secret,
                _ => {
                    let secret = remote_shared.secret.lock().clone();
                    let _ = db::settings::set(&pool, "remote_secret_code", &secret);
                }
            }

            app.manage(AppState {
                pool: pool.clone(),
                shared: shared.clone(),
                sys: sys_shared.clone(),
                remote: remote_shared.clone(),
                data_dir,
                media_dir: media_dir.clone(),
                db_path,
            });

            // If the remote server was left enabled, start it on launch.
            if db::settings::get_bool(&pool, "remote_enabled").unwrap_or(false) {
                remote_shared
                    .enabled
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                remote::start(remote::ApiState {
                    pool: pool.clone(),
                    tracking: shared.clone(),
                    media_dir: Arc::new(media_dir.clone()),
                    remote: remote_shared.clone(),
                    sys: sys_shared.clone(),
                });
                // Re-apply opt-in AnyDesk-style UAC handling if it was left on.
                if db::settings::get_bool(&pool, "remote_show_uac").unwrap_or(false) {
                    let _ = remote::uac::set_visible(true);
                }
            }

            tray::build(handle)?;

            // Keep the tray tooltip in sync with live tracking state.
            let tip_handle = handle.clone();
            handle.listen("tracking://state", move |event| {
                if let Ok(st) = serde_json::from_str::<tracking::TrackingState>(event.payload()) {
                    if let Some(tray) = tip_handle.tray_by_id(tray::TRAY_ID) {
                        let tip = tray_tooltip(&st);
                        let _ = tray.set_tooltip(Some(&tip));
                    }
                }
            });

            tracking::spawn(
                handle.clone(),
                pool.clone(),
                shared,
                sys_shared.clone(),
                media_dir,
            );

            // Shared clipboard: start the native capture listener + floating
            // overlay if the feature was left enabled (off by default). Runs in
            // the setup hook (main thread) — safe to build the window here, the
            // pump is not blocked by a command. Errors land in the diagnostics log.
            if let Err(e) = clipboard::apply_settings(handle) {
                clipboard::log(format!("startup apply_settings failed: {e}"));
            }

            // Keep the elevated logon task pointed at this install folder (survives
            // reinstalls / custom install paths without requiring a Settings toggle).
            {
                let pool_sync = pool.clone();
                std::thread::spawn(move || {
                    let enabled =
                        db::settings::get_bool(&pool_sync, "start_with_windows").unwrap_or(true);
                    let _ = autostart::sync_from_setting(enabled);
                });
            }

            // Background system monitor (CPU/GPU/RAM/disk + the sensor sidecar).
            system::spawn(pool, sys_shared, None);

            // Silently check GitHub Releases for a newer signed build and install
            // it in the background (no prompt). The app already runs elevated, so
            // the perMachine NSIS update applies without a second UAC prompt.
            spawn_update_check(handle.clone());

            // Honor --minimized (startup launch): stay in tray.
            let minimized = std::env::args().any(|a| a == "--minimized");
            if minimized {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let close_to_tray = app
                    .try_state::<AppState>()
                    .map(|s| db::settings::get_bool(&s.pool, "close_to_tray").unwrap_or(true))
                    .unwrap_or(true);
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_setting,
            commands::complete_onboarding,
            commands::list_games,
            commands::get_game,
            commands::save_game,
            commands::delete_game,
            commands::set_game_status,
            commands::set_game_cover,
            commands::fetch_cover,
            commands::fetch_game_info,
            commands::search_games_online,
            commands::check_for_updates,
            commands::install_update,
            commands::fetch_hltb,
            commands::add_from_path,
            commands::add_app_from_path,
            commands::fetch_app_info,
            commands::detect_games,
            commands::detect_apps,
            commands::import_detected,
            commands::import_detected_apps,
            commands::import_games_csv,
            commands::default_csv_path,
            commands::list_screenshots,
            commands::delete_screenshot,
            commands::list_sessions,
            commands::dashboard,
            commands::apps_overview,
            commands::heatmap,
            commands::hour_of_day,
            commands::catalog_analytics,
            commands::insights,
            commands::fetch_steam_reviews,
            commands::fetch_metacritic_reviews,
            commands::audit_online_content,
            commands::repair_library_content,
            commands::get_game_stats,
            commands::refresh_game_stats,
            commands::fetch_full_ost,
            commands::build_ost_library,
            commands::fetch_twitch_live,
            commands::launch_game,
            embed::open_embed,
            embed::set_embed_bounds,
            embed::set_embed_visible,
            embed::close_embed,
            commands::tag_analytics,
            commands::list_tags,
            commands::rename_tag,
            commands::delete_tag,
            commands::merge_tags,
            commands::suggest_games,
            commands::add_suggested_game,
            commands::set_suggested_excluded_tags,
            commands::tracking_state,
            commands::set_paused,
            commands::system_specs,
            commands::system_live,
            commands::system_history,
            commands::system_app_history,
            commands::autostart_enabled,
            commands::set_autostart,
            commands::export_sessions_csv,
            commands::export_data_json,
            commands::write_text_file,
            commands::write_text_file,
            commands::backup_db,
            commands::restore_db,
            commands::steam_session,
            commands::steam_login,
            commands::steam_logout,
            commands::steam_validate,
            commands::steam_library,
            commands::steam_import,
            commands::steam_game_achievements,
            commands::steam_achievements_overview,
            commands::steam_sync,
            commands::gog_session,
            commands::gog_login_url,
            commands::gog_login_finish,
            commands::gog_login,
            commands::gog_logout,
            commands::gog_validate,
            commands::gog_library,
            commands::gog_import,
            commands::gog_sync,
            commands::gog_game_achievements,
            commands::launcher_capabilities,
            commands::local_launcher_library,
            commands::local_launcher_import,
            commands::media_overview,
            commands::media_heatmap,
            commands::media_hour_of_day,
            commands::media_top,
            commands::media_insights,
            commands::media_timeline,
            commands::media_recent,
            commands::record_media_play,
            commands::stop_media_play,
            commands::foreground_spans,
            commands::playlists_list,
            commands::playlist_get,
            commands::playlist_create,
            commands::playlist_rename,
            commands::playlist_delete,
            commands::playlist_add_tracks,
            commands::playlist_remove_track,
            commands::playlist_reorder,
            commands::backfill_metacritic,
            commands::remote_status,
            commands::remote_set_enabled,
            commands::remote_set_show_uac,
            commands::remote_regen_pin,
            commands::remote_set_cloud,
            commands::remote_regen_code,
            commands::remote_regen_secret,
            commands::remote_list_grants,
            commands::remote_grant,
            commands::remote_revoke,
            commands::remote_check_auth,
            commands::remote_adb_devices,
            commands::remote_adb_install,
            commands::remote_grab_frame,
            commands::remote_grab_delta,
            commands::remote_start_capture,
            commands::remote_set_capture_quality,
            commands::remote_request_keyframe,
            commands::remote_set_encode_paused,
            commands::remote_set_capture_native,
            commands::remote_stop_capture,
            commands::remote_start_aux_capture,
            commands::remote_stop_aux_capture,
            commands::remote_start_audio,
            commands::remote_stop_audio,
            commands::remote_textfield_active,
            commands::remote_cursor_kind,
            commands::remote_cursor_position,
            commands::remote_capture_stats,
            commands::remote_list_monitors,
            commands::remote_read_media,
            commands::remote_inject,
            commands::remote_inject_on,
            commands::remote_gamepad_available,
            commands::clipboard_device_info,
            commands::clipboard_list,
            commands::clipboard_pinned,
            commands::clipboard_unsynced,
            commands::clipboard_mark_synced,
            commands::clipboard_add,
            commands::clipboard_delete,
            commands::clipboard_set_pinned,
            commands::clipboard_copy,
            commands::clipboard_image_b64,
            commands::clipboard_clear_all,
            commands::clipboard_configure,
            commands::clipboard_diagnostics,
            commands::clipboard_overlay_set_pos,
            commands::speech_to_text,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Tracker")
        .run(|handle, event| {
            // Flush before the process goes away (tray Quit, real window close, or
            // Windows shutdown/logoff): end open sessions and persist their focus
            // and window-activity spans so nothing is lost. Continuous 2s accrual
            // already saves most data; this closes the final open session cleanly.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(state) = handle.try_state::<AppState>() {
                    let _ = db::sessions::close_orphans(&state.pool);
                    let _ = db::media::close_orphans(&state.pool);
                    let _ = db::foreground::close_orphans(&state.pool);
                }
                // Safety net: never leave the UAC secure desktop disabled once the
                // app is gone (it's only meant to be off during a remote session).
                let _ = remote::uac::set_visible(false);
            }
        });
}

fn tray_tooltip(st: &tracking::TrackingState) -> String {
    fn fmt(secs: i64) -> String {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        if h > 0 {
            format!("{h}h {m}m")
        } else {
            format!("{m}m")
        }
    }
    if st.paused {
        return "Tracker — paused".to_string();
    }
    // Games take priority in the tooltip; fall back to app usage when nothing is playing.
    if let (Some(name), true) = (&st.game_name, st.is_playing) {
        return format!("Playing {name} · {} today", fmt(st.today_active_seconds));
    }
    if let (Some(name), true) = (&st.app_name, st.app_is_active) {
        return format!(
            "Using {name} · {} apps today",
            fmt(st.app_today_active_seconds)
        );
    }
    format!("Tracker · {} today", fmt(st.today_active_seconds))
}
