//! The commands behind every Notes screen, registered by both the main app and the
//! notes shell. All async, with the work on a blocking worker: a synchronous command
//! runs on the UI thread, and the UI thread must never wait for a disk, a database
//! lock or another app.

use super::{bus, NotesCtx};
use crate::clipboard;
use crate::commands::run_blocking;
use crate::db::clipboard::{self as store, ClipInput, ClipItem, OutboxOp};
use crate::db::{settings, DbPool};
use crate::error::{AppError, AppResult};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipDeviceInfo {
    device_id: String,
    device_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAddInput {
    pub kind: String,
    pub text: Option<String>,
    /// Base64 (raw or data-URL) image bytes for `kind == "image"`.
    pub image_base64: Option<String>,
    pub mime: Option<String>,
    pub source: Option<String>,
    // These are present only when APPLYING a remote item (so it keeps its identity
    // and isn't re-uploaded). Absent → a fresh local capture.
    pub id: Option<String>,
    pub created_utc: Option<String>,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub pinned: Option<bool>,
    /// Folder/list label for the notes view ("" = unfiled).
    pub folder: Option<String>,
    /// Current multi-tag labels. Missing means a legacy client; its folder is
    /// promoted to one tag.
    pub tags: Option<Vec<String>>,
    /// Copy-history timestamps (present when applying a remote item that carries
    /// a merged dedup history).
    pub copies: Option<Vec<String>>,
}

fn decode_b64(s: &str) -> AppResult<Vec<u8>> {
    let s = s.rsplit_once(',').map(|(_, b)| b).unwrap_or(s);
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| AppError::msg(e.to_string()))
}

/// Normalize image bytes to PNG. Bytes that already are PNG stay as they are: a
/// re-encode cost 371 ms on a 15 MB screenshot and changed nothing.
pub(super) fn to_png(raw: Vec<u8>) -> Vec<u8> {
    const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if raw.starts_with(&PNG_MAGIC) {
        return raw;
    }
    let Ok(img) = image::load_from_memory(&raw) else { return raw };
    let mut png = Vec::new();
    match img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png) {
        Ok(()) => png,
        Err(_) => raw,
    }
}

fn add_blocking(pool: &DbPool, media_dir: &Path, input: ClipAddInput, remote: bool) -> AppResult<ClipItem> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // Millisecond-precision UTC with a literal Z — the ONE timestamp shape every
    // client (JS toISOString, Android SimpleDateFormat) emits and parses.
    let created_utc = input.created_utc.unwrap_or_else(store::wire_now);
    let device_id = input.device_id.unwrap_or_else(|| clipboard::device_id(pool));
    let device_name = input.device_name.or_else(|| Some(clipboard::device_name()));
    let source = input.source.unwrap_or_else(|| {
        if remote {
            "android".into()
        } else {
            "manual".into()
        }
    });

    let (image_path, thumb_path, mime, size, content_hash) = if input.kind == "image" {
        let raw = decode_b64(input.image_base64.as_deref().unwrap_or_default())?;
        let png = to_png(raw);
        let hash = store::content_hash("image", &png);
        let (ip, tp, sz) = clipboard::save_image(media_dir, &id, &png)?;
        (Some(ip), Some(tp), Some("image/png".to_string()), sz, Some(hash))
    } else {
        let size = input.text.as_ref().map(|t| t.len() as i64).unwrap_or(0);
        let hash = store::content_hash("text", input.text.as_deref().unwrap_or_default().as_bytes());
        (None, None, input.mime.clone().or(Some("text/plain".into())), size, Some(hash))
    };

    let legacy_folder = input.folder.unwrap_or_default();
    let tags = input.tags.unwrap_or_else(|| {
        if legacy_folder.trim().is_empty() {
            Vec::new()
        } else {
            vec![legacy_folder.clone()]
        }
    });
    let item = ClipInput {
        id,
        kind: input.kind,
        text: input.text,
        image_path,
        thumb_path,
        mime,
        size,
        created_utc,
        device_id,
        device_name,
        source,
        pinned: input.pinned.unwrap_or(false),
        folder: legacy_folder,
        tags,
        content_hash,
        copies: input.copies.unwrap_or_default(),
        synced: remote, // remote items are already on the relay
    };

    if remote {
        store::upsert(pool, &item)?;
        let saved = store::get(pool, &item.id)?
            .ok_or_else(|| AppError::msg("clip item vanished after insert"))?;
        bus::changed();
        Ok(saved)
    } else {
        clipboard::add_local(pool, item)
    }
}

#[tauri::command]
pub async fn clipboard_device_info(ctx: State<'_, NotesCtx>) -> AppResult<ClipDeviceInfo> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        Ok(ClipDeviceInfo { device_id: clipboard::device_id(&pool), device_name: clipboard::device_name() })
    })
    .await
}

#[tauri::command]
pub async fn clipboard_list(
    ctx: State<'_, NotesCtx>,
    before_utc: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<ClipItem>> {
    let pool = ctx.pool.clone();
    run_blocking(move || store::list(&pool, before_utc.as_deref(), limit.unwrap_or(50))).await
}

#[tauri::command]
pub async fn clipboard_pinned(ctx: State<'_, NotesCtx>) -> AppResult<Vec<ClipItem>> {
    let pool = ctx.pool.clone();
    run_blocking(move || store::list_pinned(&pool)).await
}

/// One note's full text. Lists carry only the first 8 KB.
#[tauri::command]
pub async fn clipboard_text(ctx: State<'_, NotesCtx>, id: String) -> AppResult<Option<String>> {
    let pool = ctx.pool.clone();
    run_blocking(move || store::text_of(&pool, &id)).await
}

/// The newest revision, and every row that changed after `since`. The page reloads
/// instead of merging when `reload` is set.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipChanges {
    rev: i64,
    reload: bool,
    items: Vec<ClipItem>,
}

#[tauri::command]
pub async fn clipboard_changes(ctx: State<'_, NotesCtx>, since: i64) -> AppResult<ClipChanges> {
    const MERGE_LIMIT: i64 = 200;
    let pool = ctx.pool.clone();
    run_blocking(move || {
        let rev = store::current_rev(&pool)?;
        if since >= rev {
            return Ok(ClipChanges { rev, reload: false, items: Vec::new() });
        }
        let items = store::changes_since(&pool, since, MERGE_LIMIT + 1)?;
        let reload = items.len() as i64 > MERGE_LIMIT;
        Ok(ClipChanges { rev, reload, items: if reload { Vec::new() } else { items } })
    })
    .await
}

#[tauri::command]
pub async fn clipboard_search(ctx: State<'_, NotesCtx>, query: String, limit: Option<i64>) -> AppResult<Vec<ClipItem>> {
    let pool = ctx.pool.clone();
    run_blocking(move || store::search(&pool, &query, limit.unwrap_or(200))).await
}

#[tauri::command]
pub async fn clipboard_unsynced(ctx: State<'_, NotesCtx>, limit: Option<i64>) -> AppResult<Vec<ClipItem>> {
    let pool = ctx.pool.clone();
    run_blocking(move || store::list_unsynced(&pool, limit.unwrap_or(100))).await
}

#[tauri::command]
pub async fn clipboard_mark_synced(ctx: State<'_, NotesCtx>, id: String) -> AppResult<()> {
    let pool = ctx.pool.clone();
    run_blocking(move || store::mark_synced(&pool, &id)).await
}

#[tauri::command]
pub async fn clipboard_outbox_list(ctx: State<'_, NotesCtx>, limit: Option<i64>) -> AppResult<Vec<OutboxOp>> {
    let pool = ctx.pool.clone();
    run_blocking(move || store::outbox_list(&pool, limit.unwrap_or(200))).await
}

#[tauri::command]
pub async fn clipboard_outbox_ack(ctx: State<'_, NotesCtx>, seq: i64) -> AppResult<()> {
    let pool = ctx.pool.clone();
    run_blocking(move || store::outbox_ack(&pool, seq)).await
}

/// Add an item. When `remote` is true the input carries an existing identity and
/// is applied WITHOUT queueing it for upload (it already lives on the relay).
#[tauri::command]
pub async fn clipboard_add(ctx: State<'_, NotesCtx>, input: ClipAddInput, remote: Option<bool>) -> AppResult<ClipItem> {
    let (pool, media_dir) = (ctx.pool.clone(), ctx.media_dir.clone());
    run_blocking(move || add_blocking(&pool, &media_dir, input, remote.unwrap_or(false))).await
}

#[tauri::command]
pub async fn clipboard_delete(ctx: State<'_, NotesCtx>, id: String, propagate: Option<bool>) -> AppResult<()> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        let (img, thumb) = store::tombstone(&pool, &id)?;
        clipboard::remove_files([img, thumb]);
        if propagate.unwrap_or(true) {
            store::outbox_push(&pool, "delete", &id, None)?;
            bus::outbox();
        }
        bus::changed();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn clipboard_set_pinned(
    ctx: State<'_, NotesCtx>,
    id: String,
    pinned: bool,
    propagate: Option<bool>,
) -> AppResult<()> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        store::set_pinned(&pool, &id, pinned)?;
        if propagate.unwrap_or(true) {
            store::outbox_push(&pool, "pin", &id, Some(&pinned.to_string()))?;
            bus::outbox();
        }
        bus::changed();
        Ok(())
    })
    .await
}

/// Edit a text item in place. It goes back in the upload queue under the SAME id:
/// the relay upserts and every other device replaces its copy.
#[tauri::command]
pub async fn clipboard_update_text(ctx: State<'_, NotesCtx>, id: String, text: String) -> AppResult<ClipItem> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        if !store::update_text(&pool, &id, &text, &store::wire_now())? {
            return Err(AppError::msg("item not found or not editable"));
        }
        let saved = store::get(&pool, &id)?.ok_or_else(|| AppError::msg("clip item vanished after edit"))?;
        bus::outbox();
        bus::changed();
        Ok(saved)
    })
    .await
}

/// Move an item to a folder ('' = unfiled). `propagate` queues the bare folder
/// notice for the relay (false when applying a remote move).
#[tauri::command]
pub async fn clipboard_set_folder(
    ctx: State<'_, NotesCtx>,
    id: String,
    folder: String,
    propagate: Option<bool>,
) -> AppResult<()> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        store::set_folder(&pool, &id, &folder)?;
        if propagate.unwrap_or(true) {
            store::outbox_push(&pool, "folder", &id, Some(&folder))?;
            bus::outbox();
        }
        bus::changed();
        Ok(())
    })
    .await
}

/// Distinct folder names across live items (for the filter chips).
#[tauri::command]
pub async fn clipboard_folders(ctx: State<'_, NotesCtx>) -> AppResult<Vec<String>> {
    let pool = ctx.pool.clone();
    run_blocking(move || store::list_folders(&pool)).await
}

#[tauri::command]
pub async fn clipboard_tags(ctx: State<'_, NotesCtx>) -> AppResult<Vec<String>> {
    let pool = ctx.pool.clone();
    run_blocking(move || store::list_tags(&pool)).await
}

#[tauri::command]
pub async fn clipboard_set_tags(
    ctx: State<'_, NotesCtx>,
    id: String,
    tags: Vec<String>,
    propagate: Option<bool>,
) -> AppResult<Vec<String>> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        let tags = store::set_tags(&pool, &id, tags)?;
        if propagate.unwrap_or(true) {
            let json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
            store::outbox_push(&pool, "tags", &id, Some(&json))?;
            bus::outbox();
        }
        bus::changed();
        Ok(tags)
    })
    .await
}

/// Create an (empty) folder that syncs to every device: a kind='folder' row, unsynced
/// so the sync engine uploads it.
#[tauri::command]
pub async fn clipboard_create_folder(ctx: State<'_, NotesCtx>, name: String) -> AppResult<()> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        let name = name.trim();
        if name.is_empty() {
            return Ok(());
        }
        let device_id = clipboard::device_id(&pool);
        let device_name = clipboard::device_name();
        store::create_folder(&pool, name, &device_id, Some(&device_name), &store::wire_now())?;
        bus::outbox();
        bus::changed();
        Ok(())
    })
    .await
}

/// Delete a folder everywhere: tombstone the folder entity AND unfile its notes
/// (they move to "unfiled", not deleted). Both propagate over the relay.
#[tauri::command]
pub async fn clipboard_delete_folder(ctx: State<'_, NotesCtx>, name: String) -> AppResult<()> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        for id in store::ids_in_folder(&pool, &name)? {
            store::set_folder(&pool, &id, "")?;
            store::outbox_push(&pool, "folder", &id, Some(""))?;
        }
        for id in store::tombstone_folder(&pool, &name)? {
            store::outbox_push(&pool, "delete", &id, None)?;
        }
        bus::outbox();
        bus::changed();
        Ok(())
    })
    .await
}

/// One-time retroactive dedup: merge pre-existing duplicate notes (same content) into
/// one. Survivors stay unsynced so the backlog re-uploads their merged history; the
/// tombstoned losers go in the outbox.
#[tauri::command]
pub async fn clipboard_dedupe(ctx: State<'_, NotesCtx>) -> AppResult<()> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        let (survivors, losers) = store::dedupe_existing(&pool)?;
        for id in &losers {
            store::outbox_push(&pool, "delete", id, None)?;
        }
        if !survivors.is_empty() || !losers.is_empty() {
            bus::outbox();
            bus::changed();
        }
        Ok(())
    })
    .await
}

/// Apply a remote folder entity (kind='folder' notice) into the local store.
/// Called by the JS sync engine; never queues anything for upload.
#[tauri::command]
pub async fn clipboard_apply_folder(
    ctx: State<'_, NotesCtx>,
    id: String,
    name: String,
    created_utc: Option<String>,
    device_id: Option<String>,
    device_name: Option<String>,
    deleted: Option<bool>,
) -> AppResult<()> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        let created = created_utc.unwrap_or_else(store::wire_now);
        store::apply_folder_entity(
            &pool,
            &id,
            &name,
            &created,
            device_id.as_deref(),
            device_name.as_deref(),
            deleted.unwrap_or(false),
        )?;
        bus::changed();
        Ok(())
    })
    .await
}

/// Put a note on the OS clipboard. Never on the UI thread: `EmptyClipboard` waits for
/// the app that owns the clipboard. If that takes a moment, the page is told who it
/// is waiting for, and the promise still resolves when the write lands.
#[tauri::command]
pub async fn clipboard_copy(app: AppHandle, ctx: State<'_, NotesCtx>, id: String) -> AppResult<()> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        let Some(item) = store::get(&pool, &id)? else { return Ok(()) };
        copy_item(&app, &item)
    })
    .await
}

#[cfg(windows)]
fn copy_item(app: &AppHandle, item: &ClipItem) -> AppResult<()> {
    use super::os_clipboard::{dib_from_rgba, owner_app, submit, Payload};
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::Duration;
    let payload = if item.kind == "image" {
        let image = item
            .image_path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| image::load_from_memory(&bytes).ok());
        match image {
            Some(img) => Payload::Dib(dib_from_rgba(&img.to_rgba8())),
            None => return Err(AppError::msg("That image's file is missing.")),
        }
    } else {
        Payload::Text(item.text.clone().unwrap_or_default())
    };
    let waiting_for = owner_app();
    let done = submit(payload)?;
    match done.recv_timeout(Duration::from_millis(350)) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => {
            let _ = app.emit("clipboard://copy-wait", waiting_for);
            done.recv().map_err(|_| AppError::msg("clipboard thread stopped"))?
        }
        Err(RecvTimeoutError::Disconnected) => Err(AppError::msg("clipboard thread stopped")),
    }
}

#[cfg(not(windows))]
fn copy_item(_app: &AppHandle, _item: &ClipItem) -> AppResult<()> {
    Ok(())
}

/// Base64 of a stored image's bytes, for the JS sync client to encrypt + upload.
#[tauri::command]
pub async fn clipboard_image_b64(ctx: State<'_, NotesCtx>, id: String) -> AppResult<Option<String>> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        let Some(item) = store::get(&pool, &id)? else { return Ok(None) };
        let Some(path) = item.image_path else { return Ok(None) };
        Ok(std::fs::read(path).ok().map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)))
    })
    .await
}

#[tauri::command]
pub async fn clipboard_clear_all(ctx: State<'_, NotesCtx>) -> AppResult<()> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        let files = store::clear_all(&pool)?;
        clipboard::remove_files(files.into_iter().map(Some));
        bus::outbox();
        bus::changed();
        Ok(())
    })
    .await
}

/// Write the three clipboard toggles and reconcile the watcher + floating widget.
///
/// Building a window has to run on the main thread and pumps it while WebView2
/// starts, so it's queued there instead of running under this command.
#[tauri::command]
pub async fn clipboard_configure(
    ctx: State<'_, NotesCtx>,
    app: AppHandle,
    enabled: bool,
    overlay: bool,
    auto_capture: bool,
) -> AppResult<()> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        settings::set(&pool, "clipboard_enabled", if enabled { "true" } else { "false" })?;
        settings::set(&pool, "clipboard_overlay_enabled", if overlay { "true" } else { "false" })?;
        settings::set(&pool, "clipboard_auto_capture", if auto_capture { "true" } else { "false" })?;
        clipboard::log(format!(
            "clipboard_configure: toggles written (enabled={enabled}, overlay={overlay}, auto={auto_capture}); deferring apply_settings to main thread"
        ));
        Ok(())
    })
    .await?;
    clipboard::apply_settings_deferred(app);
    Ok(())
}

/// Snapshot of the clipboard runtime log for the Settings "Copy logs" button.
#[tauri::command]
pub async fn clipboard_diagnostics() -> AppResult<Vec<String>> {
    Ok(clipboard::diagnostics())
}

/// Keep the floating Notes process up to date on sync. It reads this from a file, so
/// it needs nothing from this process to stay alive.
#[tauri::command]
pub async fn clipboard_publish_status(ctx: State<'_, NotesCtx>, mut status: serde_json::Value) -> AppResult<()> {
    let path = ctx.data_dir.join("notes-status.json");
    run_blocking(move || {
        if let Some(o) = status.as_object_mut() {
            o.insert("updatedMs".into(), chrono::Utc::now().timestamp_millis().into());
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, status.to_string())?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn clipboard_overlay_set_pos(ctx: State<'_, NotesCtx>, x: f64, y: f64) -> AppResult<()> {
    let pool = ctx.pool.clone();
    run_blocking(move || settings::set(&pool, "clipboard_overlay_pos", &format!("{},{}", x.round(), y.round()))).await
}

/// Resolve the Sarvam key: a user-supplied one in settings wins (so voice-to-text
/// works on installs that shipped without a baked key, and can be rotated without a
/// rebuild), falling back to the `.env`/compile-time key.
fn sarvam_key(pool: &DbPool) -> Option<String> {
    settings::get(pool, "clipboard_sarvam_key")
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("SARVAM_API_KEY").ok())
        .or_else(|| option_env!("SARVAM_API_KEY").map(str::to_string))
        .filter(|s| !s.trim().is_empty())
}

/// Transcribe short (≤30s) audio via Sarvam's speech-to-text REST API. The key comes
/// from settings (`clipboard_sarvam_key`) if set, else the `.env`/baked key.
#[tauri::command]
pub async fn speech_to_text(
    ctx: State<'_, NotesCtx>,
    audio_base64: String,
    mime: Option<String>,
    language: Option<String>,
) -> AppResult<String> {
    let pool = ctx.pool.clone();
    run_blocking(move || {
        let key = sarvam_key(&pool).ok_or_else(|| AppError::msg("Sarvam API key not configured"))?;
        let language = language.or_else(|| {
            settings::get(&pool, "clipboard_stt_language")
                .ok()
                .flatten()
                .filter(|s| !s.trim().is_empty())
        });
        let bytes = decode_b64(&audio_base64)?;
        let mime = mime.unwrap_or_else(|| "audio/wav".into());
        let boundary = format!("----gtclip{}", uuid::Uuid::new_v4().simple());

        let mut body: Vec<u8> = Vec::new();
        let field = |name: &str, value: &str, body: &mut Vec<u8>| {
            body.extend_from_slice(
                format!(
                    "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
                )
                .as_bytes(),
            );
        };
        field("model", "saaras:v3", &mut body);
        field("mode", "transcribe", &mut body);
        if let Some(lang) = language.as_deref() {
            field("language_code", lang, &mut body);
        }
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio\"\r\nContent-Type: {mime}\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(&bytes);
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

        // Sarvam intermittently 5xxs / stalls; a bounded timeout + one retry turns
        // "mic silently does nothing" into a reliable transcribe (or a real error).
        let send = || {
            ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .post("https://api.sarvam.ai/speech-to-text")
                .set("api-subscription-key", &key)
                .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
                .send_bytes(&body)
        };
        let resp = match send() {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) if (500..600).contains(&code) => {
                std::thread::sleep(std::time::Duration::from_millis(600));
                send().map_err(|e| AppError::msg(format!("Sarvam request failed: {e}"))).or_else(|first| {
                    // Surface the original server body if the retry also failed.
                    let body = r.into_string().unwrap_or_default();
                    Err(AppError::msg(format!(
                        "{first} (server said: {})",
                        body.chars().take(200).collect::<String>()
                    )))
                })?
            }
            Err(ureq::Error::Transport(_)) => {
                std::thread::sleep(std::time::Duration::from_millis(600));
                send().map_err(|e| AppError::msg(format!("Sarvam request failed: {e}")))?
            }
            Err(e) => return Err(AppError::msg(format!("Sarvam request failed: {e}"))),
        };
        let json: serde_json::Value = resp.into_json().map_err(|e| AppError::msg(e.to_string()))?;
        Ok(json.get("transcript").and_then(|v| v.as_str()).unwrap_or("").to_string())
    })
    .await
}
