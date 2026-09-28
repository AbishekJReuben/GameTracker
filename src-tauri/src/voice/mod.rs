//! Voice: every Claude Code session on this PC, narrated to the phone.
//!
//! transcript files ─▶ [transcript] events ─▶ [plan] log ─▶ [engine] Kokoro
//!                                              │                 │ MP3
//!                                              └──▶ [relay] ◀────┘ encrypted
//!
//! One loop thread owns the log. A synth thread owns the TTS worker process
//! (started on first use, stopped after 10 idle minutes). A relay thread owns
//! the socket. Nothing here calls any AI API; the voice is local.

pub mod engine;
pub mod install;
pub mod plan;
pub mod relay;
pub mod speak;
pub mod transcript;

use crate::db::{self, DbPool};
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde::Serialize;
use speak::Kind;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

const TICK: Duration = Duration::from_millis(120);
/// The model stays loaded this long after the last line, so the next one is
/// instant (a cold start costs ~2.5 s); after that its ~400 MB are released.
const ENGINE_IDLE: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub id: String,
    pub kind: &'static str,
    pub text: String,
    pub project: String,
    pub title: String,
    /// "ready" | "pending" | "skipped"
    pub audio: &'static str,
    pub played: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub installed: bool,
    pub installing: bool,
    pub progress: f32,
    pub progress_label: String,
    pub running: bool,
    pub relay: String,
    pub phone_listening: bool,
    pub engine_loaded: bool,
    pub backlog_secs: f64,
    /// Last line: ms to synthesize, ms to encode, ms of audio produced.
    pub last_synth_ms: u32,
    pub last_encode_ms: u32,
    pub last_audio_ms: u32,
    pub error: Option<String>,
    pub recent: Vec<Line>,
}

struct Ctx {
    pool: DbPool,
    data_dir: PathBuf,
}

pub struct Voice {
    ctx: OnceCell<Ctx>,
    status: Mutex<Status>,
    run_stop: Mutex<Option<Arc<AtomicBool>>>,
    install_cancel: AtomicBool,
    inject: Mutex<Option<Sender<transcript::Event>>>,
}

static VOICE: Voice = Voice {
    ctx: OnceCell::new(),
    status: Mutex::new(Status {
        enabled: false,
        installed: false,
        installing: false,
        progress: 0.0,
        progress_label: String::new(),
        running: false,
        relay: String::new(),
        phone_listening: false,
        engine_loaded: false,
        backlog_secs: 0.0,
        last_synth_ms: 0,
        last_encode_ms: 0,
        last_audio_ms: 0,
        error: None,
        recent: Vec::new(),
    }),
    run_stop: Mutex::new(None),
    install_cancel: AtomicBool::new(false),
    inject: Mutex::new(None),
};

/// Called once from setup. Starts the voice if it was left on.
pub fn init(pool: DbPool, data_dir: PathBuf) {
    let _ = VOICE.ctx.set(Ctx { pool, data_dir });
    let enabled = VOICE.ctx.get().map(|c| db::settings::get_bool(&c.pool, "voice_enabled").unwrap_or(false)).unwrap_or(false);
    if enabled {
        let _ = set_enabled(true);
    } else {
        refresh_installed();
    }
}

fn refresh_installed() {
    if let Some(c) = VOICE.ctx.get() {
        VOICE.status.lock().installed = install::installed(&c.data_dir);
    }
}

pub fn status() -> Status {
    refresh_installed();
    VOICE.status.lock().clone()
}

/// Turn the whole feature on or off. On: installs the model if needed (in the
/// background), then starts narrating.
pub fn set_enabled(on: bool) -> Result<Status, String> {
    let ctx = VOICE.ctx.get().ok_or("voice not initialised")?;
    db::settings::set(&ctx.pool, "voice_enabled", if on { "true" } else { "false" }).map_err(|e| e.to_string())?;
    VOICE.status.lock().enabled = on;
    if !on {
        VOICE.install_cancel.store(true, Ordering::SeqCst);
        stop();
        return Ok(status());
    }
    VOICE.install_cancel.store(false, Ordering::SeqCst);
    if install::installed(&ctx.data_dir) {
        start();
    } else if !VOICE.status.lock().installing {
        VOICE.status.lock().installing = true;
        let data_dir = ctx.data_dir.clone();
        std::thread::spawn(move || {
            let r = install::install(&data_dir, &VOICE.install_cancel, &|p, label| {
                let mut s = VOICE.status.lock();
                s.progress = p;
                s.progress_label = label.to_string();
            });
            let mut s = VOICE.status.lock();
            s.installing = false;
            match r {
                Ok(()) => {
                    s.installed = true;
                    s.error = None;
                    let still_on = s.enabled;
                    drop(s);
                    if still_on {
                        start();
                    }
                }
                Err(e) => s.error = Some(e),
            }
        });
    }
    Ok(status())
}

/// Say a sample line in the voice used for `kind` (and send it to the phone).
pub fn test(kind: &str) -> Result<(), String> {
    let kind = match kind {
        "thinking" => Kind::Thinking,
        "action" => Kind::Action,
        "output" => Kind::Output,
        _ => Kind::Reply,
    };
    let text = match kind {
        Kind::Thinking => "This is how Claude's thinking sounds, when the transcript carries it.",
        Kind::Action => "Running the Rust library tests.",
        Kind::Output => "Test result: ok. 85 passed, 0 failed.",
        _ => "This is how Claude's replies will sound on your phone.",
    };
    let tx = VOICE.inject.lock().clone().ok_or("Voice isn't running yet")?;
    tx.send(transcript::Event {
        id: format!("test-{}", chrono::Utc::now().timestamp_millis()),
        session_id: "test".into(),
        title: "Voice test".into(),
        project: "GameTracker".into(),
        kind,
        text: text.into(),
        helper: false,
        category: "",
        failed: false,
    })
    .map_err(|_| "Voice isn't running".to_string())
}

fn stop() {
    if let Some(flag) = VOICE.run_stop.lock().take() {
        flag.store(true, Ordering::SeqCst);
    }
    *VOICE.inject.lock() = None;
    let mut s = VOICE.status.lock();
    s.running = false;
    s.relay.clear();
    s.phone_listening = false;
}

fn start() {
    stop();
    let Some(ctx) = VOICE.ctx.get() else { return };
    let flag = Arc::new(AtomicBool::new(false));
    *VOICE.run_stop.lock() = Some(flag.clone());
    let (inj_tx, inj_rx) = mpsc::channel();
    *VOICE.inject.lock() = Some(inj_tx);
    let pool = ctx.pool.clone();
    let data_dir = ctx.data_dir.clone();
    std::thread::Builder::new()
        .name("voice".into())
        .spawn(move || {
            if let Err(e) = run(pool, data_dir, flag, inj_rx) {
                let mut s = VOICE.status.lock();
                s.error = Some(e);
                s.running = false;
            }
        })
        .ok();
}

struct Settings {
    voices: serde_json::Value,
    output_max_chars: usize,
}

fn read_settings(pool: &DbPool) -> Settings {
    let voices = db::settings::get(pool, "voice_voices")
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let output_max_chars = db::settings::get_i64(pool, "voice_output_max_chars", 800).unwrap_or(800).max(0) as usize;
    Settings { voices, output_max_chars }
}

fn sid_for(voices: &serde_json::Value, kind: Kind) -> u32 {
    let fallback = match kind {
        Kind::Thinking => 6,
        Kind::Action | Kind::Summary => 16,
        Kind::Output => 26,
        Kind::Reply | Kind::Question => 3,
    };
    voices.get(kind.as_str()).and_then(|v| v.as_u64()).map(|v| v as u32).unwrap_or(fallback)
}

/// An empty job just loads the model (sent when Voice starts and when a phone
/// connects, so the first line doesn't pay the cold start).
struct Job {
    id: String,
    part: usize,
    text: String,
    sid: u32,
}

struct Done {
    id: String,
    part: usize,
    result: Result<(Vec<u8>, u32), String>,
}

fn now_us() -> i64 {
    chrono::Utc::now().timestamp_micros()
}

fn utc_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn run(pool: DbPool, data_dir: PathBuf, stop: Arc<AtomicBool>, inject: Receiver<transcript::Event>) -> Result<(), String> {
    let secret = db::settings::get(&pool, "remote_secret_code").ok().flatten().unwrap_or_default();
    if secret.trim().is_empty() {
        return Err("No permanent key yet: open Remote once to create it, then pair the phone.".into());
    }
    let signal = db::settings::get(&pool, "remote_signal_url").ok().flatten().unwrap_or_default();
    let root = transcript::projects_root().ok_or("can't find your home folder")?;
    let crypto = relay::Crypto::new(secret.trim());
    let url = format!("{}/voice/ws?clip={}&device=pc&role=pc", relay::ws_base(&signal), relay::space_id(secret.trim()));

    let (out_tx, out_rx) = mpsc::channel::<relay::Out>();
    let (in_tx, in_rx) = mpsc::channel::<relay::In>();
    {
        let stop = stop.clone();
        std::thread::Builder::new().name("voice-relay".into()).spawn(move || relay::run(url, out_rx, in_tx, stop)).ok();
    }
    let (job_tx, job_rx) = mpsc::channel::<Job>();
    let (done_tx, done_rx) = mpsc::channel::<Done>();
    {
        let paths = install::paths(&data_dir);
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        std::thread::Builder::new()
            .name("voice-synth".into())
            .spawn(move || synth_loop(exe, paths, job_rx, done_tx))
            .ok();
    }

    {
        let mut s = VOICE.status.lock();
        s.running = true;
        s.error = None;
        s.relay = "connecting".into();
    }

    let mut settings = read_settings(&pool);
    let mut settings_at = Instant::now();
    let mut watcher = transcript::Watcher::new(root);
    let mut parser = transcript::Parser::new(settings.output_max_chars);
    let mut log = plan::Log::default();
    let limits = plan::Limits::default();
    let mut busy = false;
    let mut wanted: VecDeque<(String, usize)> = VecDeque::new();
    let mut status_at = Instant::now();
    let warm = |tx: &Sender<Job>| {
        let _ = tx.send(Job { id: String::new(), part: 0, text: String::new(), sid: 0 });
    };
    warm(&job_tx);

    while !stop.load(Ordering::SeqCst) {
        let tick = Instant::now();
        if settings_at.elapsed() > Duration::from_secs(3) {
            settings = read_settings(&pool);
            parser.output_max_chars = settings.output_max_chars;
            settings_at = Instant::now();
        }
        for line in watcher.poll() {
            for ev in parser.line(&line) {
                log.push(ev, now_us(), utc_now());
            }
        }
        while let Ok(ev) = inject.try_recv() {
            log.push(ev, now_us(), utc_now());
        }
        while let Ok(msg) = in_rx.try_recv() {
            match msg {
                relay::In::Connected => VOICE.status.lock().relay = "connected".into(),
                relay::In::Disconnected(why) => {
                    let mut s = VOICE.status.lock();
                    s.relay = format!("offline ({why})");
                    s.phone_listening = false;
                }
                relay::In::Head(order) => {
                    log.set_head(order);
                    let mut s = VOICE.status.lock();
                    if !s.phone_listening && !s.engine_loaded && !busy {
                        warm(&job_tx);
                    }
                    s.phone_listening = true;
                }
                relay::In::Want(id) => {
                    if let Some(it) = log.items.iter().find(|it| it.id == id) {
                        for (p, a) in it.audio_ms.iter().enumerate() {
                            if a.is_none() {
                                wanted.push_back((id.clone(), p));
                            }
                        }
                    }
                }
            }
        }
        log.condense(&limits, now_us(), &utc_now());

        // Publish new and changed items.
        for it in log.items.iter_mut().filter(|it| it.dirty) {
            it.dirty = false;
            let payload = serde_json::json!({
                "kind": it.kind.as_str(),
                "text": it.text,
                "session": it.session_id,
                "title": it.title,
                "project": it.project,
                "helper": it.helper,
            });
            let _ = out_tx.send(relay::Out::Item(serde_json::json!({
                "itemId": it.id,
                "order": it.order,
                "createdUtc": it.created_utc,
                "skip": it.skip,
                "parts": it.parts.len(),
                "cipher": crypto.seal_b64(payload.to_string().as_bytes()),
            })));
        }

        // Results from the synth thread.
        while let Ok(done) = done_rx.try_recv() {
            busy = false;
            match done.result {
                Ok((mp3, ms)) => {
                    log.set_audio(&done.id, done.part, ms);
                    let _ = out_tx.send(relay::Out::Audio {
                        item: done.id,
                        part: done.part,
                        dur_ms: ms,
                        data: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, crypto.seal(&mp3)),
                    });
                    VOICE.status.lock().engine_loaded = true;
                }
                Err(e) => {
                    // Don't retry a part forever: mark it done (silent) and say why.
                    log.set_audio(&done.id, done.part, 0);
                    VOICE.status.lock().error = Some(e);
                }
            }
        }

        // One job at a time: requested replays first, then the playback window.
        if !busy {
            let next = wanted
                .pop_front()
                .or_else(|| log.next_to_synthesize(&limits).map(|(i, p)| (log.items[i].id.clone(), p)));
            if let Some((id, part)) = next {
                if let Some(it) = log.items.iter().find(|it| it.id == id) {
                    if let Some(text) = it.parts.get(part) {
                        let sid = sid_for(&settings.voices, it.kind);
                        if job_tx.send(Job { id: id.clone(), part, text: text.clone(), sid }).is_ok() {
                            busy = true;
                        }
                    }
                }
            }
        }

        if status_at.elapsed() > Duration::from_millis(500) {
            status_at = Instant::now();
            let head = log.head.unwrap_or(i64::MAX);
            let recent: Vec<Line> = log
                .items
                .iter()
                .rev()
                .take(60)
                .map(|it| Line {
                    id: it.id.clone(),
                    kind: it.kind.as_str(),
                    text: it.text.chars().take(240).collect(),
                    project: it.project.clone(),
                    title: it.title.clone(),
                    audio: if it.skip {
                        "skipped"
                    } else if it.audio_ms.iter().all(Option::is_some) {
                        "ready"
                    } else {
                        "pending"
                    },
                    played: it.order <= head,
                })
                .collect();
            let mut s = VOICE.status.lock();
            s.recent = recent;
            s.backlog_secs = log.backlog_secs();
        }

        let spent = tick.elapsed();
        if spent < TICK {
            std::thread::sleep(TICK - spent);
        }
    }
    Ok(())
}

/// Owns the worker process: started on the first job, stopped after an idle spell.
fn synth_loop(exe: PathBuf, paths: install::Paths, jobs: Receiver<Job>, done: Sender<Done>) {
    let threads = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(4).clamp(2, 6) as u32;
    let mut engine: Option<engine::Engine> = None;
    loop {
        let job = match jobs.recv_timeout(ENGINE_IDLE) {
            Ok(j) => j,
            Err(RecvTimeoutError::Timeout) => {
                engine = None; // frees the ~400 MB model
                VOICE.status.lock().engine_loaded = false;
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        if engine.as_mut().is_some_and(|e| !e.alive()) {
            engine = None;
        }
        if engine.is_none() {
            match engine::Engine::start(&exe, &paths.engine, &paths.model, threads) {
                Ok(e) => engine = Some(e),
                Err(e) => {
                    let _ = done.send(Done { id: job.id, part: job.part, result: Err(e) });
                    continue;
                }
            }
        }
        if job.text.is_empty() {
            VOICE.status.lock().engine_loaded = true;
            continue; // warm-up only
        }
        let e = engine.as_mut().expect("engine");
        let t0 = Instant::now();
        let result = e.speak(&job.text, job.sid, 1.0).and_then(|pcm| {
            let synth_ms = t0.elapsed().as_millis() as u32;
            let ms = (pcm.len() as u64 * 1000 / e.rate.max(1) as u64) as u32;
            let t1 = Instant::now();
            let out = engine::encode_mp3(&pcm, e.rate).map(|mp3| (mp3, ms));
            let mut s = VOICE.status.lock();
            s.last_synth_ms = synth_ms;
            s.last_encode_ms = t1.elapsed().as_millis() as u32;
            s.last_audio_ms = ms;
            out
        });
        if result.is_err() {
            engine = None; // restart it next time
        }
        if done.send(Done { id: job.id, part: job.part, result }).is_err() {
            return;
        }
    }
}

/// Development harness (`examples/voice_probe.rs`): the real pipeline with a
/// throwaway key against any relay, without the app, its window or its database.
/// Prints its status every two seconds and stops after `seconds`.
pub fn probe(secret: &str, signal_url: &str, data_dir: PathBuf, seconds: u64) -> Result<(), String> {
    let db_path = std::env::temp_dir().join(format!("gt-voice-probe-{}.db", std::process::id()));
    let pool = db::init_pool(&db_path).map_err(|e| e.to_string())?;
    db::settings::set(&pool, "remote_secret_code", secret).map_err(|e| e.to_string())?;
    db::settings::set(&pool, "remote_signal_url", signal_url).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(seconds);
            while Instant::now() < until {
                std::thread::sleep(Duration::from_secs(2));
                let s = VOICE.status.lock().clone();
                eprintln!(
                    "[probe] relay={} phone={} engine={} backlog={:.0}s last: synth {} ms, encode {} ms, audio {} ms lines={} error={:?}",
                    s.relay,
                    s.phone_listening,
                    s.engine_loaded,
                    s.backlog_secs,
                    s.last_synth_ms,
                    s.last_encode_ms,
                    s.last_audio_ms,
                    s.recent.len(),
                    s.error
                );
            }
            stop.store(true, Ordering::SeqCst);
        });
    }
    let (tx, rx) = mpsc::channel();
    let _ = tx.send(transcript::Event {
        id: "probe-hello".into(),
        session_id: "probe".into(),
        title: "Voice probe".into(),
        project: "GameTracker".into(),
        kind: Kind::Reply,
        text: "Voice probe started. This line was spoken on the PC and sent to the phone.".into(),
        helper: false,
        category: "",
        failed: false,
    });
    let r = run(pool, data_dir, stop, rx);
    let _ = std::fs::remove_file(&db_path);
    r
}
