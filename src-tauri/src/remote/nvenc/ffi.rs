//! Hand-written FFI for NVIDIA's **NVENC** encoder API (`nvEncodeAPI64.dll`).
//!
//! Why hand-written: the published binding crates (`nvidia-video-codec-sdk`, `nvenc`)
//! need the NVIDIA Video Codec SDK *installed* and pull in `cudarc`, which would break
//! this repo's turnkey "clone and `cargo build`" rule (see AGENTS.md §2) and add a CUDA
//! dependency we don't want — we feed the encoder a **D3D11 texture**, not CUDA memory.
//! `nvEncodeAPI64.dll` ships with every NVIDIA display driver, so loading it dynamically
//! needs no SDK, no import lib, and no build step: absent DLL simply means "no NVENC
//! here" and the caller falls back to the JPEG path.
//!
//! ## Why API 12.0 and not the newest
//! NVENC is **backward** compatible: a newer driver happily accepts an older API
//! version, but not the reverse. Targeting 12.0 (SDK 12.0, driver 522.25+, Oct 2022)
//! therefore covers far more machines than the current 13.1 would — this dev box's
//! 596-series driver reports a max supported API of **13.0**, so binding 13.1 would
//! have disabled NVENC on the very machine it's for. Struct layouts genuinely differ
//! between versions (`NV_ENC_INITIALIZE_PARAMS` is 1808 bytes at 12.0 vs 1800 at 13.1),
//! so the version and the layouts must move together — never bump one alone.
//! Everything this module needs (ultra-low-latency tuning, `zeroReorderDelay`,
//! `maxNumRefFrames`, the VUI bitstream-restriction flag) exists in 12.0.
//!
//! ## Layouts are verified, not guessed
//! Every struct mirrors `nvEncodeAPI.h` from FFmpeg's **nv-codec-headers** (MIT), tag
//! `n12.0.16.0`. The sizes/offsets in the `const _: () = assert!(...)` blocks are
//! machine-generated ground truth: `scripts/nvenc-abi-probe.c` compiles that header
//! with MSVC and prints `sizeof`/`offsetof`. They are NOT hand-arithmetic — hand
//! arithmetic already got the function table wrong once (`Option<*mut c_void>` has no
//! null-pointer optimisation, so every slot was 16 bytes and silently misaligned; the
//! asserts caught it). A wrong offset here is memory corruption inside the display
//! driver, so **if you touch a struct, re-run the probe and update the asserts.**
//! `reserved*` tails are load-bearing padding: NVENC validates the `version` field
//! (which encodes the layout) and will reject or misread a short struct. Structs whose
//! interior we don't use are declared head-fields-then-`tail: [u8; N]` on purpose.
//!
//! Only the subset needed for realtime D3D11 → H.264 is bound; unused entry points are
//! typed as opaque pointer slots so the function-table offsets still line up.

#![cfg(windows)]
#![allow(non_snake_case, non_camel_case_types, dead_code)]

use std::ffi::c_void;
use windows::core::GUID;

// ---- versioning -----------------------------------------------------------
// NVENCAPI_VERSION = MAJOR | (MINOR << 24); struct versions layer the struct
// revision and a 0x7 tag on top. Mirrors the macros in nvEncodeAPI.h.
pub const NVENCAPI_MAJOR_VERSION: u32 = 12;
pub const NVENCAPI_MINOR_VERSION: u32 = 0;
pub const NVENCAPI_VERSION: u32 = NVENCAPI_MAJOR_VERSION | (NVENCAPI_MINOR_VERSION << 24);

const fn struct_ver(v: u32) -> u32 {
    NVENCAPI_VERSION | (v << 16) | (0x7 << 28)
}

pub const NV_ENC_CAPS_PARAM_VER: u32 = struct_ver(1);
pub const NV_ENC_CREATE_BITSTREAM_BUFFER_VER: u32 = struct_ver(1);
pub const NV_ENC_RC_PARAMS_VER: u32 = struct_ver(1);
pub const NV_ENC_CONFIG_VER: u32 = struct_ver(8) | (1 << 31);
pub const NV_ENC_INITIALIZE_PARAMS_VER: u32 = struct_ver(5) | (1 << 31);
pub const NV_ENC_RECONFIGURE_PARAMS_VER: u32 = struct_ver(1) | (1 << 31);
pub const NV_ENC_PRESET_CONFIG_VER: u32 = struct_ver(4) | (1 << 31);
pub const NV_ENC_PIC_PARAMS_VER: u32 = struct_ver(6) | (1 << 31);
pub const NV_ENC_LOCK_BITSTREAM_VER: u32 = struct_ver(2);
pub const NV_ENC_REGISTER_RESOURCE_VER: u32 = struct_ver(4);
pub const NV_ENC_MAP_INPUT_RESOURCE_VER: u32 = struct_ver(4);
pub const NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER: u32 = struct_ver(1);
pub const NV_ENCODE_API_FUNCTION_LIST_VER: u32 = struct_ver(2);

// Cross-check the version words against the probe (`const NV_ENC_*_VER` lines, abi12).
const _: () = assert!(NVENCAPI_VERSION == 0x0000_000C);
const _: () = assert!(NV_ENC_CONFIG_VER == 0xF008_000C);
const _: () = assert!(NV_ENC_INITIALIZE_PARAMS_VER == 0xF005_000C);
const _: () = assert!(NV_ENC_RECONFIGURE_PARAMS_VER == 0xF001_000C);
const _: () = assert!(NV_ENC_PRESET_CONFIG_VER == 0xF004_000C);
const _: () = assert!(NV_ENC_PIC_PARAMS_VER == 0xF006_000C);
const _: () = assert!(NV_ENC_LOCK_BITSTREAM_VER == 0x7002_000C);
const _: () = assert!(NV_ENC_REGISTER_RESOURCE_VER == 0x7004_000C);
const _: () = assert!(NV_ENC_MAP_INPUT_RESOURCE_VER == 0x7004_000C);
const _: () = assert!(NV_ENC_CREATE_BITSTREAM_BUFFER_VER == 0x7001_000C);
const _: () = assert!(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER == 0x7001_000C);
const _: () = assert!(NV_ENC_CAPS_PARAM_VER == 0x7001_000C);
const _: () = assert!(NV_ENC_RC_PARAMS_VER == 0x7001_000C);
const _: () = assert!(NV_ENCODE_API_FUNCTION_LIST_VER == 0x7002_000C);

pub const NVENC_INFINITE_GOPLENGTH: u32 = 0xffff_ffff;

// ---- enums (probed values) ------------------------------------------------
pub const NV_ENC_SUCCESS: u32 = 0;
pub const NV_ENC_ERR_UNSUPPORTED_DEVICE: u32 = 2;
pub const NV_ENC_ERR_INVALID_VERSION: u32 = 15;
pub const NV_ENC_ERR_NEED_MORE_INPUT: u32 = 17;

pub const NV_ENC_DEVICE_TYPE_DIRECTX: u32 = 0;
pub const NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX: u32 = 0;
pub const NV_ENC_INPUT_IMAGE: u32 = 0;
pub const NV_ENC_MEMORY_HEAP_AUTOSELECT: u32 = 0;

/// DXGI_FORMAT_B8G8R8A8_UNORM (what Desktop Duplication hands us) maps to ARGB here:
/// NVENC names its 8-bit packed formats by memory order, so B,G,R,A == "ARGB".
pub const NV_ENC_BUFFER_FORMAT_ARGB: u32 = 16_777_216; // 0x01000000
pub const NV_ENC_BUFFER_FORMAT_ABGR: u32 = 268_435_456; // 0x10000000
pub const NV_ENC_BUFFER_FORMAT_NV12: u32 = 1;

pub const NV_ENC_PARAMS_RC_CONSTQP: u32 = 0;
pub const NV_ENC_PARAMS_RC_VBR: u32 = 1;
pub const NV_ENC_PARAMS_RC_CBR: u32 = 2;

pub const NV_ENC_PIC_STRUCT_FRAME: u32 = 1;
pub const NV_ENC_PIC_TYPE_P: u32 = 0;
pub const NV_ENC_PIC_TYPE_I: u32 = 2;
pub const NV_ENC_PIC_TYPE_IDR: u32 = 3;

// NOTE the values: FORCEINTRA is 1 and FORCEIDR is 2 (not the other way round).
pub const NV_ENC_PIC_FLAG_FORCEINTRA: u32 = 1;
pub const NV_ENC_PIC_FLAG_FORCEIDR: u32 = 2;
pub const NV_ENC_PIC_FLAG_OUTPUT_SPSPPS: u32 = 4;

pub const NV_ENC_H264_ENTROPY_CODING_MODE_CABAC: u32 = 1;
pub const NV_ENC_H264_ENTROPY_CODING_MODE_CAVLC: u32 = 2;
pub const NV_ENC_H264_ADAPTIVE_TRANSFORM_AUTOSELECT: u32 = 0;
pub const NV_ENC_H264_ADAPTIVE_TRANSFORM_DISABLE: u32 = 1;
pub const NV_ENC_H264_ADAPTIVE_TRANSFORM_ENABLE: u32 = 2;
/// `sliceMode = 3` ⇒ `sliceModeData` is the number of slices in the picture.
pub const NV_ENC_H264_SLICE_MODE_NUM_SLICES: u32 = 3;

pub const NV_ENC_TUNING_INFO_LOW_LATENCY: u32 = 2;
pub const NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY: u32 = 3;
pub const NV_ENC_MULTI_PASS_DISABLED: u32 = 0;
pub const NV_ENC_PARAMS_FRAME_FIELD_MODE_FRAME: u32 = 1;
pub const NV_ENC_MV_PRECISION_QUARTER_PEL: u32 = 3;
pub const NV_ENC_NUM_REF_FRAMES_1: u32 = 1;

pub const NV_ENC_CAPS_NUM_MAX_BFRAMES: u32 = 0;
pub const NV_ENC_CAPS_WIDTH_MAX: u32 = 16;
pub const NV_ENC_CAPS_HEIGHT_MAX: u32 = 17;

// ---- GUIDs (probed) -------------------------------------------------------
pub const NV_ENC_CODEC_H264_GUID: GUID =
    GUID::from_values(0x6BC8_2762, 0x4E63, 0x4CA4, [0xAA, 0x85, 0x1E, 0x50, 0xF3, 0x21, 0xF6, 0xBF]);
pub const NV_ENC_H264_PROFILE_HIGH_GUID: GUID =
    GUID::from_values(0xE7CB_C309, 0x4F7A, 0x4B89, [0xAF, 0x2A, 0xD5, 0x37, 0xC9, 0x2B, 0xE3, 0x10]);
pub const NV_ENC_H264_PROFILE_MAIN_GUID: GUID =
    GUID::from_values(0x60B5_C1D4, 0x67FE, 0x4790, [0x94, 0xD5, 0xC4, 0x72, 0x6D, 0x7B, 0x6E, 0x6D]);
pub const NV_ENC_H264_PROFILE_BASELINE_GUID: GUID =
    GUID::from_values(0x0727_BCAA, 0x78C4, 0x4C83, [0x8C, 0x2F, 0xEF, 0x3D, 0xFF, 0x26, 0x7C, 0x6A]);
/// P1 = fastest. Paired with ULTRA_LOW_LATENCY tuning this is the Moonlight/Sunshine
/// style config: no B-frames, no lookahead, minimum encode latency.
pub const NV_ENC_PRESET_P1_GUID: GUID =
    GUID::from_values(0xFC0A_8D3E, 0x45F8, 0x4CF8, [0x80, 0xC7, 0x29, 0x88, 0x71, 0x59, 0x0E, 0xBF]);
pub const NV_ENC_PRESET_P2_GUID: GUID =
    GUID::from_values(0xF581_CFB8, 0x88D6, 0x4381, [0x93, 0xF0, 0xDF, 0x13, 0xF9, 0xC2, 0x7D, 0xAB]);
pub const NV_ENC_PRESET_P3_GUID: GUID =
    GUID::from_values(0x3685_0110, 0x3A07, 0x441F, [0x94, 0xD5, 0x36, 0x70, 0x63, 0x1F, 0x91, 0xF6]);
pub const NV_ENC_PRESET_P4_GUID: GUID =
    GUID::from_values(0x90A7_B826, 0xDF06, 0x4862, [0xB9, 0xD2, 0xCD, 0x6D, 0x73, 0xA0, 0x86, 0x81]);

// ---- structs --------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct NV_ENC_QP {
    pub qpInterP: u32,
    pub qpInterB: u32,
    pub qpIntra: u32,
}
const _: () = assert!(size_of::<NV_ENC_QP>() == 12);

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_CAPS_PARAM {
    pub version: u32,
    pub capsToQuery: u32,
    pub reserved: [u32; 62],
}
const _: () = assert!(size_of::<NV_ENC_CAPS_PARAM>() == 256);

impl Default for NV_ENC_CAPS_PARAM {
    fn default() -> Self {
        // `[u32; 62]` has no derived Default (arrays only derive up to 32).
        unsafe { std::mem::zeroed() }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_RC_PARAMS {
    pub version: u32,
    pub rateControlMode: u32,
    pub constQP: NV_ENC_QP,
    pub averageBitRate: u32,
    pub maxBitRate: u32,
    pub vbvBufferSize: u32,
    pub vbvInitialDelay: u32,
    /// Packed bitfields. Bit order (LSB first) matches the C declaration:
    /// 0 enableMinQP, 1 enableMaxQP, 2 enableInitialRCQP, 3 enableAQ,
    /// 4 reservedBitField1, 5 enableLookahead, 6 disableIadapt, 7 disableBadapt,
    /// 8 enableTemporalAQ, 9 zeroReorderDelay, 10 enableNonRefP, 11 strictGOPTarget,
    /// 12..15 aqStrength, 16 enableExtLookahead, 17..31 reserved.
    pub bitfields: u32,
    pub minQP: NV_ENC_QP,
    pub maxQP: NV_ENC_QP,
    pub initialRCQP: NV_ENC_QP,
    pub temporallayerIdxMask: u32,
    pub temporalLayerQP: [u8; 8],
    pub targetQuality: u8,
    pub targetQualityLSB: u8,
    pub lookaheadDepth: u16,
    pub lowDelayKeyFrameScale: u8,
    pub yDcQPIndexOffset: i8,
    pub uDcQPIndexOffset: i8,
    pub vDcQPIndexOffset: i8,
    pub qpMapMode: u32,
    pub multiPass: u32,
    pub alphaLayerBitrateRatio: u32,
    pub cbQPIndexOffset: i8,
    pub crQPIndexOffset: i8,
    pub reserved2: u16,
    pub reserved: [u32; 4],
}
const _: () = assert!(size_of::<NV_ENC_RC_PARAMS>() == 128);

impl Default for NV_ENC_RC_PARAMS {
    fn default() -> Self {
        // Safety: the struct is plain-old-data (no refs/enums with niches), and NVENC
        // requires unused fields to be zero anyway.
        unsafe { std::mem::zeroed() }
    }
}

impl NV_ENC_RC_PARAMS {
    pub fn set_enable_min_qp(&mut self, on: bool) {
        self.set_bit(0, on);
    }
    pub fn set_enable_max_qp(&mut self, on: bool) {
        self.set_bit(1, on);
    }
    pub fn set_enable_aq(&mut self, on: bool) {
        self.set_bit(3, on);
    }
    pub fn set_enable_lookahead(&mut self, on: bool) {
        self.set_bit(5, on);
    }
    /// Tells NVENC the output order == input order, so it never holds a frame back.
    /// Half of the "phone decodes instantly" story; the other half is the SPS fixup.
    pub fn set_zero_reorder_delay(&mut self, on: bool) {
        self.set_bit(9, on);
    }
    pub fn set_enable_non_ref_p(&mut self, on: bool) {
        self.set_bit(10, on);
    }
    fn set_bit(&mut self, bit: u32, on: bool) {
        if on {
            self.bitfields |= 1 << bit;
        } else {
            self.bitfields &= !(1 << bit);
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_CONFIG_H264_VUI_PARAMETERS {
    pub overscanInfoPresentFlag: u32,
    pub overscanInfo: u32,
    pub videoSignalTypePresentFlag: u32,
    pub videoFormat: u32,
    pub videoFullRangeFlag: u32,
    pub colourDescriptionPresentFlag: u32,
    pub colourPrimaries: u32,
    pub transferCharacteristics: u32,
    pub colourMatrix: u32,
    pub chromaSampleLocationFlag: u32,
    pub chromaSampleLocationTop: u32,
    pub chromaSampleLocationBot: u32,
    /// Makes NVENC emit the bitstream-restriction block in the SPS VUI. NVENC picks its
    /// own `max_num_reorder_frames` / `max_dec_frame_buffering` values and exposes no
    /// field for them — which is exactly the Moonlight decoder-errata #2 problem — so
    /// `super::sps` rewrites those two afterwards.
    pub bitstreamRestrictionFlag: u32,
    pub timingInfoPresentFlag: u32,
    pub numUnitInTicks: u32,
    pub timeScale: u32,
    pub reserved: [u32; 12],
}
const _: () = assert!(size_of::<NV_ENC_CONFIG_H264_VUI_PARAMETERS>() == 112);

impl Default for NV_ENC_CONFIG_H264_VUI_PARAMETERS {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_CONFIG_H264 {
    /// LSB-first: 0 enableTemporalSVC, 1 enableStereoMVC, 2 hierarchicalPFrames,
    /// 3 hierarchicalBFrames, 4 outputBufferingPeriodSEI, 5 outputPictureTimingSEI,
    /// 6 outputAUD, 7 disableSPSPPS, 8 outputFramePackingSEI, 9 outputRecoveryPointSEI,
    /// 10 enableIntraRefresh, 11 enableConstrainedEncoding, 12 repeatSPSPPS,
    /// 13 enableVFR, 14 enableLTR, 15 qpPrimeYZeroTransformBypassFlag,
    /// 16 useConstrainedIntraPred, 17 enableFillerDataInsertion, 18 disableSVCPrefixNalu,
    /// 19 enableScalabilityInfoSEI, 20 singleSliceIntraRefresh, 21 enableTimeCode,
    /// 22..31 reservedBitFields.
    pub bitfields: u32,
    pub level: u32,
    pub idrPeriod: u32,
    pub separateColourPlaneFlag: u32,
    pub disableDeblockingFilterIDC: u32,
    pub numTemporalLayers: u32,
    pub spsId: u32,
    pub ppsId: u32,
    pub adaptiveTransformMode: u32,
    pub fmoMode: u32,
    pub bdirectMode: u32,
    pub entropyCodingMode: u32,
    pub stereoMode: u32,
    pub intraRefreshPeriod: u32,
    pub intraRefreshCnt: u32,
    /// DPB size. NVENC defaults this to 16, which per Moonlight errata #1 makes some
    /// Android decoders allocate 16+ buffers (lag, or outright failure). We pin it to 1.
    pub maxNumRefFrames: u32,
    pub sliceMode: u32,
    pub sliceModeData: u32,
    pub h264VUIParameters: NV_ENC_CONFIG_H264_VUI_PARAMETERS,
    pub ltrNumFrames: u32,
    pub ltrTrustMode: u32,
    pub chromaFormatIDC: u32,
    pub maxTemporalLayers: u32,
    pub useBFramesAsRef: u32,
    pub numRefL0: u32,
    pub numRefL1: u32,
    pub reserved1: [u32; 267],
    pub reserved2: [*mut c_void; 64],
}
const _: () = assert!(size_of::<NV_ENC_CONFIG_H264>() == 1792);

impl Default for NV_ENC_CONFIG_H264 {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

impl NV_ENC_CONFIG_H264 {
    pub fn set_repeat_sps_pps(&mut self, on: bool) {
        self.set_bit(12, on);
    }
    pub fn set_output_aud(&mut self, on: bool) {
        self.set_bit(6, on);
    }
    pub fn set_disable_sps_pps(&mut self, on: bool) {
        self.set_bit(7, on);
    }
    pub fn set_enable_intra_refresh(&mut self, on: bool) {
        self.set_bit(10, on);
    }
    fn set_bit(&mut self, bit: u32, on: bool) {
        if on {
            self.bitfields |= 1 << bit;
        } else {
            self.bitfields &= !(1 << bit);
        }
    }
}

/// `NV_ENC_CODEC_CONFIG`. Sized by its **largest** member (`h264Config`, 1792) — the
/// `reserved[320]` filler in the header is only 1280 bytes, so sizing off that would
/// hand NVENC a short struct.
#[repr(C)]
#[derive(Clone, Copy)]
pub union NV_ENC_CODEC_CONFIG {
    pub h264Config: NV_ENC_CONFIG_H264,
    pub raw: [u32; 448],
}
const _: () = assert!(size_of::<NV_ENC_CODEC_CONFIG>() == 1792);

impl Default for NV_ENC_CODEC_CONFIG {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_CONFIG {
    pub version: u32,
    pub profileGUID: GUID,
    pub gopLength: u32,
    pub frameIntervalP: i32,
    pub monoChromeEncoding: u32,
    pub frameFieldMode: u32,
    pub mvPrecision: u32,
    pub rcParams: NV_ENC_RC_PARAMS,
    pub encodeCodecConfig: NV_ENC_CODEC_CONFIG,
    pub reserved: [u32; 278],
    pub reserved2: [*mut c_void; 64],
}
const _: () = assert!(size_of::<NV_ENC_CONFIG>() == 3584);

impl Default for NV_ENC_CONFIG {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKTYPE {
    pub bitfields: u32,
    pub reserved1: [u32; 3],
}
const _: () = assert!(size_of::<NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKTYPE>() == 16);

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_INITIALIZE_PARAMS {
    pub version: u32,
    pub encodeGUID: GUID,
    pub presetGUID: GUID,
    pub encodeWidth: u32,
    pub encodeHeight: u32,
    pub darWidth: u32,
    pub darHeight: u32,
    pub frameRateNum: u32,
    pub frameRateDen: u32,
    pub enableEncodeAsync: u32,
    pub enablePTD: u32,
    /// LSB-first: 0 reportSliceOffsets, 1 enableSubFrameWrite, 2 enableExternalMEHints,
    /// 3 enableMEOnlyMode, 4 enableWeightedPrediction, 5..8 splitEncodeMode,
    /// 9 enableOutputInVidmem, 10 enableReconFrameOutput, 11 enableOutputStats,
    /// 12 enableUniDirectionalB, 13..31 reserved.
    pub bitfields: u32,
    pub privDataSize: u32,
    pub reserved: u32,
    pub privData: *mut c_void,
    pub encodeConfig: *mut NV_ENC_CONFIG,
    pub maxEncodeWidth: u32,
    pub maxEncodeHeight: u32,
    pub maxMEHintCountsPerBlock: [NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKTYPE; 2],
    pub tuningInfo: u32,
    pub bufferFormat: u32,
    pub reserved1: [u32; 287],
    pub reserved2: [*mut c_void; 64],
}
const _: () = assert!(size_of::<NV_ENC_INITIALIZE_PARAMS>() == 1808);

impl Default for NV_ENC_INITIALIZE_PARAMS {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_RECONFIGURE_PARAMS {
    pub version: u32,
    pub reserved: u32,
    pub reInitEncodeParams: NV_ENC_INITIALIZE_PARAMS,
    /// LSB-first: 0 resetEncoder, 1 forceIDR, 2..31 reserved.
    pub bitfields: u32,
    pub reserved2: u32,
}
const _: () = assert!(size_of::<NV_ENC_RECONFIGURE_PARAMS>() == 1824);

impl Default for NV_ENC_RECONFIGURE_PARAMS {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

impl NV_ENC_RECONFIGURE_PARAMS {
    pub fn set_reset_encoder(&mut self, on: bool) {
        if on {
            self.bitfields |= 1;
        } else {
            self.bitfields &= !1;
        }
    }
    pub fn set_force_idr(&mut self, on: bool) {
        if on {
            self.bitfields |= 1 << 1;
        } else {
            self.bitfields &= !(1 << 1);
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_PRESET_CONFIG {
    pub version: u32,
    pub reserved: u32,
    pub presetCfg: NV_ENC_CONFIG,
    pub reserved1: [u32; 255],
    pub reserved2: [*mut c_void; 64],
}
const _: () = assert!(size_of::<NV_ENC_PRESET_CONFIG>() == 5128);

impl Default for NV_ENC_PRESET_CONFIG {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

/// Head fields we actually set; the remainder (`h264ExtPicParams`, `timeCode`,
/// reserved tails) is opaque padding kept at the probed total of 1536 bytes.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_PIC_PARAMS_H264 {
    pub displayPOCSyntax: u32,
    pub reserved3: u32,
    pub refPicFlag: u32,
    pub colourPlaneId: u32,
    pub forceIntraRefreshWithFrameCnt: u32,
    /// LSB-first: 0 constrainedFrame, 1 sliceModeDataUpdate, 2 ltrMarkFrame,
    /// 3 ltrUseFrames, 4..31 reserved.
    pub bitfields: u32,
    pub sliceTypeData: *mut u8,
    pub sliceTypeArrayCnt: u32,
    pub seiPayloadArrayCnt: u32,
    pub seiPayloadArray: *mut c_void,
    pub sliceMode: u32,
    pub sliceModeData: u32,
    pub ltrMarkFrameIdx: u32,
    pub ltrUseFrameBitmap: u32,
    pub ltrUsageMode: u32,
    pub forceIntraSliceCount: u32,
    pub forceIntraSliceIdx: *mut u32,
    pub tail: [u8; 1456],
}
const _: () = assert!(size_of::<NV_ENC_PIC_PARAMS_H264>() == 1536);

/// Sized by its largest member (HEVC/AV1 pic params at 12.0), not by `h264PicParams`.
#[repr(C)]
#[derive(Clone, Copy)]
pub union NV_ENC_CODEC_PIC_PARAMS {
    pub h264PicParams: NV_ENC_PIC_PARAMS_H264,
    pub raw: [u8; 1552],
}
const _: () = assert!(size_of::<NV_ENC_CODEC_PIC_PARAMS>() == 1552);

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_PIC_PARAMS {
    pub version: u32,
    pub inputWidth: u32,
    pub inputHeight: u32,
    pub inputPitch: u32,
    pub encodePicFlags: u32,
    pub frameIdx: u32,
    pub inputTimeStamp: u64,
    pub inputDuration: u64,
    pub inputBuffer: *mut c_void,
    pub outputBitstream: *mut c_void,
    pub completionEvent: *mut c_void,
    pub bufferFmt: u32,
    pub pictureStruct: u32,
    pub pictureType: u32,
    /// 4 bytes of tail padding here in C: the union needs 8-byte alignment, so
    /// `codecPicParams` lands at offset 80 (verified by the probe).
    pub _pad0: u32,
    pub codecPicParams: NV_ENC_CODEC_PIC_PARAMS,
    /// Everything past codecPicParams (ME hints, qp maps, recon buffer, reserved
    /// tails) — we leave it zeroed. Probed total is 3360.
    pub tail: [u8; 1728],
}
const _: () = assert!(size_of::<NV_ENC_PIC_PARAMS>() == 3360);

impl Default for NV_ENC_PIC_PARAMS {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_LOCK_BITSTREAM {
    pub version: u32,
    /// LSB-first: 0 doNotWait, 1 ltrFrame, 2 getRCStats, 3..31 reserved.
    pub bitfields: u32,
    pub outputBitstream: *mut c_void,
    pub sliceOffsets: *mut u32,
    pub frameIdx: u32,
    pub hwEncodeStatus: u32,
    pub numSlices: u32,
    pub bitstreamSizeInBytes: u32,
    pub outputTimeStamp: u64,
    pub outputDuration: u64,
    pub bitstreamBufferPtr: *mut c_void,
    pub pictureType: u32,
    pub pictureStruct: u32,
    pub frameAvgQP: u32,
    /// Everything past frameAvgQP (SATD, LTR, MB counts, reserved tails). We read none
    /// of it, so it stays opaque padding — this also keeps the struct stable across the
    /// 12.x line, where the interior gained fields but the 1544-byte total did not.
    pub tail: [u8; 1468],
}
const _: () = assert!(size_of::<NV_ENC_LOCK_BITSTREAM>() == 1544);

impl Default for NV_ENC_LOCK_BITSTREAM {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

impl NV_ENC_LOCK_BITSTREAM {
    pub fn set_do_not_wait(&mut self, on: bool) {
        if on {
            self.bitfields |= 1;
        } else {
            self.bitfields &= !1;
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_REGISTER_RESOURCE {
    pub version: u32,
    pub resourceType: u32,
    pub width: u32,
    pub height: u32,
    pub pitch: u32,
    pub subResourceIndex: u32,
    pub resourceToRegister: *mut c_void,
    pub registeredResource: *mut c_void,
    pub bufferFormat: u32,
    pub bufferUsage: u32,
    pub pInputFencePoint: *mut c_void,
    // NOTE: no chromaOffset/chromaOffsetIn at API 12.0 — those arrive later. Adding
    // them here silently pushed the struct to 1552 bytes (the assert caught it).
    pub reserved1: [u32; 247],
    pub reserved2: [*mut c_void; 61],
}
const _: () = assert!(size_of::<NV_ENC_REGISTER_RESOURCE>() == 1536);

impl Default for NV_ENC_REGISTER_RESOURCE {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_MAP_INPUT_RESOURCE {
    pub version: u32,
    pub subResourceIndex: u32,
    pub inputResource: *mut c_void,
    pub registeredResource: *mut c_void,
    pub mappedResource: *mut c_void,
    pub mappedBufferFmt: u32,
    pub reserved1: [u32; 251],
    pub reserved2: [*mut c_void; 63],
}
const _: () = assert!(size_of::<NV_ENC_MAP_INPUT_RESOURCE>() == 1544);

impl Default for NV_ENC_MAP_INPUT_RESOURCE {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_CREATE_BITSTREAM_BUFFER {
    pub version: u32,
    pub size: u32,
    pub memoryHeap: u32,
    pub reserved: u32,
    pub bitstreamBuffer: *mut c_void,
    pub bitstreamBufferPtr: *mut c_void,
    pub reserved1: [u32; 58],
    pub reserved2: [*mut c_void; 64],
}
const _: () = assert!(size_of::<NV_ENC_CREATE_BITSTREAM_BUFFER>() == 776);

impl Default for NV_ENC_CREATE_BITSTREAM_BUFFER {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
    pub version: u32,
    pub deviceType: u32,
    pub device: *mut c_void,
    pub reserved: *mut c_void,
    pub apiVersion: u32,
    pub reserved1: [u32; 253],
    pub reserved2: [*mut c_void; 64],
}
const _: () = assert!(size_of::<NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS>() == 1552);

impl Default for NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

// ---- function table -------------------------------------------------------
// Slot order is load-bearing: NVENC fills this table by offset. Entry points we
// don't call are kept as opaque `*mut c_void` so the ones we do call stay aligned.
// Offsets verified against the probe (OpenEncodeSession@8 … GetEncodePresetConfigEx@320).

pub type PEncOpenEncodeSessionEx =
    unsafe extern "C" fn(*mut NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS, *mut *mut c_void) -> u32;
pub type PEncGetEncodeCaps = unsafe extern "C" fn(*mut c_void, GUID, *mut NV_ENC_CAPS_PARAM, *mut i32) -> u32;
pub type PEncGetEncodePresetConfigEx =
    unsafe extern "C" fn(*mut c_void, GUID, GUID, u32, *mut NV_ENC_PRESET_CONFIG) -> u32;
pub type PEncInitializeEncoder = unsafe extern "C" fn(*mut c_void, *mut NV_ENC_INITIALIZE_PARAMS) -> u32;
pub type PEncReconfigureEncoder = unsafe extern "C" fn(*mut c_void, *mut NV_ENC_RECONFIGURE_PARAMS) -> u32;
pub type PEncCreateBitstreamBuffer = unsafe extern "C" fn(*mut c_void, *mut NV_ENC_CREATE_BITSTREAM_BUFFER) -> u32;
pub type PEncDestroyBitstreamBuffer = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u32;
pub type PEncEncodePicture = unsafe extern "C" fn(*mut c_void, *mut NV_ENC_PIC_PARAMS) -> u32;
pub type PEncLockBitstream = unsafe extern "C" fn(*mut c_void, *mut NV_ENC_LOCK_BITSTREAM) -> u32;
pub type PEncUnlockBitstream = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u32;
pub type PEncRegisterResource = unsafe extern "C" fn(*mut c_void, *mut NV_ENC_REGISTER_RESOURCE) -> u32;
pub type PEncUnregisterResource = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u32;
pub type PEncMapInputResource = unsafe extern "C" fn(*mut c_void, *mut NV_ENC_MAP_INPUT_RESOURCE) -> u32;
pub type PEncUnmapInputResource = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u32;
pub type PEncDestroyEncoder = unsafe extern "C" fn(*mut c_void) -> u32;
pub type PEncGetLastErrorString = unsafe extern "C" fn(*mut c_void) -> *const std::ffi::c_char;

/// Unused entry-point slot. Must be a bare pointer, **not** `Option<*mut c_void>`:
/// raw pointers have no niche, so `Option` around one is 16 bytes and every slot after
/// it would be misaligned (the size assert below catches exactly that). `Option<fn>`
/// *is* null-pointer-optimised to 8 bytes, which is why the typed slots can use it.
type Slot = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENCODE_API_FUNCTION_LIST {
    pub version: u32,
    pub reserved: u32,
    pub nvEncOpenEncodeSession: Slot,
    pub nvEncGetEncodeGUIDCount: Slot,
    pub nvEncGetEncodeProfileGUIDCount: Slot,
    pub nvEncGetEncodeProfileGUIDs: Slot,
    pub nvEncGetEncodeGUIDs: Slot,
    pub nvEncGetInputFormatCount: Slot,
    pub nvEncGetInputFormats: Slot,
    pub nvEncGetEncodeCaps: Option<PEncGetEncodeCaps>,
    pub nvEncGetEncodePresetCount: Slot,
    pub nvEncGetEncodePresetGUIDs: Slot,
    pub nvEncGetEncodePresetConfig: Slot,
    pub nvEncInitializeEncoder: Option<PEncInitializeEncoder>,
    pub nvEncCreateInputBuffer: Slot,
    pub nvEncDestroyInputBuffer: Slot,
    pub nvEncCreateBitstreamBuffer: Option<PEncCreateBitstreamBuffer>,
    pub nvEncDestroyBitstreamBuffer: Option<PEncDestroyBitstreamBuffer>,
    pub nvEncEncodePicture: Option<PEncEncodePicture>,
    pub nvEncLockBitstream: Option<PEncLockBitstream>,
    pub nvEncUnlockBitstream: Option<PEncUnlockBitstream>,
    pub nvEncLockInputBuffer: Slot,
    pub nvEncUnlockInputBuffer: Slot,
    pub nvEncGetEncodeStats: Slot,
    pub nvEncGetSequenceParams: Slot,
    pub nvEncRegisterAsyncEvent: Slot,
    pub nvEncUnregisterAsyncEvent: Slot,
    pub nvEncMapInputResource: Option<PEncMapInputResource>,
    pub nvEncUnmapInputResource: Option<PEncUnmapInputResource>,
    pub nvEncDestroyEncoder: Option<PEncDestroyEncoder>,
    pub nvEncInvalidateRefFrames: Slot,
    pub nvEncOpenEncodeSessionEx: Option<PEncOpenEncodeSessionEx>,
    pub nvEncRegisterResource: Option<PEncRegisterResource>,
    pub nvEncUnregisterResource: Option<PEncUnregisterResource>,
    pub nvEncReconfigureEncoder: Option<PEncReconfigureEncoder>,
    pub reserved1: Slot,
    pub nvEncCreateMVBuffer: Slot,
    pub nvEncDestroyMVBuffer: Slot,
    pub nvEncRunMotionEstimationOnly: Slot,
    pub nvEncGetLastErrorString: Option<PEncGetLastErrorString>,
    pub nvEncSetIOCudaStreams: Slot,
    pub nvEncGetEncodePresetConfigEx: Option<PEncGetEncodePresetConfigEx>,
    pub nvEncGetSequenceParamEx: Slot,
    pub nvEncRestoreEncoderState: Slot,
    pub nvEncLookaheadPicture: Slot,
    pub reserved2: [Slot; 275],
}
const _: () = assert!(size_of::<NV_ENCODE_API_FUNCTION_LIST>() == 2552);

impl Default for NV_ENCODE_API_FUNCTION_LIST {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

// Function-table offsets, cross-checked against the probe. `Option<fn>` is a
// null-pointer-optimised 8-byte slot, same as the C function pointer.
const _: () = {
    use std::mem::offset_of;
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncOpenEncodeSession) == 8);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncGetEncodeGUIDs) == 40);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncGetEncodeCaps) == 64);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncInitializeEncoder) == 96);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncCreateBitstreamBuffer) == 120);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncDestroyBitstreamBuffer) == 128);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncEncodePicture) == 136);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncLockBitstream) == 144);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncUnlockBitstream) == 152);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncMapInputResource) == 208);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncUnmapInputResource) == 216);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncDestroyEncoder) == 224);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncOpenEncodeSessionEx) == 240);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncRegisterResource) == 248);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncUnregisterResource) == 256);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncReconfigureEncoder) == 264);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncGetLastErrorString) == 304);
    assert!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncGetEncodePresetConfigEx) == 320);
};

// Field offsets that the probe pinned down and that hand-arithmetic gets wrong
// (u8/u16 packing in RC_PARAMS, the union alignment pad in PIC_PARAMS).
const _: () = {
    use std::mem::offset_of;
    assert!(offset_of!(NV_ENC_RC_PARAMS, averageBitRate) == 20);
    assert!(offset_of!(NV_ENC_RC_PARAMS, targetQuality) == 88);
    assert!(offset_of!(NV_ENC_RC_PARAMS, lookaheadDepth) == 90);
    assert!(offset_of!(NV_ENC_RC_PARAMS, qpMapMode) == 96);
    assert!(offset_of!(NV_ENC_RC_PARAMS, multiPass) == 100);
    assert!(offset_of!(NV_ENC_CONFIG_H264, maxNumRefFrames) == 60);
    assert!(offset_of!(NV_ENC_CONFIG_H264, h264VUIParameters) == 72);
    assert!(offset_of!(NV_ENC_CONFIG_H264, chromaFormatIDC) == 192);
    assert!(offset_of!(NV_ENC_CONFIG_H264_VUI_PARAMETERS, bitstreamRestrictionFlag) == 48);
    assert!(offset_of!(NV_ENC_CONFIG, rcParams) == 40);
    assert!(offset_of!(NV_ENC_CONFIG, encodeCodecConfig) == 168);
    assert!(offset_of!(NV_ENC_INITIALIZE_PARAMS, encodeConfig) == 88);
    assert!(offset_of!(NV_ENC_INITIALIZE_PARAMS, tuningInfo) == 136);
    assert!(offset_of!(NV_ENC_INITIALIZE_PARAMS, bufferFormat) == 140);
    assert!(offset_of!(NV_ENC_PIC_PARAMS, inputBuffer) == 40);
    assert!(offset_of!(NV_ENC_PIC_PARAMS, codecPicParams) == 80);
    assert!(offset_of!(NV_ENC_LOCK_BITSTREAM, bitstreamSizeInBytes) == 36);
    assert!(offset_of!(NV_ENC_LOCK_BITSTREAM, bitstreamBufferPtr) == 56);
    assert!(offset_of!(NV_ENC_REGISTER_RESOURCE, resourceToRegister) == 24);
    assert!(offset_of!(NV_ENC_MAP_INPUT_RESOURCE, mappedResource) == 24);
    assert!(offset_of!(NV_ENC_CREATE_BITSTREAM_BUFFER, bitstreamBuffer) == 16);
    assert!(offset_of!(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS, apiVersion) == 24);
    assert!(offset_of!(NV_ENC_PRESET_CONFIG, presetCfg) == 8);
    assert!(offset_of!(NV_ENC_RECONFIGURE_PARAMS, reInitEncodeParams) == 8);
};
