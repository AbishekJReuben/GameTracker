//! **NVENC** H.264 encoding for the remote screen stream.
//!
//! ## Why this exists (do not regress)
//! The old DIRECT path made the pixels cross the GPU/CPU boundary four times and
//! compressed them twice: DXGI texture → GPU downscale → CPU readback → JPEG encode
//! → IPC (≈334 KB/frame) → JPEG decode in the webview → canvas → `VideoFrame(canvas)`
//! → back into the GPU process → MediaFoundation H.264. Measured on an RTX 4070 Ti,
//! that round trip cost **~27 ms of FIXED overhead** — a 2×2 pixel frame still took
//! 27.5 ms to "encode", which proves the cost is the pipeline, not the encoding.
//!
//! Here the duplication texture is handed straight to NVENC on the same D3D11 device.
//! No readback, no JPEG, no canvas, no second encoder. The webview only ever sees the
//! finished ~30 KB Annex-B frame and forwards it to the data channel.
//!
//! ## Latency-shaped on purpose
//! Preset **P1 + ULTRA_LOW_LATENCY**, CBR, `frameIntervalP = 1` (no B-frames),
//! `zeroReorderDelay`, no lookahead, infinite GOP with IDRs only on demand, and
//! `maxNumRefFrames = 1`. The last one matters off-host: NVENC defaults the DPB to 16,
//! which makes some Android decoders allocate 16+ buffers (Moonlight decoder-errata #1).
//!
//! Profile is **Constrained Baseline + CAVLC** (not High+CABAC): Moonlight errata #8 —
//! some Android HW decoders refuse to enter low-latency mode when the SPS says High,
//! because B-frames *could* be present. Baseline forbids them at the profile level.
//! Multi-slice encode (`sliceMode=3`) lets the phone's decoder parallelise across
//! cores and cuts wall-clock decode ms on mid-range SoCs.
//! Output still goes through [`sps`] to fix the two VUI fields NVENC won't expose.
//!
//! Absent DLL / non-NVIDIA GPU / any init failure ⇒ [`Encoder::new`] returns `None` and
//! the caller keeps the JPEG path. NVENC is an optimisation, never a requirement.

#![cfg(windows)]

pub mod ffi;
pub mod sps;

use std::ffi::c_void;
use std::sync::OnceLock;

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};

use ffi::*;

/// How many slices to put in a frame of the given height.
///
/// Sunshine/Moonlight use `sliceMode=3` (N slices/picture) so the phone's HW decoder
/// can parallelise. Too few and a mid-range SoC sits on one core for ~16–25 ms; too
/// many wastes bits. ~1 slice per 540 px → 1080p gets 2, 1440p gets 3, 4K gets 4–8.
fn slices_for_height(h: u32) -> u32 {
    ((h + 539) / 540).clamp(1, 8)
}

/// Apply the phone-friendly H.264 knobs onto a fresh preset config. Shared by
/// `open_session` and `reconfigure` so they can never drift apart.
///
/// # Safety
/// `cfg.encodeCodecConfig` is a C union; the caller must have just filled it from
/// an H.264 preset so the `h264Config` arm is the live one.
unsafe fn apply_h264_guest_friendly(cfg: &mut NV_ENC_CONFIG, p: &Params) {
    cfg.profileGUID = NV_ENC_H264_PROFILE_BASELINE_GUID;
    // Infinite GOP: keyframes cost bandwidth and the transport is reliable, so we
    // only emit them on demand (guest `vkf`, resolution change, first frame).
    cfg.gopLength = NVENC_INFINITE_GOPLENGTH;
    // 1 == "IDR, P, P, P…" — no B-frames, so nothing is ever reordered.
    cfg.frameIntervalP = 1;
    cfg.frameFieldMode = NV_ENC_PARAMS_FRAME_FIELD_MODE_FRAME;
    cfg.mvPrecision = NV_ENC_MV_PRECISION_QUARTER_PEL;

    let rc = &mut cfg.rcParams;
    rc.version = NV_ENC_RC_PARAMS_VER;
    rc.rateControlMode = NV_ENC_PARAMS_RC_CBR;
    rc.averageBitRate = p.bitrate_bps;
    rc.maxBitRate = p.bitrate_bps;
    // One frame of VBV = the encoder must fit every frame in its own budget rather
    // than spending a burst it pays back later. This is the classic low-latency CBR
    // setup (Sunshine does the same); it's what stops IDR spikes from queueing.
    rc.vbvBufferSize = p.bitrate_bps / p.fps.max(1);
    rc.vbvInitialDelay = rc.vbvBufferSize;
    rc.set_zero_reorder_delay(true);
    rc.set_enable_lookahead(false);
    rc.set_enable_aq(false);
    rc.multiPass = NV_ENC_MULTI_PASS_DISABLED;
    rc.lookaheadDepth = 0;

    let h264 = &mut cfg.encodeCodecConfig.h264Config;
    h264.idrPeriod = NVENC_INFINITE_GOPLENGTH;
    h264.chromaFormatIDC = 1; // yuv420
    // Baseline forbids CABAC and the 8×8 adaptive transform — CAVLC is also a few
    // ms cheaper to decode on software paths (Sunshine's `nvenc_h264_cavlc` knob).
    h264.entropyCodingMode = NV_ENC_H264_ENTROPY_CODING_MODE_CAVLC;
    h264.adaptiveTransformMode = NV_ENC_H264_ADAPTIVE_TRANSFORM_DISABLE;
    // DPB of 1: the phone only ever needs the previous frame. Moonlight errata #1 —
    // NVENC's default of 16 makes some Android decoders allocate 16+ buffers.
    h264.maxNumRefFrames = 1;
    h264.numRefL0 = NV_ENC_NUM_REF_FRAMES_1;
    // Multi-slice: wall-clock decode on the phone scales with cores, not with
    // frame size. Same knob Sunshine sets from the client's `slicesPerFrame`.
    h264.sliceMode = NV_ENC_H264_SLICE_MODE_NUM_SLICES;
    h264.sliceModeData = slices_for_height(p.height);
    // Re-send SPS/PPS with every IDR so a guest that joins (or rebuilds its decoder)
    // can start from the next keyframe without a side-channel config message.
    h264.set_repeat_sps_pps(true);
    h264.set_output_aud(false);
    // Ask for the VUI bitstream-restriction block; `sps::fixup` then corrects the
    // reorder/buffering values inside it (NVENC exposes no field for them).
    h264.h264VUIParameters.bitstreamRestrictionFlag = 1;
    h264.h264VUIParameters.videoSignalTypePresentFlag = 1;
    h264.h264VUIParameters.videoFullRangeFlag = 0;
}

/// `NvEncodeAPICreateInstance` / `NvEncodeAPIGetMaxSupportedVersion` from the driver DLL.
struct Api {
    funcs: NV_ENCODE_API_FUNCTION_LIST,
}

// Safety: the function table is a plain vector of code pointers owned by the driver
// DLL, which stays loaded for the process lifetime. Encoder *sessions* are not shared
// across threads (each capture thread owns its own).
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

static API: OnceLock<Option<Api>> = OnceLock::new();

type PCreateInstance = unsafe extern "C" fn(*mut NV_ENCODE_API_FUNCTION_LIST) -> u32;
type PGetMaxVersion = unsafe extern "C" fn(*mut u32) -> u32;

/// Load `nvEncodeAPI64.dll` once. Returns `None` on any machine without a usable
/// NVIDIA encoder (no DLL, driver older than our header, or the driver refuses).
fn api() -> Option<&'static Api> {
    API.get_or_init(|| unsafe {
        use windows::core::s;
        use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};

        let lib = LoadLibraryA(s!("nvEncodeAPI64.dll")).ok()?;
        let get_max: PGetMaxVersion =
            std::mem::transmute(GetProcAddress(lib, s!("NvEncodeAPIGetMaxSupportedVersion"))?);
        let create: PCreateInstance = std::mem::transmute(GetProcAddress(lib, s!("NvEncodeAPICreateInstance"))?);

        // The driver refuses NvEncodeAPICreateInstance outright if we ask for a newer
        // API than it implements, so check first and fall back cleanly instead.
        let mut max_ver: u32 = 0;
        if get_max(&mut max_ver) != NV_ENC_SUCCESS {
            return None;
        }
        let want = (NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION;
        if max_ver < want {
            eprintln!(
                "[nvenc] driver supports API {}.{}, we need {}.{} — falling back to the JPEG path",
                max_ver >> 4,
                max_ver & 0xf,
                NVENCAPI_MAJOR_VERSION,
                NVENCAPI_MINOR_VERSION
            );
            return None;
        }

        let mut funcs = NV_ENCODE_API_FUNCTION_LIST {
            version: NV_ENCODE_API_FUNCTION_LIST_VER,
            ..Default::default()
        };
        if create(&mut funcs) != NV_ENC_SUCCESS {
            return None;
        }
        // Every entry point we actually call must be present before we trust the table.
        if funcs.nvEncOpenEncodeSessionEx.is_none()
            || funcs.nvEncInitializeEncoder.is_none()
            || funcs.nvEncEncodePicture.is_none()
            || funcs.nvEncLockBitstream.is_none()
            || funcs.nvEncUnlockBitstream.is_none()
            || funcs.nvEncRegisterResource.is_none()
            || funcs.nvEncMapInputResource.is_none()
            || funcs.nvEncUnmapInputResource.is_none()
            || funcs.nvEncCreateBitstreamBuffer.is_none()
            || funcs.nvEncGetEncodePresetConfigEx.is_none()
            || funcs.nvEncDestroyEncoder.is_none()
        {
            eprintln!("[nvenc] driver returned an incomplete function table");
            return None;
        }
        Some(Api { funcs })
    })
    .as_ref()
}

/// True when this machine has a usable NVENC (cheap after the first call).
pub fn available() -> bool {
    api().is_some()
}

/// One encoded frame, Annex-B, ready to ship.
pub struct Frame<'a> {
    pub data: &'a [u8],
    pub key: bool,
}

/// Tuning knobs the phone can change mid-stream without a session rebuild.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Params {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_bps: u32,
}

/// A live NVENC session bound to one D3D11 device.
pub struct Encoder {
    enc: *mut c_void,
    funcs: &'static NV_ENCODE_API_FUNCTION_LIST,
    bitstream: *mut c_void,
    /// Registered input textures, keyed by the raw texture pointer. Desktop
    /// Duplication recycles a small pool, so this stays tiny; registration is
    /// expensive enough that doing it per frame would defeat the point.
    registered: Vec<(*mut c_void, *mut c_void)>,
    params: Params,
    /// Scratch for the SPS-fixed-up output so we don't allocate per frame.
    out: Vec<u8>,
    /// Set once we've logged what NVENC's SPS actually looked like.
    sps_logged: bool,
}

impl Encoder {
    /// Build a session on `device`. `None` ⇒ caller uses the JPEG fallback.
    pub fn new(device: &ID3D11Device, p: Params) -> Option<Self> {
        let api = api()?;
        let funcs = &api.funcs;
        unsafe {
            let mut session = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
                version: NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER,
                deviceType: NV_ENC_DEVICE_TYPE_DIRECTX,
                device: device.as_raw(),
                apiVersion: NVENCAPI_VERSION,
                ..Default::default()
            };
            let mut enc: *mut c_void = std::ptr::null_mut();
            let st = (funcs.nvEncOpenEncodeSessionEx?)(&mut session, &mut enc);
            if st != NV_ENC_SUCCESS || enc.is_null() {
                eprintln!("[nvenc] OpenEncodeSessionEx failed: {st}");
                return None;
            }

            let mut me = Encoder {
                enc,
                funcs,
                bitstream: std::ptr::null_mut(),
                registered: Vec::new(),
                params: p,
                out: Vec::new(),
                sps_logged: false,
            };
            if let Err(e) = me.init(p) {
                eprintln!("[nvenc] initialize failed: {e}");
                return None; // Drop runs DestroyEncoder
            }
            Some(me)
        }
    }

    unsafe fn init(&mut self, p: Params) -> Result<(), String> {
        let funcs = self.funcs;

        // Start from the driver's own P1 + ultra-low-latency config so we inherit
        // whatever this GPU generation considers sane, then override the latency bits.
        let mut preset = NV_ENC_PRESET_CONFIG {
            version: NV_ENC_PRESET_CONFIG_VER,
            ..Default::default()
        };
        preset.presetCfg.version = NV_ENC_CONFIG_VER;
        let st = (funcs
            .nvEncGetEncodePresetConfigEx
            .ok_or("no GetEncodePresetConfigEx")?)(
            self.enc,
            NV_ENC_CODEC_H264_GUID,
            NV_ENC_PRESET_P1_GUID,
            NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
            &mut preset,
        );
        if st != NV_ENC_SUCCESS {
            return Err(format!("GetEncodePresetConfigEx: {st}"));
        }

        let mut cfg = preset.presetCfg;
        cfg.version = NV_ENC_CONFIG_VER;
        // SAFETY: presetCfg was filled by GetEncodePresetConfigEx for H.264.
        unsafe { apply_h264_guest_friendly(&mut cfg, &p) };

        let mut init = NV_ENC_INITIALIZE_PARAMS {
            version: NV_ENC_INITIALIZE_PARAMS_VER,
            encodeGUID: NV_ENC_CODEC_H264_GUID,
            presetGUID: NV_ENC_PRESET_P1_GUID,
            encodeWidth: p.width,
            encodeHeight: p.height,
            darWidth: p.width,
            darHeight: p.height,
            frameRateNum: p.fps,
            frameRateDen: 1,
            // Synchronous: we lock the bitstream right after submitting. Async mode
            // needs a Win32 event per frame and buys nothing at one frame in flight.
            enableEncodeAsync: 0,
            // Let NVENC pick picture types; with frameIntervalP=1 that's IDR then all P.
            enablePTD: 1,
            encodeConfig: &mut cfg,
            maxEncodeWidth: p.width,
            maxEncodeHeight: p.height,
            tuningInfo: NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
            bufferFormat: NV_ENC_BUFFER_FORMAT_ARGB,
            ..Default::default()
        };
        let st = (funcs.nvEncInitializeEncoder.ok_or("no InitializeEncoder")?)(self.enc, &mut init);
        if st != NV_ENC_SUCCESS {
            return Err(format!("InitializeEncoder: {st} ({})", self.last_error()));
        }

        let mut bs = NV_ENC_CREATE_BITSTREAM_BUFFER {
            version: NV_ENC_CREATE_BITSTREAM_BUFFER_VER,
            ..Default::default()
        };
        let st = (funcs.nvEncCreateBitstreamBuffer.ok_or("no CreateBitstreamBuffer")?)(self.enc, &mut bs);
        if st != NV_ENC_SUCCESS {
            return Err(format!("CreateBitstreamBuffer: {st}"));
        }
        self.bitstream = bs.bitstreamBuffer;
        self.params = p;
        Ok(())
    }

    fn last_error(&self) -> String {
        unsafe {
            let Some(f) = self.funcs.nvEncGetLastErrorString else {
                return String::new();
            };
            let p = f(self.enc);
            if p.is_null() {
                return String::new();
            }
            std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned()
        }
    }

    pub fn params(&self) -> Params {
        self.params
    }

    /// Apply a new bitrate/fps without rebuilding the session. Size changes need a
    /// fresh [`Encoder`] — the caller rebuilds (and the guest resyncs on the IDR).
    pub fn reconfigure(&mut self, p: Params) -> Result<(), String> {
        if p.width != self.params.width || p.height != self.params.height {
            return Err("resolution change needs a new session".into());
        }
        unsafe {
            let mut preset = NV_ENC_PRESET_CONFIG {
                version: NV_ENC_PRESET_CONFIG_VER,
                ..Default::default()
            };
            preset.presetCfg.version = NV_ENC_CONFIG_VER;
            let st = (self.funcs.nvEncGetEncodePresetConfigEx.ok_or("no preset")?)(
                self.enc,
                NV_ENC_CODEC_H264_GUID,
                NV_ENC_PRESET_P1_GUID,
                NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
                &mut preset,
            );
            if st != NV_ENC_SUCCESS {
                return Err(format!("preset: {st}"));
            }
            let mut cfg = preset.presetCfg;
            cfg.version = NV_ENC_CONFIG_VER;
            // SAFETY: presetCfg was filled by GetEncodePresetConfigEx for H.264.
            unsafe { apply_h264_guest_friendly(&mut cfg, &p) };

            let mut re = NV_ENC_RECONFIGURE_PARAMS {
                version: NV_ENC_RECONFIGURE_PARAMS_VER,
                ..Default::default()
            };
            re.reInitEncodeParams = NV_ENC_INITIALIZE_PARAMS {
                version: NV_ENC_INITIALIZE_PARAMS_VER,
                encodeGUID: NV_ENC_CODEC_H264_GUID,
                presetGUID: NV_ENC_PRESET_P1_GUID,
                encodeWidth: p.width,
                encodeHeight: p.height,
                darWidth: p.width,
                darHeight: p.height,
                frameRateNum: p.fps,
                frameRateDen: 1,
                enableEncodeAsync: 0,
                enablePTD: 1,
                encodeConfig: &mut cfg,
                maxEncodeWidth: self.params.width,
                maxEncodeHeight: self.params.height,
                tuningInfo: NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
                bufferFormat: NV_ENC_BUFFER_FORMAT_ARGB,
                ..Default::default()
            };
            let st = (self.funcs.nvEncReconfigureEncoder.ok_or("no Reconfigure")?)(self.enc, &mut re);
            if st != NV_ENC_SUCCESS {
                return Err(format!("Reconfigure: {st} ({})", self.last_error()));
            }
            self.params = p;
            Ok(())
        }
    }

    /// Register (once) and map a duplication texture as NVENC input.
    unsafe fn map(&mut self, tex: &ID3D11Texture2D) -> Result<*mut c_void, String> {
        let raw = tex.as_raw();
        let reg = match self.registered.iter().find(|(t, _)| *t == raw) {
            Some((_, r)) => *r,
            None => {
                let mut rr = NV_ENC_REGISTER_RESOURCE {
                    version: NV_ENC_REGISTER_RESOURCE_VER,
                    resourceType: NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX,
                    width: self.params.width,
                    height: self.params.height,
                    pitch: 0, // must be 0 for DirectX resources
                    resourceToRegister: raw,
                    bufferFormat: NV_ENC_BUFFER_FORMAT_ARGB,
                    bufferUsage: NV_ENC_INPUT_IMAGE,
                    ..Default::default()
                };
                let st = (self.funcs.nvEncRegisterResource.ok_or("no RegisterResource")?)(self.enc, &mut rr);
                if st != NV_ENC_SUCCESS {
                    return Err(format!("RegisterResource: {st} ({})", self.last_error()));
                }
                self.registered.push((raw, rr.registeredResource));
                rr.registeredResource
            }
        };
        let mut m = NV_ENC_MAP_INPUT_RESOURCE {
            version: NV_ENC_MAP_INPUT_RESOURCE_VER,
            registeredResource: reg,
            ..Default::default()
        };
        let st = (self.funcs.nvEncMapInputResource.ok_or("no MapInputResource")?)(self.enc, &mut m);
        if st != NV_ENC_SUCCESS {
            return Err(format!("MapInputResource: {st} ({})", self.last_error()));
        }
        Ok(m.mappedResource)
    }

    /// Encode one texture. `force_key` emits an IDR (guest `vkf`, first frame, resync).
    /// Returns the Annex-B frame, already SPS-fixed. Borrows `self` for the frame's
    /// lifetime because the bytes live in our reusable scratch buffer.
    pub fn encode(&mut self, tex: &ID3D11Texture2D, force_key: bool, ts_us: u64) -> Result<Frame<'_>, String> {
        unsafe {
            let mapped = self.map(tex)?;

            let mut pic = NV_ENC_PIC_PARAMS {
                version: NV_ENC_PIC_PARAMS_VER,
                inputWidth: self.params.width,
                inputHeight: self.params.height,
                inputPitch: self.params.width,
                encodePicFlags: if force_key {
                    // FORCEIDR (2) — also re-emits SPS/PPS thanks to repeatSPSPPS.
                    NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS
                } else {
                    0
                },
                inputTimeStamp: ts_us,
                inputBuffer: mapped,
                outputBitstream: self.bitstream,
                bufferFmt: NV_ENC_BUFFER_FORMAT_ARGB,
                pictureStruct: NV_ENC_PIC_STRUCT_FRAME,
                ..Default::default()
            };
            let st = (self.funcs.nvEncEncodePicture.ok_or("no EncodePicture")?)(self.enc, &mut pic);
            // Unmap before bailing on an error — a leaked mapping wedges the session.
            let unmap = || {
                if let Some(f) = self.funcs.nvEncUnmapInputResource {
                    let _ = f(self.enc, mapped);
                }
            };
            if st != NV_ENC_SUCCESS && st != NV_ENC_ERR_NEED_MORE_INPUT {
                unmap();
                return Err(format!("EncodePicture: {st} ({})", self.last_error()));
            }

            let mut lock = NV_ENC_LOCK_BITSTREAM {
                version: NV_ENC_LOCK_BITSTREAM_VER,
                outputBitstream: self.bitstream,
                ..Default::default()
            };
            lock.set_do_not_wait(false);
            let st = (self.funcs.nvEncLockBitstream.ok_or("no LockBitstream")?)(self.enc, &mut lock);
            if st != NV_ENC_SUCCESS {
                unmap();
                return Err(format!("LockBitstream: {st} ({})", self.last_error()));
            }

            let src = std::slice::from_raw_parts(lock.bitstreamBufferPtr as *const u8, lock.bitstreamSizeInBytes as usize);
            let key = lock.pictureType == NV_ENC_PIC_TYPE_IDR || lock.pictureType == NV_ENC_PIC_TYPE_I;

            self.out.clear();
            let rewrote = sps::fixup_into(src, &mut self.out);
            if key && !self.sps_logged {
                self.sps_logged = true;
                sps::log_summary(src);
            }

            if let Some(f) = self.funcs.nvEncUnlockBitstream {
                let _ = f(self.enc, self.bitstream);
            }
            unmap();
            let _ = rewrote;
            Ok(Frame {
                data: &self.out,
                key,
            })
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            for (_, reg) in self.registered.drain(..) {
                if let Some(f) = self.funcs.nvEncUnregisterResource {
                    let _ = f(self.enc, reg);
                }
            }
            if !self.bitstream.is_null() {
                if let Some(f) = self.funcs.nvEncDestroyBitstreamBuffer {
                    let _ = f(self.enc, self.bitstream);
                }
            }
            if !self.enc.is_null() {
                if let Some(f) = self.funcs.nvEncDestroyEncoder {
                    let _ = f(self.enc);
                }
            }
        }
    }
}

// Safety: an Encoder owns its session exclusively and is moved to (not shared with)
// the capture thread. It is deliberately NOT Sync.
unsafe impl Send for Encoder {}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

    /// Drives the real `nvEncodeAPI64.dll` end to end: opens a session on a D3D11
    /// device, encodes real textures, and prints what NVENC's SPS actually contains.
    ///
    /// `#[ignore]`d because it needs an NVIDIA GPU — CI and non-NVIDIA dev machines
    /// must not fail on it. Run it deliberately:
    ///   `cargo test --lib remote::nvenc::tests::nvenc_smoke -- --ignored --nocapture`
    ///
    /// This is the test that validates the hand-written FFI against the live driver:
    /// a wrong struct offset shows up here as a failed init or a garbage bitstream
    /// rather than as memory corruption in production.
    #[test]
    #[ignore = "needs an NVIDIA GPU"]
    fn nvenc_smoke() {
        if !available() {
            eprintln!("no NVENC on this machine — skipping");
            return;
        }
        unsafe {
            let mut device = None;
            D3D11CreateDevice(
                None::<&windows::Win32::Graphics::Dxgi::IDXGIAdapter>,
                D3D_DRIVER_TYPE_HARDWARE,
                windows::Win32::Foundation::HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
            .expect("create d3d11 device");
            let device = device.expect("device");

            let (w, h) = (1920u32, 1080u32);
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
            let mut tex = None;
            device.CreateTexture2D(&desc, None, Some(&mut tex)).expect("texture");
            let tex = tex.expect("texture");

            let mut enc = Encoder::new(
                &device,
                Params {
                    width: w,
                    height: h,
                    fps: 60,
                    bitrate_bps: 12_000_000,
                },
            )
            .expect("NVENC session — if this fails with an NVIDIA GPU present, suspect the FFI layout");

            // First frame is an IDR and carries the SPS/PPS we care about.
            let mut times = Vec::new();
            for i in 0..30 {
                let t0 = std::time::Instant::now();
                let f = enc.encode(&tex, i == 0, i as u64 * 16_667).expect("encode");
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                if i == 0 {
                    assert!(f.key, "first frame must be a keyframe");
                    assert!(f.data.len() > 4, "keyframe must carry bytes");
                    assert_eq!(&f.data[..4], &[0, 0, 0, 1], "expected Annex-B start code");
                    // The SPS we ship must declare the low-latency DPB hints.
                    let units = sps::nal_units_for_test(f.data);
                    let sps_nal = units
                        .iter()
                        .map(|&(s, e)| &f.data[s..e])
                        .find(|n| !n.is_empty() && n[0] & 0x1f == 7)
                        .expect("SPS present in the IDR");
                    let info = sps::summarize(&sps::unescape_for_test(&sps_nal[1..])).expect("parse shipped SPS");
                    eprintln!("shipped SPS: {info:?}");
                    assert_eq!(info.max_num_ref_frames, 1, "DPB must be pinned to 1");
                    assert_eq!(info.max_num_reorder_frames, Some(0), "must declare zero reordering");
                    assert_eq!(info.max_dec_frame_buffering, Some(1), "must declare a 1-frame DPB");
                } else {
                    times.push(ms);
                }
            }
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let median = times[times.len() / 2];
            eprintln!(
                "NVENC 1080p encode: median {:.2} ms over {} frames (min {:.2}, max {:.2})",
                median,
                times.len(),
                times[0],
                times[times.len() - 1]
            );
            // The WebCodecs path this replaces measured ~35 ms (27 ms of it fixed
            // overhead). Anything near that means we didn't actually escape it.
            assert!(median < 10.0, "expected single-digit ms encode, got {median:.2}");
        }
    }
}
