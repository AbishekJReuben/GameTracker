//! Minimal `adb` bridge for the desktop Remote page's "Install on USB phone"
//! button: locate the Android platform-tools `adb`, list connected devices, and
//! sideload an APK. Best-effort — every failure returns a human-readable error the
//! UI shows as a toast.

use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
const ADB_FILE: &str = "adb.exe";
#[cfg(not(windows))]
const ADB_FILE: &str = "adb";

/// Don't flash a console window when we shell out to adb on Windows.
#[cfg(windows)]
fn no_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn no_window(cmd: &mut Command) -> &mut Command {
    cmd
}

/// Find `adb`: explicit SDK env vars, the default Windows SDK location, then PATH.
fn find_adb() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for k in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Ok(v) = std::env::var(k) {
            if !v.is_empty() {
                roots.push(PathBuf::from(v));
            }
        }
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(la).join("Android").join("Sdk"));
    }
    for r in roots {
        let cand = r.join("platform-tools").join(ADB_FILE);
        if cand.exists() {
            return Some(cand);
        }
    }
    // PATH fallback: let the OS resolve "adb".
    if no_window(&mut Command::new(ADB_FILE))
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some(PathBuf::from(ADB_FILE));
    }
    None
}

fn adb() -> AppResult<PathBuf> {
    find_adb().ok_or_else(|| {
        AppError::msg(
            "adb not found. Install Android platform-tools (or set ANDROID_HOME) so USB install works.",
        )
    })
}

/// Serial numbers of devices in the `device` state (authorized + connected).
pub fn devices() -> AppResult<Vec<String>> {
    let adb = adb()?;
    let out = no_window(&mut Command::new(&adb))
        .arg("devices")
        .output()
        .map_err(|e| AppError::msg(format!("Couldn't run adb: {e}")))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut list = Vec::new();
    for line in text.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((serial, state)) = line.split_once('\t') {
            if state.trim() == "device" {
                list.push(serial.trim().to_string());
            }
        }
    }
    Ok(list)
}

/// `adb install -r <apk>` to the (single) connected device.
pub fn install(apk: &Path) -> AppResult<String> {
    let adb = adb()?;
    if devices()?.is_empty() {
        return Err(AppError::msg(
            "No phone detected over USB. Enable USB debugging and plug it in (accept the prompt on the phone).",
        ));
    }
    let out = no_window(&mut Command::new(&adb))
        .arg("install")
        .arg("-r")
        .arg(apk)
        .output()
        .map_err(|e| AppError::msg(format!("Couldn't run adb install: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() && stdout.contains("Success") {
        Ok("Installed on the connected phone.".into())
    } else {
        let msg = format!("{} {}", stdout.trim(), stderr.trim());
        Err(AppError::msg(format!(
            "adb install failed: {}",
            msg.trim()
        )))
    }
}
