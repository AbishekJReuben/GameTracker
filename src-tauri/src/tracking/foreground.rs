//! Foreground window -> owning process id + window handle/title.

#[cfg(windows)]
pub fn foreground_window() -> Option<(u32, isize)> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
        if pid == 0 {
            None
        } else {
            Some((pid, hwnd.0 as isize))
        }
    }
}

/// Read the title bar text of a window.
#[cfg(windows)]
pub fn window_title(hwnd: isize) -> Option<String> {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};
    unsafe {
        let h = HWND(hwnd as *mut c_void);
        let len = GetWindowTextLengthW(h);
        if len <= 0 {
            return None;
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let n = GetWindowTextW(h, &mut buf);
        if n <= 0 {
            return None;
        }
        let s = String::from_utf16_lossy(&buf[..n as usize]).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

#[cfg(not(windows))]
pub fn foreground_window() -> Option<(u32, isize)> {
    None
}

#[cfg(not(windows))]
pub fn window_title(_hwnd: isize) -> Option<String> {
    None
}
