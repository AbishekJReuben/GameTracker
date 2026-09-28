//! Getting the voice onto this PC: the sherpa-onnx runtime DLLs and the Kokoro
//! model, from the project's official GitHub releases, pinned by version and
//! SHA-256. Downloaded when Voice is first turned on, never bundled (the model
//! alone is 350 MB and most users never enable it).

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const ENGINE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MD-Release.tar.bz2";
const ENGINE_SHA256: &str = "3e971a04b2e0ba4dfa53d381a006367ce8c9f5f09b4ae00043e9845c2baded22";
const ENGINE_BYTES: u64 = 20_494_724;
/// Only these are needed from the runtime archive (it also carries dozens of tools).
const ENGINE_FILES: &[&str] = &["onnxruntime.dll", "onnxruntime_providers_shared.dll", "sherpa-onnx-c-api.dll"];

const MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2";
const MODEL_SHA256: &str = "c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298";
const MODEL_BYTES: u64 = 349_906_910;

pub struct Paths {
    pub engine: PathBuf,
    pub model: PathBuf,
}

pub fn paths(data_dir: &Path) -> Paths {
    let root = data_dir.join("voice");
    Paths { engine: root.join("engine-1.13.8"), model: root.join("kokoro-multi-lang-v1_0") }
}

pub fn installed(data_dir: &Path) -> bool {
    let p = paths(data_dir);
    ENGINE_FILES.iter().all(|f| p.engine.join(f).exists())
        && p.model.join("model.onnx").exists()
        && p.model.join("voices.bin").exists()
        && p.model.join(".complete").exists()
}

/// Download + verify + unpack both archives. `progress(fraction, label)` is
/// called as bytes arrive. Safe to re-run: finished parts are kept.
pub fn install(data_dir: &Path, cancel: &AtomicBool, progress: &dyn Fn(f32, &str)) -> Result<(), String> {
    let p = paths(data_dir);
    let root = data_dir.join("voice");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let total = (ENGINE_BYTES + MODEL_BYTES) as f32;

    if !ENGINE_FILES.iter().all(|f| p.engine.join(f).exists()) {
        let tmp = root.join("engine.tar.bz2.part");
        download(ENGINE_URL, &tmp, ENGINE_SHA256, cancel, &|done| {
            progress(done as f32 / total, "Downloading the voice engine")
        })?;
        progress(ENGINE_BYTES as f32 / total, "Unpacking the voice engine");
        let staging = root.join("engine.staging");
        let _ = std::fs::remove_dir_all(&staging);
        unpack(&tmp, &staging, |name| {
            let file = name.rsplit('/').next().unwrap_or(name);
            (name.contains("/lib/") && ENGINE_FILES.contains(&file)).then(|| file.to_string())
        })?;
        let _ = std::fs::remove_dir_all(&p.engine);
        std::fs::rename(&staging, &p.engine).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp);
    }

    if !p.model.join(".complete").exists() {
        let tmp = root.join("model.tar.bz2.part");
        download(MODEL_URL, &tmp, MODEL_SHA256, cancel, &|done| {
            progress((ENGINE_BYTES + done) as f32 / total, "Downloading the Kokoro voices")
        })?;
        progress(0.99, "Unpacking the Kokoro voices");
        let staging = root.join("model.staging");
        let _ = std::fs::remove_dir_all(&staging);
        unpack(&tmp, &staging, |name| {
            // "kokoro-multi-lang-v1_0/…" → the path inside the model folder. The
            // Chinese word-segmentation dictionary isn't used for English.
            let inner = name.split_once('/').map(|(_, r)| r).unwrap_or("");
            (!inner.is_empty() && !inner.starts_with("dict/")).then(|| inner.to_string())
        })?;
        std::fs::write(staging.join(".complete"), b"1").map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&p.model);
        std::fs::rename(&staging, &p.model).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp);
    }
    progress(1.0, "Ready");
    Ok(())
}

fn download(url: &str, dest: &Path, sha256: &str, cancel: &AtomicBool, progress: &dyn Fn(u64)) -> Result<(), String> {
    // A complete, verified file from an earlier interrupted install is reused.
    if dest.exists() && file_sha256(dest).as_deref() == Some(sha256) {
        return Ok(());
    }
    let resp = ureq::get(url)
        .set("Accept-Encoding", "identity")
        .timeout(std::time::Duration::from_secs(60 * 30))
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    let mut last = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if last.elapsed().as_millis() > 250 {
            last = std::time::Instant::now();
            progress(done);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got != sha256 {
        let _ = std::fs::remove_file(dest);
        return Err("the download didn't match its checksum; try again".into());
    }
    Ok(())
}

fn file_sha256(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Unpack a .tar.bz2, keeping entries `pick` maps to a relative destination path.
fn unpack(archive: &Path, dest: &Path, pick: impl Fn(&str) -> Option<String>) -> Result<(), String> {
    let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let bz = bzip2::read::BzDecoder::new(std::io::BufReader::new(f));
    let mut tar = tar::Archive::new(bz);
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in tar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let name = entry.path().map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
        let Some(rel) = pick(&name) else { continue };
        // No absolute paths or parent hops out of the destination.
        if rel.split('/').any(|c| c == ".." || c.is_empty()) || rel.contains(':') {
            continue;
        }
        let out = dest.join(&rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
    }
    Ok(())
}
