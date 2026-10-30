//! Writing to the OS clipboard. The only code in the app allowed to wait on another
//! app, so it has a thread of its own.
//!
//! `EmptyClipboard` waits for the app that owns the clipboard right now: measured
//! here, up to about 5 seconds when that app is busy, which is Windows' hang limit.
//! On a UI thread that froze every window and made Windows ghost the overlay.
//!
//! This thread also owns what it writes, so it keeps pumping messages between jobs:
//! an owner that doesn't pump would do to other apps exactly what they did to us.

#![cfg(windows)]

use crate::error::{AppError, AppResult};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardOwner, OpenClipboard, RegisterClipboardFormatW,
    SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Threading::{
    GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowThreadProcessId,
    PostThreadMessageW, RegisterClassW, HMENU, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE,
    WM_APP, WNDCLASSW,
};

const CF_DIB: u32 = 8;
const CF_UNICODETEXT: u32 = 13;
const WM_JOB: u32 = WM_APP + 1;
/// How long another app may hold the clipboard open before a copy gives up.
const OPEN_TRIES: u32 = 40;
const OPEN_WAIT: Duration = Duration::from_millis(25);

/// Registered format that marks a write as ours, so the watcher (which may be in the
/// other process) doesn't capture a note as a new note.
const ORIGIN_FORMAT: PCWSTR = w!("GameTrackerNotesCopy");

pub fn origin_format() -> u32 {
    static FORMAT: OnceLock<u32> = OnceLock::new();
    *FORMAT.get_or_init(|| unsafe { RegisterClipboardFormatW(ORIGIN_FORMAT) })
}

pub enum Payload {
    Text(String),
    /// A complete CF_DIB block.
    Dib(Vec<u8>),
}

struct Job {
    payload: Payload,
    done: Sender<AppResult<()>>,
}

static JOBS: Mutex<Vec<Job>> = Mutex::new(Vec::new());
static THREAD: OnceLock<u32> = OnceLock::new();

fn thread_id() -> Option<u32> {
    if let Some(id) = THREAD.get() {
        return Some(*id);
    }
    let (tx, rx) = channel();
    std::thread::Builder::new()
        .name("notes-clipboard".into())
        .spawn(move || run(tx))
        .ok()?;
    let id = rx.recv_timeout(Duration::from_secs(5)).ok()?;
    Some(*THREAD.get_or_init(|| id))
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    DefWindowProcW(hwnd, msg, wp, lp)
}

fn run(ready: Sender<u32>) {
    unsafe {
        let module = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).unwrap_or_default();
        let instance = HINSTANCE(module.0);
        let class = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: instance,
            lpszClassName: w!("GTNotesClipboardOwner"),
            ..Default::default()
        };
        RegisterClassW(&class);
        let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("GTNotesClipboardOwner"),
            w!("notes clipboard"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            HMENU::default(),
            instance,
            None,
        ) else {
            return;
        };
        // Forces this thread's message queue into existence before anyone posts to it.
        let mut msg = MSG::default();
        let _ = windows::Win32::UI::WindowsAndMessaging::PeekMessageW(&mut msg, HWND::default(), 0, 0, windows::Win32::UI::WindowsAndMessaging::PM_NOREMOVE);
        let _ = ready.send(GetCurrentThreadId());
        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
            if msg.message == WM_JOB {
                let jobs = JOBS.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default();
                for job in jobs {
                    let result = write(hwnd, &job.payload);
                    let _ = job.done.send(result);
                }
            } else {
                DispatchMessageW(&msg);
            }
        }
    }
}

/// Queue a write. The receiver gets the outcome once the write is done.
pub fn submit(payload: Payload) -> AppResult<Receiver<AppResult<()>>> {
    let id = thread_id().ok_or_else(|| AppError::msg("clipboard thread could not start"))?;
    let (done, rx) = channel();
    JOBS.lock()
        .map_err(|_| AppError::msg("clipboard queue is broken"))?
        .push(Job { payload, done });
    unsafe { PostThreadMessageW(id, WM_JOB, WPARAM(0), LPARAM(0)) }
        .map_err(|e| AppError::msg(format!("clipboard thread didn't take the job: {e}")))?;
    Ok(rx)
}

unsafe fn global(bytes: &[u8]) -> AppResult<HANDLE> {
    let hg = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1))
        .map_err(|e| AppError::msg(format!("clipboard memory: {e}")))?;
    let ptr = GlobalLock(hg) as *mut u8;
    if ptr.is_null() {
        return Err(AppError::msg("clipboard memory could not be locked"));
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
    let _ = GlobalUnlock(hg);
    Ok(HANDLE(hg.0))
}

unsafe fn open(hwnd: HWND) -> bool {
    for attempt in 0..OPEN_TRIES {
        if OpenClipboard(hwnd).is_ok() {
            return true;
        }
        if attempt + 1 < OPEN_TRIES {
            std::thread::sleep(OPEN_WAIT);
        }
    }
    false
}

fn write(hwnd: HWND, payload: &Payload) -> AppResult<()> {
    unsafe {
        if !open(hwnd) {
            return Err(AppError::msg("Another app is holding the clipboard. Try again."));
        }
        let result = (|| {
            EmptyClipboard().map_err(|e| AppError::msg(format!("clipboard: {e}")))?;
            match payload {
                Payload::Text(text) => {
                    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
                    let bytes = std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2);
                    SetClipboardData(CF_UNICODETEXT, global(bytes)?)
                }
                Payload::Dib(dib) => SetClipboardData(CF_DIB, global(dib)?),
            }
            .map_err(|e| AppError::msg(format!("clipboard: {e}")))?;
            let _ = SetClipboardData(origin_format(), global(&[1])?);
            Ok(())
        })();
        let _ = CloseClipboard();
        result
    }
}

/// A bottom-up 32 bpp BI_RGB DIB, the form every app can paste.
pub fn dib_from_rgba(rgba: &image::RgbaImage) -> Vec<u8> {
    let (w, h) = rgba.dimensions();
    let pixels = (w as usize) * (h as usize) * 4;
    let mut dib = Vec::with_capacity(40 + pixels);
    dib.extend_from_slice(&40u32.to_le_bytes()); // biSize
    dib.extend_from_slice(&(w as i32).to_le_bytes()); // biWidth
    dib.extend_from_slice(&(h as i32).to_le_bytes()); // biHeight (+ = bottom-up)
    dib.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    dib.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    dib.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    dib.extend_from_slice(&(pixels as u32).to_le_bytes()); // biSizeImage
    dib.extend_from_slice(&[0u8; 16]); // resolution and palette counts
    let stride = w as usize * 4;
    if stride > 0 {
        for row in rgba.as_raw().chunks_exact(stride).rev() {
            for p in row.chunks_exact(4) {
                dib.extend_from_slice(&[p[2], p[1], p[0], p[3]]);
            }
        }
    }
    dib
}

/// The app that owns the clipboard right now, for "Waiting for Unity…".
pub fn owner_app() -> Option<String> {
    unsafe {
        let owner = GetClipboardOwner().ok()?;
        let mut pid = 0u32;
        GetWindowThreadProcessId(owner, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut path = [0u16; 512];
        let mut len = path.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&path[..len as usize]);
        let stem = std::path::Path::new(&path).file_stem()?.to_string_lossy().into_owned();
        Some(stem)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dib_is_bottom_up_bgra_with_a_40_byte_header() {
        let img = image::RgbaImage::from_raw(1, 2, vec![1, 2, 3, 4, 5, 6, 7, 8]).unwrap();
        let dib = dib_from_rgba(&img);
        assert_eq!(dib.len(), 40 + 8);
        assert_eq!(u32::from_le_bytes(dib[0..4].try_into().unwrap()), 40);
        assert_eq!(i32::from_le_bytes(dib[4..8].try_into().unwrap()), 1);
        assert_eq!(i32::from_le_bytes(dib[8..12].try_into().unwrap()), 2);
        assert_eq!(&dib[40..48], &[7, 6, 5, 8, 3, 2, 1, 4], "last row first, red and blue swapped");
    }
}
