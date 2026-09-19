//! Native H.264 screen encoding — the DIRECT path's host side.
//!
//! Wraps [`super::nvenc`] with the D3D11 plumbing the capture pipeline needs, and
//! defines the wire container the webview forwards to the phone.
//!
//! ## Two input paths
//! * [`NativeEncoder::encode_pixels`] — takes the CPU BGRA/RGBA buffer the existing
//!   capture pipeline already produces (scaled, cursor composited) and uploads it to a
//!   D3D11 texture. Keeps every bit of the monitor/scale/cursor/aux logic untouched and
//!   still removes JPEG encode, the 334 KB→~30 KB IPC drop, the webview's JPEG decode,
//!   the canvas, and the ~27 ms WebCodecs round trip.
//! * [`NativeEncoder::encode_texture`] — zero-copy: the caller hands over a GPU texture
//!   that is already the exact stream size with the cursor composited (see
//!   [`super::gpu`]). No readback at all.
//!
//! Both end at the same NVENC session, so the encoder config / SPS fixup story is
//! shared. `None` from [`NativeEncoder::new`] means "no NVENC here" and the caller
//! keeps the JPEG path — this is an optimisation, never a requirement.

#![cfg(windows)]

use std::time::Instant;

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D,
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

use super::nvenc;

/// Magic for the native-H.264 container on the Rust→webview channel. The webview
/// checks these two bytes to tell a native frame from a JPEG / "GS" strip container.
pub const NATIVE_MAGIC: [u8; 2] = [b'G', b'N'];
/// `'G' 'N' | flags u8 (bit0 = keyframe) | reserved u8 | w u16 | h u16` then Annex-B.
pub const NATIVE_HEADER_LEN: usize = 8;

/// Wrap an Annex-B frame in the container the webview expects.
fn wrap(annexb: &[u8], key: bool, w: u32, h: u32) -> Vec<u8> {
    // Spare bytes for opt-in delivery timing/credit header; avoids a second
    // allocation when that header is inserted. Classic wire length is unchanged.
    let mut out = Vec::with_capacity(NATIVE_HEADER_LEN + 16 + annexb.len());
    out.extend_from_slice(&NATIVE_MAGIC);
    out.push(if key { 1 } else { 0 });
    out.push(0);
    out.extend_from_slice(&(w.min(u16::MAX as u32) as u16).to_le_bytes());
    out.extend_from_slice(&(h.min(u16::MAX as u32) as u16).to_le_bytes());
    out.extend_from_slice(annexb);
    out
}

/// Bitrate for a given stream shape, mirroring `bitrateFor()` in `rtcHost.ts` so the
/// native path lands on the same bitrate the WebRTC path would have negotiated.
/// `quality` is the existing 20..95 sharpness knob.
///
/// Bits-per-pixel is **0.10** at quality 70 (was 0.06). Constrained Baseline + CAVLC
/// needs ~10% more than High+CABAC for the same look (Sunshine's `nvenc_h264_cavlc`
/// note), and a desktop with a live webcam is far denser than a talking-head stream
/// the old 0.06 figure was tuned for — that starved the encoder into macroblocks.
pub fn auto_bitrate_bps(w: u32, h: u32, fps: u32, quality: u32) -> u32 {
    let px = (w as u64) * (h as u64);
    let bpp = 0.10_f64 * (quality as f64 / 70.0);
    let bps = (px as f64) * (fps.max(1) as f64) * bpp;
    // Floor 2 Mbps: below that even 720p desktop+webcam turns to blocks.
    bps.clamp(2_000_000.0, 40_000_000.0) as u32
}

/// A live native encoder: D3D11 device + upload texture + NVENC session.
pub struct NativeEncoder {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    enc: nvenc::Encoder,
    /// Upload target for [`NativeEncoder::encode_pixels`]; `None` on the zero-copy path.
    upload: Option<ID3D11Texture2D>,
    w: u32,
    h: u32,
    fps: u32,
    bitrate: u32,
    /// Microseconds of the last encode (submit → bitstream), for the HUD.
    pub last_encode_us: u32,
}

impl NativeEncoder {
    /// Build on a caller-supplied device (zero-copy path: must be the duplicator's
    /// device so NVENC can register its textures), or `None` to create a private one
    /// (upload path — NVENC only needs *a* device).
    pub fn new(device: Option<&ID3D11Device>, w: u32, h: u32, fps: u32, bitrate_bps: u32) -> Option<Self> {
        if !nvenc::available() {
            return None;
        }
        // NVENC wants even dimensions; the capture scaler can land on odd sizes.
        let (w, h) = (w & !1, h & !1);
        if w < 32 || h < 32 {
            return None;
        }
        let device = match device {
            Some(d) => d.clone(),
            None => unsafe {
                let mut dev = None;
                D3D11CreateDevice(
                    None::<&windows::Win32::Graphics::Dxgi::IDXGIAdapter>,
                    D3D_DRIVER_TYPE_HARDWARE,
                    windows::Win32::Foundation::HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    Some(&[D3D_FEATURE_LEVEL_11_0]),
                    D3D11_SDK_VERSION,
                    Some(&mut dev),
                    None,
                    None,
                )
                .ok()?;
                dev?
            },
        };
        let context = unsafe { device.GetImmediateContext().ok()? };

        let enc = nvenc::Encoder::new(
            &device,
            nvenc::Params {
                width: w,
                height: h,
                fps: fps.clamp(1, 240),
                bitrate_bps,
            },
        )?;
        Some(NativeEncoder {
            device,
            context,
            enc,
            upload: None,
            w,
            h,
            fps,
            bitrate: bitrate_bps,
            last_encode_us: 0,
        })
    }

    pub fn size(&self) -> (u32, u32) {
        (self.w, self.h)
    }

    pub fn device(&self) -> &ID3D11Device {
        &self.device
    }

    /// True when this session can still serve the requested shape. A resolution change
    /// needs a fresh session; bitrate/fps are applied in place.
    pub fn accepts(&mut self, w: u32, h: u32, fps: u32, bitrate_bps: u32) -> bool {
        if (w & !1) != self.w || (h & !1) != self.h {
            return false;
        }
        if fps != self.fps || bitrate_bps != self.bitrate {
            let p = nvenc::Params {
                width: self.w,
                height: self.h,
                fps: fps.clamp(1, 240),
                bitrate_bps,
            };
            match self.enc.reconfigure(p) {
                Ok(()) => {
                    self.fps = fps;
                    self.bitrate = bitrate_bps;
                }
                // A refused reconfigure isn't fatal — keep encoding at the old settings
                // rather than tearing down a working session.
                Err(e) => eprintln!("[native] reconfigure refused ({e}) — keeping current settings"),
            }
        }
        true
    }

    fn ensure_upload(&mut self) -> Option<ID3D11Texture2D> {
        if let Some(t) = &self.upload {
            return Some(t.clone());
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: self.w,
            Height: self.h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            // DEFAULT + UpdateSubresource rather than DYNAMIC + Map: NVENC cannot
            // register a DYNAMIC (CPU-writable) texture as an input resource.
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            ..Default::default()
        };
        let mut tex = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut tex)).ok()? };
        self.upload = tex.clone();
        tex
    }

    /// Encode a packed 4-byte CPU frame. `px` must be `w*h*4` in **BGRA** order
    /// (`JpegColor::Bgra`); the RGBA fallback path can't use this without a swizzle.
    /// Returns the wire container ready for `emit`.
    pub fn encode_pixels(&mut self, px: &[u8], w: u32, h: u32, force_key: bool, ts_us: u64) -> Option<Vec<u8>> {
        if w < self.w || h < self.h {
            return None; // caller must match the session shape
        }
        let tex = self.ensure_upload()?;
        let res: ID3D11Resource = tex.cast().ok()?;
        let t0 = Instant::now();
        unsafe {
            // Row pitch of the SOURCE. When the capture scaler produced a slightly
            // larger frame than the (even-rounded) encode size, this crops rather than
            // stretching — the extra row/column is never visible.
            self.context
                .UpdateSubresource(&res, 0, None, px.as_ptr() as *const _, w * 4, 0);
        }
        let frame = match self.enc.encode(&tex, force_key, ts_us) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[native] encode failed: {e}");
                return None;
            }
        };
        let out = wrap(frame.data, frame.key, self.w, self.h);
        self.last_encode_us = t0.elapsed().as_micros() as u32;
        Some(out)
    }

    /// Zero-copy: encode a texture that is already the exact session size with the
    /// cursor composited. See [`super::gpu::Compositor`].
    pub fn encode_texture(&mut self, tex: &ID3D11Texture2D, force_key: bool, ts_us: u64) -> Option<Vec<u8>> {
        let t0 = Instant::now();
        let frame = match self.enc.encode(tex, force_key, ts_us) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[native] encode failed: {e}");
                return None;
            }
        };
        let out = wrap(frame.data, frame.key, self.w, self.h);
        self.last_encode_us = t0.elapsed().as_micros() as u32;
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_frames_with_a_parseable_header() {
        let out = wrap(&[0, 0, 0, 1, 0x65, 0xAA], true, 1920, 1080);
        assert_eq!(&out[..2], &NATIVE_MAGIC);
        assert_eq!(out[2] & 1, 1, "keyframe flag");
        assert_eq!(u16::from_le_bytes([out[4], out[5]]), 1920);
        assert_eq!(u16::from_le_bytes([out[6], out[7]]), 1080);
        assert_eq!(&out[NATIVE_HEADER_LEN..], &[0, 0, 0, 1, 0x65, 0xAA]);

        let delta = wrap(&[9], false, 2, 2);
        assert_eq!(delta[2] & 1, 0, "delta frames must not claim keyframe");
    }

    #[test]
    fn auto_bitrate_tracks_pixels_and_fps_and_clamps() {
        let a = auto_bitrate_bps(1920, 1080, 60, 70);
        let b = auto_bitrate_bps(1920, 1080, 30, 70);
        assert!(a > b, "more fps must ask for more bitrate");
        // 1080p60 at quality 70 ~= 0.10 bpp -> ~12.4 Mbps.
        assert!((10_000_000..=15_000_000).contains(&a), "unexpected 1080p60 bitrate: {a}");
        // Clamps hold at the extremes.
        assert_eq!(auto_bitrate_bps(320, 180, 1, 20), 2_000_000);
        assert_eq!(auto_bitrate_bps(7680, 4320, 240, 95), 40_000_000);
    }

    /// Numerical hardware validation only: synthetic pixels, no window or screen
    /// capture. Emits Annex-B fixtures for ffmpeg's strict decoder verification.
    #[test]
    #[ignore = "requires NVIDIA GPU; writes fixtures under target/perf-validation"]
    fn native_delivery_smoke() {
        use super::super::delivery::Gate;
        use std::collections::VecDeque;
        let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/perf-validation");
        std::fs::create_dir_all(&output).unwrap();
        for (name, fast, congested) in [("classic", false, false), ("fast", true, false), ("fast-pressure", true, true)] {
            let gate = Gate::new(); gate.start(1); gate.enable(fast);
            let (w, h) = (1920u32, 1080u32);
            let mut encoder = NativeEncoder::new(None, w, h, 60, 16_000_000).expect("NVENC hardware required");
            let mut pixels = vec![0u8; (w * h * 4) as usize];
            for (i, pixel) in pixels.chunks_exact_mut(4).enumerate() {
                let x = i as u32 % w; let y = i as u32 / w;
                pixel.copy_from_slice(&[(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255]);
            }
            let mut acks = VecDeque::new();
            let mut bitstream = Vec::new();
            let mut times = Vec::new();
            let mut count = 0;
            for tick in 0..120u64 {
                // Moving high-contrast content; update only a small region so
                // CPU fixture generation is outside the measured encoding cost.
                for y in 200..360u32 { for x in 400..600u32 {
                    let at = ((y * w + x) * 4) as usize;
                    let value = if (x + tick as u32 * 4) % 100 < 50 { 235 } else { 20 };
                    pixels[at..at + 3].fill(value);
                } }
                if congested && tick % 4 == 0 { if let Some(seq) = acks.pop_front() { gate.ack(1, seq); } }
                let Some(permit) = gate.reserve(1) else { continue; };
                let start = Instant::now();
                let bytes = encoder.encode_pixels(&pixels, w, h, count == 0, tick * 16_667).expect("encode");
                let bytes = permit.packet(bytes);
                if count > 0 { times.push(start.elapsed().as_secs_f64() * 1000.0); }
                if fast {
                    assert_eq!(bytes[3], 1);
                    let seq = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
                    bitstream.extend_from_slice(&bytes[24..]);
                    if congested { acks.push_back(seq); } else { gate.ack(1, seq); }
                } else { bitstream.extend_from_slice(&bytes[8..]); }
                count += 1;
            }
            times.sort_by(|a, b| a.total_cmp(b));
            let median = times[times.len() / 2];
            let p95 = times[times.len() * 95 / 100];
            assert!(median < 10.0, "unexpected encode latency: {median}");
            if congested { assert!(count < 40 && count >= 30); } else { assert_eq!(count, 120); }
            let file = output.join(format!("{name}.h264"));
            std::fs::write(&file, bitstream).unwrap();
            eprintln!("{name}: {count} frames; encode+wrap median={median:.3}ms p95={p95:.3}ms; pre-encode skipped={}; fixture={}", gate.stats().skipped, file.display());
        }
    }
}
