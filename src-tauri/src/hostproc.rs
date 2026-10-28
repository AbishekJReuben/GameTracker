//! Crash isolation: the remote-desktop host runs in its own process.
//!
//! Remote access must survive the main app crashing (a panic, a hung or dead
//! WebView). So the WebRTC host, screen capture, input injection and the LAN
//! server live in a second copy of this exe started with `--remote-host`, with
//! its own hidden window and its own WebView2 browser process (separate user
//! data folder), so nothing in the main window can take it down.
//!
//! The two supervise each other through named mutexes, held for each process's
//! lifetime:
//! - the main app restarts the host if it isn't running;
//! - the host restarts the main app if it disappears — unless the user quit
//!   (`quit.flag`) or an update is installing (`updating.flag`).
//!
//! Panics are written to `crash.log` in the data folder (see `install_panic_log`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

pub const HOST_ARG: &str = "--remote-host";
const MAIN_MUTEX: &str = "Local\\GameTrackerMain-v1";
const HOST_MUTEX: &str = "Local\\GameTrackerRemoteHost-v1";
/// An update older than this is treated as finished (or failed).
const UPDATE_GRACE: Duration = Duration::from_secs(5 * 60);

static QUITTING: AtomicBool = AtomicBool::new(false);

/// One line per supervision event in `hostproc.log` (kept small): spawns,
/// restarts and host startup stages, so a host that won't stay up is diagnosable.
pub fn trace(msg: &str) {
    let path = data_dir().join("hostproc.log");
    if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.old"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = writeln!(
            f,
            "{} pid {} {}",
            chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"),
            std::process::id(),
            msg
        );
    }
}

pub fn is_remote_host() -> bool {
    std::env::args().any(|a| a == HOST_ARG)
}

/// `%LOCALAPPDATA%\com.chilloutgames.gametracker` — usable before Tauri starts.
pub fn data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("com.chilloutgames.gametracker")
}

fn flag(name: &str) -> PathBuf {
    data_dir().join(name)
}

fn flag_age(name: &str) -> Option<Duration> {
    let m = std::fs::metadata(flag(name)).ok()?.modified().ok()?;
    SystemTime::now().duration_since(m).ok().or(Some(Duration::ZERO))
}

/// Every panic, from any thread of either process, appended to `crash.log` with
/// its location — release builds are stripped, so this is the only trace.
pub fn install_panic_log(role: &'static str) {
    let path = data_dir().join("crash.log");
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("unnamed").to_string();
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(non-string panic)".into());
        let loc = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let line = format!(
            "{} [{} v{}] thread '{}' panicked at {}: {}\n",
            chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"),
            role,
            env!("CARGO_PKG_VERSION"),
            name,
            loc,
            msg
        );
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")));
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
        default(info);
    }));
}

/// Run `body` on a named thread forever: if it panics, log it (via the hook) and
/// start it again after a short pause, so one bad tick can't stop tracking or
/// the system monitor for the rest of the session.
pub fn spawn_supervised<F>(name: &str, body: F)
where
    F: Fn() + Send + 'static,
{
    let name = name.to_string();
    std::thread::Builder::new()
        .name(name)
        .spawn(move || {
            let mut backoff = Duration::from_secs(2);
            loop {
                let started = Instant::now();
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(&body)) {
                    Ok(()) => return, // a clean return means "done"
                    Err(_) => {
                        if started.elapsed() > Duration::from_secs(120) {
                            backoff = Duration::from_secs(2);
                        }
                        std::thread::sleep(backoff);
                        backoff = (backoff * 2).min(Duration::from_secs(60));
                    }
                }
            }
        })
        .ok();
}

/// A WebView whose renderer crashed or stopped responding (heavy load, GPU
/// trouble) shows a black page forever unless something reloads it. Do that.
#[cfg(windows)]
pub fn reload_on_renderer_crash(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::ProcessFailedEventHandler;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = ProcessFailedEventHandler::create(Box::new(|sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            let _ = args.ProcessFailedKind(&mut kind);
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
                || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED
            {
                let _ = sender.Reload();
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_ProcessFailed(&handler, &mut token);
    });
}

#[cfg(not(windows))]
pub fn reload_on_renderer_crash(_window: &tauri::WebviewWindow) {}

// ---- named mutexes ----------------------------------------------------------

#[cfg(windows)]
mod mutex {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::{CreateMutexW, OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};

    /// Create and hold for the process lifetime. False if someone already holds it.
    pub fn claim(name: &str) -> bool {
        unsafe {
            match CreateMutexW(None, false, &HSTRING::from(name)) {
                Ok(h) => {
                    if GetLastError() == ERROR_ALREADY_EXISTS {
                        let _ = CloseHandle(h);
                        false
                    } else {
                        // Leaked on purpose: released when the process ends.
                        true
                    }
                }
                Err(_) => false,
            }
        }
    }

    pub fn exists(name: &str) -> bool {
        unsafe {
            match OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, &HSTRING::from(name)) {
                Ok(h) => {
                    let _ = CloseHandle(h);
                    true
                }
                Err(_) => false,
            }
        }
    }
}

#[cfg(not(windows))]
mod mutex {
    pub fn claim(_: &str) -> bool {
        true
    }
    pub fn exists(_: &str) -> bool {
        true
    }
}

fn spawn_exe(args: &[&str]) -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // Out of any job this process is in, so it outlives us.
        match cmd.creation_flags(CREATE_BREAKAWAY_FROM_JOB).spawn() {
            Ok(c) => {
                trace(&format!("spawned {args:?} pid {} (breakaway)", c.id()));
                return Ok(());
            }
            Err(e) => trace(&format!("breakaway spawn failed: {e}")),
        }
        let mut plain = std::process::Command::new(&exe);
        plain.args(args);
        let r = plain.spawn();
        match &r {
            Ok(c) => trace(&format!("spawned {args:?} pid {}", c.id())),
            Err(e) => trace(&format!("spawn {args:?} failed: {e}")),
        }
        return r.map(|_| ());
    }
    #[cfg(not(windows))]
    cmd.spawn().map(|_| ())
}

// ---- main app side ----------------------------------------------------------

/// Called once from the main app's setup.
pub fn main_started() {
    let _ = mutex::claim(MAIN_MUTEX);
    let _ = std::fs::remove_file(flag("quit.flag"));
    let _ = std::fs::remove_file(flag("updating.flag"));
}

/// The user chose Quit: the host stops too and won't bring the app back.
pub fn mark_quitting() {
    QUITTING.store(true, Ordering::SeqCst);
    let _ = std::fs::write(flag("quit.flag"), b"1");
}

/// An update is about to replace the exe: don't restart anything meanwhile.
pub fn mark_updating() {
    QUITTING.store(true, Ordering::SeqCst);
    let _ = std::fs::write(flag("updating.flag"), b"1");
}

/// The update didn't happen after all: supervision resumes.
pub fn clear_updating() {
    QUITTING.store(false, Ordering::SeqCst);
    let _ = std::fs::remove_file(flag("updating.flag"));
}

pub fn host_running() -> bool {
    mutex::exists(HOST_MUTEX)
}

// ---- shared remote state across the two processes ----------------------------

/// The host process follows the Remote page through the database: the switch,
/// the connection code, the permanent key and the LAN pairing PIN.
pub fn sync_remote_from_db(pool: &crate::db::DbPool, r: &crate::remote::RemoteShared) {
    use crate::db::settings;
    let on = settings::get_bool(pool, "remote_enabled").unwrap_or(false);
    r.enabled.store(on, Ordering::SeqCst);
    let cloud = settings::get_bool(pool, "remote_cloud_enabled").unwrap_or(false);
    r.cloud_enabled.store(cloud, Ordering::SeqCst);
    let get = |k: &str| settings::get(pool, k).ok().flatten().filter(|v| !v.trim().is_empty());
    if let Some(code) = get("remote_code") {
        *r.code.lock() = code;
    }
    if let Some(secret) = get("remote_secret_code") {
        *r.secret.lock() = secret;
    }
    if let Some(pin) = get("remote_pin") {
        let mut cur = r.pin.lock();
        if *cur != pin {
            *cur = pin;
            r.tokens.lock().clear();
            r.reset_pairing_attempts();
        }
    }
}

fn status_path() -> PathBuf {
    data_dir().join("remote-host.json")
}

/// Host: write the live session status for the main app's Remote page.
pub fn write_status(mut info: serde_json::Value, r: &crate::remote::RemoteShared) {
    if let Some(o) = info.as_object_mut() {
        o.insert("updatedMs".into(), chrono::Utc::now().timestamp_millis().into());
        o.insert("lanRunning".into(), r.running.load(Ordering::SeqCst).into());
        o.insert("lanClients".into(), (r.clients.load(Ordering::SeqCst) as u64).into());
    }
    let path = status_path();
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, info.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Main app: the host's last status, if it's alive and reported recently.
pub fn read_status() -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(status_path()).ok()?).ok()?;
    let at = v.get("updatedMs")?.as_i64()?;
    let fresh = chrono::Utc::now().timestamp_millis() - at < 10_000;
    (fresh && host_running()).then_some(v)
}

/// Keep a remote host process running for as long as the main app is.
pub fn supervise_host() {
    std::thread::Builder::new()
        .name("remote-host-supervisor".into())
        .spawn(|| {
            let mut backoff = Duration::from_secs(5);
            let mut last_spawn: Option<Instant> = None;
            loop {
                if QUITTING.load(Ordering::SeqCst) {
                    return;
                }
                if !mutex::exists(HOST_MUTEX) && last_spawn.map_or(true, |t| t.elapsed() >= backoff) {
                    // Decided once per respawn (not per check): a host that died
                    // within a minute of starting backs off, a long-lived one doesn't.
                    backoff = if last_spawn.is_some_and(|t| t.elapsed() < Duration::from_secs(60)) {
                        (backoff * 2).min(Duration::from_secs(120))
                    } else {
                        Duration::from_secs(5)
                    };
                    last_spawn = Some(Instant::now());
                    trace("remote host not running: starting it");
                    let _ = spawn_exe(&[HOST_ARG]);
                }
                std::thread::sleep(Duration::from_secs(3));
            }
        })
        .ok();
}

// ---- host side --------------------------------------------------------------

/// Called first in the host process. False → another host is already running.
pub fn host_started() -> bool {
    let ok = mutex::claim(HOST_MUTEX);
    trace(&format!("host starting, claimed host mutex: {ok}"));
    ok
}

/// Capture workers can wedge while the process and renderer remain alive. A
/// WebView-only restart then keeps reusing the same stuck native graphics state.
/// Exit this isolated host after a bounded lack of real frame deliveries; the
/// main app's existing mutex supervisor respawns it and phones auto-reconnect.
pub fn watch_capture() {
    if !is_remote_host() { return; }
    if let Err(error)=crate::remote::capture_health::supervise(
        || {
            let mut sample=crate::remote::capture::health_sample();
            if flag("quit.flag").exists() || flag_age("updating.flag").is_some_and(|age|age<UPDATE_GRACE) {
                sample.running=false;
            }
            sample
        },
        |sample| {
            trace(&format!("capture made no delivery for 20s; restarting isolated remote host; sample={sample:?}; stats={}",serde_json::to_string(&crate::remote::capture::capture_stats()).unwrap_or_default()));
            let released=crate::remote::input::release_for_recovery();
            trace(&format!("remote-owned input released before recovery: {released}"));
            // app.exit() depends on the UI event loop, which may itself be stuck.
            // This process owns no tracker, updater, Notes, Voice or discovery.
            std::process::exit(75);
        },
    ) {trace(&format!("could not start capture-health watchdog: {error}"));}
}

/// In the host: exit when the user quits; bring the main app back if it crashes.
pub fn watch_main(on_quit: impl Fn() + Send + 'static) {
    std::thread::Builder::new()
        .name("main-app-watchdog".into())
        .spawn(move || {
            let mut gone_since: Option<Instant> = None;
            let mut last_restart: Option<Instant> = None;
            loop {
                std::thread::sleep(Duration::from_secs(2));
                if flag("quit.flag").exists() {
                    on_quit();
                    return;
                }
                if mutex::exists(MAIN_MUTEX) {
                    if gone_since.take().is_some() {
                        trace("main app is back");
                    }
                    continue;
                }
                if flag_age("updating.flag").is_some_and(|a| a < UPDATE_GRACE) {
                    continue; // the installer will relaunch it
                }
                let since = *gone_since.get_or_insert_with(Instant::now);
                // Give a restart/self-update a moment to bring itself back.
                if since.elapsed() < Duration::from_secs(8) {
                    continue;
                }
                if last_restart.map_or(true, |t| t.elapsed() > Duration::from_secs(60)) {
                    last_restart = Some(Instant::now());
                    trace("main app gone: restarting it");
                    let _ = spawn_exe(&["--minimized"]);
                }
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervised_threads_restart_after_a_panic() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;
        let runs = Arc::new(AtomicUsize::new(0));
        let r = runs.clone();
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        spawn_supervised("test-supervised", move || {
            if r.fetch_add(1, Ordering::SeqCst) == 0 {
                panic!("first run fails");
            }
        });
        let until = Instant::now() + Duration::from_secs(10);
        while runs.load(Ordering::SeqCst) < 2 && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        std::panic::set_hook(prev);
        assert_eq!(runs.load(Ordering::SeqCst), 2, "ran again after the panic, then stopped");
    }

    #[cfg(windows)]
    #[test]
    fn a_claimed_mutex_is_visible_and_exclusive() {
        let name = format!("Local\\GameTrackerTest-{}", std::process::id());
        assert!(!mutex::exists(&name));
        assert!(mutex::claim(&name));
        assert!(mutex::exists(&name));
        assert!(!mutex::claim(&name), "second claim sees it held");
    }
}
