//! System monitoring: a background sampler that merges sysinfo (CPU load, RAM,
//! disks, uptime) with the `sensorbridge` sidecar (real CPU/GPU temperatures,
//! GPU load/clock/power/VRAM, disk activity) into a live ring buffer and a
//! persisted history. Powers the Systems tab — specs, live gauges, charts, and
//! a history that lines up with the games/apps you were running.

mod sensor;

use crate::db::models::SessionDto;
use crate::db::DbPool;
use crate::error::AppResult;
use chrono::{Duration as ChronoDuration, Utc};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use sysinfo::{Disks, System};

const TICK_SECS: u64 = 2;
const LIVE_CAP: usize = 300; // ~10 minutes at 2s resolution
const PERSIST_EVERY: u32 = 8; // persist a row roughly every 16s
const DISKS_EVERY: u32 = 15; // refresh disk capacity roughly every 30s
const PRUNE_DAYS: i64 = 30;
const SENSOR_STALE_SECS: u64 = 8; // ignore sidecar readings older than this

/// Latest readings from the sensor sidecar (real hardware sensors).
#[derive(Debug, Clone, Default)]
pub struct SensorReading {
    pub sidecar_present: bool,
    pub last_update: Option<Instant>,
    // specs
    pub cpu_name: Option<String>,
    pub gpu_names: Vec<String>,
    pub motherboard: Option<String>,
    // live sample
    pub cpu_temp: Option<f64>,
    pub cpu_clock: Option<f64>,
    pub cpu_power: Option<f64>,
    pub gpu_name: Option<String>,
    pub gpu_load: Option<f64>,
    pub gpu_temp: Option<f64>,
    pub gpu_clock: Option<f64>,
    pub gpu_power: Option<f64>,
    pub gpu_mem_used: Option<f64>,
    pub gpu_mem_total: Option<f64>,
    pub ram_temp: Option<f64>,
    pub disk_activity: Option<f64>,
    pub disk_temp: Option<f64>,
}

impl SensorReading {
    /// Only trust live sample fields when the sidecar reported recently.
    fn fresh(&self) -> bool {
        self.last_update
            .map(|t| t.elapsed() < Duration::from_secs(SENSOR_STALE_SECS))
            .unwrap_or(false)
    }
}

pub struct SystemShared {
    pub specs: Mutex<Option<SystemSpecs>>,
    pub sensor: Mutex<SensorReading>,
    pub live: Mutex<VecDeque<SystemSample>>,
}

impl SystemShared {
    pub fn new() -> Self {
        Self {
            specs: Mutex::new(None),
            sensor: Mutex::new(SensorReading::default()),
            live: Mutex::new(VecDeque::with_capacity(LIVE_CAP)),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpec {
    pub name: String,
    pub mount: String,
    pub kind: String, // "SSD" | "HDD" | "Removable" | "Unknown"
    pub fs: String,
    pub total_gb: f64,
    pub used_gb: f64,
    pub available_gb: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSpecs {
    pub cpu_name: String,
    pub cpu_cores: usize,
    pub cpu_threads: usize,
    pub cpu_ghz: f64,
    pub gpu_names: Vec<String>,
    pub gpu_vram_mb: Option<f64>,
    pub ram_total_gb: f64,
    pub swap_total_gb: f64,
    pub motherboard: Option<String>,
    pub os_name: String,
    pub os_version: String,
    pub kernel: String,
    pub hostname: String,
    pub uptime_secs: u64,
    pub boot_utc: String,
    pub disks: Vec<DiskSpec>,
    /// Whether real CPU temperature is being read (needs the sidecar + admin).
    pub has_cpu_temp: bool,
    pub has_gpu_sensors: bool,
    pub sidecar_present: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSample {
    pub ts: String,
    pub cpu: f64,
    pub cpu_temp: Option<f64>,
    pub cpu_clock_mhz: Option<f64>,
    pub cpu_power_w: Option<f64>,
    pub per_core: Vec<f64>,
    pub gpu: Option<f64>,
    pub gpu_temp: Option<f64>,
    pub gpu_clock_mhz: Option<f64>,
    pub gpu_power_w: Option<f64>,
    pub gpu_mem_used_mb: Option<f64>,
    pub gpu_mem_total_mb: Option<f64>,
    pub ram: f64,
    pub ram_used_gb: f64,
    pub ram_total_gb: f64,
    pub ram_temp: Option<f64>,
    pub swap: f64,
    /// Capacity used on the system drive (always available from sysinfo).
    pub disk_usage: f64,
    /// Live disk activity % (needs the sidecar / elevation).
    pub disk: Option<f64>,
    pub disk_temp: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemLive {
    pub specs: SystemSpecs,
    pub samples: Vec<SystemSample>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub ts: String,
    pub cpu: f64,
    pub cpu_temp: Option<f64>,
    pub gpu: Option<f64>,
    pub gpu_temp: Option<f64>,
    pub ram: f64,
    pub ram_temp: Option<f64>,
    pub disk: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemHistory {
    pub points: Vec<HistoryPoint>,
    pub sessions: Vec<SessionDto>,
}

fn bytes_to_gb(b: u64) -> f64 {
    b as f64 / 1_073_741_824.0
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn disk_kind_label(kind: sysinfo::DiskKind, removable: bool) -> String {
    match kind {
        sysinfo::DiskKind::SSD => "SSD".into(),
        sysinfo::DiskKind::HDD => "HDD".into(),
        _ if removable => "Removable".into(),
        _ => "Unknown".into(),
    }
}

fn build_specs(sys: &System, disks: &Disks, sensor: &SensorReading) -> SystemSpecs {
    let threads = sys.cpus().len();
    let cores = sys.physical_core_count().unwrap_or(threads.max(1));
    let cpu_ghz = sys
        .cpus()
        .first()
        .map(|c| c.frequency() as f64 / 1000.0)
        .unwrap_or(0.0);
    let cpu_name = sensor
        .cpu_name
        .clone()
        .or_else(|| sys.cpus().first().map(|c| c.brand().trim().to_string()))
        .unwrap_or_else(|| "Unknown CPU".into());

    let disk_specs: Vec<DiskSpec> = disks
        .list()
        .iter()
        .map(|d| {
            let total = d.total_space();
            let avail = d.available_space();
            DiskSpec {
                name: d.name().to_string_lossy().trim().to_string(),
                mount: d.mount_point().to_string_lossy().to_string(),
                kind: disk_kind_label(d.kind(), d.is_removable()),
                fs: d.file_system().to_string_lossy().to_string(),
                total_gb: round1(bytes_to_gb(total)),
                used_gb: round1(bytes_to_gb(total.saturating_sub(avail))),
                available_gb: round1(bytes_to_gb(avail)),
            }
        })
        .collect();

    let boot = System::boot_time();
    let boot_utc = chrono::DateTime::<Utc>::from_timestamp(boot as i64, 0)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default();

    SystemSpecs {
        cpu_name,
        cpu_cores: cores,
        cpu_threads: threads,
        cpu_ghz: round1(cpu_ghz),
        gpu_names: sensor.gpu_names.clone(),
        gpu_vram_mb: sensor.gpu_mem_total,
        ram_total_gb: round1(bytes_to_gb(sys.total_memory())),
        swap_total_gb: round1(bytes_to_gb(sys.total_swap())),
        motherboard: sensor.motherboard.clone(),
        os_name: System::long_os_version().unwrap_or_else(|| System::name().unwrap_or_default()),
        os_version: System::os_version().unwrap_or_default(),
        kernel: System::kernel_version().unwrap_or_default(),
        hostname: System::host_name().unwrap_or_default(),
        uptime_secs: System::uptime(),
        boot_utc,
        disks: disk_specs,
        has_cpu_temp: sensor.fresh() && sensor.cpu_temp.is_some(),
        has_gpu_sensors: sensor.fresh() && (sensor.gpu_temp.is_some() || sensor.gpu_load.is_some()),
        sidecar_present: sensor.sidecar_present,
    }
}

pub fn spawn(pool: DbPool, shared: Arc<SystemShared>, sidecar: Option<PathBuf>) {
    sensor::spawn(shared.clone(), sidecar);
    std::thread::Builder::new()
        .name("gametracker-sysmon".into())
        .spawn(move || run_loop(pool, shared))
        .ok();
}

fn run_loop(pool: DbPool, shared: Arc<SystemShared>) {
    let _ = ensure_table(&pool);
    let _ = prune(&pool);

    let mut sys = System::new();
    sys.refresh_cpu_all();
    sys.refresh_memory();
    let mut disks = Disks::new_with_refreshed_list();

    // Seed specs immediately so the UI has something on first paint.
    {
        let sensor = shared.sensor.lock().clone();
        *shared.specs.lock() = Some(build_specs(&sys, &disks, &sensor));
    }

    let mut tick: u32 = 0;
    loop {
        tick = tick.wrapping_add(1);
        std::thread::sleep(Duration::from_secs(TICK_SECS));

        sys.refresh_cpu_all();
        sys.refresh_memory();
        if tick % DISKS_EVERY == 0 {
            disks.refresh();
        }

        let sensor = shared.sensor.lock().clone();
        let fresh = sensor.fresh();

        let total_mem = sys.total_memory();
        let used_mem = sys.used_memory();
        let ram = if total_mem > 0 {
            used_mem as f64 / total_mem as f64 * 100.0
        } else {
            0.0
        };
        let total_swap = sys.total_swap();
        let swap = if total_swap > 0 {
            sys.used_swap() as f64 / total_swap as f64 * 100.0
        } else {
            0.0
        };
        let per_core: Vec<f64> = sys
            .cpus()
            .iter()
            .map(|c| round1(c.cpu_usage() as f64))
            .collect();
        let cpu = round1(sys.global_cpu_usage() as f64);
        let cpu_clock = sys.cpus().first().map(|c| c.frequency() as f64);

        // System-drive capacity used % — prefer C:, else the largest volume.
        let disk_usage = {
            let list = disks.list();
            let primary = list
                .iter()
                .find(|d| d.mount_point().to_string_lossy().starts_with("C:"))
                .or_else(|| list.iter().max_by_key(|d| d.total_space()));
            primary
                .map(|d| {
                    let t = d.total_space();
                    if t > 0 {
                        round1((t.saturating_sub(d.available_space())) as f64 / t as f64 * 100.0)
                    } else {
                        0.0
                    }
                })
                .unwrap_or(0.0)
        };

        let take = |v: Option<f64>| if fresh { v } else { None };

        let sample = SystemSample {
            ts: Utc::now().to_rfc3339(),
            cpu,
            cpu_temp: take(sensor.cpu_temp),
            cpu_clock_mhz: take(sensor.cpu_clock).or(cpu_clock),
            cpu_power_w: take(sensor.cpu_power),
            per_core,
            gpu: take(sensor.gpu_load),
            gpu_temp: take(sensor.gpu_temp),
            gpu_clock_mhz: take(sensor.gpu_clock),
            gpu_power_w: take(sensor.gpu_power),
            gpu_mem_used_mb: take(sensor.gpu_mem_used),
            gpu_mem_total_mb: take(sensor.gpu_mem_total),
            ram: round1(ram),
            ram_used_gb: round1(bytes_to_gb(used_mem)),
            ram_total_gb: round1(bytes_to_gb(total_mem)),
            ram_temp: take(sensor.ram_temp),
            swap: round1(swap),
            disk_usage,
            disk: take(sensor.disk_activity),
            disk_temp: take(sensor.disk_temp),
        };

        {
            let mut live = shared.live.lock();
            if live.len() >= LIVE_CAP {
                live.pop_front();
            }
            live.push_back(sample.clone());
        }

        // Specs are cheap to rebuild and pick up sensor names / temp availability
        // as soon as the sidecar reports them.
        *shared.specs.lock() = Some(build_specs(&sys, &disks, &sensor));

        if tick % PERSIST_EVERY == 0 {
            let _ = persist(&pool, &sample);
            if tick % (PERSIST_EVERY * 200) == 0 {
                let _ = prune(&pool);
            }
        }
    }
}

fn ensure_table(pool: &DbPool) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS system_samples (
            ts        TEXT PRIMARY KEY,
            cpu       REAL NOT NULL DEFAULT 0,
            cpu_temp  REAL,
            gpu       REAL,
            gpu_temp  REAL,
            ram       REAL NOT NULL DEFAULT 0,
            ram_temp  REAL,
            disk      REAL
        );",
    )?;
    // Upgrade older system_samples tables created before ram_temp existed.
    let _ = conn.execute("ALTER TABLE system_samples ADD COLUMN ram_temp REAL", []);
    Ok(())
}

fn persist(pool: &DbPool, s: &SystemSample) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "INSERT OR REPLACE INTO system_samples(ts, cpu, cpu_temp, gpu, gpu_temp, ram, ram_temp, disk)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            s.ts,
            s.cpu,
            s.cpu_temp,
            s.gpu,
            s.gpu_temp,
            s.ram,
            s.ram_temp,
            s.disk
        ],
    )?;
    Ok(())
}

fn prune(pool: &DbPool) -> AppResult<()> {
    let conn = pool.get()?;
    let cutoff = (Utc::now() - ChronoDuration::days(PRUNE_DAYS)).to_rfc3339();
    conn.execute("DELETE FROM system_samples WHERE ts < ?1", [cutoff])?;
    Ok(())
}

// ---------- command-facing reads ----------

pub fn specs(shared: &SystemShared) -> SystemSpecs {
    shared.specs.lock().clone().unwrap_or_default()
}

pub fn live(shared: &SystemShared) -> SystemLive {
    SystemLive {
        specs: shared.specs.lock().clone().unwrap_or_default(),
        samples: shared.live.lock().iter().cloned().collect(),
    }
}

pub fn history(pool: &DbPool, shared: &SystemShared, minutes: i64) -> AppResult<SystemHistory> {
    let minutes = minutes.clamp(5, 60 * 24 * PRUNE_DAYS);
    let from = (Utc::now() - ChronoDuration::minutes(minutes)).to_rfc3339();

    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT ts, cpu, cpu_temp, gpu, gpu_temp, ram, ram_temp, disk
         FROM system_samples WHERE ts >= ?1 ORDER BY ts ASC",
    )?;
    let mut points: Vec<HistoryPoint> = stmt
        .query_map([&from], |r| {
            Ok(HistoryPoint {
                ts: r.get(0)?,
                cpu: r.get(1)?,
                cpu_temp: r.get(2)?,
                gpu: r.get(3)?,
                gpu_temp: r.get(4)?,
                ram: r.get(5)?,
                ram_temp: r.get(6)?,
                disk: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Fold in the most recent live samples so the tail of the chart is current
    // even between persistence writes (which only happen every ~16s).
    let last_ts = points.last().map(|p| p.ts.clone());
    for s in shared.live.lock().iter() {
        if s.ts >= from && last_ts.as_deref().map(|t| s.ts.as_str() > t).unwrap_or(true) {
            points.push(HistoryPoint {
                ts: s.ts.clone(),
                cpu: s.cpu,
                cpu_temp: s.cpu_temp,
                gpu: s.gpu,
                gpu_temp: s.gpu_temp,
                ram: s.ram,
                ram_temp: s.ram_temp,
                disk: s.disk,
            });
        }
    }

    // Sessions (games + apps) overlapping the window — include in-progress rows
    // so overlays grow live like the main timeline (tracker updates last_seen ~2s).
    let mut sstmt = conn.prepare(
        "SELECT s.id, s.game_id, g.display_name, g.kind, g.icon_path, g.accent_color,
                s.start_utc, COALESCE(s.end_utc, s.last_seen_utc), s.last_seen_utc,
                s.runtime_seconds, s.active_seconds, s.was_idle_ended, s.focus_spans_json,
                g.cover_path
         FROM sessions s JOIN games g ON g.id = s.game_id
         WHERE datetime(s.start_utc) < datetime('now')
           AND datetime(COALESCE(s.end_utc, s.last_seen_utc)) > datetime(?1)
         ORDER BY s.start_utc ASC",
    )?;
    let sessions = sstmt
        .query_map([&from], |r| {
            let focus_raw: String = r.get(12)?;
            Ok(SessionDto {
                id: r.get(0)?,
                game_id: r.get(1)?,
                game_name: r.get(2)?,
                kind: r.get::<_, String>(3).unwrap_or_else(|_| "game".to_string()),
                icon_path: r.get(4)?,
                cover_path: r.get(13)?,
                accent_color: r.get(5)?,
                start_utc: r.get(6)?,
                end_utc: r.get(7)?,
                last_seen_utc: r.get(8)?,
                runtime_seconds: r.get(9)?,
                active_seconds: r.get(10)?,
                was_idle_ended: r.get::<_, i64>(11)? != 0,
                focus_spans: serde_json::from_str(&focus_raw).unwrap_or_default(),
                activity_spans: Vec::new(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(SystemHistory { points, sessions })
}
