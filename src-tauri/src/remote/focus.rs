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

/// The current system cursor shape as a stable kind string, so the phone can
/// mirror the real desktop cursor (arrow / hand / text-beam / resize / busy…)
/// instead of always drawing an arrow. We read the globally-displayed cursor
/// (`GetCursorInfo`) and compare its handle against the shared OS cursors. Custom
/// app-drawn cursors won't match any and fall back to "arrow".
#[cfg(windows)]
pub fn foreground_cursor_kind() -> &'static str {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorInfo, LoadCursorW, CURSORINFO, CURSOR_SHOWING, IDC_APPSTARTING, IDC_ARROW,
        IDC_CROSS, IDC_HAND, IDC_HELP, IDC_IBEAM, IDC_NO, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS,
        IDC_SIZENWSE, IDC_SIZEWE, IDC_WAIT,
    };
    unsafe {
        let mut ci = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if GetCursorInfo(&mut ci).is_err() {
            return "arrow";
        }
        if (ci.flags.0 & CURSOR_SHOWING.0) == 0 {
            return "hidden";
        }
        let h = ci.hCursor.0;
        let is = |id| LoadCursorW(None, id).map(|c| c.0 == h).unwrap_or(false);
        if is(IDC_HAND) {
            "hand"
        } else if is(IDC_IBEAM) {
            "text"
        } else if is(IDC_WAIT) || is(IDC_APPSTARTING) {
            "busy"
        } else if is(IDC_SIZEALL) {
            "move"
        } else if is(IDC_SIZENS) {
            "resize-ns"
        } else if is(IDC_SIZEWE) {
            "resize-we"
        } else if is(IDC_SIZENWSE) {
            "resize-nwse"
        } else if is(IDC_SIZENESW) {
            "resize-nesw"
        } else if is(IDC_CROSS) {
            "cross"
        } else if is(IDC_NO) {
            "no"
        } else if is(IDC_HELP) {
            "help"
        } else {
            // IDC_ARROW or any unrecognised/custom cursor.
            let _ = is(IDC_ARROW);
            "arrow"
        }
    }
}

#[cfg(not(windows))]
pub fn foreground_cursor_kind() -> &'static str {
    "arrow"
}
