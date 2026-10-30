//! Tells pages that notes changed, in this process and in the other one.
//!
//! A burst of changes (a relay catch-up, a paste of many images) must not turn into
//! a burst of refreshes, so `clipboard://changed` is coalesced to one event per
//! `QUIET`. Across processes this is two named events, one per direction. They only
//! make things faster: the database carries the actual change, and a page that
//! misses a signal catches up on its next revision check.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const QUIET: Duration = Duration::from_millis(40);

/// Which end of the notes link this process is.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Main,
    Shell,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static SIDE: OnceLock<Side> = OnceLock::new();
static CHANGED: AtomicBool = AtomicBool::new(false);
static OUTBOX: AtomicBool = AtomicBool::new(false);

/// Called once per process, before any note can change.
pub fn start(app: AppHandle, side: Side) {
    if APP.set(app).is_err() {
        return;
    }
    let _ = SIDE.set(side);
    #[cfg(windows)]
    peer::listen(side);
    let _ = std::thread::Builder::new().name("notes-bus".into()).spawn(|| loop {
        std::thread::park_timeout(Duration::from_secs(3600));
        std::thread::sleep(QUIET);
        flush();
    }).map(|t| {
        let _ = WORKER.set(t.thread().clone());
    });
}

static WORKER: OnceLock<std::thread::Thread> = OnceLock::new();

fn wake() {
    if let Some(w) = WORKER.get() {
        w.unpark();
    }
}

fn flush() {
    let Some(app) = APP.get() else { return };
    if CHANGED.swap(false, Ordering::SeqCst) {
        let _ = app.emit("clipboard://changed", ());
    }
    if OUTBOX.swap(false, Ordering::SeqCst) {
        let _ = app.emit("clipboard://outbox", ());
    }
}

/// A note changed here: refresh this process's pages and the other process's.
pub fn changed() {
    CHANGED.store(true, Ordering::SeqCst);
    wake();
    #[cfg(windows)]
    if let Some(side) = SIDE.get() {
        peer::pulse(*side);
    }
}

/// Something is waiting to go to the relay. Only the main app talks to the relay,
/// so from the shell this reaches it through the same signal as a change.
pub fn outbox() {
    if SIDE.get() == Some(&Side::Main) {
        OUTBOX.store(true, Ordering::SeqCst);
        wake();
    }
    #[cfg(windows)]
    if let Some(side) = SIDE.get() {
        peer::pulse(*side);
    }
}

/// The other process changed something.
#[cfg(windows)]
fn from_peer() {
    CHANGED.store(true, Ordering::SeqCst);
    OUTBOX.store(true, Ordering::SeqCst);
    wake();
}

#[cfg(windows)]
mod peer {
    use super::Side;
    use std::sync::OnceLock;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject, INFINITE};

    const TO_MAIN: PCWSTR = w!("Local\\GameTrackerNotesToMain-v1");
    const TO_SHELL: PCWSTR = w!("Local\\GameTrackerNotesToShell-v1");

    #[derive(Clone, Copy)]
    struct Event(HANDLE);
    unsafe impl Send for Event {}
    unsafe impl Sync for Event {}

    static OTHER: OnceLock<Option<Event>> = OnceLock::new();

    fn event(name: PCWSTR) -> Option<Event> {
        // Auto-reset, so one wake per burst of signals. Both ends may create it first.
        unsafe { CreateEventW(None, false, false, name) }.ok().map(Event)
    }

    fn names(side: Side) -> (PCWSTR, PCWSTR) {
        match side {
            Side::Main => (TO_MAIN, TO_SHELL),
            Side::Shell => (TO_SHELL, TO_MAIN),
        }
    }

    pub fn listen(side: Side) {
        let (mine, theirs) = names(side);
        let _ = OTHER.set(event(theirs));
        let Some(mine) = event(mine) else { return };
        let _ = std::thread::Builder::new().name("notes-peer".into()).spawn(move || {
            let mine = mine;
            loop {
                if unsafe { WaitForSingleObject(mine.0, INFINITE) }.0 != 0 {
                    return;
                }
                super::from_peer();
            }
        });
    }

    pub fn pulse(_side: Side) {
        if let Some(Some(other)) = OTHER.get() {
            let _ = unsafe { SetEvent(other.0) };
        }
    }
}
