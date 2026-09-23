//! GPU scheduling priority for the capture → composite → NVENC work.
//!
//! ## Why
//! The remote stream's GPU work is tiny (a copy, one full-screen pass, ~1 ms of NVENC)
//! but it sits in the same GPU queue as whatever game is running. Under a GPU-bound
//! game every one of those submissions waits behind a full game frame, so capture
//! latency spikes by a frame or more exactly when remote play matters most. Sunshine
//! raises both knobs below for the same reason.
//!
//! * `IDXGIDevice::SetGPUThreadPriority(7)` — per device; the duplication device is
//!   the one that copies, composites and feeds NVENC. Positive values need the
//!   `SeIncreaseBasePriorityPrivilege`, which the (always elevated) app holds but has
//!   to enable first.
//! * `D3DKMTSetProcessSchedulingPriorityClass(HIGH)` — process wide, held only while a
//!   capture pipeline runs (ref-counted across primary + pop-out threads). Only this
//!   process's GPU work is affected; the WebView renders in its own processes. HIGH,
//!   not REALTIME: realtime can starve the desktop compositor under HAGS.
//!
//! Everything is best-effort: failure just leaves default priorities.

#![cfg(windows)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Once;

use windows::core::{s, w, Interface, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, LUID};
use windows::Win32::Graphics::Direct3D11::ID3D11Device;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;

/// `D3DKMT_SCHEDULINGPRIORITYCLASS` values (d3dkmthk.h).
const PRIORITY_CLASS_NORMAL: i32 = 2;
const PRIORITY_CLASS_HIGH: i32 = 4;

static PRIVILEGE: Once = Once::new();

/// Enable `SeIncreaseBasePriorityPrivilege` on the process token (once).
fn enable_increase_base_priority() {
    PRIVILEGE.call_once(|| unsafe {
        use windows::Win32::Security::{
            AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
            TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
        };
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut token).is_err() {
            return;
        }
        let mut luid = LUID::default();
        if LookupPrivilegeValueW(PCWSTR::null(), w!("SeIncreaseBasePriorityPrivilege"), &mut luid).is_ok() {
            let tp = TOKEN_PRIVILEGES {
                PrivilegeCount: 1,
                Privileges: [LUID_AND_ATTRIBUTES {
                    Luid: luid,
                    Attributes: SE_PRIVILEGE_ENABLED,
                }],
            };
            let _ = AdjustTokenPrivileges(token, false, Some(&tp), 0, None, None);
        }
        let _ = CloseHandle(token);
    });
}

/// Raise the GPU scheduling priority of one D3D11 device (the duplication device).
pub fn raise_device(device: &ID3D11Device) {
    enable_increase_base_priority();
    unsafe {
        if let Ok(dxgi) = device.cast::<IDXGIDevice>() {
            if let Err(e) = dxgi.SetGPUThreadPriority(7) {
                eprintln!("[gpusched] SetGPUThreadPriority(7) refused: {e}");
            }
        }
    }
}

type SetClassFn = unsafe extern "system" fn(HANDLE, i32) -> i32;

fn set_process_class(class: i32) -> bool {
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};
    use windows::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let Ok(gdi) = LoadLibraryA(s!("gdi32.dll")) else {
            return false;
        };
        let Some(f) = GetProcAddress(gdi, s!("D3DKMTSetProcessSchedulingPriorityClass")) else {
            return false;
        };
        let f: SetClassFn = std::mem::transmute(f);
        // NTSTATUS: >= 0 is success.
        f(GetCurrentProcess(), class) >= 0
    }
}

static HOLDERS: AtomicUsize = AtomicUsize::new(0);

/// RAII: process GPU scheduling class HIGH while at least one capture pipeline runs.
pub struct ProcessGpuBoost(());

impl ProcessGpuBoost {
    pub fn new() -> Self {
        if HOLDERS.fetch_add(1, Ordering::SeqCst) == 0 {
            enable_increase_base_priority();
            if !set_process_class(PRIORITY_CLASS_HIGH) {
                eprintln!("[gpusched] HIGH GPU scheduling class unavailable — using defaults");
            }
        }
        ProcessGpuBoost(())
    }
}

impl Drop for ProcessGpuBoost {
    fn drop(&mut self) {
        if HOLDERS.fetch_sub(1, Ordering::SeqCst) == 1 {
            let _ = set_process_class(PRIORITY_CLASS_NORMAL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The boost is ref-counted: nested holders keep it, the last drop releases it,
    /// and none of it may panic on a machine where the calls are refused.
    #[test]
    fn nested_boosts_release_on_last_drop() {
        let a = ProcessGpuBoost::new();
        let b = ProcessGpuBoost::new();
        assert!(HOLDERS.load(Ordering::SeqCst) >= 2);
        drop(a);
        assert!(HOLDERS.load(Ordering::SeqCst) >= 1);
        drop(b);
    }
}
