//! Elevated autostart via a Task Scheduler task.
//!
//! Because the app ships a `requireAdministrator` manifest, the usual Run-key
//! autostart can't launch it elevated at login (Windows blocks it). A scheduled
//! task created with "highest privileges" + an "at logon" trigger starts the app
//! elevated *without* a UAC prompt, which is exactly what a background tray
//! utility needs. Creating/deleting the task itself needs admin — which we have.

use crate::error::{AppError, AppResult};
use std::process::Command;

const TASK_NAME: &str = "GameTracker Autostart";

#[cfg(windows)]
fn run_schtasks(args: &[&str]) -> AppResult<std::process::Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("schtasks")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| AppError::msg(e.to_string()))
}

#[cfg(not(windows))]
fn run_schtasks(_args: &[&str]) -> AppResult<std::process::Output> {
    Err(AppError::msg("autostart task is Windows-only"))
}

/// Whether the elevated logon task currently exists.
pub fn is_enabled() -> bool {
    if !cfg!(windows) {
        return false;
    }
    run_schtasks(&["/Query", "/TN", TASK_NAME])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Create or remove the elevated logon task.
pub fn set(enabled: bool) -> AppResult<()> {
    if !cfg!(windows) {
        return Ok(());
    }
    if enabled {
        register_task()?;
    } else {
        // Best-effort removal; succeed even if it wasn't there.
        let _ = run_schtasks(&["/Delete", "/TN", TASK_NAME, "/F"]);
    }
    Ok(())
}

/// Register (or overwrite) the logon task so it points at the **current** binary.
/// Safe to call on every launch and after reinstalling to a new folder.
#[cfg(windows)]
fn register_task() -> AppResult<()> {
    let exe = std::env::current_exe().map_err(|e| AppError::msg(e.to_string()))?;
    // Launch minimized to tray, elevated, at every logon. /F overwrites stale paths.
    let tr = format!("\"{}\" --minimized", exe.display());
    let out = run_schtasks(&[
        "/Create", "/TN", TASK_NAME, "/TR", &tr, "/SC", "ONLOGON", "/RL", "HIGHEST", "/F",
    ])?;
    if !out.status.success() {
        return Err(AppError::msg(format!(
            "Could not register startup task: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

#[cfg(not(windows))]
fn register_task() -> AppResult<()> {
    Ok(())
}

/// Apply the `start_with_windows` setting — creates/updates or removes the task.
pub fn sync_from_setting(enabled: bool) -> AppResult<()> {
    set(enabled)
}
