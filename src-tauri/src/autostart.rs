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

/// Task definition for `schtasks /XML`. Plain `/SC ONLOGON` would inherit Task
/// Scheduler's defaults: a 72-hour execution limit (Windows kills the tray app
/// after 3 days up) and stop/skip on battery (a USB UPS reports as one).
#[cfg_attr(not(windows), allow(dead_code))]
fn task_xml(exe: &str) -> String {
    let exe = exe
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>{exe}</Command><Arguments>--minimized</Arguments></Exec></Actions>
</Task>
"#
    )
}

/// Register (or overwrite) the logon task so it points at the **current** binary.
/// Safe to call on every launch and after reinstalling to a new folder.
#[cfg(windows)]
fn register_task() -> AppResult<()> {
    let exe = std::env::current_exe().map_err(|e| AppError::msg(e.to_string()))?;
    // Launch minimized to tray, elevated, at every logon. /F overwrites stale paths
    // and upgrades tasks created by older builds with the 72-hour limit.
    let xml = task_xml(&exe.display().to_string());
    // schtasks reads the file as UTF-16 (BOM + LE), matching the XML declaration.
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(xml.encode_utf16().flat_map(u16::to_le_bytes));
    let path = std::env::temp_dir().join("gametracker-autostart-task.xml");
    std::fs::write(&path, bytes).map_err(|e| AppError::msg(e.to_string()))?;
    let out = run_schtasks(&[
        "/Create",
        "/TN",
        TASK_NAME,
        "/XML",
        &path.to_string_lossy(),
        "/F",
    ]);
    let _ = std::fs::remove_file(&path);
    let out = out?;
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

#[cfg(test)]
mod tests {
    use super::task_xml;

    #[test]
    fn task_has_no_time_limit_or_battery_stop_and_stays_elevated() {
        let xml = task_xml(r"C:\Program Files\Tracker\gametracker.exe");
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
        assert!(xml.contains("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"));
        assert!(xml.contains("<RunLevel>HighestAvailable</RunLevel>"));
        assert!(xml.contains(r"<Command>C:\Program Files\Tracker\gametracker.exe</Command>"));
    }

    #[test]
    fn exe_path_is_xml_escaped() {
        let xml = task_xml(r"D:\R&D <x>\gametracker.exe");
        assert!(xml.contains(r"<Command>D:\R&amp;D &lt;x&gt;\gametracker.exe</Command>"));
    }
}
