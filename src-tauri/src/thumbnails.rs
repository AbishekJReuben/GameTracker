//! Disposable, bounded local thumbnails. Originals are never modified.
use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
static WRITES: AtomicUsize = AtomicUsize::new(0);
const MAX_FILES: usize = 512;
const MAX_BYTES: u64 = 128 * 1024 * 1024;

pub async fn get(media: PathBuf, path: PathBuf) -> AppResult<String> {
    // Acquire BEFORE spawning, so a large gallery cannot flood the blocking pool.
    let permit = SLOTS.acquire().await.map_err(|e| AppError::msg(e.to_string()))?;
    let result = tauri::async_runtime::spawn_blocking(move || generate(&media, &path))
        .await
        .map_err(|e| AppError::msg(e.to_string()))?;
    drop(permit);
    result
}

fn generate(media: &Path, path: &Path) -> AppResult<String> {
    use sha2::{Digest, Sha256};
    let media = media.canonicalize()?;
    let source = path.canonicalize()?;
    if !source.starts_with(&media) || !source.is_file() {
        return Err(AppError::msg("Thumbnail source must be a local media file"));
    }
    let meta = source.metadata()?;
    let mut hash = Sha256::new();
    hash.update(source.to_string_lossy().as_bytes());
    hash.update(meta.len().to_le_bytes());
    hash.update(
        meta.modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_le_bytes(),
    );
    let cache = media.join("thumbnails-v1");
    let dest = cache.join(format!("{:x}.jpg", hash.finalize()));
    if dest.is_file() {
        return Ok(dest.to_string_lossy().into_owned());
    }

    let reader = image::ImageReader::open(&source)?.with_guessed_format()?;
    let (w, h) = reader.into_dimensions().map_err(|e| AppError::msg(e.to_string()))?;
    if u64::from(w) * u64::from(h) > 64_000_000 {
        return Err(AppError::msg("Image is too large for a thumbnail"));
    }
    let thumb = image::open(&source)
        .map_err(|e| AppError::msg(e.to_string()))?
        .thumbnail(640, 640)
        .to_rgb8();
    std::fs::create_dir_all(&cache)?;
    let temp = cache.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let write = (|| -> AppResult<()> {
        let mut file = std::fs::File::create(&temp)?;
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 85)
            .encode_image(&thumb)
            .map_err(|e| AppError::msg(e.to_string()))?;
        drop(file);
        match std::fs::rename(&temp, &dest) {
            Ok(()) => Ok(()),
            Err(_) if dest.is_file() => Ok(()), // another request won the cache race
            Err(e) => Err(e.into()),
        }
    })();
    let _ = std::fs::remove_file(&temp);
    write?;
    if WRITES.fetch_add(1, Ordering::Relaxed) % 32 == 0 {
        prune(&cache, &dest);
    }
    Ok(dest.to_string_lossy().into_owned())
}

fn prune(cache: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(cache) else {
        return;
    };
    let mut entries: Vec<_> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("jpg") {
                return None;
            }
            let m = e.metadata().ok()?;
            Some((p, m.len(), m.modified().unwrap_or(std::time::UNIX_EPOCH)))
        })
        .collect();
    entries.sort_by_key(|e| e.2);
    let mut count = entries.len();
    let mut bytes: u64 = entries.iter().map(|e| e.1).sum();
    for (path, len, _) in entries {
        if count <= MAX_FILES && bytes <= MAX_BYTES {
            break;
        }
        if path != keep && std::fs::remove_file(path).is_ok() {
            count -= 1;
            bytes = bytes.saturating_sub(len);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_thumbnail_is_cached_and_original_unchanged() {
        let dir = std::env::temp_dir().join(format!("gt-thumb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("capture.png");
        image::RgbImage::from_pixel(1920, 1080, image::Rgb([40, 90, 150]))
            .save(&source)
            .unwrap();
        let original = std::fs::read(&source).unwrap();
        let first = generate(&dir, &source).unwrap();
        assert_eq!(image::image_dimensions(&first).unwrap(), (640, 360));
        assert_eq!(generate(&dir, &source).unwrap(), first);
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert!(generate(&dir.join("thumbnails-v1"), &source).is_err(), "outside scope");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
