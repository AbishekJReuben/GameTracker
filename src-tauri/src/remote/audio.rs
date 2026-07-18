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

/// Normalize any common WASAPI mix format to the exact wire contract used by
/// WebAudio: interleaved little-endian f32, mono or stereo. Shared endpoints can
/// expose integer PCM or >2 channels; forwarding those bytes as f32/stereo was
/// distortion, not merely a quality loss.
fn normalize_packet(
    src: &[u8],
    frames: usize,
    input_channels: usize,
    output_channels: usize,
    bytes_per_sample: usize,
    encoding: SampleEncoding,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(frames * output_channels * 4);
    for frame in 0..frames {
        for channel in 0..output_channels {
            let offset = (frame * input_channels + channel) * bytes_per_sample;
            let sample = match encoding {
                SampleEncoding::Float32 if offset + 4 <= src.len() => {
                    f32::from_le_bytes(src[offset..offset + 4].try_into().unwrap())
                }
                SampleEncoding::Unsigned8 if offset < src.len() => {
                    (src[offset] as f32 - 128.0) / 128.0
                }
                SampleEncoding::Signed16 if offset + 2 <= src.len() => {
                    i16::from_le_bytes(src[offset..offset + 2].try_into().unwrap()) as f32 / 32768.0
                }
                SampleEncoding::Signed24 if offset + 3 <= src.len() => {
                    let raw = (src[offset] as i32)
                        | ((src[offset + 1] as i32) << 8)
                        | ((src[offset + 2] as i32) << 16);
                    let signed = (raw << 8) >> 8;
                    signed as f32 / 8_388_608.0
                }
                SampleEncoding::Signed32 if offset + 4 <= src.len() => {
                    i32::from_le_bytes(src[offset..offset + 4].try_into().unwrap()) as f32
                        / 2_147_483_648.0
                }
                _ => 0.0,
            };
            let finite = if sample.is_finite() {
                sample.clamp(-1.0, 1.0)
            } else {
                0.0
            };
            out.extend_from_slice(&finite.to_le_bytes());
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
        let subtype = if tag == WAVE_FORMAT_EXTENSIBLE {
            let ext = std::ptr::read_unaligned(pwfx as *const WAVEFORMATEXTENSIBLE);
            Some(std::ptr::addr_of!(ext.SubFormat).read_unaligned())
        } else {
            None
        };
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
        ));
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], -1.0);
        assert_eq!(got[1], 0.0);
        assert!(got[2] > 0.999);
    }

    #[test]
    fn drops_surround_channels_without_corrupting_stereo_framing() {
        let src: Vec<u8> = [0.1f32, -0.2, 0.3, 0.4, 0.5, 0.6]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect();
        let got = floats(&normalize_packet(&src, 1, 6, 2, 4, SampleEncoding::Float32));
        assert_eq!(got, vec![0.1, -0.2]);
    }
}

#[cfg(not(windows))]
pub fn start_audio<F>(_emit: F) -> Option<AudioFormat>
where
    F: Fn(Vec<u8>) + Send + 'static,
{
    None
}
