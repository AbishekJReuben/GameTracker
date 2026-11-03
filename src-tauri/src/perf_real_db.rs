//! Timing harness for the UI's read paths against a copy of a real database.
//!
//! Every page of the app waits on one of these calls, and before v3.9.127 most of
//! them ran on the UI thread, so their cost was the app's responsiveness. Each
//! case runs on a cold SQLite page cache (another connection writes first, which
//! is what the tracker does every 2 s in the live app), so the numbers match what
//! the UI actually sees rather than a warmed-up best case.
//!
//!   set GT_PERF_DB=<path to a copy of gametracker.db>
//!   cargo test --release --lib perf_real_db -- --ignored --nocapture
//!
//! The harness copies the file first, so migrations never touch the given path.

use crate::db::{self, foreground, games, media, models::SessionFilter, music, sessions, settings, stats};
use crate::system::{self, SystemShared};
use std::time::{Duration, Instant};

const RUNS: usize = 5;

fn time_case<T>(name: &str, pool: &db::DbPool, writer: &rusqlite::Connection, mut f: impl FnMut() -> T) {
    let mut samples: Vec<Duration> = Vec::with_capacity(RUNS);
    for i in 0..RUNS {
        // Invalidate every pooled connection's page cache, like a tracker tick does.
        writer
            .execute(
                "INSERT INTO settings(key, value) VALUES('perf_probe', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [i.to_string()],
            )
            .unwrap();
        let t = Instant::now();
        std::hint::black_box(f());
        samples.push(t.elapsed());
    }
    let _ = pool;
    samples.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    println!(
        "{name:34} median {:8.1} ms   max {:8.1} ms",
        ms(samples[RUNS / 2]),
        ms(samples[RUNS - 1])
    );
}

#[test]
#[ignore]
fn perf_real_db() {
    let Ok(src) = std::env::var("GT_PERF_DB") else {
        eprintln!("GT_PERF_DB not set; skipping");
        return;
    };
    let dir = std::env::temp_dir().join(format!("gt-perf-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("gametracker.db");
    std::fs::copy(&src, &path).unwrap();

    let t = Instant::now();
    let pool = db::init_pool(&path).unwrap();
    println!("{:34} {:8.1} ms", "init_pool (migrations)", t.elapsed().as_secs_f64() * 1000.0);
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer.execute_batch("PRAGMA busy_timeout = 5000;").unwrap();
    let shared = SystemShared::new();
    let today = chrono::Utc::now() - chrono::Duration::hours(24);
    let today = today.to_rfc3339();

    // These run as the tracker and system threads start, while the UI's first
    // set_setting waits. A DELETE holds the write lock for its whole scan.
    println!("-- startup (write lock held)");
    time_case("close_orphans x3", &pool, &writer, || {
        sessions::close_orphans(&pool).unwrap();
        media::close_orphans(&pool).unwrap();
        foreground::close_orphans(&pool).unwrap();
    });
    time_case("media + foreground prune (420 d)", &pool, &writer, || {
        media::prune(&pool, 420).unwrap();
        foreground::prune(&pool, 420).unwrap();
    });
    time_case("system + app samples prune", &pool, &writer, || {
        system::prune(&pool).unwrap();
        system::prune_app(&pool).unwrap();
    });

    println!("-- per-tick (tracker loop, every 2 s)");
    time_case("today_totals_kind game+app", &pool, &writer, || {
        (
            sessions::today_totals_kind(&pool, "game").unwrap(),
            sessions::today_totals_kind(&pool, "app").unwrap(),
        )
    });
    time_case("media accrue_open_for_source", &pool, &writer, || {
        media::accrue_open_for_source(&pool, "jukebox", 0).unwrap()
    });
    time_case("settings::get_bool", &pool, &writer, || settings::get_bool(&pool, "tracking_paused").unwrap());
    time_case("games::match_candidates (16 s)", &pool, &writer, || games::match_candidates(&pool).unwrap().len());

    println!("-- UI commands");
    time_case("list_games", &pool, &writer, || games::list(&pool).unwrap().len());
    time_case("dashboard", &pool, &writer, || stats::dashboard(&pool).unwrap());
    time_case("apps_overview", &pool, &writer, || stats::apps_overview(&pool).unwrap());
    time_case("media_overview", &pool, &writer, || music::overview(&pool).unwrap());
    time_case("get_settings", &pool, &writer, || settings::all(&pool).unwrap().len());
    time_case("list_sessions (default)", &pool, &writer, || {
        sessions::list(&pool, &SessionFilter::default()).unwrap().len()
    });
    time_case("foreground_spans (24 h)", &pool, &writer, || {
        foreground::list(&pool, Some(&today), None).unwrap().len()
    });
    time_case("heatmap 365", &pool, &writer, || stats::heatmap(&pool, 365, None).unwrap().len());
    time_case("catalog_analytics", &pool, &writer, || stats::catalog_analytics(&pool).unwrap());
    for minutes in [60, 60 * 24, 60 * 24 * 7, 60 * 24 * 30] {
        time_case(&format!("system_history {minutes} min"), &pool, &writer, || {
            system::history(&pool, &shared, minutes).unwrap()
        });
        time_case(&format!("system_app_history {minutes} min"), &pool, &writer, || {
            system::app_history(&pool, &shared, minutes).unwrap()
        });
    }

    // One-time on an install that predates compaction; later runs only see the
    // day that just aged past RAW_DAYS.
    let t = Instant::now();
    let days = system::compact_samples(&pool).unwrap();
    println!("{:34} {:8.1} ms ({days} table-days)", "compact_samples (first run)", t.elapsed().as_secs_f64() * 1000.0);
    for minutes in [60 * 24 * 7, 60 * 24 * 30] {
        time_case(&format!("compacted system_history {minutes}"), &pool, &writer, || {
            system::history(&pool, &shared, minutes).unwrap()
        });
        time_case(&format!("compacted app_history {minutes}"), &pool, &writer, || {
            system::app_history(&pool, &shared, minutes).unwrap()
        });
    }
    {
        let conn = pool.get().unwrap();
        let count = |t: &str| -> i64 { conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0)).unwrap() };
        println!("rows after compaction: system_samples {}, app_samples {}", count("system_samples"), count("app_samples"));
    }
    let t = Instant::now();
    writer.execute_batch("VACUUM;").unwrap();
    println!(
        "{:34} {:8.1} ms -> {:.0} MB",
        "VACUUM",
        t.elapsed().as_secs_f64() * 1000.0,
        std::fs::metadata(&path).map(|m| m.len() as f64 / 1_048_576.0).unwrap_or(0.0)
    );

    println!("-- writes");
    time_case("set_setting", &pool, &writer, || settings::set(&pool, "perf_probe2", "x").unwrap());

    drop(writer);
    drop(pool);
    let _ = std::fs::remove_dir_all(&dir);
}
