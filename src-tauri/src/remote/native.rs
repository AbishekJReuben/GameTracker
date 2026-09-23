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

/// NVENC quality knobs that need a fresh session to change (the phone's Tune panel).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct EncoderTuning {
    /// P1..=P4 (1 = fastest).
    pub preset: u8,
    /// 0 single pass, 1 two-pass quarter-res, 2 two-pass full-res.
    pub multipass: u8,
}

impl Default for EncoderTuning {
    fn default() -> Self {
        EncoderTuning {
            preset: nvenc::DEFAULT_PRESET,
            multipass: nvenc::DEFAULT_MULTIPASS,
        }
    }
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
    tuning: EncoderTuning,
    /// Microseconds of the last encode (submit → bitstream), for the HUD.
    pub last_encode_us: u32,
    /// NVENC's average QP of the last frame — drives the still-screen refinement
    /// burst in capture.rs.
    pub last_avg_qp: u32,
}

impl NativeEncoder {
    /// Build on a caller-supplied device (zero-copy path: must be the duplicator's
    /// device so NVENC can register its textures), or `None` to create a private one
    /// (upload path — NVENC only needs *a* device).
    pub fn new(
        device: Option<&ID3D11Device>,
        w: u32,
        h: u32,
        fps: u32,
        bitrate_bps: u32,
        tuning: EncoderTuning,
    ) -> Option<Self> {
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
            nvenc::Params::new(w, h, fps.clamp(1, 240), bitrate_bps).with_tuning(tuning.preset, tuning.multipass),
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
            tuning,
            last_encode_us: 0,
            last_avg_qp: 0,
        })
    }

    pub fn tuning(&self) -> EncoderTuning {
        self.tuning
    }

    pub fn size(&self) -> (u32, u32) {
        (self.w, self.h)
    }

    pub fn device(&self) -> &ID3D11Device {
        &self.device
    }

    /// True when this session can still serve the requested shape. A resolution,
    /// preset or pass-mode change needs a fresh session; bitrate/fps apply in place.
    pub fn accepts(&mut self, w: u32, h: u32, fps: u32, bitrate_bps: u32, tuning: EncoderTuning) -> bool {
        if (w & !1) != self.w || (h & !1) != self.h || tuning != self.tuning {
            return false;
        }
        if fps != self.fps || bitrate_bps != self.bitrate {
            let p = nvenc::Params::new(self.w, self.h, fps.clamp(1, 240), bitrate_bps)
                .with_tuning(self.tuning.preset, self.tuning.multipass);
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
        self.encode_texture_ex(tex, force_key, false, ts_us)
    }

    /// [`Self::encode_texture`] that can also start an intra-refresh wave.
    pub fn encode_texture_ex(&mut self, tex: &ID3D11Texture2D, force_key: bool, force_ir: bool, ts_us: u64) -> Option<Vec<u8>> {
        let t0 = Instant::now();
        let frame = match self.enc.encode_ex(tex, force_key, force_ir, ts_us) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[native] encode failed: {e}");
                return None;
            }
        };
        self.last_avg_qp = frame.avg_qp;
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

    /// Deterministic desktop-like BGRA frame: white page with lines of dark
    /// glyph-sized marks (scrolling), a textured "photo" panel and a moving window.
    fn synthetic_desktop(w: u32, h: u32, t: u32, out: &mut [u8]) {
        let mut seed = 0x9E37_79B9u32;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        // Page background.
        for px in out.chunks_exact_mut(4) {
            px.copy_from_slice(&[250, 250, 250, 255]);
        }
        let scroll = (t * 3) % 40;
        // Text lines: 14px pitch, glyph marks 3..7 px wide, dark grey. Same PRNG seed
        // every frame so the page content is stable and only the scroll offset moves.
        let text_w = w * 3 / 5;
        let mut y = 8i64 - scroll as i64;
        while y < h as i64 {
            let mut x = 12u32;
            while x + 8 < text_w {
                let gw = 3 + rnd() % 5;
                let gh = 6 + rnd() % 4;
                if rnd() % 7 != 0 {
                    for yy in 0..gh as i64 {
                        let py = y + yy;
                        if py < 0 || py >= h as i64 {
                            continue;
                        }
                        for xx in 0..gw {
                            let i = ((py as u32 * w + x + xx) * 4) as usize;
                            out[i..i + 3].copy_from_slice(&[40, 40, 45]);
                        }
                    }
                }
                x += gw + 1 + if rnd() % 6 == 0 { 5 } else { 0 };
            }
            y += 14;
        }
        // Photo-like panel: smooth gradient plus fine noise (hard to compress).
        for py in h / 8..h * 5 / 8 {
            for px in text_w + 20..w - 20 {
                let n = (rnd() % 24) as u8;
                let i = ((py * w + px) * 4) as usize;
                out[i] = ((px * 255 / w) as u8).saturating_add(n);
                out[i + 1] = ((py * 255 / h) as u8).saturating_add(n / 2);
                out[i + 2] = (((px + py + t * 2) % 256) as u8).saturating_sub(n);
            }
        }
        // A window sliding across the page (motion vectors + sharp edges).
        let wx = (t * 7) % (w / 2);
        for py in h * 5 / 8..h * 7 / 8 {
            for px in wx..wx + w / 4 {
                let i = ((py * w + px) * 4) as usize;
                let border = py == h * 5 / 8 || px == wx || px == wx + w / 4 - 1;
                out[i..i + 3].copy_from_slice(if border { &[180, 90, 20] } else { &[235, 225, 205] });
            }
        }
    }

    /// Encoder quality/latency matrix on synthetic desktop content: P1..P4 × single /
    /// two-pass (quarter-res). Writes the BGRA source and one Annex-B stream per
    /// config so PSNR can be measured with ffmpeg; prints median encode ms + bytes.
    ///   `cargo test --release --lib remote::native::tests::encoder_tuning_matrix -- --ignored --nocapture`
    #[test]
    #[ignore = "requires NVIDIA GPU; writes fixtures under target/perf-validation"]
    fn encoder_tuning_matrix() {
        use std::io::Write;
        let out_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/perf-validation");
        std::fs::create_dir_all(&out_dir).unwrap();
        let (w, h, frames, fps, bps) = (1280u32, 720u32, 90u32, 60u32, 2_500_000u32);
        let mut src = std::fs::File::create(out_dir.join("tuning-src.bgra")).unwrap();
        let mut px = vec![0u8; (w * h * 4) as usize];
        let mut all = Vec::with_capacity(frames as usize);
        for t in 0..frames {
            synthetic_desktop(w, h, t, &mut px);
            src.write_all(&px).unwrap();
            all.push(px.clone());
        }
        for preset in 1..=4u8 {
            for multipass in [0u8, 1] {
                let tuning = EncoderTuning { preset, multipass };
                let mut enc = NativeEncoder::new(None, w, h, fps, bps, tuning).expect("NVENC hardware required");
                let mut stream = Vec::new();
                let mut times = Vec::new();
                for (i, frame) in all.iter().enumerate() {
                    let t0 = Instant::now();
                    let pkt = enc.encode_pixels(frame, w, h, i == 0, i as u64 * 16_667).expect("encode");
                    if i > 0 {
                        times.push(enc.last_encode_us as f64 / 1000.0);
                    }
                    let _ = t0;
                    stream.extend_from_slice(&pkt[NATIVE_HEADER_LEN..]);
                }
                times.sort_by(|a, b| a.total_cmp(b));
                let median = times[times.len() / 2];
                let p95 = times[times.len() * 95 / 100];
                let name = format!("tuning-p{preset}-mp{multipass}.h264");
                std::fs::write(out_dir.join(&name), &stream).unwrap();
                eprintln!(
                    "P{preset} multipass={multipass}: encode median {median:.3} ms p95 {p95:.3} ms, {} bytes → {name}",
                    stream.len()
                );
            }
        }
    }

    /// Pure NVENC latency per preset at 1080p: frames are uploaded to GPU textures
    /// up front (like the zero-copy path), so only `encode` is timed.
    ///   `cargo test --lib remote::native::tests::preset_latency_1080p -- --ignored --nocapture`
    #[test]
    #[ignore = "requires NVIDIA GPU"]
    fn preset_latency_1080p() {
        use windows::Win32::Graphics::Direct3D11::D3D11_SUBRESOURCE_DATA;
        let (w, h, frames) = (1920u32, 1080u32, 120u32);
        let mut dev = None;
        unsafe {
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
            .unwrap();
        }
        let device = dev.unwrap();
        let mut px = vec![0u8; (w * h * 4) as usize];
        let mut textures = Vec::new();
        for t in 0..frames {
            synthetic_desktop(w, h, t, &mut px);
            let desc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                ..Default::default()
            };
            let init = D3D11_SUBRESOURCE_DATA { pSysMem: px.as_ptr() as *const _, SysMemPitch: w * 4, SysMemSlicePitch: 0 };
            let mut tex = None;
            unsafe { device.CreateTexture2D(&desc, Some(&init), Some(&mut tex)).unwrap() };
            textures.push(tex.unwrap());
        }
        for preset in 1..=4u8 {
            let mut enc = nvenc::Encoder::new(&device, nvenc::Params::new(w, h, 60, 12_000_000).with_tuning(preset, 0)).unwrap();
            let mut times = Vec::new();
            let mut bytes = 0usize;
            for (i, tex) in textures.iter().enumerate() {
                let t0 = Instant::now();
                let f = enc.encode(tex, i == 0, i as u64 * 16_667).unwrap();
                bytes += f.data.len();
                if i > 0 {
                    times.push(t0.elapsed().as_secs_f64() * 1000.0);
                }
            }
            times.sort_by(|a, b| a.total_cmp(b));
            eprintln!(
                "1080p P{preset}: encode median {:.3} ms, p95 {:.3} ms, max {:.3} ms, {bytes} bytes",
                times[times.len() / 2],
                times[times.len() * 95 / 100],
                times[times.len() - 1]
            );
        }
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
            let mut encoder = NativeEncoder::new(None, w, h, 60, 16_000_000, EncoderTuning::default()).expect("NVENC hardware required");
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
