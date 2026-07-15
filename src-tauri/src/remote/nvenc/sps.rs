//! H.264 **SPS fixup** — the "phone decodes instantly" half of the latency work.
//!
//! ## The problem this solves (measured, not theoretical)
//! With the stock NVENC SPS the phone reported ~30 ms decode latency — *and it stayed
//! ~30 ms when the stream was dropped to 2×2 pixels at 1 kbit/s*. Four pixels cannot
//! take 30 ms to decode, so that number was never decode **work**: the hardware decoder
//! was holding roughly one frame before emitting it.
//!
//! Android H.264 decoders decide how many frames to buffer from the SPS:
//!   * `max_num_ref_frames` — NVENC defaults it to 16, so decoders allocate 16+ buffers
//!     (lag, or outright failure on weaker chips). Moonlight decoder-errata #1.
//!   * `max_num_reorder_frames` / `max_dec_frame_buffering` in the VUI bitstream
//!     restriction — if absent, decoders must assume the worst and pipeline ahead.
//!     Moonlight decoder-errata #2: *"substantial frame-level delays with unmodified
//!     SPS from NVENC"*. NVENC has a `bitstreamRestrictionFlag` but **no field for
//!     these two values**, which is why this rewrite exists rather than a config call.
//!
//! We never reorder (`frameIntervalP = 1`, no B-frames, `zeroReorderDelay`), so we
//! declare that: reorder 0, DPB 1, refs 1.
//!
//! ## What we deliberately do NOT touch
//! `pic_order_cnt_type`. Per [ExoPlayer#8514] the Snapdragon slow path keys off
//! `pic_order_cnt_type == 0` (reordering *possible*, even if unused), and type 2 means
//! *impossible*. But flipping it in the SPS alone produces an illegal stream: type 0
//! carries `pic_order_cnt_lsb` in **every slice header**, which type 2 does not, so the
//! change would require re-writing and re-aligning every slice. [`log_summary`] reports
//! what NVENC actually emitted so we can decide from data — if it already emits type 2
//! there is nothing to do.
//!
//! [ExoPlayer#8514]: https://github.com/google/ExoPlayer/issues/8514
//!
//! Everything here is pure bit-twiddling over `&[u8]` — no NVENC types — so it is unit
//! testable on any platform (see the tests at the bottom).

/// Values we force into every SPS. Named so the intent survives the bit-twiddling.
const FORCE_MAX_NUM_REF_FRAMES: u32 = 1;
const FORCE_MAX_NUM_REORDER_FRAMES: u32 = 0;
const FORCE_MAX_DEC_FRAME_BUFFERING: u32 = 1;

// ---- bit IO ---------------------------------------------------------------

struct BitReader<'a> {
    d: &'a [u8],
    bit: usize,
}

impl<'a> BitReader<'a> {
    fn new(d: &'a [u8]) -> Self {
        Self { d, bit: 0 }
    }
    fn bits_left(&self) -> usize {
        self.d.len() * 8 - self.bit.min(self.d.len() * 8)
    }
    fn u1(&mut self) -> Result<u32, ()> {
        if self.bit >= self.d.len() * 8 {
            return Err(());
        }
        let v = (self.d[self.bit >> 3] >> (7 - (self.bit & 7))) & 1;
        self.bit += 1;
        Ok(v as u32)
    }
    fn u(&mut self, n: u32) -> Result<u32, ()> {
        let mut v = 0u32;
        for _ in 0..n {
            v = (v << 1) | self.u1()?;
        }
        Ok(v)
    }
    /// Exp-Golomb unsigned. Capped at 32 leading zeros so malformed input can't spin.
    fn ue(&mut self) -> Result<u32, ()> {
        let mut lz = 0u32;
        while self.u1()? == 0 {
            lz += 1;
            if lz > 32 {
                return Err(());
            }
        }
        if lz == 0 {
            return Ok(0);
        }
        let rest = self.u(lz)?;
        Ok((1u32 << lz) - 1 + rest)
    }
    fn se(&mut self) -> Result<i32, ()> {
        let k = self.ue()?;
        let v = ((k + 1) >> 1) as i32;
        Ok(if k & 1 == 1 { v } else { -v })
    }
}

#[derive(Default)]
struct BitWriter {
    d: Vec<u8>,
    nbits: usize,
}

impl BitWriter {
    fn u1(&mut self, v: u32) {
        if self.nbits % 8 == 0 {
            self.d.push(0);
        }
        if v & 1 == 1 {
            let i = self.nbits >> 3;
            self.d[i] |= 1 << (7 - (self.nbits & 7));
        }
        self.nbits += 1;
    }
    fn u(&mut self, v: u32, n: u32) {
        for i in (0..n).rev() {
            self.u1((v >> i) & 1);
        }
    }
    fn ue(&mut self, v: u32) {
        // v+1 written as a (2*len-1)-bit exp-Golomb code. v+1 can't overflow for any
        // value we re-emit (all are bounded by what we just parsed).
        let x = v + 1;
        let len = 32 - x.leading_zeros();
        for _ in 0..(len - 1) {
            self.u1(0);
        }
        self.u(x, len);
    }
    fn se(&mut self, v: i32) {
        let k = if v <= 0 { (-v as u32) * 2 } else { (v as u32) * 2 - 1 };
        self.ue(k);
    }
    fn trailing(&mut self) {
        self.u1(1);
        while self.nbits % 8 != 0 {
            self.u1(0);
        }
    }
}

// ---- RBSP escaping --------------------------------------------------------

/// Strip emulation-prevention bytes (`00 00 03` → `00 00`) to get raw RBSP.
fn unescape(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    let mut i = 0;
    while i < nal.len() {
        let b = nal[i];
        if zeros >= 2 && b == 0x03 && i + 1 < nal.len() && nal[i + 1] <= 0x03 {
            zeros = 0; // drop the emulation byte
        } else {
            out.push(b);
            zeros = if b == 0 { zeros + 1 } else { 0 };
        }
        i += 1;
    }
    out
}

/// Re-insert emulation-prevention bytes.
fn escape(rbsp: &[u8], out: &mut Vec<u8>) {
    let mut zeros = 0;
    for &b in rbsp {
        if zeros >= 2 && b <= 0x03 {
            out.push(0x03);
            zeros = 0;
        }
        out.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
}

// ---- SPS ------------------------------------------------------------------

/// Copy `hrd_parameters()` across verbatim; we only need to traverse it to reach the
/// bitstream-restriction fields that follow.
fn copy_hrd(r: &mut BitReader, w: &mut BitWriter) -> Result<(), ()> {
    let cpb_cnt_minus1 = r.ue()?;
    w.ue(cpb_cnt_minus1);
    w.u(r.u(4)?, 4); // bit_rate_scale
    w.u(r.u(4)?, 4); // cpb_size_scale
    if cpb_cnt_minus1 > 31 {
        return Err(());
    }
    for _ in 0..=cpb_cnt_minus1 {
        w.ue(r.ue()?); // bit_rate_value_minus1
        w.ue(r.ue()?); // cpb_size_value_minus1
        w.u1(r.u1()?); // cbr_flag
    }
    w.u(r.u(5)?, 5); // initial_cpb_removal_delay_length_minus1
    w.u(r.u(5)?, 5); // cpb_removal_delay_length_minus1
    w.u(r.u(5)?, 5); // dpb_output_delay_length_minus1
    w.u(r.u(5)?, 5); // time_offset_length
    Ok(())
}

fn copy_scaling_list(r: &mut BitReader, w: &mut BitWriter, size: usize) -> Result<(), ()> {
    let mut last = 8i32;
    let mut next = 8i32;
    for _ in 0..size {
        if next != 0 {
            let delta = r.se()?;
            w.se(delta);
            next = (last + delta + 256) % 256;
        }
        last = if next == 0 { last } else { next };
    }
    Ok(())
}

/// Rewrite one SPS **RBSP** (no start code, no NAL header). `Err` ⇒ caller keeps the
/// original bytes rather than shipping a stream we half-understand.
fn rewrite_rbsp(rbsp: &[u8]) -> Result<Vec<u8>, ()> {
    let mut r = BitReader::new(rbsp);
    let mut w = BitWriter::default();

    let profile_idc = r.u(8)?;
    w.u(profile_idc, 8);
    w.u(r.u(8)?, 8); // constraint flags + reserved
    w.u(r.u(8)?, 8); // level_idc
    w.ue(r.ue()?); // seq_parameter_set_id

    if matches!(
        profile_idc,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    ) {
        let chroma_format_idc = r.ue()?;
        w.ue(chroma_format_idc);
        if chroma_format_idc == 3 {
            w.u1(r.u1()?); // separate_colour_plane_flag
        }
        w.ue(r.ue()?); // bit_depth_luma_minus8
        w.ue(r.ue()?); // bit_depth_chroma_minus8
        w.u1(r.u1()?); // qpprime_y_zero_transform_bypass_flag
        let scaling = r.u1()?;
        w.u1(scaling);
        if scaling == 1 {
            let n = if chroma_format_idc != 3 { 8 } else { 12 };
            for i in 0..n {
                let present = r.u1()?;
                w.u1(present);
                if present == 1 {
                    copy_scaling_list(&mut r, &mut w, if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }

    w.ue(r.ue()?); // log2_max_frame_num_minus4
    let poc_type = r.ue()?;
    w.ue(poc_type);
    if poc_type == 0 {
        w.ue(r.ue()?); // log2_max_pic_order_cnt_lsb_minus4
    } else if poc_type == 1 {
        w.u1(r.u1()?); // delta_pic_order_always_zero_flag
        w.se(r.se()?); // offset_for_non_ref_pic
        w.se(r.se()?); // offset_for_top_to_bottom_field
        let n = r.ue()?;
        w.ue(n);
        if n > 255 {
            return Err(());
        }
        for _ in 0..n {
            w.se(r.se()?);
        }
    }

    // --- fix 1: DPB size. NVENC ships 16 here; the phone only needs the last frame.
    let _orig_refs = r.ue()?;
    w.ue(FORCE_MAX_NUM_REF_FRAMES);

    w.u1(r.u1()?); // gaps_in_frame_num_value_allowed_flag
    w.ue(r.ue()?); // pic_width_in_mbs_minus1
    w.ue(r.ue()?); // pic_height_in_map_units_minus1
    let frame_mbs_only = r.u1()?;
    w.u1(frame_mbs_only);
    if frame_mbs_only == 0 {
        w.u1(r.u1()?); // mb_adaptive_frame_field_flag
    }
    w.u1(r.u1()?); // direct_8x8_inference_flag
    let cropping = r.u1()?;
    w.u1(cropping);
    if cropping == 1 {
        w.ue(r.ue()?);
        w.ue(r.ue()?);
        w.ue(r.ue()?);
        w.ue(r.ue()?);
    }

    let vui_present = r.u1()?;
    // We always emit a VUI: if NVENC didn't write one we still need somewhere to put
    // the bitstream restriction, and an all-absent VUI is legal (every flag is 0).
    w.u1(1);

    if vui_present == 1 {
        let aspect = r.u1()?;
        w.u1(aspect);
        if aspect == 1 {
            let idc = r.u(8)?;
            w.u(idc, 8);
            if idc == 255 {
                w.u(r.u(16)?, 16); // sar_width
                w.u(r.u(16)?, 16); // sar_height
            }
        }
        let overscan = r.u1()?;
        w.u1(overscan);
        if overscan == 1 {
            w.u1(r.u1()?);
        }
        let vst = r.u1()?;
        w.u1(vst);
        if vst == 1 {
            w.u(r.u(3)?, 3); // video_format
            w.u1(r.u1()?); // video_full_range_flag
            let cd = r.u1()?;
            w.u1(cd);
            if cd == 1 {
                w.u(r.u(8)?, 8);
                w.u(r.u(8)?, 8);
                w.u(r.u(8)?, 8);
            }
        }
        let chroma_loc = r.u1()?;
        w.u1(chroma_loc);
        if chroma_loc == 1 {
            w.ue(r.ue()?);
            w.ue(r.ue()?);
        }
        let timing = r.u1()?;
        w.u1(timing);
        if timing == 1 {
            w.u(r.u(32)?, 32); // num_units_in_tick
            w.u(r.u(32)?, 32); // time_scale
            w.u1(r.u1()?); // fixed_frame_rate_flag
        }
        let nal_hrd = r.u1()?;
        w.u1(nal_hrd);
        if nal_hrd == 1 {
            copy_hrd(&mut r, &mut w)?;
        }
        let vcl_hrd = r.u1()?;
        w.u1(vcl_hrd);
        if vcl_hrd == 1 {
            copy_hrd(&mut r, &mut w)?;
        }
        if nal_hrd == 1 || vcl_hrd == 1 {
            w.u1(r.u1()?); // low_delay_hrd_flag
        }
        w.u1(r.u1()?); // pic_struct_present_flag
    } else {
        // No source VUI: emit an empty one (all "not present" flags) up to the
        // restriction block.
        w.u1(0); // aspect_ratio_info_present_flag
        w.u1(0); // overscan_info_present_flag
        w.u1(0); // video_signal_type_present_flag
        w.u1(0); // chroma_loc_info_present_flag
        w.u1(0); // timing_info_present_flag
        w.u1(0); // nal_hrd_parameters_present_flag
        w.u1(0); // vcl_hrd_parameters_present_flag
        w.u1(0); // pic_struct_present_flag
    }

    // --- fix 2: declare zero reordering and a 1-frame DPB, so the decoder has no
    // reason to hold anything back. This is the ~30 ms.
    w.u1(1); // bitstream_restriction_flag
    if vui_present == 1 {
        let had_restriction = r.u1()?;
        if had_restriction == 1 {
            // Preserve the encoder's own MV/size limits; only the last two change.
            w.u1(r.u1()?); // motion_vectors_over_pic_boundaries_flag
            w.ue(r.ue()?); // max_bytes_per_pic_denom
            w.ue(r.ue()?); // max_bits_per_mb_denom
            w.ue(r.ue()?); // log2_max_mv_length_horizontal
            w.ue(r.ue()?); // log2_max_mv_length_vertical
            let _orig_reorder = r.ue()?;
            let _orig_dpb = r.ue()?;
        } else {
            // Spec defaults for the fields we're not opinionated about.
            w.u1(1); // motion_vectors_over_pic_boundaries_flag
            w.ue(0); // max_bytes_per_pic_denom
            w.ue(0); // max_bits_per_mb_denom
            w.ue(16); // log2_max_mv_length_horizontal
            w.ue(16); // log2_max_mv_length_vertical
        }
    } else {
        w.u1(1);
        w.ue(0);
        w.ue(0);
        w.ue(16);
        w.ue(16);
    }
    w.ue(FORCE_MAX_NUM_REORDER_FRAMES);
    w.ue(FORCE_MAX_DEC_FRAME_BUFFERING);

    w.trailing();
    Ok(w.d)
}

/// Split an Annex-B buffer into (start_code_len, nal_payload) spans.
fn nal_units(d: &[u8]) -> Vec<(usize, usize)> {
    // Returns (start_of_nal_payload, end_of_nal_payload) pairs.
    let mut out = Vec::new();
    let mut i = 0;
    let mut cur: Option<usize> = None;
    while i + 3 <= d.len() {
        let three = d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1;
        let four = i + 4 <= d.len() && d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 0 && d[i + 3] == 1;
        if three || four {
            let sc = if four { 4 } else { 3 };
            if let Some(s) = cur.take() {
                out.push((s, i));
            }
            cur = Some(i + sc);
            i += sc;
        } else {
            i += 1;
        }
    }
    if let Some(s) = cur {
        out.push((s, d.len()));
    }
    out
}

/// Copy `src` (Annex-B) into `out`, rewriting any SPS NAL along the way.
/// Returns true if at least one SPS was rewritten.
///
/// Any parse failure copies the original SPS through untouched: a stream that decodes
/// with a stale DPB hint beats a stream that doesn't decode.
pub fn fixup_into(src: &[u8], out: &mut Vec<u8>) -> bool {
    out.clear();
    out.reserve(src.len() + 32);
    let units = nal_units(src);
    if units.is_empty() {
        out.extend_from_slice(src);
        return false;
    }
    let mut rewrote = false;
    // Preserve whatever precedes the first start code (normally nothing).
    let first = units[0].0;
    let lead = first.saturating_sub(if first >= 4 && src[first - 4] == 0 { 4 } else { 3 });
    out.extend_from_slice(&src[..lead]);

    for (s, e) in units {
        let nal = &src[s..e];
        if nal.is_empty() {
            continue;
        }
        let nal_type = nal[0] & 0x1f;
        // 4-byte start code for SPS/PPS (parameter sets conventionally use it),
        // matching what NVENC emits; 3-byte is equally legal.
        let sc4 = s >= 4 && src[s - 4] == 0 && src[s - 3] == 0 && src[s - 2] == 0 && src[s - 1] == 1;
        if sc4 {
            out.extend_from_slice(&[0, 0, 0, 1]);
        } else {
            out.extend_from_slice(&[0, 0, 1]);
        }
        if nal_type == 7 {
            let rbsp = unescape(&nal[1..]);
            match rewrite_rbsp(&rbsp) {
                Ok(new_rbsp) => {
                    out.push(nal[0]);
                    escape(&new_rbsp, out);
                    rewrote = true;
                    continue;
                }
                Err(()) => {
                    eprintln!("[nvenc] SPS parse failed — shipping the encoder's SPS unmodified");
                }
            }
        }
        out.extend_from_slice(nal);
    }
    rewrote
}

/// One-shot diagnostic on the first keyframe: what did NVENC actually emit?
///
/// `pic_order_cnt_type` is the interesting one — see the module docs. If this logs
/// `poc_type=2` the Snapdragon reorder slow path was never armed; if it logs
/// `poc_type=0` the remaining decode latency may need slice-level work.
pub fn log_summary(src: &[u8]) {
    for (s, e) in nal_units(src) {
        let nal = &src[s..e];
        if nal.is_empty() || nal[0] & 0x1f != 7 {
            continue;
        }
        let rbsp = unescape(&nal[1..]);
        if let Some(info) = summarize(&rbsp) {
            eprintln!(
                "[nvenc] SPS from encoder: profile={} level={} poc_type={} max_num_ref_frames={} \
                 vui={} bitstream_restriction={} reorder={:?} dpb={:?} (we force refs={} reorder={} dpb={})",
                info.profile_idc,
                info.level_idc,
                info.poc_type,
                info.max_num_ref_frames,
                info.vui_present,
                info.bitstream_restriction,
                info.max_num_reorder_frames,
                info.max_dec_frame_buffering,
                FORCE_MAX_NUM_REF_FRAMES,
                FORCE_MAX_NUM_REORDER_FRAMES,
                FORCE_MAX_DEC_FRAME_BUFFERING,
            );
        }
        return;
    }
}

/// Test-only re-exports so the NVENC smoke test can inspect a real bitstream without
/// widening the module's real surface.
#[cfg(test)]
pub(crate) fn nal_units_for_test(d: &[u8]) -> Vec<(usize, usize)> {
    nal_units(d)
}
#[cfg(test)]
pub(crate) fn unescape_for_test(nal: &[u8]) -> Vec<u8> {
    unescape(nal)
}

#[derive(Debug, PartialEq)]
pub struct SpsInfo {
    pub profile_idc: u32,
    pub level_idc: u32,
    pub poc_type: u32,
    pub max_num_ref_frames: u32,
    pub vui_present: bool,
    pub bitstream_restriction: bool,
    pub max_num_reorder_frames: Option<u32>,
    pub max_dec_frame_buffering: Option<u32>,
}

/// Read-only parse of an SPS RBSP, for diagnostics and tests.
pub fn summarize(rbsp: &[u8]) -> Option<SpsInfo> {
    fn go(rbsp: &[u8]) -> Result<SpsInfo, ()> {
        let mut r = BitReader::new(rbsp);
        let profile_idc = r.u(8)?;
        r.u(8)?;
        let level_idc = r.u(8)?;
        r.ue()?;
        if matches!(
            profile_idc,
            100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
        ) {
            let cfi = r.ue()?;
            if cfi == 3 {
                r.u1()?;
            }
            r.ue()?;
            r.ue()?;
            r.u1()?;
            if r.u1()? == 1 {
                let n = if cfi != 3 { 8 } else { 12 };
                for i in 0..n {
                    if r.u1()? == 1 {
                        let mut w = BitWriter::default();
                        copy_scaling_list(&mut r, &mut w, if i < 6 { 16 } else { 64 })?;
                    }
                }
            }
        }
        r.ue()?;
        let poc_type = r.ue()?;
        if poc_type == 0 {
            r.ue()?;
        } else if poc_type == 1 {
            r.u1()?;
            r.se()?;
            r.se()?;
            let n = r.ue()?;
            if n > 255 {
                return Err(());
            }
            for _ in 0..n {
                r.se()?;
            }
        }
        let max_num_ref_frames = r.ue()?;
        r.u1()?;
        r.ue()?;
        r.ue()?;
        if r.u1()? == 0 {
            r.u1()?;
        }
        r.u1()?;
        if r.u1()? == 1 {
            r.ue()?;
            r.ue()?;
            r.ue()?;
            r.ue()?;
        }
        let vui_present = r.u1()? == 1;
        let mut out = SpsInfo {
            profile_idc,
            level_idc,
            poc_type,
            max_num_ref_frames,
            vui_present,
            bitstream_restriction: false,
            max_num_reorder_frames: None,
            max_dec_frame_buffering: None,
        };
        if !vui_present {
            return Ok(out);
        }
        if r.u1()? == 1 {
            let idc = r.u(8)?;
            if idc == 255 {
                r.u(16)?;
                r.u(16)?;
            }
        }
        if r.u1()? == 1 {
            r.u1()?;
        }
        if r.u1()? == 1 {
            r.u(3)?;
            r.u1()?;
            if r.u1()? == 1 {
                r.u(8)?;
                r.u(8)?;
                r.u(8)?;
            }
        }
        if r.u1()? == 1 {
            r.ue()?;
            r.ue()?;
        }
        if r.u1()? == 1 {
            r.u(32)?;
            r.u(32)?;
            r.u1()?;
        }
        let nal_hrd = r.u1()?;
        if nal_hrd == 1 {
            let mut w = BitWriter::default();
            copy_hrd(&mut r, &mut w)?;
        }
        let vcl_hrd = r.u1()?;
        if vcl_hrd == 1 {
            let mut w = BitWriter::default();
            copy_hrd(&mut r, &mut w)?;
        }
        if nal_hrd == 1 || vcl_hrd == 1 {
            r.u1()?;
        }
        r.u1()?; // pic_struct_present_flag
        if r.u1()? == 1 {
            out.bitstream_restriction = true;
            r.u1()?;
            r.ue()?;
            r.ue()?;
            r.ue()?;
            r.ue()?;
            out.max_num_reorder_frames = Some(r.ue()?);
            out.max_dec_frame_buffering = Some(r.ue()?);
        }
        Ok(out)
    }
    go(rbsp).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real 1920×1080 High-profile SPS as emitted by NVENC (poc_type 0, 16 refs,
    /// no bitstream restriction) — the exact shape that makes phones buffer a frame.
    fn nvenc_like_sps_rbsp() -> Vec<u8> {
        // Built with the writer so the test is readable; the parser is what's under test.
        let mut w = BitWriter::default();
        w.u(100, 8); // profile_idc High
        w.u(0, 8); // constraints
        w.u(42, 8); // level 4.2
        w.ue(0); // sps id
        w.ue(1); // chroma_format_idc 4:2:0
        w.ue(0); // bit_depth_luma_minus8
        w.ue(0); // bit_depth_chroma_minus8
        w.u1(0); // qpprime
        w.u1(0); // scaling matrix
        w.ue(0); // log2_max_frame_num_minus4
        w.ue(0); // pic_order_cnt_type = 0
        w.ue(2); // log2_max_pic_order_cnt_lsb_minus4
        w.ue(16); // max_num_ref_frames = 16  <-- NVENC default
        w.u1(0); // gaps_in_frame_num
        w.ue(119); // width mbs-1 (1920)
        w.ue(67); // height map units-1 (1080)
        w.u1(1); // frame_mbs_only
        w.u1(1); // direct_8x8_inference
        w.u1(0); // cropping
        w.u1(0); // vui_parameters_present_flag = 0
        w.trailing();
        w.d
    }

    #[test]
    fn forces_low_latency_dpb_fields() {
        let orig = nvenc_like_sps_rbsp();
        let before = summarize(&orig).expect("parse original");
        assert_eq!(before.max_num_ref_frames, 16);
        assert!(!before.vui_present);

        let fixed = rewrite_rbsp(&orig).expect("rewrite");
        let after = summarize(&fixed).expect("parse rewritten");

        assert_eq!(after.max_num_ref_frames, 1, "DPB must drop to 1 ref");
        assert!(after.vui_present, "must emit a VUI to carry the restriction");
        assert!(after.bitstream_restriction, "restriction block must be present");
        assert_eq!(after.max_num_reorder_frames, Some(0), "no reordering");
        assert_eq!(after.max_dec_frame_buffering, Some(1), "1-frame DPB");

        // Untouched fields must survive the round trip bit-for-bit.
        assert_eq!(after.profile_idc, before.profile_idc);
        assert_eq!(after.level_idc, before.level_idc);
        assert_eq!(after.poc_type, before.poc_type, "poc_type is deliberately preserved");
    }

    #[test]
    fn preserves_an_existing_vui_and_overrides_only_the_dpb_hints() {
        let mut w = BitWriter::default();
        w.u(100, 8);
        w.u(0, 8);
        w.u(42, 8);
        w.ue(0);
        w.ue(1);
        w.ue(0);
        w.ue(0);
        w.u1(0);
        w.u1(0);
        w.ue(0);
        w.ue(2); // poc_type 2
        w.ue(4); // max_num_ref_frames
        w.u1(0);
        w.ue(119);
        w.ue(67);
        w.u1(1);
        w.u1(1);
        w.u1(0);
        w.u1(1); // vui present
        w.u1(0); // aspect
        w.u1(0); // overscan
        w.u1(1); // video_signal_type_present
        w.u(5, 3); // video_format
        w.u1(0); // full range
        w.u1(0); // colour_description
        w.u1(0); // chroma_loc
        w.u1(1); // timing_info_present
        w.u(1000, 32);
        w.u(60000, 32);
        w.u1(0); // fixed_frame_rate
        w.u1(0); // nal_hrd
        w.u1(0); // vcl_hrd
        w.u1(0); // pic_struct_present
        w.u1(1); // bitstream_restriction_flag
        w.u1(1); // motion_vectors_over_pic_boundaries
        w.ue(0);
        w.ue(0);
        w.ue(10);
        w.ue(10);
        w.ue(2); // max_num_reorder_frames = 2  <-- the latency
        w.ue(4); // max_dec_frame_buffering = 4
        w.trailing();
        let orig = w.d;

        let before = summarize(&orig).unwrap();
        assert_eq!(before.max_num_reorder_frames, Some(2));
        assert_eq!(before.max_dec_frame_buffering, Some(4));

        let after = summarize(&rewrite_rbsp(&orig).unwrap()).unwrap();
        assert_eq!(after.max_num_reorder_frames, Some(0));
        assert_eq!(after.max_dec_frame_buffering, Some(1));
        assert_eq!(after.max_num_ref_frames, 1);
        // The VUI fields we don't own must round-trip.
        assert_eq!(after.poc_type, 2);
        assert_eq!(after.profile_idc, 100);
        assert_eq!(after.level_idc, 42);
    }

    #[test]
    fn rbsp_escaping_round_trips() {
        // 00 00 01 in the payload must be escaped so it can't be read as a start code.
        let raw = vec![0x00, 0x00, 0x01, 0x02, 0x00, 0x00, 0x00, 0x03];
        let mut esc = Vec::new();
        escape(&raw, &mut esc);
        assert!(esc.windows(3).all(|w| w != [0, 0, 1]), "no bare start codes left");
        assert_eq!(unescape(&esc), raw, "unescape(escape(x)) == x");
    }

    #[test]
    fn fixup_into_rewrites_sps_and_passes_other_nals_through() {
        let sps_rbsp = nvenc_like_sps_rbsp();
        let mut stream = vec![0, 0, 0, 1, 0x67]; // SPS NAL header
        escape(&sps_rbsp, &mut stream);
        stream.extend_from_slice(&[0, 0, 0, 1, 0x68, 0xEE, 0x3C, 0x80]); // PPS
        stream.extend_from_slice(&[0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00]); // IDR slice

        let mut out = Vec::new();
        assert!(fixup_into(&stream, &mut out), "should report a rewrite");

        // The PPS and slice must survive byte-for-byte.
        let pps = [0u8, 0, 0, 1, 0x68, 0xEE, 0x3C, 0x80];
        let idr = [0u8, 0, 0, 1, 0x65, 0x88, 0x84, 0x00];
        assert!(out.windows(pps.len()).any(|w| w == pps), "PPS preserved");
        assert!(out.windows(idr.len()).any(|w| w == idr), "IDR slice preserved");

        // And the SPS in the output now carries the low-latency hints.
        let units = nal_units(&out);
        let sps = units
            .iter()
            .map(|&(s, e)| &out[s..e])
            .find(|n| !n.is_empty() && n[0] & 0x1f == 7)
            .expect("SPS present");
        let info = summarize(&unescape(&sps[1..])).expect("parse");
        assert_eq!(info.max_num_ref_frames, 1);
        assert_eq!(info.max_num_reorder_frames, Some(0));
        assert_eq!(info.max_dec_frame_buffering, Some(1));
    }

    #[test]
    fn malformed_sps_is_passed_through_not_corrupted() {
        let mut stream = vec![0, 0, 0, 1, 0x67];
        stream.extend_from_slice(&[0xFF; 3]); // truncated garbage
        let mut out = Vec::new();
        let rewrote = fixup_into(&stream, &mut out);
        assert!(!rewrote, "must not claim a rewrite it couldn't do");
        assert_eq!(out, stream, "original bytes must be preserved verbatim");
    }
}
