//! Is an app filling the monitor the orb is on? Then the orb gets out of the way.

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsZoomed};

/// Monitor-sized windows that belong to the shell, not to an app.
const SHELL_CLASSES: [&str; 5] = ["Progman", "WorkerW", "XamlExplorerHostIslandWindow", "Windows.UI.Core.CoreWindow", "TopLevelWindowForOverflowXamlIsland"];

pub unsafe fn covers(monitor: HMONITOR) -> bool {
    let hwnd = GetForegroundWindow();
    if hwnd.0.is_null() {
        return false;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == std::process::id() || MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) != monitor {
        return false;
    }
    let mut class = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut class);
    if n > 0 && SHELL_CLASSES.contains(&String::from_utf16_lossy(&class[..n as usize]).as_str()) {
        return false;
    }
    // Maximized isn't fullscreen, even when an auto-hiding taskbar lets it fill the
    // monitor. And SHQueryUserNotificationState can't help here: it says a fullscreen
    // app exists somewhere, which would hide the orb on every other monitor too.
    !IsZoomed(hwnd).as_bool() && fills(hwnd, monitor)
}

unsafe fn fills(hwnd: HWND, monitor: HMONITOR) -> bool {
    let mut rect = RECT::default();
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if GetWindowRect(hwnd, &mut rect).is_err() || !GetMonitorInfoW(monitor, &mut info).as_bool() {
        return false;
    }
    let m = info.rcMonitor;
    rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom
}
