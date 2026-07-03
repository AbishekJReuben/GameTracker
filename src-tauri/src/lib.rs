mod autostart;
mod commands;
mod content_audit;
mod content_repair;
mod db;
mod detect;
mod embed;
mod error;
mod icons;
mod importer;
mod hltb;
mod suggestions;
mod metadata;
#[cfg(windows)]
mod registry;
mod remote;
mod state;
mod gog;
mod gog_auth;
mod launcher_catalog;
mod steam;
mod steam_emu;
mod steam_openid;
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

            let pool = db::init_pool(&db_path)
                .map_err(|e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
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
            match db::settings::get(&pool, "remote_secret_code").ok().flatten() {
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
                remote_shared.enabled.store(true, std::sync::atomic::Ordering::SeqCst);
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

            tracking::spawn(handle.clone(), pool.clone(), shared, sys_shared.clone(), media_dir);

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
            commands::remote_stop_capture,
            commands::remote_start_audio,
            commands::remote_stop_audio,
            commands::remote_textfield_active,
            commands::remote_capture_stats,
            commands::remote_list_monitors,
            commands::remote_read_media,
            commands::remote_inject,
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
        return format!("Using {name} · {} apps today", fmt(st.app_today_active_seconds));
    }
    format!("Tracker · {} today", fmt(st.today_active_seconds))
}
