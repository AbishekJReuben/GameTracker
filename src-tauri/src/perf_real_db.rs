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
//! After the real data it multiplies the tables that grow with use (sessions,
//! foreground spans, media plays, notes) by GT_PERF_SCALE (default 10) and runs
//! the hot paths again, so a heavier user's history is measured too.

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

/// What the Notes panel and the sync engine ask for all the time.
fn notes_paths(pool: &db::DbPool, writer: &rusqlite::Connection) {
    use crate::db::clipboard as clip;
    let page = clip::list(pool, None, 500).unwrap();
    let deep = page.last().map(|i| i.created_utc.clone());
    let ids: Vec<String> = page.iter().take(100).map(|i| i.id.clone()).collect();
    time_case("notes list (first page)", pool, writer, || clip::list(pool, None, 50).unwrap().len());
    time_case("notes list (page 10)", pool, writer, || clip::list(pool, deep.as_deref(), 50).unwrap().len());
    time_case("notes search \"the\"", pool, writer, || clip::search(pool, "the", 200).unwrap().len());
    time_case("notes tags", pool, writer, || clip::list_tags(pool).unwrap().len());
    time_case("notes folders", pool, writer, || clip::list_folders(pool).unwrap().len());
    time_case("notes upload page (unsynced)", pool, writer, || clip::list_unsynced(pool, None, 100).unwrap().len());
    time_case("notes known (100 ids)", pool, writer, || clip::known_ids(pool, &ids).unwrap().len());
    time_case("notes changes since 0 (500)", pool, writer, || clip::changes_since(pool, 0, 500).unwrap().len());
}

/// Add `factor - 1` shifted copies of every row of the tables that grow with use.
/// Copies land 30 days apart going back, synced, so "today" and the upload queue
/// look like a long-time user's rather than a burst.
fn inflate(writer: &rusqlite::Connection, factor: i64) {
    // (table, time columns, RFC3339 suffix the table uses)
    let tables: [(&str, &[&str], &str); 4] = [
        ("sessions", &["start_utc", "end_utc", "last_seen_utc"], "+00:00"),
        ("foreground_spans", &["start_utc", "end_utc", "last_seen_utc"], "+00:00"),
        ("media_plays", &["start_utc", "end_utc", "last_seen_utc"], "+00:00"),
        ("clipboard_items", &["created_utc"], "Z"),
    ];
    writer.execute_batch("BEGIN").unwrap();
    for (table, times, suffix) in tables {
        let cols: Vec<String> = writer
            .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|c| c.unwrap())
            .collect();
        for k in 1..factor {
            let select: Vec<String> = cols
                .iter()
                .map(|c| match c.as_str() {
                    "id" => format!("id || '-x{k}'"),
                    "synced" => "1".to_string(),
                    c if times.contains(&c) => {
                        format!("strftime('%Y-%m-%dT%H:%M:%f{suffix}', {c}, '-{} days')", k * 30)
                    }
                    c => c.to_string(),
                })
                .collect();
            writer
                .execute_batch(&format!(
                    "INSERT INTO {table} ({}) SELECT {} FROM {table} WHERE id NOT LIKE '%-x%'",
                    cols.join(", "),
                    select.join(", ")
                ))
                .unwrap();
        }
    }
    writer.execute_batch("COMMIT").unwrap();
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

    println!("-- notes (real data)");
    notes_paths(&pool, &writer);

    let factor: i64 = std::env::var("GT_PERF_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(10);
    let t = Instant::now();
    inflate(&writer, factor);
    println!("{:34} {:8.1} ms", format!("inflate x{factor}"), t.elapsed().as_secs_f64() * 1000.0);
    {
        let conn = pool.get().unwrap();
        let count = |t: &str| -> i64 { conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0)).unwrap() };
        println!(
            "rows now: sessions {}, foreground_spans {}, media_plays {}, clipboard_items {}",
            count("sessions"),
            count("foreground_spans"),
            count("media_plays"),
            count("clipboard_items")
        );
    }
    println!("-- hot paths at x{factor}");
    time_case("today_totals_kind game+app", &pool, &writer, || {
        (
            sessions::today_totals_kind(&pool, "game").unwrap(),
            sessions::today_totals_kind(&pool, "app").unwrap(),
        )
    });
    time_case("media accrue_open_for_source", &pool, &writer, || {
        media::accrue_open_for_source(&pool, "jukebox", 0).unwrap()
    });
    time_case("close_orphans x3", &pool, &writer, || {
        sessions::close_orphans(&pool).unwrap();
        media::close_orphans(&pool).unwrap();
        foreground::close_orphans(&pool).unwrap();
    });
    time_case("list_games", &pool, &writer, || games::list(&pool).unwrap().len());
    time_case("dashboard", &pool, &writer, || stats::dashboard(&pool).unwrap());
    time_case("apps_overview", &pool, &writer, || stats::apps_overview(&pool).unwrap());
    time_case("media_overview", &pool, &writer, || music::overview(&pool).unwrap());
    time_case("list_sessions (default)", &pool, &writer, || {
        sessions::list(&pool, &SessionFilter::default()).unwrap().len()
    });
    time_case("foreground_spans (24 h)", &pool, &writer, || {
        foreground::list(&pool, Some(&today), None).unwrap().len()
    });
    time_case("heatmap 365", &pool, &writer, || stats::heatmap(&pool, 365, None).unwrap().len());
    time_case("system_history 1 week", &pool, &writer, || system::history(&pool, &shared, 60 * 24 * 7).unwrap());
    notes_paths(&pool, &writer);

    println!("-- writes");
    time_case("set_setting", &pool, &writer, || settings::set(&pool, "perf_probe2", "x").unwrap());

    drop(writer);
    drop(pool);
    let _ = std::fs::remove_dir_all(&dir);
}
