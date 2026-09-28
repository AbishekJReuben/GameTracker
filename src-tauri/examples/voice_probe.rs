//! Runs the Voice pipeline outside the app, for end-to-end testing:
//! `cargo run --example voice_probe -- <secret> <signal-url> <data-dir> <seconds>`
fn main() {
    // The speech worker is this same exe, as in the app.
    if let Some(code) = gametracker_lib::voice::engine::maybe_run_worker() {
        std::process::exit(code);
    }
    let a: Vec<String> = std::env::args().collect();
    let secret = a.get(1).cloned().unwrap_or_else(|| "probe-secret".into());
    let url = a.get(2).cloned().unwrap_or_else(|| "ws://127.0.0.1:8091/ws".into());
    let data_dir = std::path::PathBuf::from(a.get(3).cloned().unwrap_or_default());
    let secs = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(60);
    if let Err(e) = gametracker_lib::voice::probe(&secret, &url, data_dir, secs) {
        eprintln!("[probe] failed: {e}");
        std::process::exit(1);
    }
}
