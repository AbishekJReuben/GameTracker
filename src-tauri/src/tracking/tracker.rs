use crate::db::{games, screenshots, sessions, settings, DbPool};
use crate::db::games::MatchGame;
use crate::tracking::{activity, foreground, idle, matcher, screenshot};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};

const TICK_SECS: u64 = 2;
const MERGE_WINDOW_SECS: i64 = 120;
const RELOAD_EVERY: u32 = 8; // reload registered games roughly every 16s
const DEFAULT_SHOT_INTERVAL_MIN: i64 = 30;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingState {
    pub paused: bool,
    pub is_idle: bool,
    // Game side — drives Now Playing on the dashboard, the sidebar, and the tray.
    pub is_playing: bool,
    pub kind: Option<String>,
    pub game_id: Option<String>,
    pub game_name: Option<String>,
    pub icon_path: Option<String>,
    pub cover_path: Option<String>,
    pub accent_color: Option<String>,
    pub session_runtime_seconds: i64,
    pub session_active_seconds: i64,
    pub today_runtime_seconds: i64,
    pub today_active_seconds: i64,
    /// Number of GAMES with a live session this tick (never counts apps).
    pub active_count: i64,
    // App side — kept fully separate so apps and games are never conflated.
    pub app_is_active: bool,
    pub app_id: Option<String>,
    pub app_name: Option<String>,
    pub app_icon_path: Option<String>,
    pub app_cover_path: Option<String>,
    pub app_accent_color: Option<String>,
    pub app_session_active_seconds: i64,
    pub app_session_runtime_seconds: i64,
    pub app_today_active_seconds: i64,
    pub app_today_runtime_seconds: i64,
    /// Number of APPS with a live session this tick.
    pub app_active_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEvent {
    kind: String,
    game_name: String,
    icon_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotEvent {
    game_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BreakEvent {
    minutes: i64,
}

/// Shared snapshot the UI/tray can read synchronously.
pub struct TrackingShared {
    pub state: Mutex<TrackingState>,
}

impl TrackingShared {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(TrackingState::default()),
        }
    }
}

/// Whether an entry should have an open session this tick.
pub fn should_have_session(g: &MatchGame, is_running: bool, is_focused: bool) -> bool {
    if g.kind == "game" {
        is_running
    } else if g.count_background {
        is_running
    } else {
        is_focused
    }
}

/// Runtime seconds to accrue this tick.
pub fn runtime_delta(g: &MatchGame, is_running: bool, is_focused: bool, tick: i64) -> i64 {
    if g.kind == "game" {
        if is_running { tick } else { 0 }
    } else if g.count_background {
        if is_running { tick } else { 0 }
    } else if is_focused {
        tick
    } else {
        0
    }
}

pub fn spawn(app: AppHandle, pool: DbPool, shared: Arc<TrackingShared>, media_dir: PathBuf) {
    std::thread::Builder::new()
        .name("gametracker-tracker".into())
        .spawn(move || run_loop(app, pool, shared, media_dir))
        .ok();
}

fn run_loop(app: AppHandle, pool: DbPool, shared: Arc<TrackingShared>, media_dir: PathBuf) {
    let _ = sessions::close_orphans(&pool);

    let mut sys = System::new();
    let mut games_cache = games::match_candidates(&pool).unwrap_or_default();
    let mut active: HashMap<String, String> = HashMap::new();
    let mut tick: u32 = 0;
    let notify = settings::get_bool(&pool, "notify_sessions").unwrap_or(true);

    // UI Automation client for reading browser URLs (COM-init on this thread).
    let automation = activity::Automation::new();
    // Per-game wall-clock timer for the periodic in-game screenshot.
    let mut last_shot: HashMap<String, Instant> = HashMap::new();
    // Per-session de-dupe key (title|url) so we only write activity on change.
    let mut last_activity_key: HashMap<String, String> = HashMap::new();
    // Seconds of uninterrupted active game play, for the break reminder.
    let mut break_accum: i64 = 0;

    loop {
        tick = tick.wrapping_add(1);
        if tick % RELOAD_EVERY == 0 {
            games_cache = games::match_candidates(&pool).unwrap_or_default();
        }

        let paused = settings::get_bool(&pool, "tracking_paused").unwrap_or(false);

        if paused {
            for (_gid, sid) in active.drain() {
                let _ = sessions::end(&pool, &sid, false);
            }
            publish(
                &app,
                &shared,
                TrackingState {
                    paused: true,
                    ..Default::default()
                },
            );
            std::thread::sleep(Duration::from_secs(TICK_SECS));
            continue;
        }

        let idle_threshold =
            (settings::get_i64(&pool, "idle_minutes", 5).unwrap_or(5)).max(0) as u64 * 60;
        let is_idle = idle_threshold > 0 && idle::idle_seconds() >= idle_threshold;

        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::everything(),
        );

        let cache_by_id: HashMap<String, MatchGame> = games_cache
            .iter()
            .map(|g| (g.id.clone(), g.clone()))
            .collect();

        let mut running: HashMap<String, RunGame> = HashMap::new();
        for proc_ in sys.processes().values() {
            if let Some(exe) = proc_.exe() {
                let path = exe.to_string_lossy();
                if let Some(g) = matcher::match_path(&games_cache, &path) {
                    running.entry(g.id.clone()).or_insert_with(|| RunGame {
                        name: g.display_name.clone(),
                        icon: g.icon_path.clone(),
                        cover: g.cover_path.clone(),
                        accent: g.accent_color.clone(),
                        kind: g.kind.clone(),
                    });
                }
            }
        }

        let fg_window = foreground::foreground_window();
        let fg_hwnd = fg_window.map(|(_, h)| h);
        let fg_exe = fg_window.and_then(|(pid, _)| {
            sys.process(Pid::from_u32(pid))
                .and_then(|p| p.exe())
                .map(|e| e.to_string_lossy().to_string())
        });
        let fg_game_id = fg_exe
            .as_deref()
            .and_then(|path| matcher::match_path(&games_cache, path).map(|g| g.id.clone()));

        let mut session_targets: HashSet<String> = HashSet::new();
        for gid in running.keys() {
            if let Some(g) = cache_by_id.get(gid) {
                if should_have_session(g, true, fg_game_id.as_deref() == Some(gid.as_str())) {
                    session_targets.insert(gid.clone());
                }
            }
        }
        if let Some(ref fg) = fg_game_id {
            if let Some(g) = cache_by_id.get(fg) {
                if should_have_session(g, running.contains_key(fg), true) {
                    session_targets.insert(fg.clone());
                }
            }
        }

        let ended: Vec<String> = active
            .keys()
            .filter(|id| !session_targets.contains(*id))
            .cloned()
            .collect();
        for gid in ended {
            if let Some(sid) = active.remove(&gid) {
                let _ = sessions::end(&pool, &sid, is_idle);
                if notify {
                    let name = running
                        .get(&gid)
                        .map(|r| r.name.as_str())
                        .or_else(|| cache_by_id.get(&gid).map(|g| g.display_name.as_str()))
                        .unwrap_or("Unknown");
                    let icon = running
                        .get(&gid)
                        .and_then(|r| r.icon.clone())
                        .or_else(|| cache_by_id.get(&gid).and_then(|g| g.icon_path.clone()));
                    emit_session(&app, "end", name, &icon);
                }
            }
        }

        for gid in &session_targets {
            let rg = running.get(gid).cloned().or_else(|| {
                cache_by_id.get(gid).map(|g| RunGame {
                    name: g.display_name.clone(),
                    icon: g.icon_path.clone(),
                    cover: g.cover_path.clone(),
                    accent: g.accent_color.clone(),
                    kind: g.kind.clone(),
                })
            });
            let Some(rg) = rg else { continue };
            let is_fg = fg_game_id.as_deref() == Some(gid.as_str());
            let is_running = running.contains_key(gid);

            let sid = match active.get(gid) {
                Some(s) => s.clone(),
                None => match sessions::start_or_resume(&pool, gid, MERGE_WINDOW_SECS) {
                    Ok(s) => {
                        active.insert(gid.clone(), s.clone());
                        if notify {
                            emit_session(&app, "start", &rg.name, &rg.icon);
                        }
                        s
                    }
                    Err(_) => continue,
                },
            };

            let g = cache_by_id.get(gid);
            let add_runtime = g
                .map(|g| runtime_delta(g, is_running, is_fg, TICK_SECS as i64))
                .unwrap_or(0);
            let add_active = if is_fg && !is_idle { TICK_SECS as i64 } else { 0 };
            let focused = is_fg && !is_idle;
            let _ = sessions::accrue(&pool, &sid, add_runtime, add_active);
            let _ = sessions::record_focus_tick(&pool, &sid, focused);
        }

        // --- Foreground activity (window title + browser URL) for the focused
        // session — surfaced on the timeline so you can see what you were doing. ---
        if let (Some(fg), Some(hwnd)) = (fg_game_id.as_ref(), fg_hwnd) {
            if let Some(sid) = active.get(fg) {
                let title = foreground::window_title(hwnd);
                let is_browser = fg_exe
                    .as_deref()
                    .map(|p| activity::is_browser(&activity::exe_file_name(p)))
                    .unwrap_or(false);
                let url = if is_browser { automation.browser_url(hwnd) } else { None };
                if title.is_some() || url.is_some() {
                    let key = format!(
                        "{}|{}",
                        title.as_deref().unwrap_or(""),
                        url.as_deref().unwrap_or("")
                    );
                    if last_activity_key.get(sid).map(String::as_str) != Some(key.as_str()) {
                        let _ = sessions::record_activity(
                            &pool,
                            sid,
                            title.as_deref(),
                            url.as_deref(),
                        );
                        last_activity_key.insert(sid.clone(), key);
                    }
                }
            }
        }

        // --- Periodic in-game screenshot for the focused game ---
        if !is_idle && settings::get_bool(&pool, "auto_screenshots_enabled").unwrap_or(true) {
            if let Some(fg) = fg_game_id.as_ref() {
                let is_game = cache_by_id.get(fg).map(|g| g.kind == "game").unwrap_or(false);
                if is_game && session_targets.contains(fg) {
                    let interval = settings::get_i64(
                        &pool,
                        "screenshot_interval_minutes",
                        DEFAULT_SHOT_INTERVAL_MIN,
                    )
                    .unwrap_or(DEFAULT_SHOT_INTERVAL_MIN)
                    .max(1) as u64
                        * 60;
                    let due = last_shot
                        .get(fg)
                        .map(|t| t.elapsed().as_secs() >= interval)
                        .unwrap_or(true);
                    if due {
                        let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
                        let dest = media_dir
                            .join("screenshots")
                            .join(fg)
                            .join(format!("{stamp}.jpg"));
                        // Mark the attempt regardless of success so a failed capture
                        // (e.g. fullscreen-exclusive DirectX) doesn't retry every tick.
                        last_shot.insert(fg.clone(), Instant::now());
                        if screenshot::capture_primary_jpeg(&dest) {
                            let sid = active.get(fg).cloned();
                            let path = dest.to_string_lossy().to_string();
                            let _ = screenshots::insert(&pool, fg, sid.as_deref(), &path);
                            let _ = app.emit(
                                "screenshot://captured",
                                ScreenshotEvent { game_id: fg.clone() },
                            );
                        }
                    }
                }
            }
        }

        // --- Break reminder: nudge after N minutes of uninterrupted active game play ---
        let break_min = settings::get_i64(&pool, "break_reminder_minutes", 0)
            .unwrap_or(0)
            .max(0);
        let focused_game_active = !is_idle
            && fg_game_id.as_ref().is_some_and(|fg| {
                session_targets.contains(fg)
                    && cache_by_id.get(fg).map(|g| g.kind == "game").unwrap_or(false)
            });
        if break_min > 0 && focused_game_active {
            break_accum += TICK_SECS as i64;
            if break_accum >= break_min * 60 {
                let _ = app.emit("reminder://break", BreakEvent { minutes: break_min });
                break_accum = 0;
            }
        } else {
            break_accum = 0;
        }

        // Partition the live sessions by kind so games and apps never mix in the UI.
        let is_kind = |gid: &str, kind: &str| {
            cache_by_id
                .get(gid)
                .map(|g| g.kind == kind)
                .unwrap_or(false)
        };
        let game_targets: Vec<String> = session_targets
            .iter()
            .filter(|id| is_kind(id, "game"))
            .cloned()
            .collect();
        let app_targets: Vec<String> = session_targets
            .iter()
            .filter(|id| is_kind(id, "app"))
            .cloned()
            .collect();

        // Primary of each kind: prefer the foreground entry, else the first running one.
        let pick_primary = |targets: &[String]| -> Option<String> {
            fg_game_id
                .clone()
                .filter(|id| targets.contains(id))
                .or_else(|| targets.first().cloned())
        };
        let primary_game = pick_primary(&game_targets);
        let primary_app = pick_primary(&app_targets);

        let lookup = |gid: &String| -> Option<RunGame> {
            running.get(gid).cloned().or_else(|| {
                cache_by_id.get(gid).map(|g| RunGame {
                    name: g.display_name.clone(),
                    icon: g.icon_path.clone(),
                    cover: g.cover_path.clone(),
                    accent: g.accent_color.clone(),
                    kind: g.kind.clone(),
                })
            })
        };

        let (today_rt, today_act) = sessions::today_totals_kind(&pool, "game").unwrap_or((0, 0));
        let (app_today_rt, app_today_act) =
            sessions::today_totals_kind(&pool, "app").unwrap_or((0, 0));
        let mut state = TrackingState {
            is_playing: !game_targets.is_empty(),
            paused: false,
            is_idle,
            today_runtime_seconds: today_rt,
            today_active_seconds: today_act,
            active_count: game_targets.len() as i64,
            app_is_active: !app_targets.is_empty(),
            app_today_active_seconds: app_today_act,
            app_today_runtime_seconds: app_today_rt,
            app_active_count: app_targets.len() as i64,
            ..Default::default()
        };
        if let Some(gid) = primary_game {
            if let (Some(rg), Some(sid)) = (lookup(&gid), active.get(&gid)) {
                let (rt, act) = sessions::open_counters(&pool, sid).unwrap_or((0, 0));
                state.kind = Some(rg.kind.clone());
                state.game_id = Some(gid.clone());
                state.game_name = Some(rg.name.clone());
                state.icon_path = rg.icon.clone();
                state.cover_path = rg.cover.clone();
                state.accent_color = rg.accent.clone();
                state.session_runtime_seconds = rt;
                state.session_active_seconds = act;
            }
        }
        if let Some(aid) = primary_app {
            if let (Some(rg), Some(sid)) = (lookup(&aid), active.get(&aid)) {
                let (rt, act) = sessions::open_counters(&pool, sid).unwrap_or((0, 0));
                state.app_id = Some(aid.clone());
                state.app_name = Some(rg.name.clone());
                state.app_icon_path = rg.icon.clone();
                state.app_cover_path = rg.cover.clone();
                state.app_accent_color = rg.accent.clone();
                state.app_session_active_seconds = act;
                state.app_session_runtime_seconds = rt;
            }
        }
        publish(&app, &shared, state);

        std::thread::sleep(Duration::from_secs(TICK_SECS));
    }
}

#[derive(Clone)]
struct RunGame {
    name: String,
    icon: Option<String>,
    cover: Option<String>,
    accent: Option<String>,
    kind: String,
}

fn publish(app: &AppHandle, shared: &Arc<TrackingShared>, state: TrackingState) {
    *shared.state.lock() = state.clone();
    let _ = app.emit("tracking://state", &state);
}

fn emit_session(app: &AppHandle, kind: &str, name: &str, icon: &Option<String>) {
    let _ = app.emit(
        "session://event",
        SessionEvent {
            kind: kind.to_string(),
            game_name: name.to_string(),
            icon_path: icon.clone(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game() -> MatchGame {
        MatchGame {
            id: "g1".into(),
            display_name: "Game".into(),
            kind: "game".into(),
            count_background: true,
            exe_paths: vec![],
            install_folder: None,
            icon_path: None,
            cover_path: None,
            accent_color: None,
        }
    }

    fn focus_app() -> MatchGame {
        MatchGame {
            id: "a1".into(),
            display_name: "App".into(),
            kind: "app".into(),
            count_background: false,
            exe_paths: vec![],
            install_folder: None,
            icon_path: None,
            cover_path: None,
            accent_color: None,
        }
    }

    fn bg_app() -> MatchGame {
        MatchGame {
            count_background: true,
            ..focus_app()
        }
    }

    #[test]
    fn game_session_when_running() {
        let g = game();
        assert!(should_have_session(&g, true, false));
        assert!(!should_have_session(&g, false, true));
    }

    #[test]
    fn focus_app_session_only_when_focused() {
        let a = focus_app();
        assert!(should_have_session(&a, true, true));
        assert!(!should_have_session(&a, true, false));
    }

    #[test]
    fn runtime_game_accrues_while_running() {
        let g = game();
        assert_eq!(runtime_delta(&g, true, false, 2), 2);
        assert_eq!(runtime_delta(&g, false, true, 2), 0);
    }

    #[test]
    fn runtime_focus_app_only_when_focused() {
        let a = focus_app();
        assert_eq!(runtime_delta(&a, true, true, 2), 2);
        assert_eq!(runtime_delta(&a, true, false, 2), 0);
    }

    #[test]
    fn runtime_bg_app_while_running() {
        let a = bg_app();
        assert_eq!(runtime_delta(&a, true, false, 2), 2);
    }
}
