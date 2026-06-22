//! Primary-monitor screen capture (GDI BitBlt) saved as a JPEG.
//!
//! Best-effort: returns `false` on any failure so the tracker just skips the
//! capture. Note GDI can't grab fullscreen-exclusive DirectX surfaces (those
//! come out black); borderless / windowed games capture fine.

use std::path::Path;

#[cfg(windows)]
pub fn capture_primary_jpeg(dest: &Path) -> bool {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HGDIOBJ, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    unsafe {
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        if w <= 0 || h <= 0 {
            return false;
        }

        let screen = GetDC(HWND::default());
        if screen.is_invalid() {
            return false;
        }
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, HGDIOBJ(bmp.0));

        let blit_ok = BitBlt(mem, 0, 0, w, h, screen, 0, 0, SRCCOPY).is_ok();

        let mut header = BITMAPINFO::default();
        header.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        header.bmiHeader.biWidth = w;
        header.bmiHeader.biHeight = -h; // top-down rows
        header.bmiHeader.biPlanes = 1;
        header.bmiHeader.biBitCount = 32;
        header.bmiHeader.biCompression = BI_RGB.0;

        let mut buffer = vec![0u8; (w * h * 4) as usize];
        let scanned = GetDIBits(
            mem,
            bmp,
            0,
            h as u32,
            Some(buffer.as_mut_ptr() as *mut c_void),
            &mut header,
            DIB_RGB_COLORS,
        );

        SelectObject(mem, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem);
        ReleaseDC(HWND::default(), screen);

        if !blit_ok || scanned == 0 {
            return false;
        }

        // BGRA -> RGB
        let mut rgb = vec![0u8; (w * h * 3) as usize];
        for (i, px) in buffer.chunks_exact(4).enumerate() {
            rgb[i * 3] = px[2];
            rgb[i * 3 + 1] = px[1];
            rgb[i * 3 + 2] = px[0];
        }

        let Some(img) = image::RgbImage::from_raw(w as u32, h as u32, rgb) else {
            return false;
        };
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        img.save(dest).is_ok()
    }
}

#[cfg(not(windows))]
pub fn capture_primary_jpeg(_dest: &Path) -> bool {
    false
}
