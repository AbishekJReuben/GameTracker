//! Screen capture → JPEG for the remote screen stream.
//!
//! Two encoders share this module:
//!  - `grab_primary_jpeg` — a whole-frame JPEG (kept for simple callers).
//!  - `TileEncoder` — a stateful **delta** encoder that only re-sends the screen
//!    tiles that actually changed since the last frame (plus a periodic keyframe).
//!    This is the big bandwidth/latency win: a mostly-static desktop sends almost
//!    nothing, so real changes get through faster. The wire format is documented
//!    on `TileEncoder::encode`.
//!
//! Multi-monitor: `list_monitors` enumerates displays in a stable left-to-right
//! order; the phone picks one and it's remembered in `SELECTED_MONITOR`, read by
//! both the capture loop and the input mapper.

use base64::Engine as _;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use xcap::image::codecs::jpeg::JpegEncoder;
use xcap::image::{imageops, imageops::FilterType, DynamicImage, RgbImage};
use xcap::Monitor;

/// Decode an image file, downscale to `max_w`, and return a small JPEG data URL.
/// Used to ship cover art over the cloud data channel cheaply (tiny + fast).
pub fn thumbnail_data_url(path: &std::path::Path, max_w: u32) -> Option<String> {
    let img = xcap::image::open(path).ok()?;
    let img = if img.width() > max_w {
        img.resize(max_w, u32::MAX, FilterType::Triangle)
    } else {
        img
    };
    let rgb = img.to_rgb8();
    let mut buf = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, 80).encode_image(&rgb).ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(buf)))
}

/// Index (into `sorted_monitors`) of the display the phone is currently viewing.
static SELECTED_MONITOR: AtomicUsize = AtomicUsize::new(0);

pub fn set_selected_monitor(i: usize) {
    SELECTED_MONITOR.store(i, Ordering::SeqCst);
}
pub fn selected_monitor() -> usize {
    SELECTED_MONITOR.load(Ordering::SeqCst)
}

/// A display, as reported to the phone's monitor switcher.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

/// All monitors in a **stable order** (left-to-right, then top-to-bottom) so an
/// index means the same display across calls, capture, and input mapping.
fn sorted_monitors() -> Vec<Monitor> {
    let mut mons = Monitor::all().unwrap_or_default();
    mons.sort_by_key(|m| (m.x().unwrap_or(0), m.y().unwrap_or(0)));
    mons
}

fn primary_monitor() -> Option<Monitor> {
    let mons = sorted_monitors();
    mons.iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .cloned()
        .or_else(|| mons.into_iter().next())
}

fn monitor_at(index: usize) -> Option<Monitor> {
    let mons = sorted_monitors();
    mons.get(index).cloned().or_else(|| primary_monitor())
}

/// Public list for the phone's monitor picker.
pub fn list_monitors() -> Vec<MonitorInfo> {
    sorted_monitors()
        .into_iter()
        .enumerate()
        .map(|(index, m)| MonitorInfo {
            index,
            name: m.name().unwrap_or_else(|_| format!("Display {}", index + 1)),
            width: m.width().unwrap_or(0),
            height: m.height().unwrap_or(0),
            is_primary: m.is_primary().unwrap_or(false),
        })
        .collect()
}

/// Virtual-desktop bounds `(x, y, w, h)` of a monitor, for mapping normalized
/// touch coordinates to real cursor positions across a multi-monitor layout.
pub fn monitor_bounds(index: usize) -> Option<(i32, i32, u32, u32)> {
    let m = monitor_at(index)?;
    Some((m.x().ok()?, m.y().ok()?, m.width().ok()?, m.height().ok()?))
}

/// Grab the primary monitor, optionally downscale to `max_w`, and JPEG-encode it.
pub fn grab_primary_jpeg(max_w: u32, quality: u8) -> Option<Vec<u8>> {
    let mon = primary_monitor()?;
    let rgba = mon.capture_image().ok()?;
    let mut dynimg = DynamicImage::ImageRgba8(rgba);
    if dynimg.width() > max_w {
        dynimg = dynimg.resize(max_w, u32::MAX, FilterType::Triangle);
    }
    let rgb = dynimg.to_rgb8();
    let mut buf = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, quality)
        .encode_image(&rgb)
        .ok()?;
    Some(buf)
}

/// Pixel size of the primary monitor.
pub fn primary_size() -> Option<(u32, u32)> {
    let mon = primary_monitor()?;
    Some((mon.width().ok()?, mon.height().ok()?))
}

const TILE: u32 = 256; // tile edge in pixels
const KEY_INTERVAL: u32 = 120; // force a full keyframe at least this often (loss recovery)

/// Stateful delta encoder. Keep one per stream (per LAN socket, or the shared
/// static for the cloud command); it remembers the previous frame to diff against.
pub struct TileEncoder {
    prev: Option<RgbImage>,
    frames_since_key: u32,
    last_monitor: usize,
}

impl Default for TileEncoder {
    fn default() -> Self {
        Self::new()
    }
}

impl TileEncoder {
    pub fn new() -> Self {
        Self { prev: None, frames_since_key: 0, last_monitor: usize::MAX }
    }

    /// Capture the selected monitor and return a serialized frame, or `None` when
    /// nothing changed (caller should simply not send anything).
    ///
    /// Wire format (little-endian):
    /// ```text
    /// "GT"        2 bytes magic
    /// version     u8  (=1)
    /// flags       u8  (bit0 = keyframe)
    /// frame_w     u16
    /// frame_h     u16
    /// tile_size   u16
    /// tile_count  u16
    /// then tile_count times:
    ///   x u16, y u16, w u16, h u16, jpeg_len u32, jpeg bytes
    /// ```
    pub fn encode(&mut self, monitor: usize, max_w: u32, quality: u8, force_key: bool) -> Option<Vec<u8>> {
        let mon = monitor_at(monitor)?;
        let rgba = mon.capture_image().ok()?;
        let mut dynimg = DynamicImage::ImageRgba8(rgba);
        if dynimg.width() > max_w {
            dynimg = dynimg.resize(max_w, u32::MAX, FilterType::Triangle);
        }
        let cur = dynimg.to_rgb8();
        let (w, h) = (cur.width(), cur.height());

        let prev_ok = matches!(&self.prev, Some(p) if p.width() == w && p.height() == h);
        let keyframe = force_key || !prev_ok || monitor != self.last_monitor || self.frames_since_key >= KEY_INTERVAL;

        let cols = w.div_ceil(TILE);
        let rows = h.div_ceil(TILE);
        let mut changed: Vec<(u32, u32, u32, u32)> = Vec::new();
        for ty in 0..rows {
            for tx in 0..cols {
                let x0 = tx * TILE;
                let y0 = ty * TILE;
                let tw = TILE.min(w - x0);
                let th = TILE.min(h - y0);
                let differs = keyframe || tile_differs(self.prev.as_ref().unwrap(), &cur, x0, y0, tw, th);
                if differs {
                    changed.push((x0, y0, tw, th));
                }
            }
        }

        if changed.is_empty() {
            // Nothing to send, but keep prev current and count toward the next keyframe.
            self.prev = Some(cur);
            self.last_monitor = monitor;
            self.frames_since_key = self.frames_since_key.saturating_add(1);
            return None;
        }

        let mut out = Vec::with_capacity(8192);
        out.extend_from_slice(b"GT");
        out.push(1);
        out.push(if keyframe { 1 } else { 0 });
        out.extend_from_slice(&(w as u16).to_le_bytes());
        out.extend_from_slice(&(h as u16).to_le_bytes());
        out.extend_from_slice(&(TILE as u16).to_le_bytes());
        out.extend_from_slice(&(changed.len() as u16).to_le_bytes());
        for (x0, y0, tw, th) in &changed {
            let sub = imageops::crop_imm(&cur, *x0, *y0, *tw, *th).to_image();
            let mut jpg = Vec::new();
            if JpegEncoder::new_with_quality(&mut jpg, quality).encode_image(&sub).is_err() {
                continue;
            }
            out.extend_from_slice(&(*x0 as u16).to_le_bytes());
            out.extend_from_slice(&(*y0 as u16).to_le_bytes());
            out.extend_from_slice(&(*tw as u16).to_le_bytes());
            out.extend_from_slice(&(*th as u16).to_le_bytes());
            out.extend_from_slice(&(jpg.len() as u32).to_le_bytes());
            out.extend_from_slice(&jpg);
        }

        self.prev = Some(cur);
        self.last_monitor = monitor;
        self.frames_since_key = if keyframe { 0 } else { self.frames_since_key.saturating_add(1) };
        Some(out)
    }
}

// ---------------------------------------------------------------------------
// Streaming capture driver (WebRTC video-track path)
//
// The cloud screen stream no longer polls one frame per IPC round-trip. Instead a
// dedicated OS thread captures the selected monitor continuously and pushes a
// full-frame JPEG to the webview over a binary Tauri channel; the host webview
// decodes it, draws it to a canvas, and feeds `canvas.captureStream()` into a real
// WebRTC video track (hardware H.264/VP9, inter-frame compression, adaptive
// bitrate). Full frames are fine here because the video codec handles temporal
// compression — we only skip *identical* frames to save CPU/bandwidth while the
// screen is static, with a ~1s keep-alive so a freshly attached decoder always
// paints. The thread is resilient: a capture error never kills it, so a display
// mode change / secure desktop / fullscreen swap can't leave a stale frame.
// ---------------------------------------------------------------------------

static CAP_MAXW: AtomicU32 = AtomicU32::new(1600);
static CAP_FPS: AtomicU32 = AtomicU32::new(30);
static CAP_QUALITY: AtomicU32 = AtomicU32::new(70);
static CAP_RUNNING: AtomicBool = AtomicBool::new(false);
/// Bumped on every (re)start so a stale thread from a prior session exits.
static CAP_GEN: AtomicU32 = AtomicU32::new(0);

/// Live-tune the running capture stream (resolution / fps / JPEG quality).
pub fn set_capture_quality(max_w: u32, fps: u32, quality: u32) {
    CAP_MAXW.store(max_w.clamp(320, 3840), Ordering::Relaxed);
    CAP_FPS.store(fps.clamp(1, 60), Ordering::Relaxed);
    CAP_QUALITY.store(quality.clamp(20, 95), Ordering::Relaxed);
}

/// Stop the capture thread (if any).
pub fn stop_capture() {
    CAP_RUNNING.store(false, Ordering::SeqCst);
    CAP_GEN.fetch_add(1, Ordering::SeqCst);
}

/// Capture the selected monitor and downscale to `max_w`, returning an RGB image.
/// `filter` trades speed for smoothness — `Nearest` is dramatically faster on a
/// big downscale (only samples output pixels), which is the main fps lever on
/// high-res / 4K monitors, so lower-quality presets use it.
fn capture_rgb(monitor: usize, max_w: u32, filter: FilterType) -> Option<RgbImage> {
    let mon = monitor_at(monitor)?;
    let rgba = mon.capture_image().ok()?;
    let mut dynimg = DynamicImage::ImageRgba8(rgba);
    if dynimg.width() > max_w {
        dynimg = dynimg.resize(max_w, u32::MAX, filter);
    }
    Some(dynimg.to_rgb8())
}

fn encode_rgb(img: &RgbImage, quality: u8) -> Option<Vec<u8>> {
    let mut buf = Vec::with_capacity(128 * 1024);
    JpegEncoder::new_with_quality(&mut buf, quality)
        .encode_image(img)
        .ok()?;
    Some(buf)
}

/// Start the streaming capture loop. `emit` is called with a full-frame JPEG for
/// every changed frame plus a periodic keep-alive; it runs until `stop_capture`.
/// Any existing loop is superseded (generation bump), so it's safe to call again.
pub fn start_capture<F>(max_w: u32, fps: u32, quality: u32, emit: F)
where
    F: Fn(Vec<u8>) + Send + 'static,
{
    set_capture_quality(max_w, fps, quality);
    let my_gen = CAP_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    CAP_RUNNING.store(true, Ordering::SeqCst);

    std::thread::spawn(move || {
        let mut prev: Option<Vec<u8>> = None; // previous raw RGB bytes, for change-detect
        let mut last_emit = Instant::now() - Duration::from_secs(2);
        while CAP_RUNNING.load(Ordering::SeqCst) && CAP_GEN.load(Ordering::SeqCst) == my_gen {
            let frame_start = Instant::now();
            let max_w = CAP_MAXW.load(Ordering::Relaxed);
            let quality = CAP_QUALITY.load(Ordering::Relaxed) as u8;
            let fps = CAP_FPS.load(Ordering::Relaxed).max(1);
            // Fast nearest-neighbour downscale below the "sharp" threshold — the big
            // fps win on high-res monitors; H.264 + the phone screen hide the aliasing.
            let filter = if quality >= 65 { FilterType::Triangle } else { FilterType::Nearest };

            match capture_rgb(selected_monitor(), max_w, filter) {
                Some(cur) => {
                    let raw = cur.as_raw();
                    let changed = prev.as_deref().map_or(true, |p| p != raw.as_slice());
                    // Keep-alive re-emit so a late/reconnecting decoder always paints.
                    let stale = last_emit.elapsed() >= Duration::from_millis(1000);
                    if changed || stale {
                        if let Some(jpg) = encode_rgb(&cur, quality) {
                            emit(jpg);
                            last_emit = Instant::now();
                        }
                        if changed {
                            prev = Some(raw.clone());
                        }
                    }
                }
                None => {
                    // Capture transiently unavailable (mode change / secure desktop).
                    // Don't die — back off briefly and retry; force a fresh frame next.
                    prev = None;
                    std::thread::sleep(Duration::from_millis(120));
                    continue;
                }
            }

            let target = Duration::from_millis(1000 / fps as u64);
            let elapsed = frame_start.elapsed();
            if elapsed < target {
                std::thread::sleep(target - elapsed);
            }
        }
    });
}

/// True if any pixel in the tile region changed between `prev` and `cur`
/// (both are the same dimensions — guaranteed by the caller).
fn tile_differs(prev: &RgbImage, cur: &RgbImage, x0: u32, y0: u32, tw: u32, th: u32) -> bool {
    let stride = (cur.width() * 3) as usize;
    let pb = prev.as_raw();
    let cb = cur.as_raw();
    let row_bytes = (tw * 3) as usize;
    for row in y0..y0 + th {
        let start = row as usize * stride + x0 as usize * 3;
        if pb[start..start + row_bytes] != cb[start..start + row_bytes] {
            return true;
        }
    }
    false
}
