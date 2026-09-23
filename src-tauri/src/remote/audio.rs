//! Desktop audio capture for the remote stream (Windows WASAPI **loopback**).
//!
//! We grab whatever is playing on the default render endpoint (the speakers) in
//! shared, event-driven mode with `AUDCLNT_STREAMFLAGS_LOOPBACK`. Endpoint mix
//! formats are normalized to interleaved float32 mono/stereo before crossing the
//! Tauri channel. The host then sends either direct Opus or the RTC fallback.
//! Non-Windows targets get a no-op.

#![allow(clippy::needless_return)]

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

static AUDIO_RUNNING: AtomicBool = AtomicBool::new(false);
static AUDIO_GEN: AtomicU32 = AtomicU32::new(0);

/// The PCM format the webview must use to interpret the byte stream.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Clone, Copy, Debug)]
enum SampleEncoding {
    Float32,
    Unsigned8,
    Signed16,
    Signed24,
    Signed32,
}

// WAVEFORMATEXTENSIBLE speaker-position bits (ksmedia.h), in channel order.
const SPK_FRONT_LEFT: u32 = 0x1;
const SPK_FRONT_RIGHT: u32 = 0x2;
const SPK_FRONT_CENTER: u32 = 0x4;
const SPK_LOW_FREQUENCY: u32 = 0x8;
const SPK_BACK_LEFT: u32 = 0x10;
const SPK_BACK_RIGHT: u32 = 0x20;
const SPK_FRONT_LEFT_OF_CENTER: u32 = 0x40;
const SPK_FRONT_RIGHT_OF_CENTER: u32 = 0x80;
const SPK_BACK_CENTER: u32 = 0x100;
const SPK_SIDE_LEFT: u32 = 0x200;
const SPK_SIDE_RIGHT: u32 = 0x400;
const SPK_TOP_CENTER: u32 = 0x800;
const SPK_TOP_FRONT_LEFT: u32 = 0x1000;
const SPK_TOP_FRONT_CENTER: u32 = 0x2000;
const SPK_TOP_FRONT_RIGHT: u32 = 0x4000;
const SPK_TOP_BACK_LEFT: u32 = 0x8000;
const SPK_TOP_BACK_CENTER: u32 = 0x10000;
const SPK_TOP_BACK_RIGHT: u32 = 0x20000;

/// -3 dB: the standard fold-down gain for centre and surround channels.
const FOLD: f32 = std::f32::consts::FRAC_1_SQRT_2;

/// Speaker position of each channel: from the endpoint's channel mask when it
/// describes exactly `channels` speakers, else the default Windows layout for
/// that count (KSAUDIO_SPEAKER_*).
fn speaker_positions(channels: usize, mask: Option<u32>) -> Vec<u32> {
    if let Some(m) = mask {
        if m.count_ones() as usize == channels {
            return (0..32).map(|b| 1u32 << b).filter(|bit| m & bit != 0).collect();
        }
    }
    let (fl, fr, fc, lfe) = (SPK_FRONT_LEFT, SPK_FRONT_RIGHT, SPK_FRONT_CENTER, SPK_LOW_FREQUENCY);
    let (bl, br) = (SPK_BACK_LEFT, SPK_BACK_RIGHT);
    let (sl, sr) = (SPK_SIDE_LEFT, SPK_SIDE_RIGHT);
    match channels {
        1 => vec![fc],
        2 => vec![fl, fr],
        3 => vec![fl, fr, fc],
        4 => vec![fl, fr, bl, br],
        5 => vec![fl, fr, fc, bl, br],
        6 => vec![fl, fr, fc, lfe, bl, br],
        7 => vec![fl, fr, fc, lfe, SPK_BACK_CENTER, sl, sr],
        8 => vec![fl, fr, fc, lfe, bl, br, sl, sr],
        // Unknown layout: FL/FR first, then alternate the rest left/right.
        n => (0..n).map(|i| if i % 2 == 0 { fl } else { fr }).collect(),
    }
}

/// (left, right) gain for one speaker position when folding down to stereo.
/// Centre-type channels feed both sides at -3 dB, left/right-type channels feed
/// their own side (surrounds at -3 dB) and LFE is dropped — the same fold-down
/// the Web Audio spec and ITU-R BS.775 use.
fn fold_gain(position: u32) -> [f32; 2] {
    match position {
        SPK_FRONT_LEFT => [1.0, 0.0],
        SPK_FRONT_RIGHT => [0.0, 1.0],
        SPK_FRONT_CENTER | SPK_BACK_CENTER | SPK_TOP_CENTER | SPK_TOP_FRONT_CENTER | SPK_TOP_BACK_CENTER => {
            [FOLD, FOLD]
        }
        SPK_LOW_FREQUENCY => [0.0, 0.0],
        SPK_FRONT_LEFT_OF_CENTER | SPK_BACK_LEFT | SPK_SIDE_LEFT | SPK_TOP_FRONT_LEFT | SPK_TOP_BACK_LEFT => {
            [FOLD, 0.0]
        }
        SPK_FRONT_RIGHT_OF_CENTER | SPK_BACK_RIGHT | SPK_SIDE_RIGHT | SPK_TOP_FRONT_RIGHT | SPK_TOP_BACK_RIGHT => {
            [0.0, FOLD]
        }
        _ => [0.0, 0.0],
    }
}

/// Per-input-channel stereo gains for an endpoint with `channels` channels. Mono
/// and stereo endpoints are passed through untouched (identity).
fn stereo_fold_matrix(channels: usize, mask: Option<u32>) -> Vec<[f32; 2]> {
    if channels <= 2 {
        return (0..channels).map(|c| if c == 0 { [1.0, 0.0] } else { [0.0, 1.0] }).collect();
    }
    speaker_positions(channels, mask).into_iter().map(fold_gain).collect()
}

/// Soft limiter for the folded mix. Summing centre + surrounds into one side can
/// exceed full scale on loud game audio, and a hard clamp there is audible
/// crackle. Identity up to ±0.8, then a smooth knee that never exceeds ±1.
fn soft_limit(x: f32) -> f32 {
    const KNEE: f32 = 0.8;
    let a = x.abs();
    if a <= KNEE {
        x
    } else {
        x.signum() * (KNEE + (1.0 - KNEE) * ((a - KNEE) / (1.0 - KNEE)).tanh())
    }
}

fn read_sample(src: &[u8], offset: usize, encoding: SampleEncoding) -> f32 {
    let sample = match encoding {
        SampleEncoding::Float32 if offset + 4 <= src.len() => {
            f32::from_le_bytes(src[offset..offset + 4].try_into().unwrap())
        }
        SampleEncoding::Unsigned8 if offset < src.len() => (src[offset] as f32 - 128.0) / 128.0,
        SampleEncoding::Signed16 if offset + 2 <= src.len() => {
            i16::from_le_bytes(src[offset..offset + 2].try_into().unwrap()) as f32 / 32768.0
        }
        SampleEncoding::Signed24 if offset + 3 <= src.len() => {
            let raw = (src[offset] as i32) | ((src[offset + 1] as i32) << 8) | ((src[offset + 2] as i32) << 16);
            let signed = (raw << 8) >> 8;
            signed as f32 / 8_388_608.0
        }
        SampleEncoding::Signed32 if offset + 4 <= src.len() => {
            i32::from_le_bytes(src[offset..offset + 4].try_into().unwrap()) as f32 / 2_147_483_648.0
        }
        _ => 0.0,
    };
    if sample.is_finite() {
        sample
    } else {
        0.0
    }
}

/// Normalize any common WASAPI mix format to the exact wire contract used by
/// WebAudio: interleaved little-endian f32, mono or stereo. Shared endpoints can
/// expose integer PCM or >2 channels; forwarding those bytes as f32/stereo was
/// distortion, not merely a quality loss. Surround endpoints (5.1/7.1…) are folded
/// down through `fold` (see [`stereo_fold_matrix`]); keeping only the first two
/// channels used to drop the centre channel, i.e. game and film dialogue.
fn normalize_packet(
    src: &[u8],
    frames: usize,
    input_channels: usize,
    output_channels: usize,
    bytes_per_sample: usize,
    encoding: SampleEncoding,
    fold: &[[f32; 2]],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(frames * output_channels * 4);
    let surround = input_channels > 2 && output_channels == 2 && fold.len() == input_channels;
    for frame in 0..frames {
        let base = frame * input_channels;
        if surround {
            let (mut l, mut r) = (0.0f32, 0.0f32);
            for (c, g) in fold.iter().enumerate() {
                let s = read_sample(src, (base + c) * bytes_per_sample, encoding);
                l += s * g[0];
                r += s * g[1];
            }
            out.extend_from_slice(&soft_limit(l).clamp(-1.0, 1.0).to_le_bytes());
            out.extend_from_slice(&soft_limit(r).clamp(-1.0, 1.0).to_le_bytes());
            continue;
        }
        for channel in 0..output_channels {
            let s = read_sample(src, (base + channel) * bytes_per_sample, encoding);
            out.extend_from_slice(&s.clamp(-1.0, 1.0).to_le_bytes());
        }
    }
    out
}

/// Stop the loopback capture thread (if any).
pub fn stop_audio() {
    AUDIO_RUNNING.store(false, Ordering::SeqCst);
    AUDIO_GEN.fetch_add(1, Ordering::SeqCst);
}

#[cfg(windows)]
pub fn start_audio<F>(emit: F) -> Option<AudioFormat>
where
    F: Fn(Vec<u8>) + Send + 'static,
{
    use std::sync::mpsc;

    // Supersede any prior capture.
    let my_gen = AUDIO_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    AUDIO_RUNNING.store(true, Ordering::SeqCst);

    let (fmt_tx, fmt_rx) = mpsc::channel::<AudioFormat>();
    std::thread::spawn(move || unsafe {
        if let Err(e) = run_loopback(my_gen, fmt_tx, emit) {
            eprintln!("remote audio: loopback ended: {e:?}");
        }
        AUDIO_RUNNING.store(false, Ordering::SeqCst);
    });

    // Wait briefly for the thread to report the negotiated mix format.
    fmt_rx
        .recv_timeout(std::time::Duration::from_millis(2500))
        .ok()
}

#[cfg(windows)]
unsafe fn run_loopback<F>(
    my_gen: u32,
    fmt_tx: std::sync::mpsc::Sender<AudioFormat>,
    emit: F,
) -> windows::core::Result<()>
where
    F: Fn(Vec<u8>) + Send + 'static,
{
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
        MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEXTENSIBLE,
        WAVE_FORMAT_PCM,
    };
    use windows::Win32::Media::KernelStreaming::{
        KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE,
    };
    use windows::Win32::Media::Multimedia::{
        KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    // Register this thread with MMCSS as "Pro Audio": at normal priority a
    // running game can starve the capture loop long enough for the endpoint
    // buffer to glitch (audible crackle on the phone during gameplay). MMCSS
    // gives it the elevated scheduler class real audio engines use without
    // starving the rest of the system. Best-effort — capture works without it.
    {
        use windows::core::w;
        use windows::Win32::System::Threading::AvSetMmThreadCharacteristicsW;
        let mut task_index = 0u32;
        let _ = AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task_index);
    }
    let result = (|| -> windows::core::Result<()> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;

        let pwfx = client.GetMixFormat()?;
        let wfx = *pwfx;
        let sample_rate = wfx.nSamplesPerSec;
        let input_channels = wfx.nChannels as usize;
        let channels = input_channels.clamp(1, 2) as u16;
        let block_align = wfx.nBlockAlign as usize; // bytes per full sample frame
        let bytes_per_sample = block_align / input_channels.max(1);
        let bits_per_sample = wfx.wBitsPerSample;
        let tag = wfx.wFormatTag as u32;
        let (subtype, channel_mask) = if tag == WAVE_FORMAT_EXTENSIBLE {
            let ext = std::ptr::read_unaligned(pwfx as *const WAVEFORMATEXTENSIBLE);
            (
                Some(std::ptr::addr_of!(ext.SubFormat).read_unaligned()),
                Some(std::ptr::addr_of!(ext.dwChannelMask).read_unaligned()),
            )
        } else {
            (None, None)
        };
        let fold = stereo_fold_matrix(input_channels, channel_mask);
        let encoding =
            if tag == WAVE_FORMAT_IEEE_FLOAT || subtype == Some(KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) {
                if bits_per_sample != 32 {
                    return Err(windows::core::Error::new(
                        windows::core::HRESULT(0x80004005u32 as i32),
                        format!("unsupported WASAPI float depth: {bits_per_sample}"),
                    ));
                }
                SampleEncoding::Float32
            } else if tag == WAVE_FORMAT_PCM || subtype == Some(KSDATAFORMAT_SUBTYPE_PCM) {
                match bits_per_sample {
                    8 => SampleEncoding::Unsigned8,
                    16 => SampleEncoding::Signed16,
                    24 => SampleEncoding::Signed24,
                    32 => SampleEncoding::Signed32,
                    bits => {
                        return Err(windows::core::Error::new(
                            windows::core::HRESULT(0x80004005u32 as i32),
                            format!("unsupported WASAPI PCM depth: {bits}"),
                        ));
                    }
                }
            } else {
                return Err(windows::core::Error::new(
                    windows::core::HRESULT(0x80004005u32 as i32),
                    format!("unsupported WASAPI format tag: {tag}"),
                ));
            };

        // Shared event-driven loopback (supported on Windows 10 1703+). The
        // engine wakes us exactly when a packet is ready instead of an 8ms poll
        // drifting against the endpoint period under game load.
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            0,
            0,
            pwfx,
            None,
        )?;
        CoTaskMemFree(Some(pwfx as *const _ as *const _));

        let ready = CreateEventW(None, false, false, windows::core::PCWSTR::null())?;
        client.SetEventHandle(ready)?;
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        let _ = fmt_tx.send(AudioFormat {
            sample_rate,
            channels,
        });

        while AUDIO_RUNNING.load(Ordering::SeqCst) && AUDIO_GEN.load(Ordering::SeqCst) == my_gen {
            let _ = WaitForSingleObject(ready, 50);
            let mut packet = capture.GetNextPacketSize()?;
            while packet != 0 {
                let mut pdata: *mut u8 = std::ptr::null_mut();
                let mut num_frames: u32 = 0;
                let mut flags: u32 = 0;
                capture.GetBuffer(&mut pdata, &mut num_frames, &mut flags, None, None)?;
                let n = num_frames as usize * block_align;
                let silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || pdata.is_null();
                let input = if silent || n == 0 {
                    &[][..]
                } else {
                    std::slice::from_raw_parts(pdata, n)
                };
                let buf = normalize_packet(
                    input,
                    num_frames as usize,
                    input_channels,
                    channels as usize,
                    bytes_per_sample,
                    encoding,
                    &fold,
                );
                capture.ReleaseBuffer(num_frames)?;
                if !buf.is_empty() {
                    emit(buf);
                }
                packet = capture.GetNextPacketSize()?;
            }
        }
        let _ = client.Stop();
        let _ = CloseHandle(ready);
        Ok(())
    })();
    CoUninitialize();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn floats(bytes: &[u8]) -> Vec<f32> {
        bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect()
    }

    #[test]
    fn normalizes_s16_to_float() {
        let src = [
            i16::MIN.to_le_bytes(),
            0i16.to_le_bytes(),
            i16::MAX.to_le_bytes(),
        ]
        .concat();
        let got = floats(&normalize_packet(
            &src,
            3,
            1,
            1,
            2,
            SampleEncoding::Signed16,
            &stereo_fold_matrix(1, None),
        ));
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], -1.0);
        assert_eq!(got[1], 0.0);
        assert!(got[2] > 0.999);
    }

    fn f32_bytes(v: &[f32]) -> Vec<u8> {
        v.iter().copied().flat_map(f32::to_le_bytes).collect()
    }

    /// 5.1 (FL FR FC LFE BL BR): centre reaches both sides at -3 dB, surrounds
    /// their own side, LFE is dropped — and stereo framing stays intact.
    #[test]
    fn folds_5_1_into_stereo_keeping_the_centre_channel() {
        let fold = stereo_fold_matrix(6, Some(0x3F));
        let src = f32_bytes(&[0.1, -0.2, 0.3, 0.4, 0.5, 0.6]);
        let got = floats(&normalize_packet(&src, 1, 6, 2, 4, SampleEncoding::Float32, &fold));
        let k = std::f32::consts::FRAC_1_SQRT_2;
        assert_eq!(got.len(), 2);
        assert!((got[0] - (0.1 + 0.3 * k + 0.5 * k)).abs() < 1e-5, "left {}", got[0]);
        assert!((got[1] - (-0.2 + 0.3 * k + 0.6 * k)).abs() < 1e-5, "right {}", got[1]);
    }

    /// Dialogue-only content (centre channel) must not go silent any more.
    #[test]
    fn centre_only_dialogue_is_audible_on_both_sides() {
        let fold = stereo_fold_matrix(6, None);
        let src = f32_bytes(&[0.0, 0.0, 0.5, 0.9, 0.0, 0.0]);
        let got = floats(&normalize_packet(&src, 1, 6, 2, 4, SampleEncoding::Float32, &fold));
        assert!(got[0] > 0.3 && (got[0] - got[1]).abs() < 1e-6, "{got:?}");
    }

    /// 7.1 masks resolve side speakers correctly, and a loud fold-down is soft
    /// limited below full scale instead of hard clipping.
    #[test]
    fn folds_7_1_by_mask_and_soft_limits_overs() {
        let fold = stereo_fold_matrix(8, Some(0x63F));
        // Every channel at -6 dBFS folds to ~1.56 per side before limiting.
        let src = f32_bytes(&[0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
        let got = floats(&normalize_packet(&src, 1, 8, 2, 4, SampleEncoding::Float32, &fold));
        assert!(got.iter().all(|v| *v < 1.0 && *v > 0.9), "{got:?}");
        assert!(soft_limit(50.0) <= 1.0 && soft_limit(-50.0) >= -1.0, "never exceeds full scale");
        assert!((soft_limit(0.5) - 0.5).abs() < 1e-7, "identity below the knee");
    }

    /// Stereo endpoints are untouched (identity), including interleaving.
    #[test]
    fn stereo_passes_through() {
        let fold = stereo_fold_matrix(2, Some(0x3));
        let src = f32_bytes(&[0.25, -0.75, 0.5, 0.125]);
        let got = floats(&normalize_packet(&src, 2, 2, 2, 4, SampleEncoding::Float32, &fold));
        assert_eq!(got, vec![0.25, -0.75, 0.5, 0.125]);
    }
}

#[cfg(not(windows))]
pub fn start_audio<F>(_emit: F) -> Option<AudioFormat>
where
    F: Fn(Vec<u8>) + Send + 'static,
{
    None
}
