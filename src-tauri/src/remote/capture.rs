//! Primary-monitor screen capture → JPEG, for the remote screen stream.
//! Uses xcap's re-exported `image` so the pixel types unify with `capture_image()`.

use xcap::image::codecs::jpeg::JpegEncoder;
use xcap::image::{imageops::FilterType, DynamicImage};
use xcap::Monitor;

fn primary_monitor() -> Option<Monitor> {
    let monitors = Monitor::all().ok()?;
    monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .cloned()
        .or_else(|| monitors.into_iter().next())
}

/// Grab the primary monitor, optionally downscale to `max_w`, and JPEG-encode it.
/// Returns `None` on any capture/encoding failure (caller simply skips the frame).
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

/// Pixel size of the primary monitor, for mapping normalized touch → absolute coords.
pub fn primary_size() -> Option<(u32, u32)> {
    let mon = primary_monitor()?;
    Some((mon.width().ok()?, mon.height().ok()?))
}
