//! Normal Win32 cursor fallback for an output whose DXGI duplication is
//! unavailable. Shape work is cached; the hotspot is always the actual cursor.
#![cfg(windows)]
use super::{display::PhysicalRect, dxdupe::CursorImage};
use windows::Win32::{Foundation::*, Graphics::Gdi::*, UI::WindowsAndMessaging::*};
#[derive(Default)]
pub(crate) struct SystemCursor {
    handle: usize,
    image: Option<CursorImage>,
    hotspot: (i32, i32),
    point: Option<(i32, i32)>,
    pub sequence: u64,
}
impl SystemCursor {
    pub fn update(&mut self) -> bool {
        unsafe {
            let mut info = CURSORINFO {
                cbSize: std::mem::size_of::<CURSORINFO>() as u32,
                ..Default::default()
            };
            let visible = GetCursorInfo(&mut info).is_ok() && info.flags == CURSOR_SHOWING;
            let point = visible.then_some((info.ptScreenPos.x, info.ptScreenPos.y));
            let mut changed = self.point != point;
            self.point = point;
            if visible && self.handle != info.hCursor.0 as usize {
                self.handle = info.hCursor.0 as usize;
                self.image = shape(HICON(info.hCursor.0)).map(|(image, hotspot)| {
                    self.hotspot = hotspot;
                    image
                });
                self.sequence += 1;
                changed = true;
            }
            changed
        }
    }
    pub fn image(&mut self, rect: PhysicalRect) -> Option<&CursorImage> {
        let (x, y) = self.point?;
        if !rect.contains(x, y) {
            return None;
        }
        let image = self.image.as_mut()?;
        image.x = x - rect.x - self.hotspot.0;
        image.y = y - rect.y - self.hotspot.1;
        Some(image)
    }
}
unsafe fn shape(icon: HICON) -> Option<(CursorImage, (i32, i32))> {
    struct Bitmaps(ICONINFO);
    impl Drop for Bitmaps {
        fn drop(&mut self) {
            unsafe {
                if !self.0.hbmColor.is_invalid() {
                    let _ = DeleteObject(HGDIOBJ(self.0.hbmColor.0));
                }
                if !self.0.hbmMask.is_invalid() {
                    let _ = DeleteObject(HGDIOBJ(self.0.hbmMask.0));
                }
            }
        }
    }
    let mut info = ICONINFO::default();
    GetIconInfo(icon, &mut info).ok()?;
    let info = Bitmaps(info);
    let mut bitmap = BITMAP::default();
    let color = !info.0.hbmColor.is_invalid();
    let handle = if color {
        info.0.hbmColor
    } else {
        info.0.hbmMask
    };
    if GetObjectW(
        HGDIOBJ(handle.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some((&mut bitmap as *mut BITMAP).cast()),
    ) == 0
    {
        return None;
    }
    let (w, h) = (
        bitmap.bmWidth,
        if color {
            bitmap.bmHeight
        } else {
            bitmap.bmHeight / 2
        },
    );
    if w <= 0 || h <= 0 || w > 1024 || h > 1024 {
        return None;
    }
    let black = draw(icon, w, h, 0)?;
    let white = draw(icon, w, h, 255)?;
    let masked = black
        .chunks_exact(4)
        .zip(white.chunks_exact(4))
        .any(|(b, w)| b[0] > w[0] || b[1] > w[1] || b[2] > w[2]);
    let mut pixels = vec![0; black.len()];
    for ((out, b), white) in pixels
        .chunks_exact_mut(4)
        .zip(black.chunks_exact(4))
        .zip(white.chunks_exact(4))
    {
        if masked {
            out[..3].copy_from_slice(&b[..3]);
            out[3] = if b[..3] == white[..3] { 0 } else { 255 };
        } else {
            let alpha = 255_u32.saturating_sub((white[0] as u32).saturating_sub(b[0] as u32));
            out[3] = alpha as u8;
            if alpha > 0 {
                for i in 0..3 {
                    out[i] = ((b[i] as u32 * 255 + alpha / 2) / alpha).min(255) as u8;
                }
            }
        }
    }
    Some((
        CursorImage {
            px: pixels,
            w: w as u32,
            h: h as u32,
            x: 0,
            y: 0,
            masked,
        },
        (info.0.xHotspot as i32, info.0.yHotspot as i32),
    ))
}
unsafe fn draw(icon: HICON, w: i32, h: i32, background: u8) -> Option<Vec<u8>> {
    struct Dc(HDC);
    impl Drop for Dc {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteDC(self.0);
            }
        }
    }
    struct Bitmap(HBITMAP);
    impl Drop for Bitmap {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(self.0 .0));
            }
        }
    }
    let screen = GetDC(HWND::default());
    if screen.is_invalid() {
        return None;
    }
    let dc = CreateCompatibleDC(screen);
    let _ = ReleaseDC(HWND::default(), screen);
    if dc.is_invalid() {
        return None;
    }
    let dc = Dc(dc);
    let description = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut address = std::ptr::null_mut();
    let bitmap =
        Bitmap(CreateDIBSection(dc.0, &description, DIB_RGB_COLORS, &mut address, None, 0).ok()?);
    let old = SelectObject(dc.0, HGDIOBJ(bitmap.0 .0));
    let pixels = std::slice::from_raw_parts_mut(address as *mut u8, w as usize * h as usize * 4);
    pixels.fill(background);
    let result = DrawIconEx(dc.0, 0, 0, icon, w, h, 0, None, DI_NORMAL)
        .is_ok()
        .then(|| pixels.to_vec());
    SelectObject(dc.0, old);
    result
}
