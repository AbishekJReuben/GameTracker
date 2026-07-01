//! Detect whether the foreground app currently has a text field focused, so the
//! phone can auto-open its on-screen keyboard the moment you click into an input
//! on the streamed PC screen.
//!
//! This uses the lightweight Win32 caret heuristic: a focused text control keeps a
//! blinking system caret, reported via `GetGUIThreadInfo` for the foreground
//! window's GUI thread. It covers standard Win32/edit controls and most native
//! apps. Some custom-drawn or Electron/Chromium editors don't create a system
//! caret and won't be detected — UI Automation `TextPattern` would be the heavier
//! but more thorough upgrade if that becomes a problem.

#[cfg(windows)]
pub fn foreground_text_field_active() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
        GUI_CARETBLINKING,
    };
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        let tid = GetWindowThreadProcessId(hwnd, None);
        if tid == 0 {
            return false;
        }
        let mut gti = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if GetGUIThreadInfo(tid, &mut gti).is_ok() {
            // A blinking caret or a live caret window means a text field has focus.
            (gti.flags.0 & GUI_CARETBLINKING.0) != 0 || !gti.hwndCaret.0.is_null()
        } else {
            false
        }
    }
}

#[cfg(not(windows))]
pub fn foreground_text_field_active() -> bool {
    false
}
