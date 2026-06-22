//! Foreground window activity: browser detection + address-bar URL extraction
//! via UI Automation. Window titles come from `foreground::window_title`.

/// Lowercased file name of an executable path (e.g. "chrome.exe").
pub fn exe_file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase()
}

/// Whether the given (lowercased) exe name is a known web browser.
pub fn is_browser(exe_lower: &str) -> bool {
    const BROWSERS: &[&str] = &[
        "chrome.exe",
        "msedge.exe",
        "firefox.exe",
        "brave.exe",
        "opera.exe",
        "vivaldi.exe",
        "chromium.exe",
        "arc.exe",
        "librewolf.exe",
        "waterfox.exe",
        "browser.exe", // Yandex
    ];
    BROWSERS.contains(&exe_lower)
}

pub use imp::Automation;

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use windows::core::VARIANT;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationValuePattern, TreeScope_Descendants,
        UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_ValuePatternId,
    };

    /// Reusable UI Automation client, created once on the tracker thread.
    pub struct Automation {
        inner: Option<IUIAutomation>,
    }

    impl Automation {
        pub fn new() -> Self {
            unsafe {
                // Join the MTA; ignore "already initialized in another mode".
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let inner =
                unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok() };
            Self { inner }
        }

        /// Best-effort URL from the focused browser window's address bar.
        pub fn browser_url(&self, hwnd: isize) -> Option<String> {
            let auto = self.inner.as_ref()?;
            unsafe {
                let element = auto.ElementFromHandle(HWND(hwnd as *mut c_void)).ok()?;
                let cond = auto
                    .CreatePropertyCondition(
                        UIA_ControlTypePropertyId,
                        &VARIANT::from(UIA_EditControlTypeId.0),
                    )
                    .ok()?;
                let edit = element.FindFirst(TreeScope_Descendants, &cond).ok()?;
                let pattern: IUIAutomationValuePattern =
                    edit.GetCurrentPatternAs(UIA_ValuePatternId).ok()?;
                let value = pattern.CurrentValue().ok()?;
                normalize_url(&value.to_string())
            }
        }
    }

    /// Turn raw omnibox text into a real URL, or `None` for search queries and
    /// internal pages. Bare hosts get an `https://` scheme so spans store a
    /// consistent, clickable URL and the host can be parsed downstream.
    fn normalize_url(raw: &str) -> Option<String> {
        let s = raw.trim();
        if s.is_empty() || s.len() > 2048 {
            return None;
        }
        // The omnibox only shows spaces for a typed search query, never a URL.
        if s.chars().any(char::is_whitespace) {
            return None;
        }
        let candidate = if s.contains("://") {
            s.to_string()
        } else {
            format!("https://{s}")
        };
        // Require a dotted host (or localhost). This also drops browser-internal
        // pages like chrome://settings or about:blank (host has no dot).
        let host = candidate
            .split("://")
            .nth(1)?
            .split(['/', '?', '#'])
            .next()?;
        if host.is_empty() || (!host.contains('.') && host != "localhost") {
            return None;
        }
        Some(candidate)
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct Automation;
    impl Automation {
        pub fn new() -> Self {
            Automation
        }
        pub fn browser_url(&self, _hwnd: isize) -> Option<String> {
            None
        }
    }
}
