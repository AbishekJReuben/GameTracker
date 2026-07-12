//! Desktop audio capture for the remote stream (Windows WASAPI **loopback**).
//!
//! We grab whatever is playing on the default render endpoint (the speakers) in
//! shared mode with `AUDCLNT_STREAMFLAGS_LOOPBACK`, and hand the raw interleaved
//! **float32 PCM** to the host webview over a Tauri channel. The webview feeds it
//! into a WebAudio graph whose `MediaStreamAudioDestinationNode` track is added to
//! the same peer connection as the video, so the phone hears the PC in sync with
//! the screen. Non-Windows targets get a no-op.

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
    fmt_rx.recv_timeout(std::time::Duration::from_millis(2500)).ok()
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
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
        MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    };

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
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;

        let pwfx = client.GetMixFormat()?;
        let wfx = *pwfx;
        let sample_rate = wfx.nSamplesPerSec;
        let channels = wfx.nChannels;
        let block_align = wfx.nBlockAlign as usize; // bytes per full sample frame

        // 200ms shared buffer; loopback so we receive the render mix.
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            2_000_000,
            0,
            pwfx,
            None,
        )?;
        CoTaskMemFree(Some(pwfx as *const _ as *const _));

        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        let _ = fmt_tx.send(AudioFormat { sample_rate, channels });

        while AUDIO_RUNNING.load(Ordering::SeqCst) && AUDIO_GEN.load(Ordering::SeqCst) == my_gen {
            let mut packet = capture.GetNextPacketSize()?;
            while packet != 0 {
                let mut pdata: *mut u8 = std::ptr::null_mut();
                let mut num_frames: u32 = 0;
                let mut flags: u32 = 0;
                capture.GetBuffer(&mut pdata, &mut num_frames, &mut flags, None, None)?;
                let n = num_frames as usize * block_align;
                let mut buf = vec![0u8; n];
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) == 0 && !pdata.is_null() && n > 0 {
                    std::ptr::copy_nonoverlapping(pdata, buf.as_mut_ptr(), n);
                }
                capture.ReleaseBuffer(num_frames)?;
                if n > 0 {
                    emit(buf);
                }
                packet = capture.GetNextPacketSize()?;
            }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
        let _ = client.Stop();
        Ok(())
    })();
    CoUninitialize();
    result
}

#[cfg(not(windows))]
pub fn start_audio<F>(_emit: F) -> Option<AudioFormat>
where
    F: Fn(Vec<u8>) + Send + 'static,
{
    None
}
