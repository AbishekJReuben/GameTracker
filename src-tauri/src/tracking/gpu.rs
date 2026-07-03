//! Per-process GPU utilization via PDH "GPU Engine" performance counters — the
//! same source Task Manager uses to show per-app GPU %. Best-effort and
//! Windows-only: any failure yields an empty map so callers simply attribute no
//! GPU usage to apps (the UI degrades gracefully, like the sensor sidecar).
//!
//! A `GpuMeter` keeps a persistent PDH query alive across ticks. GPU-engine
//! utilization is a rate counter, so it needs two `PdhCollectQueryData` calls
//! spaced in time — the constructor primes it and each `poll()` reports the
//! utilization since the previous poll (our tracker polls every ~2s).

use std::collections::HashMap;

#[cfg(windows)]
mod imp {
    use super::HashMap;
    use windows::core::PCWSTR;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
        PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
    };

    const ERROR_SUCCESS: u32 = 0;
    const PDH_MORE_DATA: u32 = 0x8000_07D2;

    pub struct GpuMeter {
        query: isize,
        counter: isize,
    }

    impl GpuMeter {
        pub fn new() -> Option<Self> {
            unsafe {
                let mut query: isize = 0;
                // PdhOpenQueryW isn't re-exported cleanly across windows versions in
                // some setups; use the ANSI-agnostic English counter path instead.
                if super::pdh_open_query(&mut query) != ERROR_SUCCESS {
                    return None;
                }
                let mut counter: isize = 0;
                let path: Vec<u16> = "\\GPU Engine(*)\\Utilization Percentage\0"
                    .encode_utf16()
                    .collect();
                let rc = PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut counter);
                if rc != ERROR_SUCCESS {
                    let _ = PdhCloseQuery(query);
                    return None;
                }
                // Prime so the first real poll has a delta to format.
                let _ = PdhCollectQueryData(query);
                Some(Self { query, counter })
            }
        }

        /// Per-PID GPU utilization %, summed across engines. Empty on any error.
        pub fn poll(&self) -> HashMap<u32, f64> {
            let mut out: HashMap<u32, f64> = HashMap::new();
            unsafe {
                if PdhCollectQueryData(self.query) != ERROR_SUCCESS {
                    return out;
                }
                let mut size: u32 = 0;
                let mut count: u32 = 0;
                // Size probe (null buffer → PDH_MORE_DATA with required size/count).
                let rc = PdhGetFormattedCounterArrayW(
                    self.counter,
                    PDH_FMT_DOUBLE,
                    &mut size,
                    &mut count,
                    None,
                );
                if rc != PDH_MORE_DATA || size == 0 || count == 0 {
                    return out;
                }
                let mut buf = vec![0u8; size as usize];
                let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
                let rc = PdhGetFormattedCounterArrayW(
                    self.counter,
                    PDH_FMT_DOUBLE,
                    &mut size,
                    &mut count,
                    Some(items),
                );
                if rc != ERROR_SUCCESS {
                    return out;
                }
                for i in 0..count as usize {
                    let item = &*items.add(i);
                    let name = pwstr_to_string(item.szName.0);
                    if let Some(pid) = parse_pid(&name) {
                        let v = item.FmtValue.Anonymous.doubleValue;
                        if v.is_finite() && v > 0.0 {
                            *out.entry(pid).or_insert(0.0) += v;
                        }
                    }
                }
            }
            out
        }
    }

    impl Drop for GpuMeter {
        fn drop(&mut self) {
            unsafe {
                let _ = PdhCloseQuery(self.query);
            }
        }
    }

    unsafe fn pwstr_to_string(p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        while *p.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }

    /// GPU-engine instance names look like
    /// `pid_1234_luid_0x00000000_0x0000D3E5_phys_0_eng_0_engtype_3D`.
    fn parse_pid(name: &str) -> Option<u32> {
        let idx = name.find("pid_")?;
        let rest = &name[idx + 4..];
        let end = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        rest.get(..end)?.parse().ok()
    }
}

#[cfg(windows)]
unsafe fn pdh_open_query(query: *mut isize) -> u32 {
    use windows::core::PCWSTR;
    use windows::Win32::System::Performance::PdhOpenQueryW;
    PdhOpenQueryW(PCWSTR::null(), 0, query)
}

#[cfg(windows)]
pub use imp::GpuMeter;

// ---- Non-Windows stub so the crate still builds elsewhere (CI type-checks) ----
#[cfg(not(windows))]
pub struct GpuMeter;

#[cfg(not(windows))]
impl GpuMeter {
    pub fn new() -> Option<Self> {
        None
    }
    pub fn poll(&self) -> HashMap<u32, f64> {
        HashMap::new()
    }
}
