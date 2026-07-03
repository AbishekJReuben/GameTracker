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
//! This lowers local security (remote input can then answer UAC), so it is
//! strictly **opt-in** (`remote_show_uac`, default off) and we restore the secure
//! desktop (`1`) whenever remote is disabled or the app exits. The app runs
//! elevated (`requireAdministrator`), so the HKLM write succeeds without a prompt.

/// Registry key + value that controls the UAC secure desktop.
#[cfg(windows)]
const SUBKEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
#[cfg(windows)]
const VALUE: &str = "PromptOnSecureDesktop";

/// Make the UAC prompt visible to remote capture (`visible = true` → disable the
/// secure desktop) or restore the secure Windows default (`visible = false`).
/// Best-effort: returns a message on failure so the caller can surface it; never
/// panics. No-op on non-Windows.
#[cfg(windows)]
pub fn set_visible(visible: bool) -> Result<(), String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm
        .open_subkey_with_flags(SUBKEY, KEY_READ | KEY_SET_VALUE)
        .map_err(|e| format!("open UAC policy key: {e}"))?;
    // 0 = prompt on the normal desktop (capturable); 1 = secure desktop (default).
    let want: u32 = if visible { 0 } else { 1 };
    key.set_value(VALUE, &want)
        .map_err(|e| format!("set {VALUE}: {e}"))
}

#[cfg(not(windows))]
pub fn set_visible(_visible: bool) -> Result<(), String> {
    Ok(())
}
