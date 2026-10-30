//! Writes UI-thread stalls to `ui-stalls.log`, naming what was running.
//!
//! A freeze that clears on its own leaves no trace anywhere: Windows only records a
//! hang if the app gets closed. Everything in a process shares one UI thread, so
//! this is the record of what actually blocked it. Cheap by design: two wake-ups a
//! second, and one line per stall.

use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// Below this nobody notices.
const REPORT_AT: Duration = Duration::from_millis(250);
const PROBE_EVERY: Duration = Duration::from_millis(500);
const LOG_LIMIT: u64 = 256 * 1024;

static CURRENT: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// A synchronous command is about to run on this thread.
pub fn enter(command: &str) {
    *CURRENT.lock() = Some((command.to_string(), Instant::now()));
}

pub fn leave() {
    if let Some((name, began)) = CURRENT.lock().take() {
        let took = began.elapsed();
        if took >= REPORT_AT {
            write(&format!("{} ms in command {name}", took.as_millis()));
        }
    }
}

fn write(line: &str) {
    use std::io::Write;
    let path = crate::hostproc::data_dir().join("ui-stalls.log");
    if std::fs::metadata(&path).map(|m| m.len() > LOG_LIMIT).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.old"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(
            f,
            "{} pid {} {}",
            chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"),
            std::process::id(),
            line
        );
    }
}

/// Measure the UI thread from outside: post it a closure and time how long it waits.
pub fn watch(app: AppHandle, role: &'static str) {
    let _ = std::thread::Builder::new().name("ui-stall-probe".into()).spawn(move || {
        let waiting = Arc::new(AtomicBool::new(false));
        loop {
            std::thread::sleep(PROBE_EVERY);
            if waiting.swap(true, Ordering::SeqCst) {
                continue; // the last probe hasn't run yet
            }
            let posted = Instant::now();
            let done = waiting.clone();
            let posted_ok = app.run_on_main_thread(move || {
                let waited = posted.elapsed();
                done.store(false, Ordering::SeqCst);
                if waited >= REPORT_AT {
                    let during = CURRENT.lock().as_ref().map(|(name, _)| name.clone());
                    write(&format!(
                        "{role}: UI thread stalled {} ms{}",
                        waited.as_millis(),
                        during.map(|n| format!(" (during {n})")).unwrap_or_default()
                    ));
                }
            });
            if posted_ok.is_err() {
                return;
            }
        }
    });
}
