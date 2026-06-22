//! Spawns the `sensorbridge` sidecar and parses its newline-delimited JSON into
//! the shared `SensorReading`. Runs on its own thread and restarts the sidecar
//! if it dies. Everything is best-effort: if the sidecar is missing or a sensor
//! is unavailable (e.g. CPU temperature without admin), the field stays `None`
//! and the rest of the system stats (from sysinfo) are unaffected.

use super::SystemShared;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const SIDECAR_NAMES: &[&str] = &[
    "sensorbridge.exe",
    "sensorbridge-x86_64-pc-windows-msvc.exe",
];

pub fn spawn(shared: Arc<SystemShared>, explicit: Option<PathBuf>) {
    std::thread::Builder::new()
        .name("gametracker-sensor".into())
        .spawn(move || reader_loop(shared, explicit))
        .ok();
}

/// Locate the sidecar in bundled (next to the app exe) or dev (`binaries/`) layouts.
fn resolve_path(explicit: &Option<PathBuf>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        if p.is_file() {
            return Some(p.clone());
        }
    }
    if let Ok(cur) = std::env::current_exe() {
        if let Some(dir) = cur.parent() {
            for name in SIDECAR_NAMES {
                let c = dir.join(name);
                if c.is_file() {
                    return Some(c);
                }
            }
        }
    }
    for c in [
        PathBuf::from("binaries/sensorbridge-x86_64-pc-windows-msvc.exe"),
        PathBuf::from("src-tauri/binaries/sensorbridge-x86_64-pc-windows-msvc.exe"),
    ] {
        if c.is_file() {
            return Some(c);
        }
    }
    None
}

fn reader_loop(shared: Arc<SystemShared>, explicit: Option<PathBuf>) {
    loop {
        let Some(path) = resolve_path(&explicit) else {
            // No sidecar available — sysinfo metrics still work; don't busy-loop.
            shared.sensor.lock().sidecar_present = false;
            std::thread::sleep(Duration::from_secs(30));
            continue;
        };
        shared.sensor.lock().sidecar_present = true;

        let mut cmd = Command::new(&path);
        cmd.arg("--interval=2000")
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        match cmd.spawn() {
            Ok(mut child) => {
                // Tie the (elevated) sidecar's lifetime to ours via a job object so
                // it can never outlive the app and lock files during a reinstall.
                #[cfg(windows)]
                job::assign(&child);
                if let Some(out) = child.stdout.take() {
                    let reader = BufReader::new(out);
                    for line in reader.lines().map_while(Result::ok) {
                        if line.trim().is_empty() {
                            continue;
                        }
                        parse_line(&shared, &line);
                    }
                }
                let _ = child.wait();
            }
            Err(_) => { /* fall through to retry */ }
        }

        // Sidecar exited — mark readings stale and retry shortly.
        shared.sensor.lock().last_update = None;
        std::thread::sleep(Duration::from_secs(10));
    }
}

/// Windows job object that kills assigned child processes when the app exits.
/// One job is created per process; every (re)spawned sidecar is assigned to it.
/// When our process dies for any reason, the OS closes the handle and the
/// `KILL_ON_JOB_CLOSE` flag terminates the sidecar — no elevated orphans.
#[cfg(windows)]
mod job {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    struct Job(HANDLE);
    // The handle is only ever used to assign children; safe to share across threads.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn handle() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(None, windows::core::PCWSTR::null()).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let _ = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            Some(Job(h))
        })
        .as_ref()
        .map(|j| j.0)
    }

    pub fn assign(child: &std::process::Child) {
        if let Some(job) = handle() {
            unsafe {
                let _ = AssignProcessToJobObject(job, HANDLE(child.as_raw_handle() as *mut c_void));
            }
        }
    }
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

fn parse_line(shared: &Arc<SystemShared>, line: &str) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("specs") => {
            let mut s = shared.sensor.lock();
            s.cpu_name = v.get("cpuName").and_then(|x| x.as_str()).map(str::to_string);
            s.motherboard = v
                .get("motherboard")
                .and_then(|x| x.as_str())
                .map(str::to_string);
            if let Some(arr) = v.get("gpuNames").and_then(|x| x.as_array()) {
                s.gpu_names = arr
                    .iter()
                    .filter_map(|g| g.as_str().map(str::to_string))
                    .collect();
            }
        }
        Some("sample") => {
            let mut s = shared.sensor.lock();
            s.cpu_temp = num(&v, "cpuTemp");
            s.cpu_clock = num(&v, "cpuClock");
            s.cpu_power = num(&v, "cpuPower");
            s.gpu_name = v.get("gpuName").and_then(|x| x.as_str()).map(str::to_string);
            s.gpu_load = num(&v, "gpuLoad");
            s.gpu_temp = num(&v, "gpuTemp");
            s.gpu_clock = num(&v, "gpuClock");
            s.gpu_power = num(&v, "gpuPower");
            s.gpu_mem_used = num(&v, "gpuMemUsed");
            s.gpu_mem_total = num(&v, "gpuMemTotal");
            s.ram_temp = num(&v, "ramTemp");
            s.disk_activity = num(&v, "diskActivity");
            s.disk_temp = num(&v, "diskTemp");
            s.last_update = Some(Instant::now());
        }
        _ => {}
    }
}
