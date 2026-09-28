//! Local text-to-speech: Kokoro through the sherpa-onnx C API, in a worker process.
//!
//! The worker is this same executable started with `--tts-worker`. Keeping the
//! model out of the tracker's process means a crash in the native runtime can't
//! take the app down, and the ~400 MB it holds is released when the worker is
//! stopped. The DLLs (`sherpa-onnx-c-api.dll` + `onnxruntime.dll`) and the model
//! are downloaded on first enable (see `install.rs`), never linked at build time.
//!
//! Protocol over the worker's stdin/stdout:
//!   worker → `{"ready":true,"rate":24000,"speakers":53}\n` once loaded
//!   host   → `{"id":1,"text":"…","sid":3,"speed":1.0}\n`
//!   worker → `{"id":1,"ok":true,"samples":N,"rate":24000}\n` + N × i16 LE
//!         or `{"id":1,"ok":false,"error":"…"}\n`

use std::ffi::{c_char, CString};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

// ---- C API (sherpa-onnx v1.13.8, include/sherpa-onnx/c-api/c-api.h) ---------
// Field order is the header's; sizes are asserted below for x86_64. The version
// is pinned by install.rs, so the layout can't drift under us.

type Cstr = *const c_char;

#[repr(C)]
struct VitsCfg { model: Cstr, lexicon: Cstr, tokens: Cstr, data_dir: Cstr, noise_scale: f32, noise_scale_w: f32, length_scale: f32, dict_dir: Cstr }
#[repr(C)]
struct MatchaCfg { acoustic_model: Cstr, vocoder: Cstr, lexicon: Cstr, tokens: Cstr, data_dir: Cstr, noise_scale: f32, length_scale: f32, dict_dir: Cstr }
#[repr(C)]
struct KokoroCfg { model: Cstr, voices: Cstr, tokens: Cstr, data_dir: Cstr, length_scale: f32, dict_dir: Cstr, lexicon: Cstr, lang: Cstr }
#[repr(C)]
struct KittenCfg { model: Cstr, voices: Cstr, tokens: Cstr, data_dir: Cstr, length_scale: f32 }
#[repr(C)]
struct ZipvoiceCfg { tokens: Cstr, encoder: Cstr, decoder: Cstr, vocoder: Cstr, data_dir: Cstr, lexicon: Cstr, feat_scale: f32, t_shift: f32, target_rms: f32, guidance_scale: f32 }
#[repr(C)]
struct PocketCfg { lm_flow: Cstr, lm_main: Cstr, encoder: Cstr, decoder: Cstr, text_conditioner: Cstr, vocab_json: Cstr, token_scores_json: Cstr, voice_embedding_cache_capacity: i32 }
#[repr(C)]
struct SupertonicCfg { duration_predictor: Cstr, text_encoder: Cstr, vector_estimator: Cstr, vocoder: Cstr, tts_json: Cstr, unicode_indexer: Cstr, voice_style: Cstr }
#[repr(C)]
struct ModelCfg { vits: VitsCfg, num_threads: i32, debug: i32, provider: Cstr, matcha: MatchaCfg, kokoro: KokoroCfg, kitten: KittenCfg, zipvoice: ZipvoiceCfg, pocket: PocketCfg, supertonic: SupertonicCfg }
#[repr(C)]
struct TtsCfg { model: ModelCfg, rule_fsts: Cstr, max_num_sentences: i32, rule_fars: Cstr, silence_scale: f32 }
#[repr(C)]
struct GeneratedAudio { samples: *const f32, n: i32, sample_rate: i32 }

#[cfg(target_pointer_width = "64")]
const _: () = {
    assert!(std::mem::size_of::<VitsCfg>() == 56);
    assert!(std::mem::size_of::<MatchaCfg>() == 56);
    assert!(std::mem::size_of::<KokoroCfg>() == 64);
    assert!(std::mem::size_of::<KittenCfg>() == 40);
    assert!(std::mem::size_of::<ZipvoiceCfg>() == 64);
    assert!(std::mem::size_of::<PocketCfg>() == 64);
    assert!(std::mem::size_of::<SupertonicCfg>() == 56);
    assert!(std::mem::size_of::<ModelCfg>() == 416);
    assert!(std::mem::size_of::<TtsCfg>() == 448);
    assert!(std::mem::size_of::<GeneratedAudio>() == 16);
};

type FnCreate = unsafe extern "C" fn(*const TtsCfg) -> *const std::ffi::c_void;
type FnDestroy = unsafe extern "C" fn(*const std::ffi::c_void);
type FnRate = unsafe extern "C" fn(*const std::ffi::c_void) -> i32;
type FnSpeakers = unsafe extern "C" fn(*const std::ffi::c_void) -> i32;
type FnGenerate = unsafe extern "C" fn(*const std::ffi::c_void, Cstr, i32, f32) -> *const GeneratedAudio;
type FnFreeAudio = unsafe extern "C" fn(*const GeneratedAudio);

/// A loaded Kokoro model. Only ever lives inside the worker process.
pub struct Tts {
    _ort: libloading::Library,
    _api: libloading::Library,
    tts: *const std::ffi::c_void,
    destroy: FnDestroy,
    generate: FnGenerate,
    free_audio: FnFreeAudio,
    pub rate: u32,
    pub speakers: u32,
    // Strings the C side may keep pointers to for the model's lifetime.
    _keep: Vec<CString>,
}

impl Tts {
    pub fn load(engine_dir: &Path, model_dir: &Path, threads: i32) -> Result<Self, String> {
        let lib = |name: &str| -> Result<libloading::Library, String> {
            let path = engine_dir.join(name);
            #[cfg(windows)]
            {
                // Search the DLL's own folder for its dependencies: Windows ships an
                // older onnxruntime.dll in System32 that must not be picked up.
                const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 0x0000_0008;
                unsafe { libloading::os::windows::Library::load_with_flags(&path, LOAD_WITH_ALTERED_SEARCH_PATH) }
                    .map(Into::into)
                    .map_err(|e| format!("load {}: {e}", path.display()))
            }
            #[cfg(not(windows))]
            unsafe { libloading::Library::new(&path) }.map_err(|e| format!("load {}: {e}", path.display()))
        };
        let ort = lib(if cfg!(windows) { "onnxruntime.dll" } else { "libonnxruntime.so" })?;
        let api = lib(if cfg!(windows) { "sherpa-onnx-c-api.dll" } else { "libsherpa-onnx-c-api.so" })?;
        unsafe {
            let create: FnCreate = *api.get(b"SherpaOnnxCreateOfflineTts\0").map_err(|e| e.to_string())?;
            let destroy: FnDestroy = *api.get(b"SherpaOnnxDestroyOfflineTts\0").map_err(|e| e.to_string())?;
            let rate: FnRate = *api.get(b"SherpaOnnxOfflineTtsSampleRate\0").map_err(|e| e.to_string())?;
            let speakers: FnSpeakers = *api.get(b"SherpaOnnxOfflineTtsNumSpeakers\0").map_err(|e| e.to_string())?;
            let generate: FnGenerate = *api.get(b"SherpaOnnxOfflineTtsGenerate\0").map_err(|e| e.to_string())?;
            let free_audio: FnFreeAudio =
                *api.get(b"SherpaOnnxDestroyOfflineTtsGeneratedAudio\0").map_err(|e| e.to_string())?;

            let mut keep = Vec::new();
            let mut c = |s: String| -> Cstr {
                let cs = CString::new(s).unwrap_or_default();
                let p = cs.as_ptr();
                keep.push(cs);
                p
            };
            let m = |f: &str| model_dir.join(f).to_string_lossy().into_owned();
            let empty = c(String::new());
            let model_file = if model_dir.join("model.onnx").exists() { "model.onnx" } else { "model.int8.onnx" };
            let lexicon = format!("{},{}", m("lexicon-us-en.txt"), m("lexicon-zh.txt"));
            let cfg = TtsCfg {
                model: ModelCfg {
                    vits: VitsCfg { model: empty, lexicon: empty, tokens: empty, data_dir: empty, noise_scale: 0.667, noise_scale_w: 0.8, length_scale: 1.0, dict_dir: empty },
                    num_threads: threads,
                    debug: 0,
                    provider: c("cpu".into()),
                    matcha: MatchaCfg { acoustic_model: empty, vocoder: empty, lexicon: empty, tokens: empty, data_dir: empty, noise_scale: 1.0, length_scale: 1.0, dict_dir: empty },
                    kokoro: KokoroCfg {
                        model: c(m(model_file)),
                        voices: c(m("voices.bin")),
                        tokens: c(m("tokens.txt")),
                        data_dir: c(m("espeak-ng-data")),
                        length_scale: 1.0,
                        dict_dir: empty,
                        lexicon: c(lexicon),
                        lang: empty,
                    },
                    kitten: KittenCfg { model: empty, voices: empty, tokens: empty, data_dir: empty, length_scale: 1.0 },
                    zipvoice: ZipvoiceCfg { tokens: empty, encoder: empty, decoder: empty, vocoder: empty, data_dir: empty, lexicon: empty, feat_scale: 0.1, t_shift: 0.5, target_rms: 0.1, guidance_scale: 1.0 },
                    pocket: PocketCfg { lm_flow: empty, lm_main: empty, encoder: empty, decoder: empty, text_conditioner: empty, vocab_json: empty, token_scores_json: empty, voice_embedding_cache_capacity: 0 },
                    supertonic: SupertonicCfg { duration_predictor: empty, text_encoder: empty, vector_estimator: empty, vocoder: empty, tts_json: empty, unicode_indexer: empty, voice_style: empty },
                },
                rule_fsts: empty,
                max_num_sentences: 1,
                rule_fars: empty,
                silence_scale: 0.2,
            };
            let tts = create(&cfg);
            if tts.is_null() {
                return Err("the voice model failed to load".into());
            }
            Ok(Self {
                rate: rate(tts).max(1) as u32,
                speakers: speakers(tts).max(0) as u32,
                _ort: ort,
                _api: api,
                tts,
                destroy,
                generate,
                free_audio,
                _keep: keep,
            })
        }
    }

    /// Synthesize; returns 16-bit PCM at `self.rate`.
    pub fn speak(&self, text: &str, sid: i32, speed: f32) -> Result<Vec<i16>, String> {
        let t = CString::new(text.replace('\0', " ")).map_err(|e| e.to_string())?;
        unsafe {
            let audio = (self.generate)(self.tts, t.as_ptr(), sid, speed);
            if audio.is_null() {
                return Err("synthesis failed".into());
            }
            let a = &*audio;
            let pcm = if a.samples.is_null() || a.n <= 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(a.samples, a.n as usize)
                    .iter()
                    .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
                    .collect()
            };
            (self.free_audio)(audio);
            Ok(pcm)
        }
    }
}

impl Drop for Tts {
    fn drop(&mut self) {
        unsafe { (self.destroy)(self.tts) };
    }
}

// ---- worker side ---------------------------------------------------------

/// If this process was started as the TTS worker, run it and return the exit
/// code. Called first thing in `run()`, before Tauri or single-instance.
pub fn maybe_run_worker() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--tts-worker") {
        return None;
    }
    let engine = PathBuf::from(args.get(2).cloned().unwrap_or_default());
    let model = PathBuf::from(args.get(3).cloned().unwrap_or_default());
    let threads = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(4);
    Some(worker_main(&engine, &model, threads))
}

fn worker_main(engine: &Path, model: &Path, threads: i32) -> i32 {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let tts = match Tts::load(engine, model, threads) {
        Ok(t) => t,
        Err(e) => {
            let _ = writeln!(out, "{}", serde_json::json!({ "ready": false, "error": e }));
            return 2;
        }
    };
    let _ = writeln!(out, "{}", serde_json::json!({ "ready": true, "rate": tts.rate, "speakers": tts.speakers }));
    let _ = out.flush();
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let id = req.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
        let text = req.get("text").and_then(|v| v.as_str()).unwrap_or("");
        let sid = req.get("sid").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let speed = req.get("speed").and_then(|v| v.as_f64()).unwrap_or(1.0) as f32;
        match tts.speak(text, sid, speed) {
            Ok(pcm) => {
                let _ = writeln!(out, "{}", serde_json::json!({ "id": id, "ok": true, "samples": pcm.len(), "rate": tts.rate }));
                let mut bytes = Vec::with_capacity(pcm.len() * 2);
                for s in pcm {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                let _ = out.write_all(&bytes);
            }
            Err(e) => {
                let _ = writeln!(out, "{}", serde_json::json!({ "id": id, "ok": false, "error": e }));
            }
        }
        if out.flush().is_err() {
            break;
        }
    }
    0
}

// ---- host side -----------------------------------------------------------

/// A running worker. Dropping it ends the process.
pub struct Engine {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    pub rate: u32,
}

impl Engine {
    /// Start `exe --tts-worker <engine> <model> <threads>` and wait for it to load.
    pub fn start(exe: &Path, engine_dir: &Path, model_dir: &Path, threads: u32) -> Result<Self, String> {
        let mut cmd = Command::new(exe);
        cmd.arg("--tts-worker")
            .arg(engine_dir)
            .arg(model_dir)
            .arg(threads.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
            // Below normal: narration must never steal time from a game or a stream.
            cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
        }
        let mut child = cmd.spawn().map_err(|e| format!("start voice worker: {e}"))?;
        let stdin = child.stdin.take().ok_or("worker stdin")?;
        let mut stdout = BufReader::new(child.stdout.take().ok_or("worker stdout")?);
        let mut line = String::new();
        stdout.read_line(&mut line).map_err(|e| e.to_string())?;
        let v: serde_json::Value = serde_json::from_str(line.trim()).map_err(|_| format!("voice worker said: {}", line.trim()))?;
        if v.get("ready").and_then(|r| r.as_bool()) != Some(true) {
            let _ = child.kill();
            return Err(v.get("error").and_then(|e| e.as_str()).unwrap_or("voice worker failed").to_string());
        }
        let rate = v.get("rate").and_then(|r| r.as_u64()).unwrap_or(24_000) as u32;
        Ok(Self { child, stdin, stdout, next_id: 1, rate })
    }

    pub fn speak(&mut self, text: &str, sid: u32, speed: f32) -> Result<Vec<i16>, String> {
        let id = self.next_id;
        self.next_id += 1;
        let req = serde_json::json!({ "id": id, "text": text, "sid": sid, "speed": speed });
        writeln!(self.stdin, "{req}").map_err(|e| format!("voice worker gone: {e}"))?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        if self.stdout.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("voice worker exited".into());
        }
        let v: serde_json::Value = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
        if v.get("ok").and_then(|o| o.as_bool()) != Some(true) {
            return Err(v.get("error").and_then(|e| e.as_str()).unwrap_or("synthesis failed").to_string());
        }
        let n = v.get("samples").and_then(|s| s.as_u64()).unwrap_or(0) as usize;
        let mut bytes = vec![0u8; n * 2];
        self.stdout.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        Ok(bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect())
    }

    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 16-bit mono PCM → MP3. 32 kb/s is clear for one voice at 24 kHz and costs the
/// phone ~240 KB per spoken minute.
pub fn encode_mp3(pcm: &[i16], rate: u32) -> Result<Vec<u8>, String> {
    use mp3lame_encoder::{Bitrate, Builder, FlushNoGap, MonoPcm, Quality};
    let mut enc = Builder::new()
        .ok_or("mp3 encoder")?
        .with_num_channels(1)
        .map_err(|e| format!("{e:?}"))?
        .with_sample_rate(rate)
        .map_err(|e| format!("{e:?}"))?
        .with_brate(Bitrate::Kbps32)
        .map_err(|e| format!("{e:?}"))?
        .with_quality(Quality::Good)
        .map_err(|e| format!("{e:?}"))?
        .build()
        .map_err(|e| format!("{e:?}"))?;
    let mut out = Vec::new();
    out.reserve(mp3lame_encoder::max_required_buffer_size(pcm.len()) + 7200);
    enc.encode_to_vec(MonoPcm(pcm), &mut out).map_err(|e| format!("{e:?}"))?;
    enc.flush_to_vec::<FlushNoGap>(&mut out).map_err(|e| format!("{e:?}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mp3_of_a_tone_is_a_valid_stream() {
        let pcm: Vec<i16> = (0..24_000).map(|i| ((i as f32 * 0.05).sin() * 8000.0) as i16).collect();
        let mp3 = encode_mp3(&pcm, 24_000).unwrap();
        // Frame sync: 11 set bits.
        assert!(mp3.windows(2).any(|w| w[0] == 0xFF && w[1] & 0xE0 == 0xE0));
        // ~1 s at 32 kb/s ≈ 4 KB.
        assert!((2_500..7_000).contains(&mp3.len()), "{}", mp3.len());
    }

    /// Real model, real DLLs: `GT_TTS_ENGINE=… GT_TTS_MODEL=… cargo test -- --ignored kokoro`.
    #[test]
    #[ignore]
    fn kokoro_speaks_through_the_c_api() {
        let engine = std::env::var("GT_TTS_ENGINE").expect("GT_TTS_ENGINE");
        let model = std::env::var("GT_TTS_MODEL").expect("GT_TTS_MODEL");
        let tts = Tts::load(Path::new(&engine), Path::new(&model), 4).unwrap();
        assert_eq!(tts.rate, 24_000);
        assert!(tts.speakers >= 50, "{}", tts.speakers);
        let t = std::time::Instant::now();
        let pcm = tts.speak("The release build has started.", 3, 1.0).unwrap();
        let secs = pcm.len() as f64 / tts.rate as f64;
        eprintln!("{secs:.2}s of audio in {:?}", t.elapsed());
        assert!((1.0..5.0).contains(&secs));
        let peak = pcm.iter().map(|s| s.unsigned_abs()).max().unwrap();
        assert!(peak > 3000, "audible: {peak}");
    }
}
