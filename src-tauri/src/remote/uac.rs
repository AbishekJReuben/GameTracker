//! Optional AnyDesk-style UAC handling for the remote session.
//!
//! Windows renders UAC elevation prompts on an isolated **secure desktop** that
//! screen-capture APIs (DXGI Desktop Duplication, GDI) cannot see, so a remote
//! viewer never gets the admin-consent dialog — the PC just appears to freeze on
//! a dimmed screen. Disabling the secure desktop for UAC (`PromptOnSecureDesktop
//! = 0`, the exact registry switch AnyDesk flips for "Direct UAC handling") makes
//! the prompt render on the normal interactive desktop, which we DO capture — so
//! the phone can see it and click Yes/No.
//!
//! Because injected input can't click the elevation dialog anyway (`consent.exe`
//! runs at a higher integrity level than our High-IL elevated app, and UIPI drops
//! upward input) without a uiAccess-signed build, "on" ALSO sets
//! **`ConsentPromptBehaviorAdmin = 0`** ("Elevate without prompting"), so an admin
//! user's UAC operations proceed **automatically** while remote is on — the remote
//! side just works instead of hanging on an unclickable prompt.
//!
//! This lowers local security, so it is strictly **opt-in** (`remote_show_uac`,
//! default off) and we restore the secure Windows defaults (secure desktop on,
//! prompt-for-consent) whenever remote is disabled or the app exits. The app runs
//! elevated (`requireAdministrator`), so the HKLM writes succeed without a prompt.

/// UAC policy registry key (both values live here).
#[cfg(windows)]
const SUBKEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";

/// Enable (`visible = true`) AnyDesk-style remote UAC handling — disable the secure
/// desktop AND auto-approve admin elevations — or restore the secure Windows
/// defaults (`visible = false`). Best-effort: returns a message on failure so the
/// caller can surface it; never panics. No-op on non-Windows.
#[cfg(windows)]
pub fn set_visible(visible: bool) -> Result<(), String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm
        .open_subkey_with_flags(SUBKEY, KEY_READ | KEY_SET_VALUE)
        .map_err(|e| format!("open UAC policy key: {e}"))?;

    // PromptOnSecureDesktop: 0 = prompt on the normal (capturable) desktop, 1 = secure default.
    let secure: u32 = if visible { 0 } else { 1 };
    // ConsentPromptBehaviorAdmin: 0 = elevate without prompting (auto-approve),
    // 5 = the Windows default (prompt for consent for non-Windows binaries).
    let consent: u32 = if visible { 0 } else { 5 };

    key.set_value("PromptOnSecureDesktop", &secure)
        .map_err(|e| format!("set PromptOnSecureDesktop: {e}"))?;
    key.set_value("ConsentPromptBehaviorAdmin", &consent)
        .map_err(|e| format!("set ConsentPromptBehaviorAdmin: {e}"))?;
    Ok(())
}

#[cfg(not(windows))]
pub fn set_visible(_visible: bool) -> Result<(), String> {
    Ok(())
}
