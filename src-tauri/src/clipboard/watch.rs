//! Windows clipboard capture — a message-only window that listens for
//! `WM_CLIPBOARDUPDATE` (via `AddClipboardFormatListener`) and records new text /
//! image copies. This is the desktop's true always-on auto-capture (Android can't
//! read the clipboard in the background, so it uses tap/share instead).
//!
//! Runs on its own thread with a classic Win32 message loop. `start` is idempotent
//! (refreshes context if already running); `stop` posts a close to the window.

#![cfg(windows)]

use crate::db::clipboard::{self as store, ClipInput};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicIsize, AtomicU64, Ordering};
use tauri::AppHandle;
use windows::core::w;
use windows::Win32::Foundation::{HANDLE, HGLOBAL, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData,
    IsClipboardFormatAvailable, OpenClipboard, RemoveClipboardFormatListener, SetClipboardData,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, PostMessageW,
    PostQuitMessage, RegisterClassW, TranslateMessage, HMENU, HWND_MESSAGE, MSG, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_CLIPBOARDUPDATE, WM_CLOSE, WM_DESTROY, WNDCLASSW,
};

const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
    pool: crate::db::DbPool,
    media_dir: PathBuf,
    device_id: String,
    device_name: String,
}

static WATCH: Lazy<Mutex<Option<Ctx>>> = Lazy::new(|| Mutex::new(None));
static RUNNING: AtomicBool = AtomicBool::new(false);
static HWND_PTR: AtomicIsize = AtomicIsize::new(0);
/// Suppress capture for a short window after we set the clipboard ourselves
/// (quick-copy), so a copy doesn't loop back in as a "new" item.
static IGNORE_UNTIL: AtomicI64 = AtomicI64::new(0);
/// Hash of the last content we captured (text or image). Windows fires
/// `WM_CLIPBOARDUPDATE` several times for a single copy (an app sets CF_DIB,
/// CF_DIBV5 and CF_BITMAP in separate calls), so without this an image copy
/// lands as two or three identical rows. 0 means "nothing captured yet".
static LAST_HASH: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Stable hash of a captured payload, namespaced by kind so an image and a text
/// item that happen to collide never dedupe each other. Never returns 0 (that
/// value is reserved for "nothing captured yet").
fn content_hash(kind: &str, bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    kind.hash(&mut h);
    bytes.hash(&mut h);
    let v = h.finish();
    if v == 0 {
        1
    } else {
        v
    }
}

/// Ignore the next clipboard update (called right before we SetClipboardData).
pub fn ignore_next() {
    IGNORE_UNTIL.store(now_ms() + 1500, Ordering::SeqCst);
}

/// Start (or refresh) the listener thread. Safe to call repeatedly. Returns Ok on
/// successful handoff (the thread itself may still fail later — that's logged via
/// `crate::clipboard::log` from inside `run_message_loop`).
pub fn start(
    app: AppHandle,
    pool: crate::db::DbPool,
    media_dir: PathBuf,
    device_id: String,
    device_name: String,
) -> crate::error::AppResult<()> {
    *WATCH.lock() = Some(Ctx {
        app,
        pool,
        media_dir,
        device_id,
        device_name,
    });
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(()); // already looping; new context picked up on the next update
    }
    std::thread::spawn(|| {
        unsafe { run_message_loop() };
        RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

/// Stop the listener (posts WM_CLOSE to the message-only window).
pub fn stop() {
    let ptr = HWND_PTR.load(Ordering::SeqCst);
    if ptr != 0 {
        unsafe {
            let _ = PostMessageW(HWND(ptr as *mut c_void), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
    *WATCH.lock() = None;
}

unsafe fn run_message_loop() {
    crate::clipboard::log("watch: listener thread started");
    let hinstance: HINSTANCE = match GetModuleHandleW(None) {
        Ok(h) => HINSTANCE(h.0),
        Err(e) => {
            crate::clipboard::log(format!("watch: GetModuleHandleW failed: {e}"));
            return;
        }
    };
    let class_name = w!("GTClipboardWatch");
    let wc = WNDCLASSW {
        lpfnWndProc: Some(wndproc),
        hInstance: hinstance,
        lpszClassName: class_name,
        ..Default::default()
    };
    // Ignore the return: a second registration of the same class fails harmlessly.
    let _ = RegisterClassW(&wc);

    let hwnd = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        class_name,
        w!("gtclip"),
        WINDOW_STYLE(0),
        0,
        0,
        0,
        0,
        HWND_MESSAGE,
        HMENU::default(),
        hinstance,
        None,
    );
    let hwnd = match hwnd {
        Ok(h) => h,
        Err(e) => {
            crate::clipboard::log(format!("watch: CreateWindowExW failed: {e}"));
            return;
        }
    };
    HWND_PTR.store(hwnd.0 as isize, Ordering::SeqCst);
    match AddClipboardFormatListener(hwnd) {
        Ok(()) => crate::clipboard::log("watch: AddClipboardFormatListener ok"),
        Err(e) => {
            crate::clipboard::log(format!("watch: AddClipboardFormatListener FAILED: {e}"));
            // Without the listener we'll never receive updates, but a healthy
            // message loop is still required for a clean shutdown.
        }
    }

    let mut msg = MSG::default();
    while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    crate::clipboard::log("watch: message loop exited");

    let _ = RemoveClipboardFormatListener(hwnd);
    let _ = DestroyWindow(hwnd);
    HWND_PTR.store(0, Ordering::SeqCst);
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_CLIPBOARDUPDATE => {
            handle_update(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

unsafe fn handle_update(hwnd: HWND) {
    if now_ms() < IGNORE_UNTIL.load(Ordering::SeqCst) {
        return;
    }
    let Some(ctx) = WATCH.lock().clone() else {
        return;
    };
    let (text, png) = read_clipboard(hwnd);
    // Millisecond UTC + literal Z — the shared wire shape (see clipboard_add).
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    // An image copy wins over its text alternative (many apps offer both).
    if let Some(png) = png {
        // Skip Windows' repeated updates for the same copy (CF_DIB/CF_DIBV5/…),
        // which otherwise land as duplicate rows.
        let hash = content_hash("image", &png);
        if LAST_HASH.load(Ordering::SeqCst) == hash {
            return;
        }
        let id = uuid::Uuid::new_v4().to_string();
        if let Ok((image_path, thumb_path, size)) =
            crate::clipboard::save_image(&ctx.media_dir, &id, &png)
        {
            let input = ClipInput {
                id,
                kind: "image".into(),
                text: None,
                image_path: Some(image_path),
                thumb_path: Some(thumb_path),
                mime: Some("image/png".into()),
                size,
                created_utc: now,
                device_id: ctx.device_id.clone(),
                device_name: Some(ctx.device_name.clone()),
                source: "desktop".into(),
                pinned: false,
                folder: String::new(),
                content_hash: Some(store::content_hash("image", &png)),
                copies: Vec::new(),
                synced: false,
            };
            // add_local dedups: a re-copy of the same image bumps the existing note.
            let _ = crate::clipboard::add_local(&ctx.app, &ctx.pool, input);
            LAST_HASH.store(hash, Ordering::SeqCst);
        }
        return;
    }

    if let Some(text) = text {
        let text = text.trim_end_matches('\0').to_string();
        if text.is_empty() {
            return;
        }
        // In-memory guard against Windows' rapid duplicate WM_CLIPBOARDUPDATE
        // re-fires for a SINGLE copy. A deliberate re-copy of the same text later
        // (after copying something else) flows through — add_local dedups it into
        // the existing note and bumps that note to the top.
        let hash = content_hash("text", text.as_bytes());
        if LAST_HASH.load(Ordering::SeqCst) == hash {
            return;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let size = text.len() as i64;
        let store_hash = store::content_hash("text", text.as_bytes());
        let input = ClipInput {
            id,
            kind: "text".into(),
            text: Some(text),
            image_path: None,
            thumb_path: None,
            mime: Some("text/plain".into()),
            size,
            created_utc: now,
            device_id: ctx.device_id.clone(),
            device_name: Some(ctx.device_name.clone()),
            source: "desktop".into(),
            pinned: false,
            folder: String::new(),
            content_hash: Some(store_hash),
            copies: Vec::new(),
            synced: false,
        };
        let _ = crate::clipboard::add_local(&ctx.app, &ctx.pool, input);
        LAST_HASH.store(hash, Ordering::SeqCst);
    }
}

/// Read the current clipboard once (text + DIB image in a single session).
unsafe fn read_clipboard(hwnd: HWND) -> (Option<String>, Option<Vec<u8>>) {
    if OpenClipboard(hwnd).is_err() {
        return (None, None);
    }
    let mut text = None;
    let mut png = None;

    if IsClipboardFormatAvailable(CF_UNICODETEXT).is_ok() {
        if let Ok(h) = GetClipboardData(CF_UNICODETEXT) {
            let hg = HGLOBAL(h.0);
            let ptr = GlobalLock(hg) as *const u16;
            if !ptr.is_null() {
                let mut len = 0usize;
                while *ptr.add(len) != 0 {
                    len += 1;
                    if len > 20_000_000 {
                        break;
                    }
                }
                let slice = std::slice::from_raw_parts(ptr, len);
                text = Some(String::from_utf16_lossy(slice));
                let _ = GlobalUnlock(hg);
            }
        }
    }

    if IsClipboardFormatAvailable(CF_DIB).is_ok() {
        if let Ok(h) = GetClipboardData(CF_DIB) {
            let hg = HGLOBAL(h.0);
            let size = GlobalSize(hg);
            let ptr = GlobalLock(hg) as *const u8;
            if !ptr.is_null() && size > 0 {
                let dib = std::slice::from_raw_parts(ptr, size).to_vec();
                let _ = GlobalUnlock(hg);
                png = dib_to_png(&dib);
            }
        }
    }

    let _ = CloseClipboard();
    (text, png)
}

/// Convert a CF_DIB payload (BITMAPINFOHEADER + pixels) to PNG bytes by wrapping
/// it in a BMP file header and decoding it. Handles the common cases (24/32bpp
/// BI_RGB, 8bpp palette, BI_BITFIELDS); anything exotic just returns None.
fn dib_to_png(dib: &[u8]) -> Option<Vec<u8>> {
    if dib.len() < 20 {
        return None;
    }
    let header_size = u32::from_le_bytes([dib[0], dib[1], dib[2], dib[3]]) as usize;
    let bit_count = u16::from_le_bytes([dib[14], dib[15]]);
    let compression = u32::from_le_bytes([dib[16], dib[17], dib[18], dib[19]]);
    let clr_used = if dib.len() >= 36 {
        u32::from_le_bytes([dib[32], dib[33], dib[34], dib[35]]) as usize
    } else {
        0
    };
    let palette = if bit_count <= 8 {
        let n = if clr_used != 0 {
            clr_used
        } else {
            1usize << bit_count
        };
        n * 4
    } else if compression == 3 {
        // BI_BITFIELDS: three DWORD colour masks follow a v3 header.
        if header_size <= 40 {
            12
        } else {
            0
        }
    } else {
        0
    };
    let off_bits = 14 + header_size + palette;
    let file_size = 14 + dib.len();

    let mut bmp = Vec::with_capacity(file_size);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&(file_size as u32).to_le_bytes());
    bmp.extend_from_slice(&0u16.to_le_bytes()); // reserved1
    bmp.extend_from_slice(&0u16.to_le_bytes()); // reserved2
    bmp.extend_from_slice(&(off_bits as u32).to_le_bytes());
    bmp.extend_from_slice(dib);

    let img = image::load_from_memory_with_format(&bmp, image::ImageFormat::Bmp).ok()?;
    let mut rgba = img.to_rgba8();
    // A 32bpp source that left alpha all-zero (common for screenshots) would decode
    // as fully transparent — treat it as opaque.
    if rgba.pixels().all(|p| p[3] == 0) {
        for p in rgba.pixels_mut() {
            p[3] = 255;
        }
    }
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    Some(png)
}

/// Put UTF-16 text on the OS clipboard.
pub fn set_os_text(text: &str) {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = wide.len() * 2;
    unsafe {
        if OpenClipboard(HWND::default()).is_err() {
            return;
        }
        let _ = EmptyClipboard();
        if let Ok(hg) = GlobalAlloc(GMEM_MOVEABLE, bytes) {
            let ptr = GlobalLock(hg) as *mut u16;
            if !ptr.is_null() {
                std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
                let _ = GlobalUnlock(hg);
                // On success the system owns the memory — don't free it.
                let _ = SetClipboardData(CF_UNICODETEXT, HANDLE(hg.0));
            }
        }
        let _ = CloseClipboard();
    }
}

/// Put an image on the OS clipboard as a bottom-up 32bpp BI_RGB DIB.
pub fn set_os_image(rgba: &image::RgbaImage) {
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
    dib.extend_from_slice(&0i32.to_le_bytes()); // biXPelsPerMeter
    dib.extend_from_slice(&0i32.to_le_bytes()); // biYPelsPerMeter
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant
    for y in (0..h).rev() {
        for x in 0..w {
            let p = rgba.get_pixel(x, y).0;
            dib.push(p[2]);
            dib.push(p[1]);
            dib.push(p[0]);
            dib.push(p[3]);
        }
    }
    unsafe {
        if OpenClipboard(HWND::default()).is_err() {
            return;
        }
        let _ = EmptyClipboard();
        if let Ok(hg) = GlobalAlloc(GMEM_MOVEABLE, dib.len()) {
            let ptr = GlobalLock(hg) as *mut u8;
            if !ptr.is_null() {
                std::ptr::copy_nonoverlapping(dib.as_ptr(), ptr, dib.len());
                let _ = GlobalUnlock(hg);
                let _ = SetClipboardData(CF_DIB, HANDLE(hg.0));
            }
        }
        let _ = CloseClipboard();
    }
}
