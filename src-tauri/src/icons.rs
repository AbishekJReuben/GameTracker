//! Game artwork helpers: extract an icon from an exe, or import a user-supplied cover.
use crate::error::{AppError, AppResult};
use std::path::Path;

/// Copy a user-chosen image into the app's media folder and return the stored path.
pub fn import_cover(src: &str, media_dir: &Path, game_id: &str) -> AppResult<String> {
    let src_path = Path::new(src);
    if !src_path.is_file() {
        return Err(AppError::msg("Image file not found."));
    }
    std::fs::create_dir_all(media_dir)?;
    let ext = src_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let dest = media_dir.join(format!("cover_{game_id}.{ext}"));
    std::fs::copy(src_path, &dest)?;
    Ok(dest.to_string_lossy().to_string())
}

/// Extract an icon from an executable into `media_dir`, returning the PNG path.
/// Best-effort: `Ok(None)` when no icon can be read (UI falls back to a placeholder).
pub fn extract_icon_png(
    exe_path: &str,
    media_dir: &Path,
    game_id: &str,
) -> AppResult<Option<String>> {
    #[cfg(windows)]
    {
        if let Some(img) = win::extract(exe_path) {
            std::fs::create_dir_all(media_dir)?;
            let dest = media_dir.join(format!("icon_{game_id}.png"));
            img.save(&dest).map_err(|e| AppError::msg(e.to_string()))?;
            return Ok(Some(dest.to_string_lossy().to_string()));
        }
        Ok(None)
    }
    #[cfg(not(windows))]
    {
        let _ = (exe_path, media_dir, game_id);
        Ok(None)
    }
}

#[cfg(windows)]
mod win {
    use image::RgbaImage;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, ReleaseDC, BITMAP,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, GetDC, HBITMAP, HDC, HGDIOBJ,
    };
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn extract(exe_path: &str) -> Option<RgbaImage> {
        unsafe {
            let path = wide(exe_path);
            let mut shfi = SHFILEINFOW::default();
            let res = SHGetFileInfoW(
                PCWSTR(path.as_ptr()),
                Default::default(),
                Some(&mut shfi),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            );
            if res == 0 || shfi.hIcon.is_invalid() {
                return None;
            }
            let img = hicon_to_rgba(shfi.hIcon);
            let _ = DestroyIcon(shfi.hIcon);
            img
        }
    }

    unsafe fn hicon_to_rgba(icon: HICON) -> Option<RgbaImage> {
        let mut info = ICONINFO::default();
        if GetIconInfo(icon, &mut info).is_err() {
            return None;
        }
        let color: HBITMAP = info.hbmColor;
        let mut bmp = BITMAP::default();
        let got = GetObjectW(
            HGDIOBJ(color.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut _),
        );
        if got == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 {
            cleanup(&info);
            return None;
        }
        let (w, h) = (bmp.bmWidth, bmp.bmHeight);

        let mut header = BITMAPINFO::default();
        header.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        header.bmiHeader.biWidth = w;
        header.bmiHeader.biHeight = -h; // top-down
        header.bmiHeader.biPlanes = 1;
        header.bmiHeader.biBitCount = 32;
        header.bmiHeader.biCompression = BI_RGB.0;

        let screen: HDC = GetDC(HWND::default());
        let dc = CreateCompatibleDC(screen);
        let mut buffer = vec![0u8; (w * h * 4) as usize];
        let scanned = GetDIBits(
            dc,
            color,
            0,
            h as u32,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut header,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(dc);
        ReleaseDC(HWND::default(), screen);
        cleanup(&info);

        if scanned == 0 {
            return None;
        }
        // BGRA -> RGBA
        for px in buffer.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        RgbaImage::from_raw(w as u32, h as u32, buffer)
    }

    unsafe fn cleanup(info: &ICONINFO) {
        if !info.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmColor.0));
        }
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
        }
    }
}
