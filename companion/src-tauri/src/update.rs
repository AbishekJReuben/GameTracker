//! In-app updater for the Android companion.
//!
//! Tauri's `updater` plugin does not support Android, so this is a small custom
//! mechanism: the webview checks GitHub for a newer version (see
//! `src/companion/update.ts`) and, when the user taps "Update", calls
//! [`download_and_install_apk`]. That downloads the release APK into the app
//! cache dir and hands it to Android's system package installer (which shows the
//! usual one-tap install confirmation — stock Android never allows a fully
//! silent sideload install).

use std::io::Read;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// The `content://` URI of the APK last copied into the public Downloads folder
/// (see [`save_apk_to_downloads`]). Remembered so [`open_downloaded_apk`] can hand
/// exactly that file to the system installer as a fallback workaround.
static LAST_DOWNLOADS_URI: Mutex<Option<String>> = Mutex::new(None);

/// The companion's applicationId (identifier in `companion/src-tauri/tauri.conf.json`).
/// Used to build the FileProvider authority and the explicit receiver class name.
#[cfg(target_os = "android")]
const PACKAGE_NAME: &str = "com.chilloutgames.gametracker.companion";

/// FileProvider authority — must match `${applicationId}.fileprovider` declared
/// in the generated AndroidManifest (identifier from tauri.conf.json).
#[cfg(target_os = "android")]
const FILE_PROVIDER_AUTHORITY: &str = "com.chilloutgames.gametracker.companion.fileprovider";

/// Download the APK at `url` into the app cache dir, then launch the Android
/// package installer for it. Progress is emitted on `apk-update://progress`
/// (`{ phase, received, total }`) so the UI can show a bar.
#[tauri::command]
pub async fn download_and_install_apk(app: AppHandle, url: String) -> Result<(), String> {
    // Resolve the cache dir on the calling thread (AppHandle::path needs the
    // handle), then do the blocking download + install off the main thread.
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache dir: {e}"))?;

    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_update(&app2, &url, &cache_dir))
        .await
        .map_err(|e| format!("update task panicked: {e}"))?
}

/// Workaround for when the in-place install won't go through (the system
/// confirmation dialog never appears, or a "package appears invalid" error):
/// download the APK (reusing the cached copy if present) and copy it into the
/// user-visible **Downloads** folder. Returns the display path (e.g.
/// `Download/GameTrackerRemote-3.9.5.apk`) so the UI can tell the user exactly
/// where it landed, and remembers its content URI for [`open_downloaded_apk`].
///
/// `version` is optional and only used for the Downloads filename; when omitted
/// we derive a name from the URL's last path segment.
#[tauri::command]
pub async fn save_apk_to_downloads(
    app: AppHandle,
    url: String,
    version: Option<String>,
) -> Result<String, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache dir: {e}"))?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let apk_path = ensure_downloaded(&app2, &url, &cache_dir)?;
        emit(&app2, "saving", 0, 0);
        let display_name = version
            .as_deref()
            .filter(|v| !v.is_empty())
            .map(|v| format!("GameTrackerRemote-{v}.apk"))
            .or_else(|| {
                url.rsplit('/')
                    .next()
                    .filter(|s| s.ends_with(".apk"))
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| "GameTrackerRemote.apk".into());
        save_to_downloads(&apk_path, &display_name)
    })
    .await
    .map_err(|e| format!("save task panicked: {e}"))?
}

/// Hand the APK previously copied to Downloads (via [`save_apk_to_downloads`]) to
/// the system installer through its `content://` URI — a second install path for
/// when the cache-dir FileProvider one didn't take. Errors clearly if nothing was
/// saved yet.
#[tauri::command]
pub async fn open_downloaded_apk() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(open_downloaded_apk_impl)
        .await
        .map_err(|e| format!("open task panicked: {e}"))?
}

/// Fetch the update manifest JSON over HTTP and return it as a string.
///
/// The webview's own `fetch()` is subject to CORS, and GitHub's release-asset host
/// doesn't send `Access-Control-Allow-Origin` for the app's origin, so an in-page
/// fetch fails with "Failed to fetch". Doing it here (ureq, like the APK download)
/// sidesteps CORS entirely — the manifest is tiny, so the round-trip is cheap.
#[tauri::command]
pub async fn fetch_update_manifest(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resp = ureq::get(&url)
            .set("User-Agent", "GameTrackerRemote-Updater")
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(code, _) => format!("update server returned HTTP {code}"),
                other => format!("could not reach the update server: {other}"),
            })?;
        resp.into_string()
            .map_err(|e| format!("could not read the update manifest: {e}"))
    })
    .await
    .map_err(|e| format!("manifest fetch task panicked: {e}"))?
}

/// Whether Android currently permits this app to install packages ("install
/// unknown apps"). Checked up front so the UI can prompt the user to grant it
/// BEFORE downloading, instead of failing at the install step. Always `true` on
/// non-Android / pre-API-26 where the concept doesn't exist.
#[tauri::command]
pub async fn install_permission_status() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(check_install_permission)
        .await
        .map_err(|e| format!("permission check panicked: {e}"))?
}

/// Open the system "install unknown apps" settings screen for this app so the
/// user can grant permission in one tap.
#[tauri::command]
pub async fn open_install_settings() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(open_install_settings_impl)
        .await
        .map_err(|e| format!("open settings panicked: {e}"))?
}

/// The JavaVM + activity for JNI calls, read from **tao's** per-activity context map.
///
/// tao 0.35+ (the windowing layer under tauri 2.x) no longer initializes the
/// `ndk-context` crate's process-wide global — its multi-activity rework keeps its
/// own `CONTEXTS` map instead — so the old `ndk_context::android_context()` call
/// panicked with "android context was not initialized" on EVERY install/save path
/// (the "task N panicked" errors in the update dialog). `context_jobject` is the
/// activity (a leaked GlobalRef, valid for the app's lifetime); `None` can only
/// happen before the first activity finishes creating, which can't be the case
/// while the webview is already invoking commands.
#[cfg(target_os = "android")]
fn tao_android_context() -> Result<tao::platform::android::prelude::AndroidContext, String> {
    tao::platform::android::prelude::main_android_context().ok_or_else(|| {
        "Android activity context is not available yet — try again in a moment".to_string()
    })
}

#[cfg(target_os = "android")]
fn check_install_permission() -> Result<bool, String> {
    use jni::objects::JObject;
    let ctx = tao_android_context()?;
    let vm = unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };
    let allowed = can_request_installs(&mut env, &context).unwrap_or(true);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
    Ok(allowed)
}

#[cfg(target_os = "android")]
fn open_install_settings_impl() -> Result<(), String> {
    use jni::objects::JObject;
    let ctx = tao_android_context()?;
    let vm = unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };
    let r = open_unknown_sources_settings(&mut env, &context);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    r
}

#[cfg(not(target_os = "android"))]
fn check_install_permission() -> Result<bool, String> {
    Ok(true)
}

#[cfg(not(target_os = "android"))]
fn open_install_settings_impl() -> Result<(), String> {
    Err("Install settings are only available on Android".into())
}

fn emit(app: &AppHandle, phase: &str, received: u64, total: u64) {
    let _ = app.emit(
        "apk-update://progress",
        serde_json::json!({ "phase": phase, "received": received, "total": total }),
    );
}

/// Download (or reuse) the APK in the cache dir, then hand it to the installer.
fn run_update(app: &AppHandle, url: &str, cache_dir: &std::path::Path) -> Result<(), String> {
    let apk_path = ensure_downloaded(app, url, cache_dir)?;
    emit(app, "installing", 0, 0);
    launch_installer(apk_path.to_string_lossy().as_ref()).map_err(|e| {
        format!(
            "Install step failed after a successful download: {e}. You can save the APK to Downloads and install it from there."
        )
    })
}

/// A complete APK is a ZIP: it starts with the "PK" magic AND ends with an
/// End-Of-Central-Directory record (signature `50 4B 05 06`) somewhere in the last
/// ~64 KB (the ZIP comment can be up to 65535 bytes). Checking the EOCD — not just
/// the 2-byte header — is what catches a **truncated or corrupted** download: the
/// header-only check accepted a partial file that then failed to install with
/// "package appears to be invalid".
fn apk_looks_complete(path: &std::path::Path) -> bool {
    use std::io::{Seek, SeekFrom};
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let len = match f.metadata() {
        Ok(m) => m.len(),
        Err(_) => return false,
    };
    if len < 1024 {
        return false;
    }
    let mut head = [0u8; 2];
    if f.read_exact(&mut head).is_err() || &head != b"PK" {
        return false;
    }
    let tail = std::cmp::min(len, 65_557) as usize; // 22-byte EOCD + max comment
    if f.seek(SeekFrom::End(-(tail as i64))).is_err() {
        return false;
    }
    let mut buf = vec![0u8; tail];
    if f.read_exact(&mut buf).is_err() {
        return false;
    }
    buf.windows(4).any(|w| w == [0x50, 0x4b, 0x05, 0x06])
}

/// Ensure `cache_dir/update.apk` holds a *complete, valid* APK for `url`, and return
/// its path. Reuses an existing cached copy only when it passes the full integrity
/// check, so a corrupt earlier download can't stick the user on "package invalid"
/// forever (it used to be reused on every retry). Downloads to a `.part` temp file
/// and only promotes it after verifying completeness, so the cache is never a
/// half-written file.
fn ensure_downloaded(
    app: &AppHandle,
    url: &str,
    cache_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(cache_dir).map_err(|e| format!("mkdir cache: {e}"))?;
    let apk_path = cache_dir.join("update.apk");

    // Reuse only a verified-complete cached APK.
    if apk_looks_complete(&apk_path) {
        let len = std::fs::metadata(&apk_path).map(|m| m.len()).unwrap_or(0);
        emit(app, "downloading", len, len);
        return Ok(apk_path);
    }
    let _ = std::fs::remove_file(&apk_path); // drop any corrupt/partial cache

    emit(app, "downloading", 0, 0);
    let tmp_path = cache_dir.join("update.apk.part");
    // GitHub's `releases/latest/download/<asset>` URL answers with a chain of 302
    // redirects to a signed CDN object; ureq follows redirects by default. Send a
    // User-Agent (GitHub can reject blank-UA clients) and surface a clear error if
    // the final response isn't a 2xx so the UI can report *why* it failed.
    //
    // Accept-Encoding: identity — ureq 2 enables transparent gzip by default, and a
    // Content-Encoding round-trip on an already-compressed binary APK can hand back
    // altered bytes (the "package appears to be invalid" install failure, while the
    // same asset downloaded by a browser installs fine). Forcing identity guarantees
    // we store the exact release bytes.
    let resp = ureq::get(url)
        .set("User-Agent", "GameTrackerRemote-Updater")
        .set("Accept-Encoding", "identity")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => {
                format!("download failed: server returned HTTP {code}")
            }
            other => format!("download failed: {other}"),
        })?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&tmp_path).map_err(|e| format!("create apk: {e}"))?;
    let mut buf = [0u8; 64 * 1024];
    let mut received: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| format!("write: {e}"))?;
        received += n as u64;
        emit(app, "downloading", received, total);
    }
    // Flush to disk before validating / handing the path to another process.
    let _ = file.sync_all();
    drop(file);

    // Completeness: bytes must match Content-Length (when the server gave one) AND
    // the file must be a structurally-complete ZIP. Either failing means a truncated
    // or altered body — delete it and report, so a retry re-downloads cleanly instead
    // of reusing a broken cache.
    if total > 0 && received != total {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "download incomplete ({received} of {total} bytes) — check your connection and try again"
        ));
    }
    if !apk_looks_complete(&tmp_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(
            "the downloaded update looks incomplete or corrupted (not a valid APK) — please try again"
                .into(),
        );
    }

    std::fs::rename(&tmp_path, &apk_path).map_err(|e| format!("finalize apk: {e}"))?;
    Ok(apk_path)
}

/// Hand the downloaded APK to the Android package installer.
///
/// Primary path is the **`PackageInstaller` Session API** (`do_install_session`):
/// on modern Android (this app targets SDK 36 / Android 16) the legacy
/// `ACTION_VIEW` + `application/vnd.android.package-archive` intent is unreliable —
/// the system install-confirmation dialog frequently just never appears (which is
/// exactly "the install prompt never shows up"). PackageInstaller is the API Google
/// documents for this: committing a session makes the *system* drive the
/// confirmation UI via a status callback, so the prompt reliably shows. We keep the
/// old `ACTION_VIEW` path (`do_install_legacy`) as a fallback for the rare device
/// where the session path errors.
#[cfg(target_os = "android")]
fn launch_installer(apk_path: &str) -> Result<(), String> {
    use jni::objects::JObject;

    let ctx = tao_android_context()?;
    let vm = unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };

    // Gate up front: without "install unknown apps" the system silently refuses.
    // Bounce the user to the exact settings screen and return a clear message
    // instead of firing an install that quietly does nothing. On API < 26 the check
    // throws NoSuchMethodError → treat as allowed and clear the pending exception.
    let allowed = can_request_installs(&mut env, &context).unwrap_or(true);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
    if !allowed {
        let _ = open_unknown_sources_settings(&mut env, &context);
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        return Err(
            "Android needs permission to install updates. We opened the setting — enable \
             \"Allow from this source\", then tap Update again."
                .into(),
        );
    }

    // Try the modern PackageInstaller session first. Any pending Java exception is
    // ALWAYS cleared before returning: detaching the thread with an exception pending
    // makes ART abort the whole process (the old "crashes when installing" bug).
    let session_result = do_install_session(&mut env, &context, apk_path);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe(); // dump to logcat for diagnosis
        let _ = env.exception_clear();
    }
    if session_result.is_ok() {
        return Ok(());
    }

    // Fallback: legacy ACTION_VIEW + FileProvider intent.
    let legacy_result = do_install_legacy(&mut env, &context, apk_path);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    // Surface the session error if the legacy path also failed (it's the more
    // informative one on a modern device).
    legacy_result.map_err(|legacy| {
        let session = session_result.err().unwrap_or_default();
        if session.is_empty() { legacy } else { format!("{session}; fallback: {legacy}") }
    })
}

/// Install the APK via `PackageInstaller` (the reliable modern path). Creates a
/// session, streams the APK bytes into it, and commits with a `PendingIntent`
/// targeting our `ApkInstallReceiver` — when the system needs user confirmation it
/// broadcasts `STATUS_PENDING_USER_ACTION` and the receiver launches the install
/// dialog. This is JNI-only (no Kotlin plugin); the receiver is a tiny generated
/// class registered by `scripts/patch-android.mjs`.
#[cfg(target_os = "android")]
fn do_install_session(
    env: &mut jni::AttachGuard,
    context: &jni::objects::JObject,
    apk_path: &str,
) -> Result<(), String> {
    use jni::objects::{JObject, JValue};

    // Load the whole APK into memory once (tens of MB — fine) so we can hand it to
    // the session's OutputStream in a single JNI write.
    let bytes = std::fs::read(apk_path).map_err(|e| format!("read apk: {e}"))?;
    let len = bytes.len() as i64;

    // PackageInstaller installer = context.getPackageManager().getPackageInstaller();
    let pm = env
        .call_method(context, "getPackageManager", "()Landroid/content/pm/PackageManager;", &[])
        .map_err(|e| format!("getPackageManager: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;
    let installer = env
        .call_method(&pm, "getPackageInstaller", "()Landroid/content/pm/PackageInstaller;", &[])
        .map_err(|e| format!("getPackageInstaller: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;

    // SessionParams params = new SessionParams(MODE_FULL_INSTALL); params.setSize(len);
    const MODE_FULL_INSTALL: i32 = 1;
    let params = env
        .new_object(
            "android/content/pm/PackageInstaller$SessionParams",
            "(I)V",
            &[JValue::Int(MODE_FULL_INSTALL)],
        )
        .map_err(|e| format!("SessionParams: {e}"))?;
    let _ = env.call_method(&params, "setSize", "(J)V", &[JValue::Long(len)]);

    // int sessionId = installer.createSession(params);
    let session_id = env
        .call_method(
            &installer,
            "createSession",
            "(Landroid/content/pm/PackageInstaller$SessionParams;)I",
            &[JValue::Object(&params)],
        )
        .map_err(|e| format!("createSession: {e}"))?
        .i()
        .map_err(|e| e.to_string())?;

    // Session session = installer.openSession(sessionId);
    let session = env
        .call_method(
            &installer,
            "openSession",
            "(I)Landroid/content/pm/PackageInstaller$Session;",
            &[JValue::Int(session_id)],
        )
        .map_err(|e| format!("openSession: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;

    // OutputStream out = session.openWrite("base.apk", 0, len);
    let name: JObject = env.new_string("base.apk").map_err(|e| e.to_string())?.into();
    let out = env
        .call_method(
            &session,
            "openWrite",
            "(Ljava/lang/String;JJ)Ljava/io/OutputStream;",
            &[JValue::Object(&name), JValue::Long(0), JValue::Long(len)],
        )
        .map_err(|e| format!("openWrite: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;

    // out.write(bytes); session.fsync(out); out.flush(); out.close();
    let jbytes = env.byte_array_from_slice(&bytes).map_err(|e| e.to_string())?;
    env.call_method(&out, "write", "([B)V", &[JValue::Object(&JObject::from(jbytes))])
        .map_err(|e| format!("write: {e}"))?;
    env.call_method(&session, "fsync", "(Ljava/io/OutputStream;)V", &[JValue::Object(&out)])
        .map_err(|e| format!("fsync: {e}"))?;
    let _ = env.call_method(&out, "flush", "()V", &[]);
    env.call_method(&out, "close", "()V", &[]).map_err(|e| format!("close: {e}"))?;

    // Intent statusIntent = new Intent().setClassName(pkg, "<pkg>.ApkInstallReceiver");
    let pkg_name = env
        .call_method(context, "getPackageName", "()Ljava/lang/String;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    let receiver: JObject = env
        .new_string(format!("{PACKAGE_NAME}.ApkInstallReceiver"))
        .map_err(|e| e.to_string())?
        .into();
    let intent = env
        .new_object("android/content/Intent", "()V", &[])
        .map_err(|e| e.to_string())?;
    env.call_method(
        &intent,
        "setClassName",
        "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
        &[JValue::Object(&pkg_name), JValue::Object(&receiver)],
    )
    .map_err(|e| format!("setClassName: {e}"))?;

    // PendingIntent pi = PendingIntent.getBroadcast(ctx, sessionId, intent, MUTABLE|UPDATE_CURRENT);
    // FLAG_MUTABLE (API 31+) is REQUIRED — the system fills the status extras in.
    const FLAG_UPDATE_CURRENT: i32 = 0x0800_0000;
    const FLAG_MUTABLE: i32 = 0x0200_0000;
    let pending = env
        .call_static_method(
            "android/app/PendingIntent",
            "getBroadcast",
            "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;",
            &[
                JValue::Object(context),
                JValue::Int(session_id),
                JValue::Object(&intent),
                JValue::Int(FLAG_UPDATE_CURRENT | FLAG_MUTABLE),
            ],
        )
        .map_err(|e| format!("getBroadcast: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;
    let sender = env
        .call_method(&pending, "getIntentSender", "()Landroid/content/IntentSender;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;

    // session.commit(sender); session.close();
    env.call_method(&session, "commit", "(Landroid/content/IntentSender;)V", &[JValue::Object(&sender)])
        .map_err(|e| format!("commit: {e}"))?;
    let _ = env.call_method(&session, "close", "()V", &[]);
    Ok(())
}

/// Legacy install path: hand the APK to the installer via a FileProvider
/// content:// URI + `ACTION_VIEW` intent. Kept only as a fallback — on modern
/// Android the confirmation dialog can silently fail to appear (see
/// `do_install_session`, the primary path).
#[cfg(target_os = "android")]
fn do_install_legacy(
    env: &mut jni::AttachGuard,
    context: &jni::objects::JObject,
    apk_path: &str,
) -> Result<(), String> {
    use jni::objects::{JObject, JValue};

    // On Android 8+ an app can't launch the package installer unless the user has
    // granted it "install unknown apps". If we don't have it, bounce the user to the
    // exact settings screen for THIS app and return a clear message instead of firing
    // an install intent that the system silently refuses (which looked like a failure).
    // On API < 26 `canRequestPackageInstalls` doesn't exist (throws NoSuchMethodError) —
    // treat any check failure as "allowed" and CLEAR the pending exception so it can't
    // poison the install JNI calls that follow (a pending exception aborts the process).
    let allowed = can_request_installs(env, context).unwrap_or(true);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
    if !allowed {
        let _ = open_unknown_sources_settings(env, context);
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        return Err(
            "Android needs permission to install updates. We opened the setting — enable \
             \"Allow from this source\", then tap Update again."
                .into(),
        );
    }

    // File file = new File(apk_path);
    let jpath: JObject = env.new_string(apk_path).map_err(|e| e.to_string())?.into();
    let file = env
        .new_object("java/io/File", "(Ljava/lang/String;)V", &[JValue::Object(&jpath)])
        .map_err(|e| e.to_string())?;

    // Uri uri = FileProvider.getUriForFile(context, authority, file);
    let authority: JObject = env
        .new_string(FILE_PROVIDER_AUTHORITY)
        .map_err(|e| e.to_string())?
        .into();
    let uri = env
        .call_static_method(
            "androidx/core/content/FileProvider",
            "getUriForFile",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/io/File;)Landroid/net/Uri;",
            &[
                JValue::Object(context),
                JValue::Object(&authority),
                JValue::Object(&file),
            ],
        )
        .map_err(|e| format!("getUriForFile: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;

    // Intent intent = new Intent(Intent.ACTION_VIEW);
    let action: JObject = env
        .new_string("android.intent.action.VIEW")
        .map_err(|e| e.to_string())?
        .into();
    let intent = env
        .new_object(
            "android/content/Intent",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&action)],
        )
        .map_err(|e| e.to_string())?;

    // intent.setDataAndType(uri, "application/vnd.android.package-archive");
    let mime: JObject = env
        .new_string("application/vnd.android.package-archive")
        .map_err(|e| e.to_string())?
        .into();
    env.call_method(
        &intent,
        "setDataAndType",
        "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;",
        &[JValue::Object(&uri), JValue::Object(&mime)],
    )
    .map_err(|e| e.to_string())?;

    // intent.addFlags(FLAG_ACTIVITY_NEW_TASK | FLAG_GRANT_READ_URI_PERMISSION);
    const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;
    const FLAG_GRANT_READ_URI_PERMISSION: i32 = 0x0000_0001;
    env.call_method(
        &intent,
        "addFlags",
        "(I)Landroid/content/Intent;",
        &[JValue::Int(FLAG_ACTIVITY_NEW_TASK | FLAG_GRANT_READ_URI_PERMISSION)],
    )
    .map_err(|e| e.to_string())?;

    // context.startActivity(intent);
    env.call_method(
        context,
        "startActivity",
        "(Landroid/content/Intent;)V",
        &[JValue::Object(&intent)],
    )
    .map_err(|e| format!("startActivity: {e}"))?;

    Ok(())
}

/// context.getPackageManager().canRequestPackageInstalls() — whether this app may
/// install packages (Android 8+; older versions always may, so treat errors as `true`).
#[cfg(target_os = "android")]
fn can_request_installs(
    env: &mut jni::AttachGuard,
    context: &jni::objects::JObject,
) -> Result<bool, String> {
    let pm = env
        .call_method(context, "getPackageManager", "()Landroid/content/pm/PackageManager;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    let allowed = env
        .call_method(&pm, "canRequestPackageInstalls", "()Z", &[])
        .map_err(|e| e.to_string())?
        .z()
        .map_err(|e| e.to_string())?;
    Ok(allowed)
}

/// Open Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES for this package so the user can
/// grant install permission in one tap. Best-effort (errors are ignored by the caller).
#[cfg(target_os = "android")]
fn open_unknown_sources_settings(
    env: &mut jni::AttachGuard,
    context: &jni::objects::JObject,
) -> Result<(), String> {
    use jni::objects::{JObject, JValue};

    // String pkg = context.getPackageName();  (kept as a Java String — no Rust round-trip)
    let pkg = env
        .call_method(context, "getPackageName", "()Ljava/lang/String;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;

    // Uri uri = Uri.fromParts("package", pkg, null);  (builds package:<pkg> in Java)
    let scheme: JObject = env.new_string("package").map_err(|e| e.to_string())?.into();
    let null_obj = JObject::null();
    let uri = env
        .call_static_method(
            "android/net/Uri",
            "fromParts",
            "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/net/Uri;",
            &[
                JValue::Object(&scheme),
                JValue::Object(&pkg),
                JValue::Object(&null_obj),
            ],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;

    // Intent intent = new Intent(ACTION_MANAGE_UNKNOWN_APP_SOURCES, uri);
    let action: JObject = env
        .new_string("android.settings.MANAGE_UNKNOWN_APP_SOURCES")
        .map_err(|e| e.to_string())?
        .into();
    let intent = env
        .new_object(
            "android/content/Intent",
            "(Ljava/lang/String;Landroid/net/Uri;)V",
            &[JValue::Object(&action), JValue::Object(&uri)],
        )
        .map_err(|e| e.to_string())?;

    const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;
    env.call_method(&intent, "addFlags", "(I)Landroid/content/Intent;", &[JValue::Int(FLAG_ACTIVITY_NEW_TASK)])
        .map_err(|e| e.to_string())?;
    env.call_method(context, "startActivity", "(Landroid/content/Intent;)V", &[JValue::Object(&intent)])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn launch_installer(_apk_path: &str) -> Result<(), String> {
    Err("APK install is only supported on Android".into())
}

/// Copy `apk_path` into the public Downloads collection and remember its content URI.
#[cfg(target_os = "android")]
fn save_to_downloads(apk_path: &std::path::Path, display_name: &str) -> Result<String, String> {
    use jni::objects::{JObject, JValue};

    let bytes = std::fs::read(apk_path).map_err(|e| format!("read cached apk: {e}"))?;
    let ctx = tao_android_context()?;
    let vm = unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };

    let result = (|| -> Result<String, String> {
        // ContentResolver resolver = context.getContentResolver();
        let resolver = env
            .call_method(context, "getContentResolver", "()Landroid/content/ContentResolver;", &[])
            .map_err(|e| format!("getContentResolver: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;

        // ContentValues values = new ContentValues();
        let values = env
            .new_object("android/content/ContentValues", "()V", &[])
            .map_err(|e| format!("ContentValues: {e}"))?;
        let put_string = |env: &mut jni::AttachGuard, key: &str, val: &str| -> Result<(), String> {
            let jk: JObject = env.new_string(key).map_err(|e| e.to_string())?.into();
            let jv: JObject = env.new_string(val).map_err(|e| e.to_string())?.into();
            env.call_method(
                &values,
                "put",
                "(Ljava/lang/String;Ljava/lang/String;)V",
                &[JValue::Object(&jk), JValue::Object(&jv)],
            )
            .map_err(|e| format!("put {key}: {e}"))?;
            Ok(())
        };
        // MediaStore.MediaColumns.* string values (not the Java constant names).
        put_string(&mut env, "_display_name", display_name)?;
        put_string(&mut env, "mime_type", "application/vnd.android.package-archive")?;
        // IS_PENDING = 1 while we write (API 29+ MediaStore.Downloads)
        {
            let jk: JObject = env.new_string("is_pending").map_err(|e| e.to_string())?.into();
            let one = env
                .new_object("java/lang/Integer", "(I)V", &[JValue::Int(1)])
                .map_err(|e| e.to_string())?;
            env.call_method(
                &values,
                "put",
                "(Ljava/lang/String;Ljava/lang/Integer;)V",
                &[JValue::Object(&jk), JValue::Object(&one)],
            )
            .map_err(|e| format!("put is_pending: {e}"))?;
        }

        // Uri collection = MediaStore.Downloads.getContentUri("external");
        let external: JObject = env.new_string("external").map_err(|e| e.to_string())?.into();
        let collection = env
            .call_static_method(
                "android/provider/MediaStore$Downloads",
                "getContentUri",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[JValue::Object(&external)],
            )
            .map_err(|e| format!("Downloads.getContentUri: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;

        // Uri item = resolver.insert(collection, values);
        let item = env
            .call_method(
                &resolver,
                "insert",
                "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
                &[JValue::Object(&collection), JValue::Object(&values)],
            )
            .map_err(|e| format!("insert: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;
        if item.is_null() {
            return Err(
                "Couldn't create a file in Downloads (storage permission or MediaStore insert failed)"
                    .into(),
            );
        }

        // OutputStream out = resolver.openOutputStream(item);
        let out = env
            .call_method(
                &resolver,
                "openOutputStream",
                "(Landroid/net/Uri;)Ljava/io/OutputStream;",
                &[JValue::Object(&item)],
            )
            .map_err(|e| format!("openOutputStream: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;
        if out.is_null() {
            return Err("Couldn't open Downloads file for writing".into());
        }

        // Write in chunks via JNI byte arrays.
        const CHUNK: usize = 256 * 1024;
        for chunk in bytes.chunks(CHUNK) {
            let jbytes = env.byte_array_from_slice(chunk).map_err(|e| e.to_string())?;
            env.call_method(&out, "write", "([B)V", &[JValue::Object(&JObject::from(jbytes))])
                .map_err(|e| format!("write Downloads: {e}"))?;
        }
        let _ = env.call_method(&out, "flush", "()V", &[]);
        env.call_method(&out, "close", "()V", &[])
            .map_err(|e| format!("close Downloads: {e}"))?;

        // Clear IS_PENDING so the file becomes visible in the Files/Downloads UI.
        let done = env
            .new_object("android/content/ContentValues", "()V", &[])
            .map_err(|e| e.to_string())?;
        {
            let jk: JObject = env.new_string("is_pending").map_err(|e| e.to_string())?.into();
            let zero = env
                .new_object("java/lang/Integer", "(I)V", &[JValue::Int(0)])
                .map_err(|e| e.to_string())?;
            env.call_method(
                &done,
                "put",
                "(Ljava/lang/String;Ljava/lang/Integer;)V",
                &[JValue::Object(&jk), JValue::Object(&zero)],
            )
            .map_err(|e| e.to_string())?;
        }
        let null_s = JObject::null();
        let _ = env.call_method(
            &resolver,
            "update",
            "(Landroid/net/Uri;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I",
            &[
                JValue::Object(&item),
                JValue::Object(&done),
                JValue::Object(&null_s),
                JValue::Object(&null_s),
            ],
        );

        // Remember URI for open_downloaded_apk.
        let uri_j = env
            .call_method(&item, "toString", "()Ljava/lang/String;", &[])
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;
        let uri_str: String = env
            .get_string(&uri_j.into())
            .map_err(|e| e.to_string())?
            .into();
        if let Ok(mut g) = LAST_DOWNLOADS_URI.lock() {
            *g = Some(uri_str);
        }

        Ok(format!("Download/{display_name}"))
    })();

    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    result
}

#[cfg(not(target_os = "android"))]
fn save_to_downloads(apk_path: &std::path::Path, display_name: &str) -> Result<String, String> {
    // Desktop/dev stub: copy next to the cache path so the flow is testable.
    let dest = apk_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join(display_name);
    std::fs::copy(apk_path, &dest).map_err(|e| format!("copy: {e}"))?;
    if let Ok(mut g) = LAST_DOWNLOADS_URI.lock() {
        *g = Some(dest.to_string_lossy().into_owned());
    }
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(target_os = "android")]
fn open_downloaded_apk_impl() -> Result<(), String> {
    use jni::objects::{JObject, JValue};

    let uri_str = LAST_DOWNLOADS_URI
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .ok_or_else(|| {
            "No APK has been saved to Downloads yet — tap \"Save to Downloads\" first.".to_string()
        })?;

    let ctx = tao_android_context()?;
    let vm = unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };

    let result = (|| -> Result<(), String> {
        let allowed = can_request_installs(&mut env, &context).unwrap_or(true);
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        if !allowed {
            let _ = open_unknown_sources_settings(&mut env, &context);
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_clear();
            }
            return Err(
                "Android needs permission to install updates. We opened the setting — enable \
                 \"Allow from this source\", then try again."
                    .into(),
            );
        }

        let juri: JObject = env.new_string(&uri_str).map_err(|e| e.to_string())?.into();
        let uri = env
            .call_static_method(
                "android/net/Uri",
                "parse",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[JValue::Object(&juri)],
            )
            .map_err(|e| format!("Uri.parse: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;

        let action: JObject = env
            .new_string("android.intent.action.VIEW")
            .map_err(|e| e.to_string())?
            .into();
        let intent = env
            .new_object(
                "android/content/Intent",
                "(Ljava/lang/String;)V",
                &[JValue::Object(&action)],
            )
            .map_err(|e| e.to_string())?;
        let mime: JObject = env
            .new_string("application/vnd.android.package-archive")
            .map_err(|e| e.to_string())?
            .into();
        env.call_method(
            &intent,
            "setDataAndType",
            "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;",
            &[JValue::Object(&uri), JValue::Object(&mime)],
        )
        .map_err(|e| e.to_string())?;

        const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;
        const FLAG_GRANT_READ_URI_PERMISSION: i32 = 0x0000_0001;
        env.call_method(
            &intent,
            "addFlags",
            "(I)Landroid/content/Intent;",
            &[JValue::Int(FLAG_ACTIVITY_NEW_TASK | FLAG_GRANT_READ_URI_PERMISSION)],
        )
        .map_err(|e| e.to_string())?;

        env.call_method(
            context,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[JValue::Object(&intent)],
        )
        .map_err(|e| format!("startActivity (Downloads APK): {e}"))?;
        Ok(())
    })();

    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    result
}

#[cfg(not(target_os = "android"))]
fn open_downloaded_apk_impl() -> Result<(), String> {
    Err("Opening a saved APK is only supported on Android".into())
}
