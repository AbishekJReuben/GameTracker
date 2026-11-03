//! Per-user encryption for credentials kept in the settings table (Windows DPAPI).
//!
//! gametracker.db is a plain file: any process running as this user, a backup, or
//! a copy of the folder carried the Sarvam API key in clear text. DPAPI ties the
//! ciphertext to this Windows account, so the stored value is useless anywhere
//! else, and the app (always the same user, elevated or not) reads it back as before.

use base64::Engine;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

const PREFIX: &str = "dpapi:";

pub fn is_protected(stored: &str) -> bool {
    stored.starts_with(PREFIX)
}

/// Encrypt for the current Windows user. None if DPAPI refused (never expected).
pub fn protect(plain: &str) -> Option<String> {
    let mut input = plain.as_bytes().to_vec();
    let blob = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_mut_ptr() };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&blob, windows::core::PCWSTR::null(), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).ok()?;
    }
    let bytes = take(out);
    Some(format!("{PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Decrypt a value written by `protect`. None if it is not ours or was encrypted
/// by another Windows account (a database copied from elsewhere).
pub fn unprotect(stored: &str) -> Option<String> {
    let mut input = base64::engine::general_purpose::STANDARD
        .decode(stored.strip_prefix(PREFIX)?)
        .ok()?;
    let blob = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_mut_ptr() };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&blob, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).ok()?;
    }
    String::from_utf8(take(out)).ok()
}

/// Copy a DPAPI output buffer and free it.
fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if out.pbData.is_null() {
        return Vec::new();
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(HLOCAL(out.pbData as *mut core::ffi::c_void));
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_hides_the_value() {
        let plain = "sk_test_not_a_real_key_0123";
        let stored = protect(plain).expect("dpapi");
        assert!(is_protected(&stored));
        assert!(!stored.contains(plain));
        assert_eq!(unprotect(&stored).as_deref(), Some(plain));
    }

    #[test]
    fn foreign_or_damaged_values_read_as_absent() {
        assert_eq!(unprotect("not-protected"), None);
        assert_eq!(unprotect("dpapi:%%%"), None);
        assert_eq!(unprotect("dpapi:AAAA"), None);
    }
}
