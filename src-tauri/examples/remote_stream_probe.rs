//! Read-only shipping capture pipeline probe. No input, app session, windows,
//! services, database, or screenshot export. Captured pixels remain in memory.
#[path = "../src/remote/capture.rs"]
mod capture;
#[path = "../src/remote/capture_broker.rs"]
mod capture_broker;
#[path = "../src/remote/capture_health.rs"]
mod capture_health;
#[path = "../src/remote/capture_surface.rs"]
mod capture_surface;
#[path = "../src/remote/delivery.rs"]
mod delivery;
#[path = "../src/remote/display.rs"]
mod display;
#[path = "../src/remote/dxdupe.rs"]
mod dxdupe;
#[path = "../src/remote/gpu.rs"]
mod gpu;
#[path = "../src/remote/gpu_transfer.rs"]
mod gpu_transfer;
#[path = "../src/remote/gpusched.rs"]
mod gpusched;
#[path = "../src/remote/native.rs"]
mod native;
#[path = "../src/remote/nvenc/mod.rs"]
mod nvenc;
#[path = "../src/remote/system_cursor.rs"]
mod system_cursor;
#[path = "../src/remote/view.rs"]
mod view;
#[path = "../src/remote/view_session.rs"]
mod view_session;
mod presence {
    pub fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }
    pub fn apply_view(_: &str, _: super::view::AppliedView) -> bool {
        true
    }
}
mod input {
    pub fn release_session(_: &str) {}
}
#[cfg(windows)]
fn main() {
    if std::env::args().any(|a| a == "--recover-stalled-child") {
        let exe = std::env::current_exe().unwrap();
        let status = std::process::Command::new(&exe)
            .arg("--stalled-child")
            .status()
            .unwrap();
        assert_eq!(
            status.code(),
            Some(75),
            "stalled child must exit through the shipping native watchdog"
        );
        let fresh = std::process::Command::new(exe).status().unwrap();
        assert!(fresh.success(), "a fresh process must deliver again");
        println!("isolated stalled worker exited and a fresh capture child delivered again");
        return;
    }
    let stalled = std::env::args().any(|a| a == "--stalled-child");
    #[cfg(feature = "capture-probes")]
    if stalled {
        capture::probe_stall(true);
    }
    if stalled {
        capture_health::supervise(capture::health_sample, |sample| {
            eprintln!("native watchdog recovered stalled capture: {sample:?}");
            std::process::exit(75);
        })
        .unwrap();
    }
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };
    let snapshot = display::snapshot();
    let selected = snapshot.displays.iter().find(|d| d.is_primary).unwrap();
    let view = view::AppliedView::create(
        &snapshot,
        view::ViewMode::Single,
        &selected.id,
        1,
        2160,
        4096,
        8_294_400,
    )
    .unwrap();
    view_session::authorize("isolated-probe", "primary", view, true);
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    capture::start_capture(2160, 30, 72, move |packet| {
        if packet.starts_with(b"GE") {
            observed.fetch_add(1, Ordering::Relaxed);
        }
    });
    let start = Instant::now();
    let mut restarted = Instant::now();
    while start.elapsed() < Duration::from_secs(if stalled { 30 } else { 4 }) {
        std::thread::sleep(Duration::from_millis(500));
        if stalled && restarted.elapsed() >= Duration::from_secs(5) {
            // Repeated soft restarts reset producedFrames but cannot make this
            // injected native stall produce. The backstop must still expire.
            capture::start_capture(2160, 30, 72, |_| {});
            restarted = Instant::now();
            eprintln!(
                "soft capture restart: produced={} emitted={}",
                capture::capture_stats().produced_frames,
                capture::health_sample().emitted
            );
        }
        if !stalled {
            eprintln!(
                "{}",
                serde_json::to_string(&capture::capture_stats()).unwrap()
            );
        }
    }
    capture::stop_capture();
    println!(
        "{}",
        serde_json::json!({"frames":count.load(Ordering::Relaxed),"scope":"isolated shipping JPEG capture with epoch metadata; no pixel export or app connection"})
    );
    if count.load(Ordering::Relaxed) == 0 {
        std::process::exit(2);
    }
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows required");
}
