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
use fast_image_resize::images::{Image as FirImage, ImageRef};
use fast_image_resize::{FilterType as FirFilter, PixelType, ResizeAlg, ResizeOptions, Resizer};
use jpeg_encoder::{ColorType as JpegColor, Encoder as JpegEnc, SamplingFactor};
use parking_lot::{Condvar, Mutex as PlMutex};
use rayon::prelude::*;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use xcap::image::codecs::jpeg::JpegEncoder;
use xcap::image::{imageops, imageops::FilterType, RgbImage};
use xcap::Monitor;

// ---------------------------------------------------------------------------
// Fast pixel helpers shared by every stream path.
//
// The old path used the `image` crate's `resize(Triangle)` + `JpegEncoder`, both
// compiled for size — together ~150 ms/frame on a high-res monitor, which is why
// the remote stream topped out at ~6 fps. These replace them with SIMD downscale
// (`fast_image_resize`) and SIMD (AVX2) JPEG (`jpeg-encoder`), an order-of-magnitude
// faster, so the WebRTC video track is fed at its real target rate.
// ---------------------------------------------------------------------------

/// Drop the alpha from a tightly-packed 4-byte-per-pixel buffer, yielding RGB.
/// `swap_rb` converts BGRA (Desktop Duplication) → RGB; RGBA (xcap) passes false.
fn u8x4_to_rgb(px4: &[u8], w: u32, h: u32, swap_rb: bool) -> Vec<u8> {
    let n = (w as usize) * (h as usize);
    let mut out = Vec::with_capacity(n * 3);
    if swap_rb {
        for px in px4.chunks_exact(4) {
            out.push(px[2]);
            out.push(px[1]);
            out.push(px[0]);
        }
    } else {
        for px in px4.chunks_exact(4) {
            out.extend_from_slice(&px[0..3]);
        }
    }
    out
}

/// Downscale a captured RGBA/BGRA frame to `max_w` (keeping aspect) and return
/// packed RGB bytes + the output dimensions. `fast` picks nearest-neighbour (the
/// big fps lever on a 4K downscale) over bilinear; H.264 + the phone screen hide
/// the aliasing at the lower-quality presets. `swap_rb` handles BGRA sources.
fn scale_u8x4_to_rgb(px4: &[u8], sw: u32, sh: u32, max_w: u32, fast: bool, swap_rb: bool) -> Option<(Vec<u8>, u32, u32)> {
    if sw == 0 || sh == 0 {
        return None;
    }
    if sw <= max_w {
        return Some((u8x4_to_rgb(px4, sw, sh, swap_rb), sw, sh));
    }
    let dw = max_w;
    let dh = (((sh as u64) * (dw as u64)) / (sw as u64)).max(1) as u32;
    // Borrow the source (so the caller's buffer — e.g. the duplicator's reusable
    // readback — isn't consumed); the resize is spread across cores via rayon.
    let src = ImageRef::new(sw, sh, px4, PixelType::U8x4).ok()?;
    let mut dst = FirImage::new(dw, dh, PixelType::U8x4);
    let alg = if fast {
        ResizeAlg::Nearest
    } else {
        ResizeAlg::Convolution(FirFilter::Bilinear)
    };
    let opts = ResizeOptions::new().resize_alg(alg);
    Resizer::new().resize(&src, &mut dst, &opts).ok()?;
    Some((u8x4_to_rgb(dst.buffer(), dw, dh, swap_rb), dw, dh))
}

/// Downscale a captured 4-byte-per-pixel frame to `max_w` (keeping aspect) and
/// return it still packed as U8x4 — **no color conversion**. The video-track paths
/// feed BGRA/RGBA straight to the JPEG encoder (it drops alpha during its own
/// per-MCU color transform), so the old separate full-frame BGRA→RGB pass — a
/// scalar read+write of every pixel plus a fresh allocation per frame — is gone.
fn scale_u8x4(px4: &[u8], sw: u32, sh: u32, max_w: u32, fast: bool) -> Option<(Vec<u8>, u32, u32)> {
    if sw == 0 || sh == 0 {
        return None;
    }
    if sw <= max_w {
        return Some((px4.to_vec(), sw, sh));
    }
    let dw = max_w;
    let dh = (((sh as u64) * (dw as u64)) / (sw as u64)).max(1) as u32;
    let src = ImageRef::new(sw, sh, px4, PixelType::U8x4).ok()?;
    let mut dst = FirImage::new(dw, dh, PixelType::U8x4);
    let alg = if fast {
        ResizeAlg::Nearest
    } else {
        ResizeAlg::Convolution(FirFilter::Bilinear)
    };
    let opts = ResizeOptions::new().resize_alg(alg);
    Resizer::new().resize(&src, &mut dst, &opts).ok()?;
    Some((dst.into_vec(), dw, dh))
}

/// Bytes per pixel for the source layouts we feed the JPEG encoder.
fn bpp_of(color: JpegColor) -> usize {
    match color {
        JpegColor::Rgb | JpegColor::Bgr | JpegColor::Ycbcr => 3,
        _ => 4,
    }
}

/// Encode packed pixels to a JPEG via the SIMD encoder. `subsample_420` trades a
/// little chroma sharpness for speed + size (fine for the video-track path, whose
/// H.264 stage is 4:2:0 anyway); tile/LAN paths pass `false` for crisp text.
/// `color` names the source layout (Rgb / Bgra / Rgba — alpha is ignored).
fn encode_jpeg_px(px: &[u8], w: u32, h: u32, quality: u8, subsample_420: bool, color: JpegColor) -> Option<Vec<u8>> {
    let mut buf = Vec::with_capacity(64 * 1024);
    let mut enc = JpegEnc::new(&mut buf, quality);
    enc.set_sampling_factor(if subsample_420 {
        SamplingFactor::R_4_2_0
    } else {
        SamplingFactor::R_4_4_4
    });
    enc.encode(px, w as u16, h as u16, color).ok()?;
    Some(buf)
}

/// RGB convenience wrapper (LAN tile path + one-shot grabs).
fn encode_jpeg_rgb(rgb: &[u8], w: u32, h: u32, quality: u8, subsample_420: bool) -> Option<Vec<u8>> {
    encode_jpeg_px(rgb, w, h, quality, subsample_420, JpegColor::Rgb)
}

/// Encode a full RGB frame for the WebRTC video-track feed. At high resolutions a
/// single-threaded JPEG encode becomes the bottleneck (and leaves cores idle), so
/// large frames are split into horizontal **strips encoded in parallel** (rayon)
/// and packed into a "GS" container the host webview composites onto its canvas.
/// Strip heights are 16-aligned (the 4:2:0 MCU height) so seams fall on block
/// boundaries. Small frames just return a plain single JPEG (magic `FF D8`).
fn encode_frame(px: &[u8], w: u32, h: u32, quality: u8, color: JpegColor) -> Option<Vec<u8>> {
    // Text mode keeps full 4:4:4 chroma so glyph edges survive the JPEG → H.264
    // hand-off; auto/video use 4:2:0 (smaller + faster, and H.264 is 4:2:0 anyway).
    let sub420 = CAP_CONTENT.load(Ordering::Relaxed) != CONTENT_TEXT;
    let area = w as u64 * h as u64;
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    // Only parallelize when it pays off: enough pixels and >1 core.
    let strips = if area >= 1_300_000 && cores > 1 {
        (cores.min(6) as u32).min(h / 16).max(1)
    } else {
        1
    };
    if strips <= 1 {
        return encode_jpeg_px(px, w, h, quality, sub420, color);
    }

    // Split H into `strips` bands, each a multiple of 16 rows (last takes the rest).
    let stride = w as usize * bpp_of(color);
    let band = ((h / strips) / 16).max(1) * 16;
    let mut bands: Vec<(u32, u32)> = Vec::new();
    let mut y = 0u32;
    for _ in 0..strips {
        if y >= h {
            break;
        }
        let bh = band.min(h - y);
        bands.push((y, bh));
        y += bh;
    }
    if y < h {
        // Give the remainder to the last band.
        let last = bands.last_mut().unwrap();
        last.1 = h - last.0;
    }

    let parts: Vec<Option<(u32, u32, Vec<u8>)>> = bands
        .par_iter()
        .map(|&(y0, bh)| {
            let start = y0 as usize * stride;
            let end = start + bh as usize * stride;
            encode_jpeg_px(&px[start..end], w, bh, quality, sub420, color).map(|j| (y0, bh, j))
        })
        .collect();

    let mut out = Vec::with_capacity(64 * 1024);
    out.extend_from_slice(b"GS");
    out.push(1);
    out.extend_from_slice(&(w as u16).to_le_bytes());
    out.extend_from_slice(&(h as u16).to_le_bytes());
    out.push(bands.len() as u8);
    for p in parts {
        let (y0, bh, jpg) = p?;
        out.extend_from_slice(&(y0 as u16).to_le_bytes());
        out.extend_from_slice(&(bh as u16).to_le_bytes());
        out.extend_from_slice(&(jpg.len() as u32).to_le_bytes());
        out.extend_from_slice(&jpg);
    }
    Some(out)
}

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

/// Register the calling thread with MMCSS ("Capture" class) so a running game
/// can't starve the screen pipeline — the same treatment the WASAPI loopback
/// thread gets ("Pro Audio" in audio.rs). Under full game load the capture and
/// encoder threads otherwise compete at normal priority with the game's worker
/// pool and the produced fps sags exactly when remote play needs it most.
/// Best-effort: streaming works without it.
fn boost_capture_thread() {
    #[cfg(windows)]
    unsafe {
        use windows::core::w;
        use windows::Win32::System::Threading::AvSetMmThreadCharacteristicsW;
        let mut task_index = 0u32;
        let _ = AvSetMmThreadCharacteristicsW(w!("Capture"), &mut task_index);
    }
}

/// RAII guard that raises the Windows timer resolution to 1ms for the life of a
/// capture loop. `thread::sleep` (and most OS waits) quantize to the system timer
/// period — default ~15.6ms — so the fps-pacing sleeps between frames overshot by
/// up to a full tick and a 25ms budget (40 fps) really ran at ~30 fps. Matched
/// timeBeginPeriod/timeEndPeriod calls, so resolution is only boosted while a
/// stream is actually running.
struct TimerBoost;
impl TimerBoost {
    fn new() -> Self {
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::Media::timeBeginPeriod(1);
        }
        TimerBoost
    }
}
impl Drop for TimerBoost {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::Media::timeEndPeriod(1);
        }
    }
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
    /// True for the display the host is CURRENTLY capturing. `SELECTED_MONITOR` is a
    /// process-global that persists across phone connections, so the phone can't
    /// assume index 0 — it must read this to show the right screen number on connect
    /// (otherwise the label is wrong until the user switches displays once).
    pub selected: bool,
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
    let sel = selected_monitor();
    sorted_monitors()
        .into_iter()
        .enumerate()
        .map(|(index, m)| MonitorInfo {
            index,
            name: m.name().unwrap_or_else(|_| format!("Display {}", index + 1)),
            width: m.width().unwrap_or(0),
            height: m.height().unwrap_or(0),
            is_primary: m.is_primary().unwrap_or(false),
            selected: index == sel,
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
    let (sw, sh) = (rgba.width(), rgba.height());
    let raw = rgba.into_raw();
    let (rgb, w, h) = scale_u8x4_to_rgb(&raw, sw, sh, max_w, false, false)?;
    encode_jpeg_rgb(&rgb, w, h, quality, false)
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
        let (sw, sh) = (rgba.width(), rgba.height());
        // SIMD downscale to packed RGB (bilinear keeps tiles crisp for the sharp
        // LAN path), then wrap as an RgbImage for the tile diff/crop below.
        let raw = rgba.into_raw();
        let (rgb, w, h) = scale_u8x4_to_rgb(&raw, sw, sh, max_w, false, false)?;
        let cur = RgbImage::from_raw(w, h, rgb)?;

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
            let Some(jpg) = encode_jpeg_rgb(sub.as_raw(), *tw, *th, quality, false) else {
                continue;
            };
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
/// Content-optimization mode driving downscale filter + JPEG chroma subsampling.
/// 0 = auto (quality-driven), 1 = text (sharp + 4:4:4), 2 = video (fast + 4:2:0).
static CAP_CONTENT: AtomicU32 = AtomicU32::new(0);
pub const CONTENT_AUTO: u32 = 0;
pub const CONTENT_TEXT: u32 = 1;
pub const CONTENT_VIDEO: u32 = 2;
static CAP_RUNNING: AtomicBool = AtomicBool::new(false);
/// Bumped on every (re)start so a stale thread from a prior session exits.
static CAP_GEN: AtomicU32 = AtomicU32::new(0);

// Live per-frame telemetry (micros / bytes / dims), so the phone can show exactly
// where the pipeline is spending time and whether the host or the network is the
// bottleneck. Written by the capture/encode threads, read by `capture_stats`.
static ST_CAP_US: AtomicU32 = AtomicU32::new(0);
static ST_SCALE_US: AtomicU32 = AtomicU32::new(0);
static ST_ENC_US: AtomicU32 = AtomicU32::new(0);
static ST_BYTES: AtomicU32 = AtomicU32::new(0);
static ST_NAT_W: AtomicU32 = AtomicU32::new(0);
static ST_NAT_H: AtomicU32 = AtomicU32::new(0);
static ST_OUT_W: AtomicU32 = AtomicU32::new(0);
static ST_OUT_H: AtomicU32 = AtomicU32::new(0);
/// Monotonic count of frames actually encoded+emitted; the phone diffs it over
/// time to derive the true produced fps (independent of the target fps).
static ST_PRODUCED: AtomicU32 = AtomicU32::new(0);

/// True while the stream is being encoded natively (NVENC H.264) rather than as JPEG.
/// Surfaced to the HUD so "why is this slow" is answerable at a glance.
static ST_NATIVE: AtomicBool = AtomicBool::new(false);

/// True while frames go GPU→GPU (duplication texture → composite → NVENC) with no
/// readback at all. Implies `ST_NATIVE`.
static ST_ZEROCOPY: AtomicBool = AtomicBool::new(false);

/// Set while the capture thread owns a live zero-copy NVENC session.
///
/// **This is a correctness interlock, not telemetry.** Exactly one NVENC session may
/// ever feed the stream: two sessions produce two independent reference chains, and
/// interleaving them on one channel makes the guest decode P-frames against the wrong
/// references — static areas survive (skip macroblocks) while everything that moves
/// turns to garbage. That was the "sometimes great, sometimes choppy with patches that
/// never refresh" bug. The encoder thread's upload-path encoder must stand down while
/// this is set.
static ST_ZC_LIVE: AtomicBool = AtomicBool::new(false);

/// The stream size for a given native resolution and width cap: never upscale, keep
/// the aspect, and round to even (NVENC requires even dimensions). Mirrors what
/// `scale_u8x4` lands on for the CPU path so both routes stream the same shape.
#[cfg(windows)]
fn native_out_size(native_w: u32, native_h: u32, max_w: u32) -> (u32, u32) {
    let w = max_w.min(native_w).max(32);
    let h = ((native_h as u64 * w as u64) / native_w.max(1) as u64).max(32) as u32;
    (w & !1, h & !1)
}

/// Set by [`request_keyframe`] when the guest asks for an IDR (`vkf`/`vreset`, a fresh
/// decoder, a resolution change). Consumed by the encoder thread on the next frame.
static NATIVE_FORCE_KEY: AtomicBool = AtomicBool::new(false);

/// Backpressure gate for the native H.264 path: while set, captures are NOT fed
/// to NVENC (keyframe requests still are). The host JS sets this when the video
/// data channel backs up, instead of dropping already-encoded frames — a dropped
/// encoded P-frame is a reference the NEXT frames were encoded against, so every
/// post-encode drop corrupts the picture until a recovery IDR (this was the
/// visible artifacting that "cleared every ~4s"). Skipping BEFORE the encoder
/// keeps the reference chain intact: the same frames go unsent either way, but
/// what IS sent always decodes clean. Same design as libwebrtc's pre-encoder
/// FrameDropper. Cleared on [`set_capture_native`] transitions.
static NATIVE_ENCODE_PAUSED: AtomicBool = AtomicBool::new(false);
/// Captures skipped pre-encode while paused (diagnostics; surfaced in stats).
static ST_PAUSE_SKIPS: AtomicU32 = AtomicU32::new(0);

/// Host JS backpressure signal — see [`NATIVE_ENCODE_PAUSED`].
pub fn set_encode_paused(paused: bool) {
    NATIVE_ENCODE_PAUSED.store(paused, Ordering::Relaxed);
}

/// Ask the native encoder for a self-contained keyframe on the next frame.
///
/// The native path runs an effectively infinite GOP (keyframes cost bandwidth and the
/// data channel is reliable), so a guest whose decoder just started has nothing to
/// decode until one of these lands.
pub fn request_keyframe() {
    NATIVE_FORCE_KEY.store(true, Ordering::Relaxed);
}

/// Bitrate the native encoder should target for this shape. Mirrors `bitrateFor()` in
/// `rtcHost.ts`; an explicit override from the phone's Tune panel wins.
#[cfg(windows)]
fn native_bitrate_bps(w: u32, h: u32, fps: u32, quality: u32) -> u32 {
    let override_kbps = CAP_BITRATE_KBPS.load(Ordering::Relaxed);
    if override_kbps > 0 {
        return (override_kbps.saturating_mul(1000)).clamp(500_000, 40_000_000);
    }
    super::native::auto_bitrate_bps(w, h, fps, quality)
}

/// Explicit bitrate ceiling in kbps from the phone's Tune panel (0 = derive from
/// resolution/fps/quality).
static CAP_BITRATE_KBPS: AtomicU32 = AtomicU32::new(0);

/// Live-set the native encoder's bitrate (kbps; 0 = auto).
pub fn set_capture_bitrate(kbps: u32) {
    CAP_BITRATE_KBPS.store(kbps.min(40_000), Ordering::Relaxed);
}

/// Whether the consumer can accept native H.264 frames.
///
/// **Off by default and it must stay that way.** Only the DIRECT (WebCodecs-over-data-
/// channel) guest can take pre-encoded H.264; the WebRTC track path needs real *pixels*
/// to composite onto its canvas, and would show a black screen if we handed it a
/// bitstream. The host flips this on when the guest opts into DIRECT and off on every
/// fallback to RTC.
static CAP_NATIVE_OK: AtomicBool = AtomicBool::new(false);

/// Allow/forbid the native H.264 path (host calls this as the guest enters/leaves
/// DIRECT). Enabling also forces a keyframe so the guest's fresh decoder has a start
/// point instead of waiting out the infinite GOP.
pub fn set_capture_native(on: bool) {
    CAP_NATIVE_OK.store(on, Ordering::Relaxed);
    // A stale pause from a torn-down session must never stall the next one.
    NATIVE_ENCODE_PAUSED.store(false, Ordering::Relaxed);
    if on {
        request_keyframe();
    } else {
        // Drop the zero-copy claim so a later re-enable (or the JPEG fallback)
        // isn't blocked by a stale interlock from the previous DIRECT session.
        ST_ZC_LIVE.store(false, Ordering::Relaxed);
    }
}

/// A snapshot of the host capture pipeline, surfaced to the companion's debug HUD.
#[derive(Serialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStats {
    pub capture_ms: f32,
    pub scale_ms: f32,
    pub encode_ms: f32,
    pub frame_bytes: u32,
    pub native_w: u32,
    pub native_h: u32,
    pub out_w: u32,
    pub out_h: u32,
    pub produced_frames: u32,
    pub max_w: u32,
    pub fps: u32,
    pub quality: u32,
    pub content: u32,
    pub running: bool,
    /// True when frames are leaving as NVENC H.264 rather than JPEG. When true,
    /// `encode_ms` is real NVENC time and `frame_bytes` is the H.264 frame.
    pub native: bool,
    /// True when the frame never touches system RAM (duplication texture → GPU
    /// composite → NVENC). Implies `native`; `capture_ms` then excludes the readback
    /// and `scale_ms` is 0 because the composite does the scaling.
    pub zero_copy: bool,
    /// Captures skipped BEFORE the encoder because the video channel was backed
    /// up (reference-safe backpressure). Non-zero here with a healthy link means
    /// the phone's radio is stalling in bursts, not that bandwidth is short.
    pub pause_skips: u32,
}

/// Read the latest host-side capture telemetry.
pub fn capture_stats() -> CaptureStats {
    CaptureStats {
        capture_ms: ST_CAP_US.load(Ordering::Relaxed) as f32 / 1000.0,
        scale_ms: ST_SCALE_US.load(Ordering::Relaxed) as f32 / 1000.0,
        encode_ms: ST_ENC_US.load(Ordering::Relaxed) as f32 / 1000.0,
        frame_bytes: ST_BYTES.load(Ordering::Relaxed),
        native_w: ST_NAT_W.load(Ordering::Relaxed),
        native_h: ST_NAT_H.load(Ordering::Relaxed),
        out_w: ST_OUT_W.load(Ordering::Relaxed),
        out_h: ST_OUT_H.load(Ordering::Relaxed),
        produced_frames: ST_PRODUCED.load(Ordering::Relaxed),
        max_w: CAP_MAXW.load(Ordering::Relaxed),
        fps: CAP_FPS.load(Ordering::Relaxed),
        quality: CAP_QUALITY.load(Ordering::Relaxed),
        content: CAP_CONTENT.load(Ordering::Relaxed),
        running: CAP_RUNNING.load(Ordering::Relaxed),
        native: ST_NATIVE.load(Ordering::Relaxed),
        zero_copy: ST_ZEROCOPY.load(Ordering::Relaxed),
        pause_skips: ST_PAUSE_SKIPS.load(Ordering::Relaxed),
    }
}

/// Live-tune the running capture stream (resolution / fps / JPEG quality).
pub fn set_capture_quality(max_w: u32, fps: u32, quality: u32) {
    CAP_MAXW.store(max_w.clamp(320, 3840), Ordering::Relaxed);
    CAP_FPS.store(fps.clamp(1, 120), Ordering::Relaxed);
    CAP_QUALITY.store(quality.clamp(20, 95), Ordering::Relaxed);
}

/// Set the content-optimization mode (0 auto / 1 text / 2 video). Affects the
/// downscale filter (sharp vs fast) and JPEG chroma subsampling live.
pub fn set_capture_content(mode: u32) {
    CAP_CONTENT.store(mode.clamp(CONTENT_AUTO, CONTENT_VIDEO), Ordering::Relaxed);
}

/// Stop the capture threads (if any).
pub fn stop_capture() {
    CAP_RUNNING.store(false, Ordering::SeqCst);
    CAP_GEN.fetch_add(1, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// Aux (pop-out) capture — one lightweight pipeline per monitor index so a second
// browser tab can stream display 2 while the primary path keeps display 1.
//
// Each aux pipeline uses its OWN persistent DXGI Desktop Duplication session,
// targeting its monitor by desktop origin (same path the primary uses). Desktop
// Duplication supports one session PER OUTPUT within a process — different
// outputs never collide, and the OS limit is 4 concurrent duplication apps — so
// the primary + several pop-outs coexist fine. This replaced an xcap
// full-framebuffer grab that returned a stale/black or wrong-display image on
// secondary monitors, which is why a pop-out tab connected but its visuals never
// updated. xcap stays as a fallback for when duplication init fails on that
// display (an exclusive-fullscreen game, a driver quirk).
// ---------------------------------------------------------------------------

struct AuxSlot {
    gen: AtomicU32,
    running: AtomicBool,
}

static AUX: once_cell::sync::Lazy<parking_lot::Mutex<std::collections::HashMap<usize, Arc<AuxSlot>>>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(std::collections::HashMap::new()));

fn aux_slot(monitor: usize) -> Arc<AuxSlot> {
    let mut map = AUX.lock();
    map.entry(monitor)
        .or_insert_with(|| {
            Arc::new(AuxSlot {
                gen: AtomicU32::new(0),
                running: AtomicBool::new(false),
            })
        })
        .clone()
}

/// Stop one aux monitor pipeline, or every aux pipeline when `monitor` is `None`.
pub fn stop_aux_capture(monitor: Option<usize>) {
    let map = AUX.lock();
    if let Some(m) = monitor {
        if let Some(s) = map.get(&m) {
            s.running.store(false, Ordering::SeqCst);
            s.gen.fetch_add(1, Ordering::SeqCst);
        }
    } else {
        for s in map.values() {
            s.running.store(false, Ordering::SeqCst);
            s.gen.fetch_add(1, Ordering::SeqCst);
        }
    }
}

/// Stream JPEG frames of a **fixed** monitor for a multi-monitor pop-out tab.
pub fn start_aux_capture<F>(monitor: usize, max_w: u32, fps: u32, quality: u32, emit: F)
where
    F: Fn(Vec<u8>) + Send + 'static,
{
    let slot = aux_slot(monitor);
    let my_gen = slot.gen.fetch_add(1, Ordering::SeqCst) + 1;
    slot.running.store(true, Ordering::SeqCst);
    let max_w = max_w.clamp(320, 3840);
    let fps = fps.clamp(1, 60);
    let quality = quality.clamp(20, 95) as u8;

    let fast = quality < 65; // sharp downscale for text, fast for video-ish content

    std::thread::spawn(move || {
        boost_capture_thread();
        let _timer = TimerBoost::new(); // 1ms sleep precision for fps pacing
        let budget_ms = (1000 / fps).clamp(1, 1000);
        let budget = Duration::from_millis(budget_ms as u64);
        // Persistent duplication session for THIS monitor (recreated if lost).
        #[cfg(windows)]
        let mut dup: Option<super::dxdupe::Duplicator> = None;
        let mut last: Option<Arc<Vec<u8>>> = None;
        let mut last_wh = (0u32, 0u32);
        let mut last_color = JpegColor::Bgra;
        let mut last_emit = Instant::now() - Duration::from_secs(2);
        // Encoded copy of the last emitted static frame, for cheap keep-alives.
        let mut cached_jpg: Option<Vec<u8>> = None;

        while slot.running.load(Ordering::SeqCst) && slot.gen.load(Ordering::SeqCst) == my_gen {
            let t0 = Instant::now();
            // (px4, out_w, out_h, color, from_dd). Pixels stay 4-byte (BGRA from
            // Desktop Duplication, RGBA from xcap) all the way to the JPEG encoder —
            // no separate RGB conversion pass. `from_dd` = always a genuine change.
            let mut scaled: Option<(Vec<u8>, u32, u32, JpegColor, bool)> = None;
            let mut timed_out = false;

            #[cfg(windows)]
            {
                if dup.is_none() {
                    let (tx, ty) = monitor_bounds(monitor).map(|(x, y, _, _)| (x, y)).unwrap_or((0, 0));
                    dup = super::dxdupe::Duplicator::new_for(tx, ty);
                }
                if let Some(d) = dup.as_mut() {
                    match d.grab(budget_ms, max_w) {
                        super::dxdupe::Grab::Frame { w: gw, h: gh, .. } => {
                            if let Some((mut px, ow, oh)) = scale_u8x4(d.buffer(), gw, gh, max_w, fast) {
                                // Real system cursor into the frame (remote users need it).
                                d.draw_cursor(&mut px, ow, oh);
                                scaled = Some((px, ow, oh, JpegColor::Bgra, true));
                            }
                        }
                        super::dxdupe::Grab::Timeout => timed_out = true,
                        super::dxdupe::Grab::Lost => dup = None,
                    }
                } else if let Some(rgba) = monitor_at(monitor).and_then(|m| m.capture_image().ok()) {
                    let (sw, sh) = (rgba.width(), rgba.height());
                    let raw = rgba.into_raw();
                    if let Some((px, ow, oh)) = scale_u8x4(&raw, sw, sh, max_w, fast) {
                        scaled = Some((px, ow, oh, JpegColor::Rgba, false));
                    }
                }
            }
            #[cfg(not(windows))]
            {
                if let Some(rgba) = monitor_at(monitor).and_then(|m| m.capture_image().ok()) {
                    let (sw, sh) = (rgba.width(), rgba.height());
                    let raw = rgba.into_raw();
                    if let Some((px, ow, oh)) = scale_u8x4(&raw, sw, sh, max_w, fast) {
                        scaled = Some((px, ow, oh, JpegColor::Rgba, false));
                    }
                }
            }

            if let Some((px, w, h, color, from_dd)) = scaled {
                let changed = from_dd
                    || last
                        .as_ref()
                        .map_or(true, |prev| last_wh != (w, h) || prev.as_slice() != px.as_slice());
                let stale = last_emit.elapsed() >= Duration::from_millis(900);
                if changed {
                    if let Some(jpg) = encode_frame(&px, w, h, quality, color) {
                        emit(jpg);
                        last_emit = Instant::now();
                        cached_jpg = None; // frame content moved on — drop the stale cache
                    }
                } else if stale {
                    // Keep-alive on a static screen: re-send the SAME pixels. Reuse the
                    // cached encode (encode once, then clone ~1/s) instead of burning a
                    // full JPEG encode per keep-alive.
                    if cached_jpg.is_none() {
                        cached_jpg = encode_frame(&px, w, h, quality, color);
                    }
                    if let Some(jpg) = cached_jpg.clone() {
                        emit(jpg);
                        last_emit = Instant::now();
                    }
                }
                last = Some(Arc::new(px));
                last_wh = (w, h);
                last_color = color;
            } else if let Some(prev) = last.as_ref() {
                // Static screen: re-send the last frame occasionally so a freshly
                // attached decoder still gets a keyframe (cached — no re-encode).
                if last_emit.elapsed() >= Duration::from_millis(900) {
                    if cached_jpg.is_none() {
                        cached_jpg = encode_frame(prev, last_wh.0, last_wh.1, quality, last_color);
                    }
                    if let Some(jpg) = cached_jpg.clone() {
                        emit(jpg);
                        last_emit = Instant::now();
                    }
                }
            }

            // Desktop Duplication already blocked up to the budget waiting for a
            // change; only sleep to hit target fps when it didn't (timeout / xcap).
            let elapsed = t0.elapsed();
            if !timed_out && elapsed < budget {
                std::thread::sleep(budget - elapsed);
            }
        }
    });
}

/// One captured + downscaled frame handed from the capture thread to the encoder
/// thread through a single-slot mailbox (latest-wins, so a slow encoder never
/// backs up latency — it just skips stale frames).
struct RawFrame {
    /// Shared so the capture thread can also retain it for keep-alive without a
    /// full-frame copy (a 4K frame is ~25 MB — cloning it every frame was pure
    /// memory-bandwidth waste). The encoder only reads it. Pixels are packed
    /// 4-byte (`color` says BGRA vs RGBA) — the JPEG encoder consumes them
    /// directly, so no RGB conversion pass ever touches the frame.
    px: Arc<Vec<u8>>,
    w: u32,
    h: u32,
    nat_w: u32,
    nat_h: u32,
    cap_us: u32,
    scale_us: u32,
    /// Source pixel layout (Bgra = Desktop Duplication, Rgba = xcap fallback).
    color: JpegColor,
    /// True when this frame carries genuinely new pixels (a fresh capture), false
    /// for a keep-alive re-send. Lets the encoder skip the whole-frame diff.
    changed: bool,
}

/// Start the streaming capture **pipeline**. Two threads run so capture(frame N+1)
/// overlaps encode+emit(frame N) — roughly doubling throughput vs the old
/// single-threaded loop. The capture thread grabs + SIMD-downscales; the encoder
/// thread change-detects + SIMD-JPEG-encodes and calls `emit` with a full-frame
/// JPEG for every changed frame plus a ~1s keep-alive. Runs until `stop_capture`;
/// any existing pipeline is superseded (generation bump), so it's safe to re-call.
pub fn start_capture<F>(max_w: u32, fps: u32, quality: u32, emit: F)
where
    F: Fn(Vec<u8>) + Send + Sync + 'static,
{
    // Shared because BOTH threads can emit: the zero-copy path finishes a frame on the
    // capture thread (grab → GPU composite → NVENC, never touching system RAM), while
    // the CPU/JPEG path still hands off to the encoder thread through the mailbox.
    let emit = Arc::new(emit);
    let cap_emit = emit.clone();
    set_capture_quality(max_w, fps, quality);
    let my_gen = CAP_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    CAP_RUNNING.store(true, Ordering::SeqCst);
    ST_PRODUCED.store(0, Ordering::Relaxed);
    // Per-session, like `produced`. Left cumulative these read as tens of
    // thousands of skips against a few thousand frames on a healthy stream,
    // which is exactly the wrong conclusion to hand someone reading the HUD.
    ST_PAUSE_SKIPS.store(0, Ordering::Relaxed);
    // Every session starts on JPEG and is upgraded only once THIS guest opts into
    // DIRECT. Leaving the previous session's flag set would hand native H.264 to a
    // brand-new RTC guest, which paints its canvas from pixels and would show black.
    CAP_NATIVE_OK.store(false, Ordering::Relaxed);
    ST_NATIVE.store(false, Ordering::Relaxed);
    ST_ZEROCOPY.store(false, Ordering::Relaxed);
    ST_ZC_LIVE.store(false, Ordering::Relaxed);

    // Single-slot mailbox: (latest frame, condvar to wake the encoder).
    let mailbox: Arc<(PlMutex<Option<RawFrame>>, Condvar)> =
        Arc::new((PlMutex::new(None), Condvar::new()));

    // ---- capture thread: grab (persistent DXGI Desktop Duplication on Windows,
    // xcap/GDI fallback) + SIMD downscale, as fast as the target fps allows ----
    let cap_mail = mailbox.clone();
    std::thread::spawn(move || {
        boost_capture_thread();
        let _timer = TimerBoost::new(); // 1ms sleep precision for fps pacing
        #[cfg(windows)]
        let mut dup: Option<super::dxdupe::Duplicator> = None;
        // ---- zero-copy state (Windows + NVIDIA + Desktop Duplication) ----
        // When all three line up the frame never leaves the GPU: duplication texture →
        // compositor (scale + cursor) → NVENC → data channel. `zc_off` latches after a
        // failure so we stop retrying every frame and let the CPU path carry the stream.
        #[cfg(windows)]
        let mut zc: Option<(super::gpu::Compositor, super::native::NativeEncoder)> = None;
        #[cfg(windows)]
        let mut zc_off = false;
        #[cfg(windows)]
        let zc_started = Instant::now();
        // Last zero-copy emit — used to pace keep-alives on a static desktop
        // (`Grab::Timeout`) without spinning the encoder every tick.
        #[cfg(windows)]
        let mut zc_last_emit = Instant::now() - Duration::from_secs(2);
        let mut cur_mon = usize::MAX;
        // Last successfully scaled frame (shared), re-sent on idle so the encoder's
        // ~1s keep-alive still fires for a freshly attached decoder.
        let mut last: Option<(Arc<Vec<u8>>, u32, u32, u32, u32, JpegColor)> = None;
        let mut last_push = Instant::now() - Duration::from_secs(2);

        while CAP_RUNNING.load(Ordering::SeqCst) && CAP_GEN.load(Ordering::SeqCst) == my_gen {
            let max_w = CAP_MAXW.load(Ordering::Relaxed);
            let quality = CAP_QUALITY.load(Ordering::Relaxed);
            let fps = CAP_FPS.load(Ordering::Relaxed).max(1);
            // Downscale filter: text always sharp, video always fast (fps lever on a
            // 4K downscale), auto keys off quality.
            let fast = match CAP_CONTENT.load(Ordering::Relaxed) {
                CONTENT_TEXT => false,
                CONTENT_VIDEO => true,
                _ => quality < 65,
            };
            let budget_ms = (1000 / fps).clamp(1, 1000);
            let sel = selected_monitor();

            let cap0 = Instant::now();
            // Capture + downscale one frame → packed 4-byte pixels (kept in the
            // source layout; the JPEG encoder drops alpha itself). Tuple layout:
            // (px4, out_w, out_h, native_w, native_h, scale_us, color, from_dd).
            // `from_dd` = came from Desktop Duplication (always a genuine change) vs
            // the xcap fallback (which still needs a diff for the static-screen skip).
            let mut scaled: Option<(Vec<u8>, u32, u32, u32, u32, u32, JpegColor, bool)> = None;
            let mut timed_out = false;
            let mut cap_us = 0u32;

            #[cfg(windows)]
            {
                if dup.is_none() || cur_mon != sel {
                    let (tx, ty) = monitor_bounds(sel).map(|(x, y, _, _)| (x, y)).unwrap_or((0, 0));
                    dup = super::dxdupe::Duplicator::new_for(tx, ty);
                    cur_mon = sel;
                    zc = None; // new device ⇒ the old compositor/encoder are dead
                    ST_ZC_LIVE.store(false, Ordering::Relaxed);
                }

                // ---- zero-copy: grab → GPU scale+cursor → NVENC, no readback -------
                // Skips the staging Map that costs ~7ms/frame ("capture" in the HUD)
                // and the CPU downscale + cursor paint that follow it.
                if !zc_off && CAP_NATIVE_OK.load(Ordering::Relaxed) && dup.is_some() {
                    let d = dup.as_mut().unwrap();
                    let g0 = Instant::now();
                    match d.grab_gpu(budget_ms) {
                        super::dxdupe::Grab::Frame { native_w, native_h, .. } => {
                            let cap_us = g0.elapsed().as_micros() as u32;
                            let (ow, oh) = native_out_size(native_w, native_h, max_w);
                            // (Re)build on first use or a resolution change. NVENC must
                            // sit on the DUPLICATOR's device to register its textures.
                            let fresh = match &zc {
                                Some((c, _)) => c.size() != (ow, oh),
                                None => true,
                            };
                            if fresh {
                                zc = super::gpu::Compositor::new(d.device(), d.context(), ow, oh).and_then(|c| {
                                    let bps = native_bitrate_bps(ow, oh, fps, quality);
                                    super::native::NativeEncoder::new(Some(d.device()), ow, oh, fps, bps)
                                        .map(|e| (c, e))
                                });
                                if zc.is_none() {
                                    zc_off = true;
                                    ST_ZC_LIVE.store(false, Ordering::Relaxed);
                                    eprintln!(
                                        "[capture] zero-copy GPU path unavailable at {ow}x{oh} — using the readback path"
                                    );
                                } else {
                                    // Claim the stream BEFORE the first encode so the
                                    // encoder thread can't race a second NVENC session
                                    // onto the same channel.
                                    ST_ZC_LIVE.store(true, Ordering::Relaxed);
                                }
                                NATIVE_FORCE_KEY.store(true, Ordering::Relaxed);
                            }
                            if let Some((comp, enc)) = zc.as_mut() {
                                let bps = native_bitrate_bps(ow, oh, fps, quality);
                                enc.accepts(ow, oh, fps, bps);
                                let srv = d.frame_srv();
                                let img = d.cursor_image();
                                let ok = match &srv {
                                    Some(s) => comp.render(s, native_w, native_h, img.as_ref().map(|i| (i, d.cursor_seq()))),
                                    None => false,
                                };
                                // Channel backpressure: skip BEFORE the encoder so the
                                // reference chain stays intact (see NATIVE_ENCODE_PAUSED).
                                // Keyframe requests bypass — an IDR needs no references
                                // and is how a stalled stream recovers.
                                if ok
                                    && NATIVE_ENCODE_PAUSED.load(Ordering::Relaxed)
                                    && !NATIVE_FORCE_KEY.load(Ordering::Relaxed)
                                {
                                    ST_PAUSE_SKIPS.fetch_add(1, Ordering::Relaxed);
                                } else if ok {
                                    let force_key = NATIVE_FORCE_KEY.swap(false, Ordering::Relaxed);
                                    let ts_us = zc_started.elapsed().as_micros() as u64;
                                    let e0 = Instant::now();
                                    if let Some(pkt) = enc.encode_texture(comp.output(), force_key, ts_us) {
                                        ST_CAP_US.store(cap_us, Ordering::Relaxed);
                                        // The composite IS the scale; there is no
                                        // separate CPU resize pass to report.
                                        ST_SCALE_US.store(0, Ordering::Relaxed);
                                        ST_ENC_US.store(e0.elapsed().as_micros() as u32, Ordering::Relaxed);
                                        ST_NAT_W.store(native_w, Ordering::Relaxed);
                                        ST_NAT_H.store(native_h, Ordering::Relaxed);
                                        ST_OUT_W.store(ow, Ordering::Relaxed);
                                        ST_OUT_H.store(oh, Ordering::Relaxed);
                                        ST_BYTES.store(pkt.len() as u32, Ordering::Relaxed);
                                        ST_NATIVE.store(true, Ordering::Relaxed);
                                        ST_ZEROCOPY.store(true, Ordering::Relaxed);
                                        ST_PRODUCED.fetch_add(1, Ordering::Relaxed);
                                        cap_emit(pkt);
                                        zc_last_emit = Instant::now();
                                    } else {
                                        // Encode faulted: drop the session (stays
                                        // retryable — the next frame rebuilds it).
                                        zc = None;
                                        ST_ZC_LIVE.store(false, Ordering::Relaxed);
                                    }
                                }
                            }
                        }
                        super::dxdupe::Grab::Timeout => {
                            // Nothing new on screen. Re-encode the last composited
                            // frame occasionally so a freshly-attached decoder still
                            // gets something on a static desktop (H.264 makes this
                            // nearly free — an unchanged P-frame is a few hundred
                            // bytes of skip macroblocks).
                            if let Some((comp, enc)) = zc.as_mut() {
                                let want_key = NATIVE_FORCE_KEY.load(Ordering::Relaxed);
                                // The static-screen keep-alive also respects the
                                // backpressure pause (it would only deepen the backlog);
                                // a requested IDR still goes out.
                                if want_key
                                    || (!NATIVE_ENCODE_PAUSED.load(Ordering::Relaxed)
                                        && zc_last_emit.elapsed() >= Duration::from_millis(700))
                                {
                                    let force_key = NATIVE_FORCE_KEY.swap(false, Ordering::Relaxed);
                                    let ts_us = zc_started.elapsed().as_micros() as u64;
                                    if let Some(pkt) = enc.encode_texture(comp.output(), force_key, ts_us) {
                                        ST_BYTES.store(pkt.len() as u32, Ordering::Relaxed);
                                        ST_PRODUCED.fetch_add(1, Ordering::Relaxed);
                                        cap_emit(pkt);
                                        zc_last_emit = Instant::now();
                                    }
                                }
                            }
                        }
                        super::dxdupe::Grab::Lost => {
                            dup = None;
                            zc = None;
                            ST_ZC_LIVE.store(false, Ordering::Relaxed);
                        }
                    }
                    // **Never fall through to the CPU path while we own a zero-copy
                    // session.** Doing so pushes a frame to the mailbox, and the
                    // encoder thread would encode it with a SECOND NVENC session whose
                    // reference chain is unrelated to ours. Interleaving two chains on
                    // one channel is what made the picture glitch and leave patches
                    // stale — the screen only had to go briefly static (a grab_gpu
                    // timeout) for the second encoder to cut in.
                    if zc.is_some() {
                        let elapsed = cap0.elapsed();
                        let target = Duration::from_millis(budget_ms as u64);
                        if elapsed < target {
                            std::thread::sleep(target - elapsed);
                        }
                        continue;
                    }
                }

                if let Some(d) = dup.as_mut() {
                    // Grab downscales on the GPU toward max_w; time it on its own so
                    // capture vs scale telemetry stays honest.
                    let g0 = Instant::now();
                    let grab = d.grab(budget_ms, max_w);
                    cap_us = g0.elapsed().as_micros() as u32;
                    match grab {
                        super::dxdupe::Grab::Frame { w: gw, h: gh, native_w, native_h } => {
                            let s0 = Instant::now();
                            // BGRA source (already GPU-downscaled to ~max_w); the CPU
                            // resize just trims to the exact target across all cores.
                            if let Some((mut px, ow, oh)) = scale_u8x4(d.buffer(), gw, gh, max_w, fast) {
                                // Composite the real system cursor into the outgoing
                                // frame (DD frames don't include the pointer).
                                d.draw_cursor(&mut px, ow, oh);
                                scaled = Some((px, ow, oh, native_w, native_h, s0.elapsed().as_micros() as u32, JpegColor::Bgra, true));
                            }
                        }
                        super::dxdupe::Grab::Timeout => timed_out = true,
                        super::dxdupe::Grab::Lost => dup = None,
                    }
                } else if let Some(rgba) = monitor_at(sel).and_then(|m| m.capture_image().ok()) {
                    cap_us = cap0.elapsed().as_micros() as u32;
                    let (sw, sh) = (rgba.width(), rgba.height());
                    let raw = rgba.into_raw();
                    let s0 = Instant::now();
                    if let Some((px, ow, oh)) = scale_u8x4(&raw, sw, sh, max_w, fast) {
                        scaled = Some((px, ow, oh, sw, sh, s0.elapsed().as_micros() as u32, JpegColor::Rgba, false));
                    }
                }
            }
            #[cfg(not(windows))]
            {
                cur_mon = sel;
                if let Some(rgba) = monitor_at(sel).and_then(|m| m.capture_image().ok()) {
                    cap_us = cap0.elapsed().as_micros() as u32;
                    let (sw, sh) = (rgba.width(), rgba.height());
                    let raw = rgba.into_raw();
                    let s0 = Instant::now();
                    if let Some((px, ow, oh)) = scale_u8x4(&raw, sw, sh, max_w, fast) {
                        scaled = Some((px, ow, oh, sw, sh, s0.elapsed().as_micros() as u32, JpegColor::Rgba, false));
                    }
                }
            }

            if let Some((px, w, h, nat_w, nat_h, scale_us, color, from_dd)) = scaled {
                // DD only ever yields changed frames; the xcap fallback diffs the
                // scaled result against the previous to preserve the static skip.
                let changed = from_dd
                    || last.as_ref().map_or(true, |(prev, pw, ph, _, _, _)| {
                        *pw != w || *ph != h || prev.as_slice() != px.as_slice()
                    });
                let px = Arc::new(px);
                {
                    let (lock, cv) = &*cap_mail;
                    let mut slot = lock.lock();
                    // If an as-yet-unconsumed frame was already "changed", carry that
                    // forward so coalescing can never swallow a real update.
                    let carried = slot.as_ref().map_or(false, |f| f.changed);
                    *slot = Some(RawFrame {
                        px: px.clone(),
                        w,
                        h,
                        nat_w,
                        nat_h,
                        cap_us,
                        scale_us,
                        color,
                        changed: changed || carried,
                    });
                    cv.notify_one();
                }
                last = Some((px, w, h, nat_w, nat_h, color));
                last_push = Instant::now();

                // Pace to target fps. Desktop Duplication already blocked up to the
                // budget waiting for a change, so only the xcap path really sleeps.
                let elapsed = cap0.elapsed();
                let target = Duration::from_millis(budget_ms as u64);
                if elapsed < target {
                    std::thread::sleep(target - elapsed);
                }
            } else {
                // No new frame. Re-send the last one occasionally for keep-alive.
                if let Some((px, w, h, sw, sh, color)) = &last {
                    if last_push.elapsed() >= Duration::from_millis(700) {
                        let (lock, cv) = &*cap_mail;
                        let mut slot = lock.lock();
                        let carried = slot.as_ref().map_or(false, |f| f.changed);
                        *slot = Some(RawFrame {
                            px: px.clone(),
                            w: *w,
                            h: *h,
                            nat_w: *sw,
                            nat_h: *sh,
                            cap_us,
                            scale_us: 0,
                            color: *color,
                            changed: carried,
                        });
                        cv.notify_one();
                        last_push = Instant::now();
                    }
                }
                // DD already waited `budget_ms`; only back off when it didn't block.
                if !timed_out {
                    std::thread::sleep(Duration::from_millis(budget_ms.min(60) as u64));
                }
            }
        }
        // Wake the encoder so it re-checks the run flag and exits.
        mailbox_wake(&cap_mail);
    });

    // ---- encoder thread: change-detect + (native H.264 | SIMD JPEG) + emit ----
    let enc_mail = mailbox;
    std::thread::spawn(move || {
        boost_capture_thread();
        let mut last_emit = Instant::now() - Duration::from_secs(2);
        // Encoded copy of the last emitted frame for keep-alive re-sends: a static
        // screen then costs one encode + a ~1/s memcpy instead of an encode per
        // keep-alive. Never touched on the changed-frame hot path.
        let mut cached: Option<(Vec<u8>, u32, u32, u8)> = None;
        // Native NVENC session, built lazily on the first frame (we need its real
        // dimensions) and rebuilt whenever the stream resolution changes. `None` means
        // this machine has no NVENC and the JPEG path below carries the stream.
        #[cfg(windows)]
        let mut native: Option<super::native::NativeEncoder> = None;
        #[cfg(windows)]
        let mut native_off = false;
        #[cfg(windows)]
        let started = Instant::now();
        while CAP_RUNNING.load(Ordering::SeqCst) && CAP_GEN.load(Ordering::SeqCst) == my_gen {
            let frame = {
                let (lock, cv) = &*enc_mail;
                let mut slot = lock.lock();
                loop {
                    if !CAP_RUNNING.load(Ordering::SeqCst) || CAP_GEN.load(Ordering::SeqCst) != my_gen {
                        return;
                    }
                    if let Some(f) = slot.take() {
                        break f;
                    }
                    cv.wait_for(&mut slot, Duration::from_millis(200));
                }
            };

            let quality = CAP_QUALITY.load(Ordering::Relaxed) as u8;
            let stale = last_emit.elapsed() >= Duration::from_millis(1000);

            // Record capture/scale/dims every frame so the HUD stays live even on a
            // static screen (where we skip the encode).
            ST_CAP_US.store(frame.cap_us, Ordering::Relaxed);
            ST_SCALE_US.store(frame.scale_us, Ordering::Relaxed);
            ST_NAT_W.store(frame.nat_w, Ordering::Relaxed);
            ST_NAT_H.store(frame.nat_h, Ordering::Relaxed);
            ST_OUT_W.store(frame.w, Ordering::Relaxed);
            ST_OUT_H.store(frame.h, Ordering::Relaxed);

            // ---- native H.264 (NVENC) fast path ----------------------------------
            // Only the BGRA (Desktop Duplication) source qualifies: the xcap fallback
            // hands us RGBA, and swizzling a whole frame on the CPU would give back
            // exactly the kind of per-pixel pass this path exists to remove.
            //
            // Stand down while the capture thread owns a zero-copy session
            // (`ST_ZC_LIVE`): two NVENC reference chains on one channel is what made
            // the picture glitch with patches that never refreshed.
            #[cfg(windows)]
            if !native_off
                && CAP_NATIVE_OK.load(Ordering::Relaxed)
                && !ST_ZC_LIVE.load(Ordering::Relaxed)
                && matches!(frame.color, JpegColor::Bgra)
                && (frame.changed || stale)
            {
                let fps = CAP_FPS.load(Ordering::Relaxed).max(1);
                let want_bps = native_bitrate_bps(frame.w, frame.h, fps, quality as u32);
                // (Re)build on first use or a resolution change. NVENC rounds to even
                // dimensions, so ask the session what it settled on.
                let usable = match native.as_mut() {
                    Some(n) => n.accepts(frame.w, frame.h, fps, want_bps),
                    None => false,
                };
                if !usable {
                    native = super::native::NativeEncoder::new(None, frame.w, frame.h, fps, want_bps);
                    if native.is_none() {
                        // No NVENC on this machine (or it refused this shape). Say so
                        // once, then stop paying for the attempt every frame.
                        native_off = true;
                        eprintln!(
                            "[capture] native H.264 unavailable — streaming via the JPEG path ({}x{})",
                            frame.w, frame.h
                        );
                    }
                }
                if let Some(n) = native.as_mut() {
                    // Channel backpressure: skip BEFORE the encoder so the reference
                    // chain stays intact (see NATIVE_ENCODE_PAUSED). Keyframe requests
                    // and the stale keep-alive (which forces an IDR) still encode.
                    if NATIVE_ENCODE_PAUSED.load(Ordering::Relaxed)
                        && !NATIVE_FORCE_KEY.load(Ordering::Relaxed)
                        && !stale
                    {
                        ST_PAUSE_SKIPS.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    let (nw, nh) = n.size();
                    // First frame of a session, a guest keyframe request, or the ~1s
                    // keep-alive on a static screen all need a self-contained IDR.
                    let force_key = NATIVE_FORCE_KEY.swap(false, Ordering::Relaxed) || stale;
                    let ts_us = started.elapsed().as_micros() as u64;
                    if let Some(pkt) = n.encode_pixels(&frame.px, frame.w, frame.h, force_key, ts_us) {
                        ST_ENC_US.store(n.last_encode_us, Ordering::Relaxed);
                        ST_BYTES.store(pkt.len() as u32, Ordering::Relaxed);
                        ST_OUT_W.store(nw, Ordering::Relaxed);
                        ST_OUT_H.store(nh, Ordering::Relaxed);
                        ST_NATIVE.store(true, Ordering::Relaxed);
                        // We're here via the readback path, so whatever the capture
                        // thread last claimed, this frame is not zero-copy.
                        ST_ZEROCOPY.store(false, Ordering::Relaxed);
                        ST_PRODUCED.fetch_add(1, Ordering::Relaxed);
                        emit(pkt);
                        last_emit = Instant::now();
                        cached = None;
                        continue;
                    }
                    // Encode failed — drop the session and let JPEG carry this frame.
                    // Staying retryable matters: a transient fault must not strand the
                    // stream on JPEG for the rest of the session.
                    native = None;
                }
            }
            #[cfg(windows)]
            {
                ST_NATIVE.store(false, Ordering::Relaxed);
                ST_ZEROCOPY.store(false, Ordering::Relaxed);
            }

            // ---- JPEG fallback ---------------------------------------------------
            // The capture side already told us whether the pixels changed, so there's
            // no whole-frame diff here (a 4K memcmp per frame was pure overhead).
            if frame.changed {
                let enc0 = Instant::now();
                if let Some(jpg) = encode_frame(&frame.px, frame.w, frame.h, quality, frame.color) {
                    ST_ENC_US.store(enc0.elapsed().as_micros() as u32, Ordering::Relaxed);
                    ST_BYTES.store(jpg.len() as u32, Ordering::Relaxed);
                    ST_PRODUCED.fetch_add(1, Ordering::Relaxed);
                    emit(jpg);
                    last_emit = Instant::now();
                    cached = None; // content moved on — drop the stale keep-alive cache
                }
            } else if stale {
                // Keep-alive: same pixels as last time. Encode once, then serve clones.
                let usable = matches!(&cached, Some((_, w, h, q)) if *w == frame.w && *h == frame.h && *q == quality);
                if !usable {
                    cached = encode_frame(&frame.px, frame.w, frame.h, quality, frame.color)
                        .map(|j| (j, frame.w, frame.h, quality));
                }
                if let Some((jpg, ..)) = &cached {
                    ST_BYTES.store(jpg.len() as u32, Ordering::Relaxed);
                    ST_PRODUCED.fetch_add(1, Ordering::Relaxed);
                    emit(jpg.clone());
                    last_emit = Instant::now();
                }
            }
        }
    });
}

/// Nudge the encoder thread's condvar (used on capture-thread exit).
fn mailbox_wake(mail: &Arc<(PlMutex<Option<RawFrame>>, Condvar)>) {
    let (_lock, cv) = &**mail;
    cv.notify_all();
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
