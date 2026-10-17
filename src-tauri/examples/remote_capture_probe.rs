//! Isolated, read-only capture/encode probe. Never starts the app, signaling,
//! input controller, updater, or DB. Do not mistake this for a client latency test.
#[cfg(windows)]
#[path = "../src/remote/dxdupe.rs"]
mod dxdupe;
#[cfg(windows)]
#[path = "../src/remote/gpusched.rs"]
mod gpusched;
#[cfg(windows)]
#[path = "../src/remote/gpu.rs"]
mod gpu;
#[cfg(windows)]
#[path = "../src/remote/nvenc/mod.rs"]
mod nvenc;
#[cfg(windows)]
#[path = "../src/remote/native.rs"]
mod native;
#[path = "../src/remote/display.rs"]
mod display;

#[cfg(windows)]
fn main() {
    use std::time::{Duration, Instant};
    if std::env::args().any(|a|a == "--topology-only") {
        let before = display::snapshot();
        std::thread::sleep(Duration::from_secs(6));
        let after = display::snapshot();
        println!("{}",serde_json::json!({"kind":"topology","before":before,"after":after,"unchangedRevision":before.revision == after.revision}));
        return;
    }
    let mut monitors = xcap::Monitor::all().expect("enumerate monitors");
    monitors.sort_by_key(|m| (m.x().unwrap_or(0), m.y().unwrap_or(0)));
    let listing: Vec<_> = monitors.iter().enumerate().map(|(index,m)| serde_json::json!({
        "index": index, "name": m.name().ok(), "x": m.x().ok(), "y":m.y().ok(),
        "width":m.width().ok(),"height":m.height().ok(),"primary":m.is_primary().ok()
    })).collect();
    println!("{}", serde_json::json!({"kind":"displays","displays":listing}));
    let m = monitors.iter().find(|m| m.is_primary().unwrap_or(false)).or(monitors.first()).expect("display");
    let Some(mut capture) = dxdupe::Duplicator::new_for(m.x().unwrap(), m.y().unwrap()) else {
        println!("{}",serde_json::json!({"kind":"unavailable","reason":"DXGI duplication could not open. Existing capture ownership, desktop or driver may prevent this isolated probe."}));
        std::process::exit(2);
    };
    let w = 1920;
    let h = ((m.height().unwrap() as u64 * w as u64 / m.width().unwrap() as u64) as u32) & !1;
    let mut compositor = gpu::Compositor::new(capture.device(), capture.context(), w, h).expect("compositor");
    let mut encoder = native::NativeEncoder::new(Some(capture.device()), w, h, 30, 12_000_000, Default::default());
    let mut samples = Vec::new();
    let start = Instant::now();
    let mut changed = 0;
    let mut timeouts = 0;
    let mut bytes = 0;
    while start.elapsed() < Duration::from_secs(8) {
        let frame_start = Instant::now();
        let cap = match capture.grab_gpu(1, m.width().unwrap() >= w * 2) {
            dxdupe::Grab::Frame { .. } => { changed += 1; true },
            dxdupe::Grab::Timeout => { timeouts += 1; false },
            dxdupe::Grab::Lost => { eprintln!("capture lost"); break; }
        };
        let capture_ms = frame_start.elapsed().as_secs_f64() * 1000.;
        // Reuse the last texture to measure encode work separately from how many
        // changed pictures the desktop actually generates. No forced application motion.
        if let Some(srv) = capture.frame_srv() {
            let comp_start = Instant::now();
            let (nw, nh) = capture.native_size();
            let mips = capture.mips_current();
            let seq = capture.cursor_seq();
            compositor.render(&srv,nw,nh,mips,capture.cursor_image_cached().map(|c|(c,seq)));
            let comp_ms = comp_start.elapsed().as_secs_f64()*1000.;
            let enc_start = Instant::now();
            if let Some(enc) = encoder.as_mut() {
                if let Some(frame) = enc.encode_texture(compositor.output(), samples.is_empty(),start.elapsed().as_micros() as u64) { bytes += frame.len(); }
            }
            samples.push(serde_json::json!({"captureMs":capture_ms,"compositionSubmitMs":comp_ms,"encodeMs":enc_start.elapsed().as_secs_f64()*1000.,"changed":cap}));
        }
        std::thread::sleep(Duration::from_millis(33).saturating_sub(frame_start.elapsed()));
    }
    println!("{}",serde_json::json!({"kind":"capture-baseline","profile":"dev","sourceWidth":m.width().ok(),"sourceHeight":m.height().ok(),"outputWidth":w,"outputHeight":h,"durationMs":start.elapsed().as_millis(),"changedFrames":changed,"timeouts":timeouts,"nativeEncoder":encoder.is_some(),"bytes":bytes,"samples":samples,"limits":"Read-only isolated GPU capture/composition/encode; composition is submission time, not GPU completion. No displayed fps, input, network, reconnect or physical device claim."}));
}

#[cfg(not(windows))]
fn main() { eprintln!("This probe requires Windows."); }
