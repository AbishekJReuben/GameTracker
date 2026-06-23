//! Minimal, read-only Windows registry access for game-launcher detection.
//!
//! Wraps `winreg`. Detection callers pass explicit key paths (including the
//! `WOW6432Node` variant) so 32-bit launcher keys — Ubisoft, Rockstar and the
//! 32-bit Uninstall hive — are visible to our 64-bit process without juggling
//! `KEY_WOW64_*` flags.
#![cfg(windows)]

use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
use winreg::RegKey;

/// The two registry roots we read from.
#[derive(Clone, Copy)]
pub enum Hive {
    /// `HKEY_LOCAL_MACHINE`
    Lm,
    /// `HKEY_CURRENT_USER`
    Cu,
}

fn root(hive: Hive) -> RegKey {
    match hive {
        Hive::Lm => RegKey::predef(HKEY_LOCAL_MACHINE),
        Hive::Cu => RegKey::predef(HKEY_CURRENT_USER),
    }
}

/// Open a subkey for reading. `None` when it doesn't exist / no access.
fn open(hive: Hive, subkey: &str) -> Option<RegKey> {
    root(hive).open_subkey_with_flags(subkey, KEY_READ).ok()
}

/// Read a string value (`REG_SZ`/`REG_EXPAND_SZ`) from a subkey, trimmed and
/// unquoted. Empty values are treated as missing.
pub fn read_string(hive: Hive, subkey: &str, value: &str) -> Option<String> {
    let key = open(hive, subkey)?;
    let raw: String = key.get_value(value).ok()?;
    let v = raw.trim().trim_matches('"').trim().to_string();
    (!v.is_empty()).then_some(v)
}

/// Immediate child subkey names under a subkey (empty if the key is missing).
pub fn subkeys(hive: Hive, subkey: &str) -> Vec<String> {
    match open(hive, subkey) {
        Some(k) => k.enum_keys().filter_map(Result::ok).collect(),
        None => Vec::new(),
    }
}
