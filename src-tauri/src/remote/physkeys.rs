//! Physical keys from a desktop guest's real keyboard.
//!
//! The browser reports `KeyboardEvent.code`: the key's position, not its
//! character. We press that position here with a Windows scan code, so the PC's
//! own keyboard layout decides what it types, exactly as if the keyboard were
//! plugged into this PC. Shortcuts, games and key holds behave like local keys.
//!
//! A few keys have no plain scan code SendInput can take (Pause is a three-byte
//! E1 sequence; media and browser keys only exist as virtual keys), so those go
//! by virtual key instead.

/// One physical key, as injected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PhysKey {
    /// A set-1 scan code; `true` = the E0-prefixed (extended) variant.
    Scan(u16, bool),
    /// A virtual-key code, for keys without a usable scan code.
    Vk(u16),
}

/// Map a DOM `KeyboardEvent.code` to the key to press. Unknown codes map to
/// `None` and are ignored.
pub fn from_code(code: &str) -> Option<PhysKey> {
    use PhysKey::{Scan, Vk};
    let s = |c: u16| Some(Scan(c, false));
    let e = |c: u16| Some(Scan(c, true));
    if let Some(letter) = code.strip_prefix("Key") {
        let mut chars = letter.chars();
        let (Some(ch), None) = (chars.next(), chars.next()) else { return None };
        const LETTERS: [u16; 26] = [
            0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32,
            0x31, 0x18, 0x19, 0x10, 0x13, 0x1F, 0x14, 0x16, 0x2F, 0x11, 0x2D, 0x15, 0x2C,
        ];
        return ch.is_ascii_uppercase().then(|| Scan(LETTERS[(ch as u8 - b'A') as usize], false));
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        return match digit.parse::<u16>() {
            Ok(0) => s(0x0B),
            Ok(d @ 1..=9) if digit.len() == 1 => s(0x01 + d),
            _ => None,
        };
    }
    if let Some(n) = code.strip_prefix("Numpad").and_then(|d| d.parse::<u16>().ok()) {
        const PAD: [u16; 10] = [0x52, 0x4F, 0x50, 0x51, 0x4B, 0x4C, 0x4D, 0x47, 0x48, 0x49];
        return (n <= 9 && code.len() == 7).then(|| Scan(PAD[n as usize], false));
    }
    if let Some(n) = code.strip_prefix('F').and_then(|d| d.parse::<u16>().ok()) {
        return match n {
            1..=10 => s(0x3A + n),
            11 => s(0x57),
            12 => s(0x58),
            13..=23 => s(0x64 + (n - 13)),
            24 => s(0x76),
            _ => None,
        };
    }
    match code {
        "Escape" => s(0x01),
        "Minus" => s(0x0C),
        "Equal" => s(0x0D),
        "Backspace" => s(0x0E),
        "Tab" => s(0x0F),
        "BracketLeft" => s(0x1A),
        "BracketRight" => s(0x1B),
        "Enter" => s(0x1C),
        "ControlLeft" => s(0x1D),
        "Semicolon" => s(0x27),
        "Quote" => s(0x28),
        "Backquote" => s(0x29),
        "ShiftLeft" => s(0x2A),
        "Backslash" => s(0x2B),
        "Comma" => s(0x33),
        "Period" => s(0x34),
        "Slash" => s(0x35),
        "ShiftRight" => s(0x36),
        "NumpadMultiply" => s(0x37),
        "AltLeft" => s(0x38),
        "Space" => s(0x39),
        "CapsLock" => s(0x3A),
        "ScrollLock" => s(0x46),
        "NumpadSubtract" => s(0x4A),
        "NumpadAdd" => s(0x4E),
        "NumpadDecimal" => s(0x53),
        "IntlBackslash" => s(0x56),
        "NumpadEqual" => s(0x59),
        "KanaMode" => s(0x70),
        "Lang2" => s(0x71),
        "Lang1" => s(0x72),
        "IntlRo" => s(0x73),
        "Convert" => s(0x79),
        "NonConvert" => s(0x7B),
        "IntlYen" => s(0x7D),
        "NumpadComma" => s(0x7E),
        "NumpadEnter" => e(0x1C),
        "ControlRight" => e(0x1D),
        "NumpadDivide" => e(0x35),
        "AltRight" => e(0x38),
        "Home" => e(0x47),
        "ArrowUp" => e(0x48),
        "PageUp" => e(0x49),
        "ArrowLeft" => e(0x4B),
        "ArrowRight" => e(0x4D),
        "End" => e(0x4F),
        "ArrowDown" => e(0x50),
        "PageDown" => e(0x51),
        "Insert" => e(0x52),
        "Delete" => e(0x53),
        "MetaLeft" | "OSLeft" => e(0x5B),
        "MetaRight" | "OSRight" => e(0x5C),
        "ContextMenu" => e(0x5D),
        // Virtual keys (Windows VK_* values).
        "PrintScreen" => Some(Vk(0x2C)),
        "Pause" => Some(Vk(0x13)),
        "NumLock" => Some(Vk(0x90)),
        "BrowserBack" => Some(Vk(0xA6)),
        "BrowserForward" => Some(Vk(0xA7)),
        "BrowserRefresh" => Some(Vk(0xA8)),
        "BrowserStop" => Some(Vk(0xA9)),
        "BrowserSearch" => Some(Vk(0xAA)),
        "BrowserFavorites" => Some(Vk(0xAB)),
        "BrowserHome" => Some(Vk(0xAC)),
        "AudioVolumeMute" | "VolumeMute" => Some(Vk(0xAD)),
        "AudioVolumeDown" | "VolumeDown" => Some(Vk(0xAE)),
        "AudioVolumeUp" | "VolumeUp" => Some(Vk(0xAF)),
        "MediaTrackNext" => Some(Vk(0xB0)),
        "MediaTrackPrevious" => Some(Vk(0xB1)),
        "MediaStop" => Some(Vk(0xB2)),
        "MediaPlayPause" => Some(Vk(0xB3)),
        "LaunchMail" => Some(Vk(0xB4)),
        "LaunchApp1" => Some(Vk(0xB6)),
        "LaunchApp2" => Some(Vk(0xB7)),
        _ => None,
    }
}

/// Virtual keys Windows expects with KEYEVENTF_EXTENDEDKEY.
fn vk_extended(vk: u16) -> bool {
    matches!(vk, 0x2C | 0x90 | 0xA6..=0xB7)
}

/// Press (`down = true`) or release one physical key on this PC.
#[cfg(windows)]
pub fn inject(key: PhysKey, down: bool) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY,
    };
    let (vk, scan, mut flags) = match key {
        PhysKey::Scan(code, extended) => (
            0u16,
            code,
            KEYEVENTF_SCANCODE | if extended { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) },
        ),
        PhysKey::Vk(vk) => (
            vk,
            unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16,
            if vk_extended(vk) { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) },
        ),
    };
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    };
    unsafe {
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(not(windows))]
pub fn inject(_key: PhysKey, _down: bool) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_digits_and_function_keys_map_to_set_one_scan_codes() {
        assert_eq!(from_code("KeyA"), Some(PhysKey::Scan(0x1E, false)));
        assert_eq!(from_code("KeyZ"), Some(PhysKey::Scan(0x2C, false)));
        assert_eq!(from_code("KeyQ"), Some(PhysKey::Scan(0x10, false)));
        assert_eq!(from_code("Digit1"), Some(PhysKey::Scan(0x02, false)));
        assert_eq!(from_code("Digit9"), Some(PhysKey::Scan(0x0A, false)));
        assert_eq!(from_code("Digit0"), Some(PhysKey::Scan(0x0B, false)));
        assert_eq!(from_code("F1"), Some(PhysKey::Scan(0x3B, false)));
        assert_eq!(from_code("F10"), Some(PhysKey::Scan(0x44, false)));
        assert_eq!(from_code("F11"), Some(PhysKey::Scan(0x57, false)));
        assert_eq!(from_code("F12"), Some(PhysKey::Scan(0x58, false)));
        assert_eq!(from_code("F13"), Some(PhysKey::Scan(0x64, false)));
        assert_eq!(from_code("F24"), Some(PhysKey::Scan(0x76, false)));
        assert_eq!(from_code("Numpad0"), Some(PhysKey::Scan(0x52, false)));
        assert_eq!(from_code("Numpad7"), Some(PhysKey::Scan(0x47, false)));
    }

    #[test]
    fn right_hand_modifiers_and_navigation_are_extended() {
        assert_eq!(from_code("ControlRight"), Some(PhysKey::Scan(0x1D, true)));
        assert_eq!(from_code("ControlLeft"), Some(PhysKey::Scan(0x1D, false)));
        assert_eq!(from_code("AltRight"), Some(PhysKey::Scan(0x38, true)));
        assert_eq!(from_code("MetaLeft"), Some(PhysKey::Scan(0x5B, true)));
        assert_eq!(from_code("OSRight"), Some(PhysKey::Scan(0x5C, true)));
        assert_eq!(from_code("ArrowUp"), Some(PhysKey::Scan(0x48, true)));
        assert_eq!(from_code("Delete"), Some(PhysKey::Scan(0x53, true)));
        assert_eq!(from_code("NumpadDecimal"), Some(PhysKey::Scan(0x53, false)));
        assert_eq!(from_code("NumpadEnter"), Some(PhysKey::Scan(0x1C, true)));
    }

    #[test]
    fn keys_without_a_plain_scan_code_go_by_virtual_key() {
        assert_eq!(from_code("PrintScreen"), Some(PhysKey::Vk(0x2C)));
        assert_eq!(from_code("Pause"), Some(PhysKey::Vk(0x13)));
        assert_eq!(from_code("MediaPlayPause"), Some(PhysKey::Vk(0xB3)));
        assert!(vk_extended(0x2C) && !vk_extended(0x13));
    }

    /// Injects real keys and checks what Windows makes of them, from a low-level
    /// hook that swallows every injected key so none reaches the foreground app.
    /// Run alone: `cargo test --lib physkeys -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn windows_sees_the_intended_keys_and_none_reach_other_apps() {
        use std::sync::{atomic::{AtomicBool, AtomicU32, Ordering}, Arc, Mutex};
        use std::time::{Duration, Instant};
        use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::Input::KeyboardAndMouse::{MapVirtualKeyW, MAPVK_VSC_TO_VK};
        use windows::Win32::UI::WindowsAndMessaging::{
            CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
            UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_QUIT,
        };
        static SEEN: Mutex<Vec<(u32, u32, bool, bool)>> = Mutex::new(Vec::new());
        unsafe extern "system" fn hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
            if code >= 0 {
                let k = &*(l.0 as *const KBDLLHOOKSTRUCT);
                if k.flags.0 & 0x10 != 0 {
                    // LLKHF_INJECTED: record it and keep it from every app.
                    SEEN.lock().unwrap().push((k.vkCode, k.scanCode, k.flags.0 & 0x01 != 0, k.flags.0 & 0x80 != 0));
                    return LRESULT(1);
                }
            }
            CallNextHookEx(None, code, w, l)
        }
        let ready = Arc::new(AtomicBool::new(false));
        let tid = Arc::new(AtomicU32::new(0));
        let (r, t) = (ready.clone(), tid.clone());
        let pump = std::thread::spawn(move || unsafe {
            t.store(windows::Win32::System::Threading::GetCurrentThreadId(), Ordering::SeqCst);
            let module = GetModuleHandleW(None).unwrap();
            let h = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), module, 0).expect("hook");
            r.store(true, Ordering::SeqCst);
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                DispatchMessageW(&msg);
            }
            let _ = UnhookWindowsHookEx(h);
        });
        while !ready.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(5));
        }
        let wait_for = |n: usize| {
            let start = Instant::now();
            while SEEN.lock().unwrap().len() < n && start.elapsed() < Duration::from_secs(2) {
                std::thread::sleep(Duration::from_millis(2));
            }
            std::mem::take(&mut *SEEN.lock().unwrap())
        };
        // Sentinel first: nothing else is injected until the hook is proven live.
        inject(from_code("F24").unwrap(), true);
        inject(from_code("F24").unwrap(), false);
        assert_eq!(wait_for(2).len(), 2, "hook never saw the sentinel; stopping before any real key");
        let letter_vk = unsafe { MapVirtualKeyW(0x1E, MAPVK_VSC_TO_VK) };
        let cases: &[(&str, u32, bool)] = &[
            ("KeyA", letter_vk, false),
            ("Digit1", 0x31, false),
            ("F5", 0x74, false),
            ("F13", 0x7C, false),
            ("Enter", 0x0D, false),
            ("NumpadEnter", 0x0D, true),
            ("ControlLeft", 0xA2, false),
            ("ControlRight", 0xA3, true),
            // Sent unextended (0x36); Windows still reports Right Shift as extended.
            ("ShiftRight", 0xA1, true),
            ("MetaLeft", 0x5B, true),
            ("ArrowUp", 0x26, true),
            ("Delete", 0x2E, true),
            ("Home", 0x24, true),
            ("ContextMenu", 0x5D, true),
            ("PrintScreen", 0x2C, true),
            ("Pause", 0x13, false),
            ("MediaPlayPause", 0xB3, true),
        ];
        let mut failures = Vec::new();
        for &(code, vk, ext) in cases {
            let key = from_code(code).unwrap();
            inject(key, true);
            inject(key, false);
            let seen = wait_for(2);
            let ok = seen.len() == 2
                && seen.iter().all(|&(v, _, e, _)| v == vk && e == ext)
                && !seen[0].3
                && seen[1].3;
            println!("{code:>15}: {seen:x?} {}", if ok { "ok" } else { "MISMATCH" });
            if !ok {
                failures.push(code);
            }
        }
        unsafe {
            let _ = PostThreadMessageW(tid.load(Ordering::SeqCst), WM_QUIT, WPARAM(0), LPARAM(0));
        }
        pump.join().unwrap();
        assert!(failures.is_empty(), "keys Windows saw differently: {failures:?}");
    }

    #[test]
    fn unknown_or_malformed_codes_are_ignored() {
        for code in ["", "Key", "KeyAA", "Keya", "Digit", "Digit10", "Digit01", "F0", "F25", "Numpad10", "Unidentified", "Fn"] {
            assert_eq!(from_code(code), None, "{code}");
        }
    }
}
